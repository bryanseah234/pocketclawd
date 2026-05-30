"""Image generation via Bedrock Nova Canvas (pay-per-use, ~$0.006/img)."""
import base64
import boto3
import json
import logging
import os
import uuid

logger = logging.getLogger(__name__)

IMAGE_GEN_TOOL = {
    "toolSpec": {
        "name": "generate_image",
        "description": "Generate an image from a text description. E.g. make me a birthday card, draw a logo.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Detailed description of the image to generate"},
                    "style": {"type": "string", "description": "Optional style hint (e.g. photorealistic, cartoon, watercolor)", "default": ""},
                },
                "required": ["prompt"],
            }
        },
    }
}


async def generate_image(prompt: str, style: str = "") -> str:
    """Generate image, upload to S3, return presigned URL."""
    region = os.environ.get("AWS_REGION", "ap-southeast-1")
    bucket = os.environ.get("DATA_BUCKET", "")
    if not bucket:
        return "Image generation unavailable (DATA_BUCKET not configured)."

    full_prompt = f"{prompt}. {style}" if style else prompt

    try:
        bedrock = boto3.client("bedrock-runtime", region_name=region)
        body = {
            "taskType": "TEXT_IMAGE",
            "textToImageParams": {"text": full_prompt[:512]},
            "imageGenerationConfig": {
                "width": 1024, "height": 1024,
                "numberOfImages": 1, "quality": "standard",
            }
        }
        resp = bedrock.invoke_model(
            modelId="amazon.nova-canvas-v1:0",
            body=json.dumps(body),
            contentType="application/json",
            accept="application/json",
        )
        result = json.loads(resp["body"].read())
        img_b64 = result["images"][0]
        img_bytes = base64.b64decode(img_b64)

        # Upload to S3
        s3 = boto3.client("s3", region_name=region)
        key = f"media/generated/{uuid.uuid4()}.png"
        s3.put_object(Bucket=bucket, Key=key, Body=img_bytes, ContentType="image/png")

        # Presigned URL (1 hour)
        url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)
        logger.info("Generated image: %s", key)

        # Return special marker so orchestrator can send as WA image
        return f"IMAGE_URL:{url}:IMAGE_URL"

    except Exception as e:
        logger.error("Image generation failed: %s", e)
        if "ResourceNotFoundException" in str(e) or "ValidationException" in str(e):
            return "Image generation model not enabled in this region. Enable amazon.nova-canvas-v1:0 in Bedrock console."
        return f"Image generation failed: {str(e)[:200]}"
