"""F1 (Wave 9): tests for the Bedrock vision describer."""
import os
from unittest.mock import patch, MagicMock
import pytest


def test_provider_default_is_bedrock(monkeypatch):
    monkeypatch.delenv("CLAWD_VISION_PROVIDER", raising=False)
    from src.vision.bedrock_vision import _provider
    assert _provider() == "bedrock"


def test_provider_respects_env(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "TESSERACT")
    from src.vision.bedrock_vision import _provider
    assert _provider() == "tesseract"


def test_describe_image_uses_tesseract_when_configured(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "tesseract")

    fake_image = MagicMock()
    fake_pil = MagicMock()
    fake_pil.__enter__ = MagicMock(return_value=fake_image)
    fake_pil.__exit__ = MagicMock(return_value=False)

    with patch("PIL.Image.open", return_value=fake_pil):
        with patch("pytesseract.image_to_string", return_value="hello world"):
            from src.vision.bedrock_vision import describe_image
            result = describe_image(b"fake image")

    assert result == "hello world"


def test_describe_image_calls_bedrock_when_configured(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "bedrock")
    monkeypatch.setenv("AWS_REGION", "ap-southeast-1")

    mock_resp_body = MagicMock()
    mock_resp_body.read.return_value = b'{"content":[{"type":"text","text":"TEXT:\\nhi\\n\\nDESCRIPTION:\\nA test."}]}'
    mock_client = MagicMock()
    mock_client.invoke_model.return_value = {"body": mock_resp_body}

    with patch("boto3.client", return_value=mock_client):
        from src.vision.bedrock_vision import describe_image
        result = describe_image(b"\xff\xd8\xff\xe0")

    assert "TEXT" in result
    assert "DESCRIPTION" in result
    mock_client.invoke_model.assert_called_once()
    # Verify the model id and that the body contains image base64 data
    call_kwargs = mock_client.invoke_model.call_args.kwargs
    assert "modelId" in call_kwargs
    body_str = call_kwargs["body"].decode("utf-8")
    assert "image" in body_str
    assert "base64" in body_str


def test_describe_image_auto_falls_back_to_tesseract(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "auto")

    with patch("src.vision.bedrock_vision.describe_with_bedrock", side_effect=RuntimeError("AWS down")):
        fake_image = MagicMock()
        fake_pil = MagicMock()
        fake_pil.__enter__ = MagicMock(return_value=fake_image)
        fake_pil.__exit__ = MagicMock(return_value=False)
        with patch("PIL.Image.open", return_value=fake_pil):
            with patch("pytesseract.image_to_string", return_value="ocr fallback"):
                from src.vision.bedrock_vision import describe_image
                result = describe_image(b"fake image")
    assert result == "ocr fallback"


def test_describe_image_bedrock_provider_propagates_errors(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "bedrock")

    with patch("src.vision.bedrock_vision.describe_with_bedrock", side_effect=RuntimeError("boom")):
        from src.vision.bedrock_vision import describe_image
        with pytest.raises(RuntimeError, match="boom"):
            describe_image(b"fake image")


def test_describe_image_auto_returns_empty_when_both_fail(monkeypatch):
    monkeypatch.setenv("CLAWD_VISION_PROVIDER", "auto")

    with patch("src.vision.bedrock_vision.describe_with_bedrock", side_effect=RuntimeError("AWS down")):
        with patch("PIL.Image.open", side_effect=RuntimeError("PIL broken")):
            from src.vision.bedrock_vision import describe_image
            result = describe_image(b"fake image")
    assert result == ""
