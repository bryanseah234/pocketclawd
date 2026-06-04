"""Regression tests for the indexer staging->documents S3 move.

Context (prod incident, 2026-06): WhatsApp/Telegram uploads land at
`users/<userId>/staging/<uploadId>/<file>`. After a successful index the
indexer copies the object to the canonical documents location and deletes the
staging original. Two bugs were fixed here:

  1. The destination MUST be the bare-userId form `<userId>/documents/<file>`
     (no `users/` prefix), because that is where the admin dashboard lists
     documents (src/cloud/admin-dashboard/index.ts uses `${uid}/documents/`).

  2. CopyObject copies the source object's tags by default; the staging object
     carries `lifecycle=staging-24h`. Copying that tag (a) required
     s3:PutObjectTagging the task role lacked -> AccessDenied, and (b) would
     have made the moved doc auto-expire in 24h. The copy now uses
     TaggingDirective="REPLACE" with an empty Tagging so the moved object has
     NO lifecycle tag and is not auto-deleted.
"""

import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src import indexer


def _stub_pipeline_modules(monkeypatch):
    extractors = types.ModuleType("src.documents.extractors")
    extractors.extract_text = lambda content, ct: "some extracted text"
    extractors.is_supported = lambda ct: True
    extractors.resolve_content_type = lambda ct, fn: ct
    monkeypatch.setitem(sys.modules, "src.documents.extractors", extractors)

    emb = types.ModuleType("src.embeddings.pipeline")

    class _Pipeline:
        def __init__(self, region=None):
            pass

        async def embed_batch(self, chunks):
            return [[0.0] * 4 for _ in chunks]

    class _Splitter:
        def split_text(self, text):
            return [text]

    emb.EmbeddingPipeline = _Pipeline
    emb.RecursiveCharacterSplitter = _Splitter
    monkeypatch.setitem(sys.modules, "src.embeddings.pipeline", emb)


@pytest.mark.asyncio
async def test_staging_move_uses_bare_userid_key_and_replaces_tags(monkeypatch):
    user_id = "wa:6592348112@s.whatsapp.net"
    filename = "image-1780537939297.jpg"
    s3_key = f"users/{user_id}/staging/wa-3AA34F090D85526BB300/{filename}"
    bucket = "nanoclaw-data-709609992277"

    s3 = MagicMock()
    s3.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=b"\xff\xd8\xff fake jpeg"))}

    fake_settings = types.SimpleNamespace(aws_region="ap-southeast-1")
    monkeypatch.setattr(indexer.state, "settings", fake_settings, raising=False)
    monkeypatch.setattr(indexer.state, "redis", AsyncMock(), raising=False)
    monkeypatch.setattr(indexer, "_clear_indexing_flag", AsyncMock())
    monkeypatch.setattr(indexer, "_notify_user", AsyncMock())
    _stub_pipeline_modules(monkeypatch)

    message = {
        "userId": user_id,
        "payload": {
            "realUserId": user_id,
            "filename": filename,
            "contentType": "image/jpeg",
            "s3Key": s3_key,
            "bucket": bucket,
            "origin": "upload_worker",
            "corporate": False,
            "channelType": "whatsapp",
            "platformId": "6592348112@s.whatsapp.net",
        },
    }

    with patch("boto3.client", return_value=s3):
        await indexer.index_file(message)

    s3.copy_object.assert_called_once()
    kwargs = s3.copy_object.call_args.kwargs
    assert kwargs["Bucket"] == bucket
    assert kwargs["CopySource"] == {"Bucket": bucket, "Key": s3_key}
    assert kwargs["Key"] == f"{user_id}/documents/{filename}"  # bare userId, no users/ prefix
    assert kwargs["TaggingDirective"] == "REPLACE"
    assert kwargs["Tagging"] == ""

    s3.delete_object.assert_called_once_with(Bucket=bucket, Key=s3_key)


@pytest.mark.asyncio
async def test_no_move_for_corporate_uploads(monkeypatch):
    """Corporate uploads live under corporate/<uploadId>/ and must not be moved."""
    user_id = "CORPORATE"
    filename = "handbook.pdf"
    s3_key = "corporate/up-1/handbook.pdf"  # no /staging/ segment
    bucket = "nanoclaw-data-709609992277"

    s3 = MagicMock()
    s3.get_object.return_value = {"Body": MagicMock(read=MagicMock(return_value=b"%PDF-1.4 fake"))}

    fake_settings = types.SimpleNamespace(aws_region="ap-southeast-1")
    monkeypatch.setattr(indexer.state, "settings", fake_settings, raising=False)
    monkeypatch.setattr(indexer.state, "redis", AsyncMock(), raising=False)
    monkeypatch.setattr(indexer, "_clear_indexing_flag", AsyncMock())
    monkeypatch.setattr(indexer, "_notify_user", AsyncMock())
    _stub_pipeline_modules(monkeypatch)

    message = {
        "userId": user_id,
        "payload": {
            "realUserId": user_id,
            "filename": filename,
            "contentType": "application/pdf",
            "s3Key": s3_key,
            "bucket": bucket,
            "origin": "upload_worker",
            "corporate": True,
        },
    }

    with patch("boto3.client", return_value=s3):
        await indexer.index_file(message)

    s3.copy_object.assert_not_called()
    s3.delete_object.assert_not_called()
