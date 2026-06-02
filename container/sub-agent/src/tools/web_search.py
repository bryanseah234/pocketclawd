"""
Web search -- multi-source, keyless, no API keys required.

Source priority (all verified working from AWS ap-southeast-1 EC2/ECS):
  1. Google News RSS  -- 100 fresh items, always 200, real XML, no key
  2. DDG Instant API  -- good for entity/fact queries (abstracts only)
  Both are tried concurrently; first non-empty set wins.

Confirmed broken from AWS ASN (do not re-add without a proxy):
  - DuckDuckGo HTML/Lite POST  --> 202 CAPTCHA challenge, zero results
  - Brave Search HTML scrape   --> 429 rate-limited / ASN block
  - SearXNG public instances   --> 403/429 across all instances
"""
import asyncio
import html as html_module
import json
import logging
import re
import urllib.parse
import xml.etree.ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

WEB_SEARCH_TOOL = {
    "toolSpec": {
        "name": "web_search",
        "description": (
            "Search the live web for current news, events, prices, facts, or anything "
            "that may have changed after your training data. "
            "Use whenever the user asks about recent events, current prices, live data, "
            "or when your knowledge may be outdated. "
            "After getting search results, use fetch_url on promising links for full content."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query. Be specific. Use quotes for exact phrases.",
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "Number of results (default 5, max 10)",
                        "default": 5,
                    },
                },
                "required": ["query"],
            }
        },
    }
}

_DDG_JSON_URL = "https://api.duckduckgo.com/"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


async def search_web(query: str, num_results: int = 5) -> str:
    """Multi-source web search, returns formatted result list."""
    num_results = min(max(1, int(num_results)), 10)
    encoded = urllib.parse.quote_plus(query)

    async with httpx.AsyncClient(
        timeout=12.0,
        follow_redirects=True,
        headers={"User-Agent": _UA},
    ) as client:
        results = await _search_concurrent(client, query, encoded, num_results)
        if results:
            return _format_results(results, query)

    return (
        f'No results found for "{query}". '
        "Try rephrasing or breaking the query into simpler parts."
    )


async def _search_concurrent(
    client: httpx.AsyncClient, query: str, encoded: str, n: int
) -> list[dict]:
    """Run Google News RSS + DDG Instant concurrently, return first non-empty result."""
    tasks = [
        _google_news_rss(client, encoded, n),
        _ddg_instant(client, encoded),
    ]
    results_list = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results_list:
        if isinstance(r, list) and r:
            return r
    return []


async def _google_news_rss(
    client: httpx.AsyncClient, encoded: str, n: int
) -> list[dict]:
    """Google News RSS search -- verified working from AWS EC2/ECS, no key needed.

    Returns up to n items with title, link, and source name.
    Note: links are Google redirect URLs (articles/...) -- fetch_url handles them.
    """
    try:
        url = (
            f"https://news.google.com/rss/search"
            f"?q={encoded}&hl=en-SG&gl=SG&ceid=SG:en"
        )
        resp = await client.get(url, timeout=10.0)
        if resp.status_code != 200:
            logger.debug("Google News RSS returned %s", resp.status_code)
            return []

        root = ET.fromstring(resp.text)
        items = root.findall(".//item")
        results = []
        for item in items[:n]:
            title_el = item.find("title")
            link_el = item.find("link")
            source_el = item.find("source")
            if title_el is None or link_el is None:
                continue
            title = (title_el.text or "").strip()
            # Strip " - Source Name" suffix that Google appends
            source_name = source_el.text.strip() if source_el is not None and source_el.text else ""
            if source_name and title.endswith(f" - {source_name}"):
                title = title[: -len(f" - {source_name}")].strip()
            link = (link_el.text or "").strip()
            # Use the source url attribute as the clean publisher URL.
            # The <link> in Google News RSS is a redirect that can't be resolved
            # server-side; source.url is the publisher homepage (e.g. channelnewsasia.com).
            source_url = source_el.get("url", "") if source_el is not None else ""
            clean_url = source_url or link  # fall back to google link if no source url
            if title and link:
                results.append({
                    "title": title,
                    "url": clean_url,
                    "google_url": link,  # kept so fetch_url can still access the article
                    "snippet": "",
                    "source": source_name,
                })
        return results
    except Exception as e:
        logger.debug("Google News RSS failed: %s", e)
        return []




async def _ddg_instant(client: httpx.AsyncClient, encoded: str) -> list[dict]:
    """DuckDuckGo Instant Answer API -- good for factual/entity queries."""
    try:
        url = (
            f"https://api.duckduckgo.com/"
            f"?q={encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1"
        )
        resp = await client.get(url, timeout=8.0)
        if resp.status_code != 200:
            return []
        data = resp.json()
        results = []
        if data.get("AbstractText"):
            results.append({
                "title": data.get("Heading", ""),
                "url": data.get("AbstractURL", ""),
                "snippet": data["AbstractText"][:300],
            })
        for rt in data.get("RelatedTopics", [])[:4]:
            if isinstance(rt, dict) and rt.get("Text") and rt.get("FirstURL"):
                results.append({
                    "title": rt.get("Text", "")[:80],
                    "url": rt["FirstURL"],
                    "snippet": rt.get("Text", "")[:200],
                })
        return results
    except Exception as e:
        logger.debug("DDG Instant failed: %s", e)
        return []


def _format_results(results: list[dict], query: str) -> str:
    lines = [f'Search results for: "{query}"\n']
    for i, r in enumerate(results, 1):
        title = r.get("title", "").strip()
        url = r.get("url", "").strip()
        source = r.get("source", "").strip()
        snippet = r.get("snippet", "").strip()
        # Clean snippet: strip "Source: X" if we now have a proper source field
        if source and snippet == f"Source: {source}":
            snippet = ""
        lines.append(f"{i}. {title}")
        if url:
            lines.append(f"   URL: {url}")
        if source:
            lines.append(f"   Source: {source}")
        # Include the Google fetch URL so the model can call fetch_url for full article
        google_url = r.get("google_url", "").strip()
        if google_url and google_url != url:
            lines.append(f"   Fetch: {google_url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")
    lines.append(
        "Tip: use fetch_url on any of the above links to read the full page content."
    )
    return "\n".join(lines)
