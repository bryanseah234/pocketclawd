"""
Tests for url_ingestion: URL extraction, safety filter, silent failure.
"""
import asyncio
import pytest

from src.url_ingestion import extract_urls, _is_safe, _doc_id_for


def test_extract_urls_finds_http_and_https():
    text = "check this out https://example.com/foo and also http://news.ycombinator.com"
    urls = extract_urls(text)
    assert "https://example.com/foo" in urls
    assert "http://news.ycombinator.com" in urls


def test_extract_urls_strips_trailing_punctuation():
    text = "see https://example.com/page."
    urls = extract_urls(text)
    assert urls == ["https://example.com/page"]


def test_extract_urls_dedupes():
    text = "https://x.com https://x.com https://x.com"
    assert extract_urls(text) == ["https://x.com"]


def test_extract_urls_empty_input():
    assert extract_urls("") == []
    assert extract_urls("hello world no urls") == []


def test_is_safe_blocks_localhost_and_private_ips():
    assert _is_safe("http://localhost/foo") is False
    assert _is_safe("http://127.0.0.1/foo") is False
    assert _is_safe("http://10.0.0.1/foo") is False
    assert _is_safe("http://192.168.1.1/foo") is False
    assert _is_safe("http://169.254.169.254/latest/meta-data/") is False
    assert _is_safe("file:///etc/passwd") is False
    assert _is_safe("ftp://example.com/") is False


def test_is_safe_allows_public_https():
    assert _is_safe("https://example.com/article") is True
    assert _is_safe("http://news.ycombinator.com/item?id=1") is True


def test_doc_id_is_stable_and_short():
    a = _doc_id_for("https://example.com/foo")
    b = _doc_id_for("https://example.com/foo")
    assert a == b
    assert a.startswith("url-")
    assert len(a) == len("url-") + 16


def test_doc_id_differs_for_different_urls():
    a = _doc_id_for("https://example.com/foo")
    b = _doc_id_for("https://example.com/bar")
    assert a != b


def test_extract_urls_ignores_bare_words_with_dots():
    text = "no urls here just a sentence with periods. and more. text."
    assert extract_urls(text) == []


def test_extract_urls_handles_query_strings_and_fragments():
    text = "page is at https://example.com/path?q=1&r=2#section"
    urls = extract_urls(text)
    assert urls == ["https://example.com/path?q=1&r=2#section"]
