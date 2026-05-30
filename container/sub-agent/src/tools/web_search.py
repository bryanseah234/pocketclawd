"""
Web search -- multi-source, keyless, no API keys required.

Source priority:
  1. DuckDuckGo HTML scrape       -- reliable, no rate limit for reasonable use
  2. SearXNG public instances     -- open-source metasearch (rotates instances)
  3. Brave Search API (keyless)   -- public endpoint, good results
  4. DDG Instant Answer API       -- good for factual/entity queries

After getting URLs, optionally auto-fetch the top result via Jina Reader
for richer context (controlled by fetch_top_result param).
"""
import asyncio
import html as html_module
import json
import logging
import re
import urllib.parse
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

# SearXNG public instances (try in order)
_SEARXNG_INSTANCES = [
    "https://searx.be",
    "https://search.inetol.net",
    "https://search.privacyguides.net",
    "https://paulgo.io",
    "https://searx.tiekoetter.com",
]

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

        # Run DDG HTML + SearXNG concurrently for speed
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
    """Run multiple search sources concurrently, return first non-empty result."""
    tasks = [
        _ddg_html(client, encoded, n),
        _searxng(client, encoded, n),
    ]
    # Fire all, return first good result
    results_list = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results_list:
        if isinstance(r, list) and r:
            return r
    # Fallback: DDG Instant
    instant = await _ddg_instant(client, encoded)
    if instant:
        return instant
    return []


async def _ddg_html(client: httpx.AsyncClient, encoded: str, n: int) -> list[dict]:
    """DuckDuckGo HTML endpoint -- most reliable, no key needed."""
    try:
        resp = await client.post(
            "https://html.duckduckgo.com/html/",
            data={"q": urllib.parse.unquote_plus(encoded), "b": "", "kl": "us-en"},
            headers={
                "User-Agent": _UA,
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": "https://duckduckgo.com/",
            },
            timeout=10.0,
        )
        if resp.status_code != 200:
            return []

        # Parse result blocks
        results = []
        # DDG HTML uses class="result__a" for titles and result__url for URLs
        # and result__snippet for snippets
        title_pattern = re.compile(
            r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL
        )
        snippet_pattern = re.compile(
            r'class="result__snippet"[^>]*>(.*?)</a>', re.DOTALL
        )
        # Also extract result URLs (DDG wraps in redirect)
        url_pattern = re.compile(r'class="result__url"[^>]*>(.*?)</span>', re.DOTALL)

        titles = title_pattern.findall(resp.text)
        snippets = snippet_pattern.findall(resp.text)
        url_texts = url_pattern.findall(resp.text)

        for i, (href, title_html) in enumerate(titles[:n]):
            title = html_module.unescape(re.sub(r"<[^>]+>", "", title_html)).strip()
            snippet = ""
            if i < len(snippets):
                snippet = html_module.unescape(
                    re.sub(r"<[^>]+>", "", snippets[i])
                ).strip()
            # Extract real URL (DDG wraps in /l/?uddg=...)
            real_url = href
            if "uddg=" in href:
                m = re.search(r"uddg=([^&]+)", href)
                if m:
                    real_url = urllib.parse.unquote(m.group(1))
            elif i < len(url_texts):
                url_text = html_module.unescape(
                    re.sub(r"<[^>]+>", "", url_texts[i])
                ).strip()
                if url_text and not url_text.startswith("/"):
                    real_url = "https://" + url_text if not url_text.startswith("http") else url_text

            if title and real_url:
                results.append({"title": title, "url": real_url, "snippet": snippet})

        return results
    except Exception as e:
        logger.debug("DDG HTML search failed: %s", e)
        return []


async def _searxng(client: httpx.AsyncClient, encoded: str, n: int) -> list[dict]:
    """SearXNG metasearch -- rotates through public instances."""
    for instance in _SEARXNG_INSTANCES:
        try:
            url = f"{instance}/search?q={encoded}&format=json&language=en&safesearch=0&categories=general"
            resp = await client.get(url, timeout=7.0)
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("results", [])[:n]
                if items:
                    return [
                        {
                            "title": r.get("title", ""),
                            "url": r.get("url", ""),
                            "snippet": r.get("content", r.get("snippet", ""))[:250],
                        }
                        for r in items
                        if r.get("url")
                    ]
        except Exception as e:
            logger.debug("SearXNG %s failed: %s", instance, e)
    return []


async def _ddg_instant(client: httpx.AsyncClient, encoded: str) -> list[dict]:
    """DuckDuckGo Instant Answer API -- good for factual/entity queries."""
    try:
        url = f"https://api.duckduckgo.com/?q={encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1"
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
        snippet = r.get("snippet", "").strip()
        lines.append(f"{i}. {title}")
        if url:
            lines.append(f"   {url}")
        if snippet:
            lines.append(f"   {snippet}")
        lines.append("")
    lines.append(
        "Tip: use fetch_url on any of the above links to read the full page content."
    )
    return "\n".join(lines)
