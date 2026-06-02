"""Tests for web_search tool.

Mocks httpx.AsyncClient -- no real network calls.
Validates Google News RSS parsing, DDG Instant fallback, error handling.
"""
import asyncio
import pytest
import xml.etree.ElementTree as ET
from unittest.mock import AsyncMock, MagicMock, patch

from src.tools.web_search import (
    search_web,
    _google_news_rss,
    _ddg_instant,
    _format_results,
)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def _make_rss(items: list[dict]) -> str:
    """Build a minimal Google News RSS XML string."""
    item_xml = ""
    for it in items:
        src = f'<source url="">{it.get("source","CNA")}</source>' if "source" in it else ""
        item_xml += (
            f"<item>"
            f"<title>{it['title']}</title>"
            f"<link>{it['link']}</link>"
            f"{src}"
            f"</item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<rss version="2.0"><channel>' + item_xml + '</channel></rss>'
    )


def _mock_response(status: int, text: str = "", json_data: dict | None = None):
    resp = MagicMock()
    resp.status_code = status
    resp.text = text
    if json_data is not None:
        resp.json = MagicMock(return_value=json_data)
    return resp


def _make_client(responses: dict):
    """responses: {url_substr: mock_response}"""
    client = MagicMock()

    async def fake_get(url, **kwargs):
        for substr, resp in responses.items():
            if substr in url:
                return resp
        return _mock_response(404)

    client.get = fake_get
    return client


# ── _google_news_rss ──────────────────────────────────────────────────────────

class TestGoogleNewsRss:
    @pytest.mark.asyncio
    async def test_returns_results_on_200(self):
        rss = _make_rss([
            {"title": "Singapore Budget 2026 announced - CNA", "link": "https://cna.asia/1", "source": "CNA"},
            {"title": "F1 Monaco GP: Verstappen wins - BBC Sport", "link": "https://bbc.com/2", "source": "BBC Sport"},
        ])
        client = _make_client({"news.google.com": _mock_response(200, rss)})
        results = await _google_news_rss(client, "singapore+news", 5)
        assert len(results) == 2

    @pytest.mark.asyncio
    async def test_strips_source_suffix_from_title(self):
        rss = _make_rss([{"title": "Budget 2026 announced - CNA", "link": "https://cna.asia/1", "source": "CNA"}])
        client = _make_client({"news.google.com": _mock_response(200, rss)})
        results = await _google_news_rss(client, "budget", 5)
        assert results[0]["title"] == "Budget 2026 announced"

    @pytest.mark.asyncio
    async def test_snippet_shows_source(self):
        rss = _make_rss([{"title": "Test article - Reuters", "link": "https://reuters.com/1", "source": "Reuters"}])
        client = _make_client({"news.google.com": _mock_response(200, rss)})
        results = await _google_news_rss(client, "test", 5)
        assert "Reuters" in results[0]["snippet"]

    @pytest.mark.asyncio
    async def test_returns_empty_on_non_200(self):
        client = _make_client({"news.google.com": _mock_response(429)})
        results = await _google_news_rss(client, "test", 5)
        assert results == []

    @pytest.mark.asyncio
    async def test_respects_n_limit(self):
        rss = _make_rss([{"title": f"Article {i} - Src", "link": f"https://example.com/{i}", "source": "Src"}
                          for i in range(10)])
        client = _make_client({"news.google.com": _mock_response(200, rss)})
        results = await _google_news_rss(client, "test", 3)
        assert len(results) == 3

    @pytest.mark.asyncio
    async def test_returns_empty_on_network_exception(self):
        client = MagicMock()
        client.get = AsyncMock(side_effect=Exception("connection refused"))
        results = await _google_news_rss(client, "test", 5)
        assert results == []

    @pytest.mark.asyncio
    async def test_returns_empty_on_malformed_xml(self):
        client = _make_client({"news.google.com": _mock_response(200, "<not valid xml>><<")})
        results = await _google_news_rss(client, "test", 5)
        assert results == []

    @pytest.mark.asyncio
    async def test_skips_items_missing_title_or_link(self):
        # One valid, one missing link
        rss = (
            '<?xml version="1.0"?><rss version="2.0"><channel>'
            '<item><title>Good article</title><link>https://good.com/1</link></item>'
            '<item><title>No link article</title></item>'
            '</channel></rss>'
        )
        client = _make_client({"news.google.com": _mock_response(200, rss)})
        results = await _google_news_rss(client, "test", 5)
        assert len(results) == 1
        assert results[0]["title"] == "Good article"


# ── _ddg_instant ──────────────────────────────────────────────────────────────

class TestDdgInstant:
    @pytest.mark.asyncio
    async def test_returns_abstract_when_present(self):
        client = _make_client({"api.duckduckgo.com": _mock_response(200, json_data={
            "AbstractText": "Singapore is a city-state in Southeast Asia.",
            "Heading": "Singapore",
            "AbstractURL": "https://en.wikipedia.org/wiki/Singapore",
            "RelatedTopics": [],
        })})
        results = await _ddg_instant(client, "singapore")
        assert len(results) == 1
        assert "Singapore" in results[0]["snippet"]

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_abstract(self):
        client = _make_client({"api.duckduckgo.com": _mock_response(200, json_data={
            "AbstractText": "",
            "RelatedTopics": [],
        })})
        results = await _ddg_instant(client, "gibberish query xyz")
        assert results == []

    @pytest.mark.asyncio
    async def test_returns_empty_on_non_200(self):
        client = _make_client({"api.duckduckgo.com": _mock_response(503)})
        results = await _ddg_instant(client, "test")
        assert results == []

    @pytest.mark.asyncio
    async def test_returns_empty_on_exception(self):
        client = MagicMock()
        client.get = AsyncMock(side_effect=Exception("timeout"))
        results = await _ddg_instant(client, "test")
        assert results == []


# ── search_web integration ────────────────────────────────────────────────────

class TestSearchWeb:
    @pytest.mark.asyncio
    async def test_returns_formatted_string_on_success(self):
        rss = _make_rss([{"title": "Big news today - CNA", "link": "https://cna.asia/1", "source": "CNA"}])
        with patch("src.tools.web_search.httpx.AsyncClient") as MockClient:
            inst = MagicMock()
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            inst.get = AsyncMock(return_value=_mock_response(200, rss))
            MockClient.return_value = inst
            result = await search_web("singapore news today")
        assert "Big news today" in result
        assert "cna.asia" in result

    @pytest.mark.asyncio
    async def test_returns_no_results_message_when_all_fail(self):
        with patch("src.tools.web_search.httpx.AsyncClient") as MockClient:
            inst = MagicMock()
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            inst.get = AsyncMock(return_value=_mock_response(429))
            MockClient.return_value = inst
            result = await search_web("some query")
        assert "No results" in result

    @pytest.mark.asyncio
    async def test_num_results_capped_at_10(self):
        rss = _make_rss([{"title": f"Article {i} - Src", "link": f"https://x.com/{i}", "source": "Src"}
                          for i in range(20)])
        with patch("src.tools.web_search.httpx.AsyncClient") as MockClient:
            inst = MagicMock()
            inst.__aenter__ = AsyncMock(return_value=inst)
            inst.__aexit__ = AsyncMock(return_value=False)
            inst.get = AsyncMock(return_value=_mock_response(200, rss))
            MockClient.return_value = inst
            result = await search_web("test", num_results=50)
        # Count result lines — each result has a number prefix "N. "
        import re
        count = len(re.findall(r"^\d+\. ", result, re.MULTILINE))
        assert count <= 10

    def test_format_results_includes_tip(self):
        results = [{"title": "T", "url": "https://x.com", "snippet": "S"}]
        out = _format_results(results, "query")
        assert "fetch_url" in out

    def test_format_results_empty_list(self):
        out = _format_results([], "query")
        assert "fetch_url" in out  # tip still appended


# ── regression: DDG/Brave no longer present ──────────────────────────────────

class TestRemovedSources:
    def test_ddg_html_not_importable(self):
        """_ddg_html was removed -- importing it should fail."""
        try:
            from src.tools.web_search import _ddg_html  # noqa
            assert False, "_ddg_html should not exist"
        except ImportError:
            pass

    def test_brave_search_not_importable(self):
        """_brave_search was removed -- importing it should fail."""
        try:
            from src.tools.web_search import _brave_search  # noqa
            assert False, "_brave_search should not exist"
        except ImportError:
            pass
