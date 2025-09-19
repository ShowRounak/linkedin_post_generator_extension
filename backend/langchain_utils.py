from langchain_google_genai import ChatGoogleGenerativeAI
import os
from dotenv import load_dotenv

load_dotenv()

os.environ["GOOGLE_API_KEY"] = os.getenv("GOOGLE_API_KEY")

def get_llm_response(transcript: str, video_url: str) -> str:
    llm = ChatGoogleGenerativeAI(
        model="gemini-2.5-flash",
        temperature=0
    )

    messages = [
        (
            "system",
            """You are an expert content strategist specializing in writing high-engagement LinkedIn posts. 
            Your task is to take a raw YouTube video transcript and transform it into a polished LinkedIn post that feels 
            authentic, thought-provoking, and shareable.

            Guidelines:
            - Start with a strong hook in the first 1-2 lines to capture attention.
            - Summarize or reframe the key insights from the transcript in a clear and conversational tone. 
            - Keep sentences short and scannable for LinkedIn readers.
            - Avoid jargon unless the video is highly technical—use plain, relatable language.
            - Add a personal or reflective angle to make it feel like the author's lived takeaway, not just a transcript summary.
            - Use few well-placed emojis to add personality and highlight key ideas (avoid overuse).
            - End with either:
            - A thought-provoking call to action (e.g., “What do you think?”), OR
            - A concise takeaway that inspires discussion.
            - Include a link to the original video for context.
            - Include 3-5 relevant hashtags at the end for visibility.
            - Limit the post to 120-180 words.
            - Avoid hashtags or emojis unless highly relevant.

            Output Format:
            Return only the LinkedIn post text, ready to be published.""",
        ),
        ("human", f"Here is the Video URL: {video_url} \n\nHere is the Transcript of the Youtube Video: {transcript}"),
    ]
    ai_msg = llm.invoke(messages)
    return ai_msg.content