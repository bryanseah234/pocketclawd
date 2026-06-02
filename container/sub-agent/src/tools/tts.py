"""Text-to-speech via AWS Polly (cheapest, no extra key)."""
import boto3
import logging
import os
import uuid

logger = logging.getLogger(__name__)

TTS_TOOL = {
    "toolSpec": {
        "name": "text_to_speech",
        "description": "Convert text to spoken audio. Sends an audio message.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to speak (max 1000 chars)"},
                    "voice": {"type": "string", "description": "Voice: Joanna (female) or Matthew (male)", "default": "Joanna"},
                },
                "required": ["text"],
            }
        },
    }
}


async def text_to_speech(text: str, voice: str = "Joanna") -> str:
    region = os.environ.get("AWS_REGION", "ap-southeast-1")
    bucket = os.environ.get("DATA_BUCKET", "")
    if not bucket:
        return "TTS unavailable (DATA_BUCKET not configured)."
    try:
        polly = boto3.client("polly", region_name=region)
        vid = voice if voice in ("Joanna", "Matthew", "Amy", "Brian") else "Joanna"
        try:
            resp = polly.synthesize_speech(
                Text=text[:1000], OutputFormat="mp3", VoiceId=vid, Engine="neural",
            )
        except Exception as neural_err:  # noqa: BLE001
            # Neural engine may be unavailable in-region or per-voice; fall back to standard.
            logger.warning("Polly neural failed (%s); retrying with standard engine", neural_err)
            resp = polly.synthesize_speech(
                Text=text[:1000], OutputFormat="mp3", VoiceId=vid, Engine="standard",
            )
        audio = resp["AudioStream"].read()
        s3 = boto3.client("s3", region_name=region)
        key = f"media/tts/{uuid.uuid4()}.mp3"
        s3.put_object(Bucket=bucket, Key=key, Body=audio, ContentType="audio/mpeg")
        url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)
        return f"AUDIO_URL:{url}:AUDIO_URL"
    except Exception as e:
        logger.error("TTS failed: %s", e)
        return f"TTS failed: {str(e)[:200]}"
