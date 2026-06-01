"""Image generation via Bedrock Stability stable-image-core-v1:1.

Nova Canvas is not available in ap-southeast-1.  We cross-call us-west-2 for
the Bedrock invoke (same AWS account, ~150ms extra latency) then upload the
PNG to the ap-southeast-1 S3 bucket so all storage stays in-region.

Cost: ~$0.04 / image (stable-image-core standard quality).
"""
import base64
import boto3
import json
import logging
import os
import uuid

logger = logging.getLogger(__name__)

# Image gen lives in us-west-2 (Nova Canvas / Stability not in ap-southeast-1).
# Override with IMAGE_GEN_REGION env var if another region is preferred.
_DEFAULT_IMAGE_GEN_REGION = "us-west-2"
_MODEL_ID = "stability.stable-image-core-v1:1"

IMAGE_GEN_TOOL = {
    "toolSpec": {
        "name": "generate_image",
        "description": (
            "Generate an image from a text description. "
            "Use this when the user asks you to draw, create, generate, or visualise something. "
            "E.g. 'make me a birthday card', 'draw a logo', 'generate a picture of...'."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Detailed description of the image to generate (max 512 chars)",
                    },
                    "style": {
                        "type": "string",
                        "description": (
                            "Optional style hint appended to the prompt, "
                            "e.g. 'photorealistic', 'cartoon', 'watercolor', 'flat icon'"
                        ),
                        "default": "",
                    },
                },
                "required": ["prompt"],
            }
        },
    }
}


async def generate_image(prompt: str, style: str = "") -> str:
    """Generate image via Bedrock us-west-2, upload to S3, return presigned URL.

    Returns IMAGE_URL:<url>:IMAGE_URL so the orchestrator delivers it as a
    media message rather than plain text.
    """
    bucket = os.environ.get("DATA_BUCKET", "")
    if not bucket:
        return "Image generation unavailable (DATA_BUCKET not configured)."

    # Bedrock image models are not in ap-southeast-1 -- use us-west-2.
    img_region = os.environ.get("IMAGE_GEN_REGION", _DEFAULT_IMAGE_GEN_REGION)
    s3_region = os.environ.get("AWS_REGION", "ap-southeast-1")

    full_prompt = f"{prompt}. Style: {style}" if style else prompt
    full_prompt = full_prompt[:512]

    try:
        bedrock = boto3.client("bedrock-runtime", region_name=img_region)

        body = {
            "prompt": full_prompt,
            "output_format": "png",
            "aspect_ratio": "1:1",
            "mode": "text-to-image",
        }

        resp = bedrock.invoke_model(
            modelId=_MODEL_ID,
            body=json.dumps(body),
            contentType="application/json",
            accept="application/json",
        )

        result = json.loads(resp["body"].read())
        images = result.get("images", [])
        if not images:
            logger.error("Bedrock returned no images: %s", result)
            return "Image generation returned no output. Please try again."

        img_bytes = base64.b64decode(images[0])

        # Upload to S3 (in-region bucket)
        s3 = boto3.client("s3", region_name=s3_region)
        key = f"media/generated/{uuid.uuid4()}.png"
        s3.put_object(
            Bucket=bucket, Key=key, Body=img_bytes,
            ContentType="image/png",
        )

        # Presigned URL valid for 24 hours
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=86400,
        )
        logger.info("Generated image key=%s region=%s", key, img_region)

        # Special marker: orchestrator strips this and delivers as media message
        return f"IMAGE_URL:{url}:IMAGE_URL"

    except Exception as e:
        err = str(e)
        logger.error("Image generation failed: %s", err)
        if "AccessDeniedException" in err:
            return (
                "Image generation is not enabled for this account. "
                "Enable stability.stable-image-core-v1:1 in the Bedrock console (us-west-2)."
            )
        if "ResourceNotFoundException" in err or "ValidationException" in err:
            return (
                "Image generation model unavailable. "
                "Check that stability.stable-image-core-v1:1 is enabled in Bedrock (us-west-2)."
            )
        return f"Sorry, image generation failed. Please try again in a moment."
