from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from youtube_transcript_api import YouTubeTranscriptApi
from langchain_utils import get_llm_response

app = FastAPI()

# Allow extension requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # for dev, restrict later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/transcript/{video_id}")
def get_transcript(video_id: str, lang: str = "en"):
    try:
        total_transcript = ""
        ytt_api = YouTubeTranscriptApi()
        fetched_transcript = ytt_api.fetch(video_id)
        for snippet in fetched_transcript:
            total_transcript += snippet.text + "\n"
        video_url = f"https://www.youtube.com/watch?v={video_id}"
        llm_response = get_llm_response(total_transcript, video_url)
        return {"videoId": video_id, "transcript": total_transcript, "linkedin_post": llm_response}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))
