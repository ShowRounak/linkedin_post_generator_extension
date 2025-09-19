window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("output").value = "";
  document.getElementById("loadingSpinner").style.display = "none";
});

document.getElementById("fetchBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes("youtube.com/watch")) {
    alert("Not a YouTube video page.");
    return;
  }

  // Extract videoId from URL
  const urlParams = new URL(tab.url).searchParams;
  const videoId = urlParams.get("v");

  if (!videoId) {
    alert("Could not extract video ID.");
    return;
  }

  const apiUrl = `http://localhost:8000/transcript/${videoId}`;

  // Show loading spinner (flex for new style)
  document.getElementById("loadingSpinner").style.display = "flex";
  document.getElementById("output").value = "";

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }

    const data = await res.json();

    // Your API returns transcript as a string
    document.getElementById("output").value = data.linkedin_post || "No transcript found.";

  } catch (err) {
    console.error(err);
    alert("Failed to fetch transcript: " + err.message);
  } finally {
    // Hide loading spinner
    document.getElementById("loadingSpinner").style.display = "none";
  }
});

// Copy button logic

document.getElementById("copyBtn").addEventListener("click", () => {
  const output = document.getElementById("output");
  output.select();
  output.setSelectionRange(0, 99999); // For mobile devices
  document.execCommand("copy");
  const copyBtn = document.getElementById("copyBtn");
  const originalText = copyBtn.textContent;
  copyBtn.textContent = "Copied!";
  setTimeout(() => { copyBtn.textContent = originalText; }, 1200);
});
