// content_script.js
// Robust YouTube caption fetcher + parser
// - Extracts player response reliably (direct, injected, or script-parse)
// - Fetches caption track URLs and tries multiple &fmt= variants
// - Parses XML timedtext, WebVTT, and JSON3 formats
// - Console logs heavily for debugging

const LOG_PREFIX = 'YTTranscript:';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function getVideoId() {
  const params = new URLSearchParams(location.search);
  return params.get('v');
}

function parseXml(text) {
  return new DOMParser().parseFromString(text, 'text/xml');
}

function decodeHtmlEntities(str) {
  const d = document.createElement('div');
  d.innerHTML = str;
  return d.textContent || d.innerText || '';
}

// Safely extract JSON-like object text by braces balancing
function extractJSONFromScriptText(text, varName) {
  const idx = text.indexOf(varName);
  if (idx === -1) return null;
  const braceStart = text.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(braceStart, i + 1);
      }
    }
  }
  return null;
}

// Try to obtain ytInitialPlayerResponse via three methods:
// 1) content script window var (may or may not exist due to isolated worlds)
// 2) inject a small page-script that posts the var via window.postMessage
// 3) parse <script> tags using brace matching
async function getPlayerResponse() {
  try {
    // 1) try direct access (sometimes works)
    if (window.ytInitialPlayerResponse) {
      log('playerResponse: direct window var');
      return window.ytInitialPlayerResponse;
    }

    // 2) inject a script into page context that posts the var back
    const injected = await new Promise((resolve) => {
      function onMessage(e) {
        if (e.source !== window) return;
        const d = e.data;
        if (d && d.__YT_TR__ === true) {
          window.removeEventListener('message', onMessage);
          resolve(d.payload || null);
        }
      }
      window.addEventListener('message', onMessage);

      const script = document.createElement('script');
      script.textContent = `
        (function(){
          try {
            window.postMessage({ __YT_TR__: true, payload: window.ytInitialPlayerResponse || null }, '*');
          } catch(e) {
            window.postMessage({ __YT_TR__: true, payload: null }, '*');
          }
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      // remove the injected script node
      script.parentNode.removeChild(script);

      // safety timeout -> resolve null
      setTimeout(() => {
        try { window.removeEventListener('message', onMessage); } catch(_) {}
        resolve(null);
      }, 1000);
    });

    if (injected) {
      log('playerResponse: injected page script');
      return injected;
    }

    // 3) fallback: scan script tags and extract JSON text robustly
    const scripts = [...document.querySelectorAll('script')];
    for (const s of scripts) {
      if (!s.textContent) continue;
      if (s.textContent.includes('ytInitialPlayerResponse')) {
        const jsonStr = extractJSONFromScriptText(s.textContent, 'ytInitialPlayerResponse');
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            log('playerResponse: parsed from script tag');
            return parsed;
          } catch (e) {
            // try continue
            log('playerResponse parse error', e);
          }
        }
      }
    }

    throw new Error('ytInitialPlayerResponse not found');
  } catch (err) {
    throw new Error('getPlayerResponse error: ' + (err && err.message ? err.message : String(err)));
  }
}

// Build a safe track list (with URL)
async function fetchCaptionList(videoId) {
  const playerResponse = await getPlayerResponse();
  const captionTracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('No caption tracks found in player response');
  }

  const tracks = captionTracks.map((t) => ({
    lang: t.languageCode,
    name: t.name?.simpleText || '',
    url: t.baseUrl || t.url || null,
    kind: t.kind || '',
    isTranslatable: !!t.isTranslatable
  }));

  log('fetched captionTracks', tracks.map(t => `${t.lang}${t.name ? ` (${t.name})` : ''}`));
  return tracks;
}

// Convert VTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds (float)
function vttTimeToSeconds(ts) {
  ts = ts.replace(',', '.').trim();
  const parts = ts.split(':').map(p => parseFloat(p));
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parseFloat(parts[0]) || 0;
}

// Parse a WebVTT blob into cues
function parseVTT(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // cue time line contains '-->'
    if (line.includes('-->')) {
      const times = line.split('-->');
      const start = vttTimeToSeconds(times[0]);
      i++;
      let cueText = '';
      while (i < lines.length && lines[i].trim() !== '') {
        cueText += (cueText ? '\n' : '') + lines[i];
        i++;
      }
      cueText = decodeHtmlEntities(cueText).replace(/\n+/g, ' ').trim();
      cues.push(`[${start}s] ${cueText}`);
    } else {
      i++;
    }
  }
  return cues;
}

// Parse JSON3 caption format (used when fmt=json3 is requested)
function parseJSON3(text) {
  try {
    const obj = JSON.parse(text);
    if (!obj.events || !Array.isArray(obj.events)) return [];
    const cues = obj.events.map(ev => {
      // events may have tStartMs and segs array with utf8 pieces
      const start = (ev.tStartMs !== undefined) ? (ev.tStartMs / 1000) : (ev.tOffsetMs ? ev.tOffsetMs / 1000 : 0);
      const segs = ev.segs || ev.a || [];
      const txt = segs.map(s => s.utf8 || s.t || s.w || '').join('').replace(/\s+/g, ' ').trim();
      return `[${start}s] ${decodeHtmlEntities(txt)}`;
    });
    return cues;
  } catch (e) {
    return [];
  }
}

// Parse XML <text> nodes
function parseXMLTextNodes(text) {
  try {
    const xml = parseXml(text);
    let nodes = [...xml.querySelectorAll('text')];
    if (nodes.length === 0) {
      // fallback: some variants use <p> or other structures
      nodes = [...xml.querySelectorAll('p')];
    }
    const cues = nodes.map(n => {
      const start = parseFloat(n.getAttribute('start') || n.getAttribute('t') || '0');
      const raw = n.textContent || '';
      return `[${start}s] ${decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim()}`;
    });
    return cues;
  } catch (e) {
    return [];
  }
}

// Try several fetch formats and parse
async function fetchCaptionText(videoId, track) {
  if (!track || !track.url) {
    throw new Error('No track URL available for ' + track.lang);
  }

  log('fetchCaptionText: attempting', track.lang, track.url);

  // Candidate formats to try (order matters)
  const candidates = [
    track.url + (track.url.includes('?') ? '&' : '?') + 'fmt=vtt',
    track.url + (track.url.includes('?') ? '&' : '?') + 'fmt=json3',
    track.url + (track.url.includes('?') ? '&' : '?') + 'fmt=srv3',
    track.url
  ];

  for (const candidate of candidates) {
    try {
      log('trying URL:', candidate);
      const res = await fetch(candidate, { credentials: 'same-origin' });
      if (!res.ok) {
        log('fetch returned non-ok status', res.status, candidate);
        continue;
      }
      const text = await res.text();
      if (!text || text.trim().length === 0) {
        log('empty response body for', candidate);
        continue;
      }

      const trimmed = text.trim();
      // 1) WebVTT detection
      if (trimmed.startsWith('WEBVTT') || trimmed.includes('-->')) {
        const cues = parseVTT(text);
        log(`parsed VTT (${cues.length} cues) from ${candidate}`);
        if (cues.length) return cues.join('\n');
      }

      // 2) XML timedtext detection
      if (trimmed.startsWith('<') || trimmed.includes('<transcript') || trimmed.includes('<text')) {
        const cues = parseXMLTextNodes(text);
        log(`parsed XML (${cues.length} cues) from ${candidate}`);
        if (cues.length) return cues.join('\n');
      }

      // 3) JSON3 detection
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.includes('"events"')) {
        const cues = parseJSON3(text);
        log(`parsed JSON3 (${cues.length} cues) from ${candidate}`);
        if (cues.length) return cues.join('\n');
      }

      // If none matched but we have text, attempt an XML parse anyway
      const xmlFallback = parseXMLTextNodes(text);
      if (xmlFallback.length) {
        log(`xmlFallback parsed (${xmlFallback.length} cues) from ${candidate}`);
        return xmlFallback.join('\n');
      }

      // last resort: return the raw text (cleaned)
      log('could not parse format but response exists - returning raw (trimmed) for', candidate);
      const raw = decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
      if (raw.length > 0 && raw.length < 200000) {
        // small safety cap
        return raw;
      }
    } catch (err) {
      log('fetch/parsing error for', candidate, err && err.message ? err.message : err);
      // try next candidate
    }
  }

  throw new Error(`Failed to fetch/parse caption for lang=${track.lang}`);
}

// Main aggregator
async function getBestTranscript() {
  const videoId = getVideoId();
  if (!videoId) throw new Error('No video id found on this page');

  log('videoId', videoId);
  const tracks = await fetchCaptionList(videoId);
  if (!tracks || tracks.length === 0) {
    throw new Error('No captions found for this video.');
  }

  const fetched = [];
  for (const t of tracks) {
    try {
      const txt = await fetchCaptionText(videoId, t);
      if (txt && txt.trim().length) {
        fetched.push({ track: t, text: txt });
      } else {
        log('empty parsed text for track', t.lang);
      }
    } catch (e) {
      log('failed to fetch/parse track', t.lang, e && e.message ? e.message : e);
    }
  }

  if (fetched.length === 0) {
    throw new Error('No captions could be fetched or parsed. See console logs for details.');
  }

  const combined = fetched
    .map(
      (f) =>
        `--- Track: ${f.track.lang} ${f.track.name ? `(${f.track.name})` : ''} ---\n${f.text}`
    )
    .join('\n\n');

  return { videoId, tracks, combined };
}

// Messaging listener (popup -> content script)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'getTranscript') {
    getBestTranscript()
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) =>
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) })
      );
    return true; // keep channel open for async response
  }
});
