"""Tests for image generation tool (image_gen.py).

Mocks boto3 clients -- no real AWS calls made.
"""
import base64
import json
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DATA_BUCKET", "test-bucket")
os.environ.setdefault("AWS_REGION", "ap-southeast-1")
os.environ.setdefault("IMAGE_GEN_REGION", "us-west-2")

from src.tools.image_gen import generate_image, _MODEL_ID, _DEFAULT_IMAGE_GEN_REGION


FAKE_PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
FAKE_URL = "https://s3.amazonaws.com/test-bucket/media/generated/abc.png?X-Amz-Signature=fake"


def _make_bedrock_mock(images=None, raise_exc=None):
    mock = MagicMock()
    if raise_exc:
        mock.invoke_model.side_effect = raise_exc
    else:
        body_content = json.dumps({"images": images if images is not None else [FAKE_PNG], "seeds": [42], "finish_reasons": [None]})
        mock_body = MagicMock()
        mock_body.read.return_value = body_content.encode()
        mock.invoke_model.return_value = {"body": mock_body}
    return mock


def _make_s3_mock(presigned_url=FAKE_URL):
    mock = MagicMock()
    mock.put_object.return_value = {}
    mock.generate_presigned_url.return_value = presigned_url
    return mock


@pytest.fixture
def mock_boto3(monkeypatch):
    """Patch boto3.client — opt-in fixture for tests that need default happy-path mocks."""
    bedrock_mock = _make_bedrock_mock()
    s3_mock = _make_s3_mock()

    def fake_client(service, region_name=None, **kwargs):
        if service == "bedrock-runtime":
            return bedrock_mock
        if service == "s3":
            return s3_mock
        raise ValueError(f"Unexpected boto3 service: {service}")

    monkeypatch.setattr("src.tools.image_gen.boto3.client", fake_client)
    return {"bedrock": bedrock_mock, "s3": s3_mock}


class TestGenerateImageSuccess:
    @pytest.mark.asyncio
    async def test_returns_image_url_marker(self, mock_boto3):
        result = await generate_image("a red circle")
        assert result.startswith("IMAGE_URL:"), f"Expected IMAGE_URL marker, got: {result!r}"
        assert result.endswith(":IMAGE_URL"), f"Missing closing marker: {result!r}"

    @pytest.mark.asyncio
    async def test_url_contains_presigned_url(self, mock_boto3):
        result = await generate_image("a red circle")
        inner = result[len("IMAGE_URL:"):-len(":IMAGE_URL")]
        assert inner == FAKE_URL

    @pytest.mark.asyncio
    async def test_correct_model_id_used(self, mock_boto3):
        await generate_image("test prompt")
        call_kwargs = mock_boto3["bedrock"].invoke_model.call_args
        assert call_kwargs.kwargs["modelId"] == _MODEL_ID

    @pytest.mark.asyncio
    async def test_bedrock_called_in_image_gen_region(self, monkeypatch):
        """Bedrock client must be created with IMAGE_GEN_REGION, not AWS_REGION."""
        captured = {}
        bedrock_mock = _make_bedrock_mock()
        s3_mock = _make_s3_mock()

        def fake_client(service, region_name=None, **kwargs):
            captured[service] = region_name
            if service == "bedrock-runtime":
                return bedrock_mock
            return s3_mock

        monkeypatch.setattr("src.tools.image_gen.boto3.client", fake_client)
        await generate_image("test")
        assert captured.get("bedrock-runtime") == "us-west-2"
        assert captured.get("s3") == "ap-southeast-1"

    @pytest.mark.asyncio
    async def test_prompt_truncated_to_512(self, mock_boto3):
        long_prompt = "x" * 600
        await generate_image(long_prompt)
        call_kwargs = mock_boto3["bedrock"].invoke_model.call_args
        body = json.loads(call_kwargs.kwargs["body"])
        assert len(body["prompt"]) <= 512

    @pytest.mark.asyncio
    async def test_style_appended_to_prompt(self, mock_boto3):
        await generate_image("a logo", style="flat icon")
        call_kwargs = mock_boto3["bedrock"].invoke_model.call_args
        body = json.loads(call_kwargs.kwargs["body"])
        assert "flat icon" in body["prompt"]

    @pytest.mark.asyncio
    async def test_no_style_prompt_clean(self, mock_boto3):
        await generate_image("a logo")
        call_kwargs = mock_boto3["bedrock"].invoke_model.call_args
        body = json.loads(call_kwargs.kwargs["body"])
        assert body["prompt"] == "a logo"

    @pytest.mark.asyncio
    async def test_s3_upload_uses_correct_bucket(self, mock_boto3):
        await generate_image("test")
        put_call = mock_boto3["s3"].put_object.call_args
        assert put_call.kwargs["Bucket"] == "test-bucket"

    @pytest.mark.asyncio
    async def test_s3_key_under_media_generated(self, mock_boto3):
        await generate_image("test")
        put_call = mock_boto3["s3"].put_object.call_args
        key = put_call.kwargs["Key"]
        assert key.startswith("media/generated/")
        assert key.endswith(".png")

    @pytest.mark.asyncio
    async def test_presigned_url_24h_expiry(self, mock_boto3):
        await generate_image("test")
        presign_call = mock_boto3["s3"].generate_presigned_url.call_args
        assert presign_call.kwargs.get("ExpiresIn") == 86400

    @pytest.mark.asyncio
    async def test_request_body_has_required_fields(self, mock_boto3):
        await generate_image("a sunset")
        body = json.loads(mock_boto3["bedrock"].invoke_model.call_args.kwargs["body"])
        assert body["output_format"] == "png"
        assert body["mode"] == "text-to-image"
        assert "prompt" in body


class TestGenerateImageErrorHandling:
    @pytest.mark.asyncio
    async def test_no_bucket_returns_unavailable(self, monkeypatch):
        monkeypatch.setenv("DATA_BUCKET", "")
        result = await generate_image("test")
        assert "unavailable" in result.lower() or "not configured" in result.lower()

    @pytest.mark.asyncio
    async def test_access_denied_returns_friendly_message(self, monkeypatch):
        exc = Exception("AccessDeniedException: User is not authorized")
        bedrock_mock = _make_bedrock_mock(raise_exc=exc)
        s3_mock = _make_s3_mock()
        import src.tools.image_gen as _mod
        import types as _types
        monkeypatch.setattr(_mod, "boto3", _types.SimpleNamespace(
            client=lambda s, region_name=None, **k: bedrock_mock if s == "bedrock-runtime" else s3_mock
        ))
        result = await generate_image("test")
        assert "not enabled" in result.lower() or "access" in result.lower()

    @pytest.mark.asyncio
    async def test_resource_not_found_returns_friendly_message(self, monkeypatch):
        exc = Exception("ResourceNotFoundException: Model not found")
        bedrock_mock = _make_bedrock_mock(raise_exc=exc)
        s3_mock = _make_s3_mock()
        import src.tools.image_gen as _mod
        import types as _types
        monkeypatch.setattr(_mod, "boto3", _types.SimpleNamespace(
            client=lambda s, region_name=None, **k: bedrock_mock if s == "bedrock-runtime" else s3_mock
        ))
        result = await generate_image("test")
        assert "unavailable" in result.lower() or "not found" in result.lower() or "check" in result.lower()

    @pytest.mark.asyncio
    async def test_empty_images_list_returns_error(self):
        """Bedrock returning images:[] must produce a user-visible error, not an IMAGE_URL."""
        from unittest.mock import patch
        import src.tools.image_gen as _mod
        bedrock_mock = _make_bedrock_mock(images=[])
        s3_mock = _make_s3_mock()
        with patch.object(_mod, "boto3") as mock_b3:
            mock_b3.client.side_effect = lambda s, region_name=None, **k: (
                bedrock_mock if s == "bedrock-runtime" else s3_mock
            )
            result = await generate_image("test")
        assert "no output" in result.lower() or "try again" in result.lower(), (
            f"Expected error message for empty images, got: {result!r}"
        )

    @pytest.mark.asyncio
    async def test_generic_exception_returns_generic_message(self, monkeypatch):
        exc = Exception("SomeUnknownError: network blip")
        bedrock_mock = _make_bedrock_mock(raise_exc=exc)
        s3_mock = _make_s3_mock()
        import src.tools.image_gen as _mod
        import types as _types
        monkeypatch.setattr(_mod, "boto3", _types.SimpleNamespace(
            client=lambda s, region_name=None, **k: bedrock_mock if s == "bedrock-runtime" else s3_mock
        ))
        result = await generate_image("test")
        # Must not leak raw exception text to user
        assert "SomeUnknownError" not in result
        assert "failed" in result.lower() or "sorry" in result.lower()


class TestImageGenDefaults:
    def test_default_region_is_us_west_2(self):
        assert _DEFAULT_IMAGE_GEN_REGION == "us-west-2"

    def test_model_id_is_stable_image_core(self):
        assert "stable-image-core" in _MODEL_ID

    def test_model_id_is_not_nova_canvas(self):
        assert "nova-canvas" not in _MODEL_ID
