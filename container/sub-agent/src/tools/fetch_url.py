"""
URL fetch and content extraction.

Extraction priority:
  1. Jina Reader (r.jina.ai) -- renders JS, returns clean markdown, keyless, free
  2. trafilatura + httpx       -- fast for plain HTML/news sites
  3. BeautifulSoup fallback   -- last resort tag-strip

Handles JS-heavy SPAs, paywalled content hints, and anti-bot redirects gracefully.
"""
import logging
import re
import urllib.parse
import httpx

logger = logging.getLogger(__name__)

FETCH_URL_TOOL = {
    "toolSpec": {
        "name": "fetch_url",
        "description": (
            "Fetch and read the content of any URL — news articles, webpages, "
            "documentation, JavaScript-heavy sites, social media, e-commerce, dashboards. "
            "Use whenever the user shares a link or you need to read a specific page. "
            "Handles JavaScript-rendered sites automatically."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL including https://"},
                    "extract_mode": {
                        "type": "string",
                        "enum": ["auto", "article", "full"],
                        "description": "auto=smart extract (default), article=news/blog focused, full=all page text",
                        "default": "auto",
                    },
                },
                "required": ["url"],
            }
        },
    }
}

# Headers that look like a real browser
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
}

_JINA_HEADERS = {
    "Accept": "text/markdown,text/plain,*/*;q=0.8",
    "X-Return-Format": "markdown",
    "X-Timeout": "20",
    # Ask Jina to include links for reference
    "X-With-Links-Summary": "true",
}


async def fetch_url(url: str, extract_mode: str = "auto") -> str:
    """Fetch URL content with JS rendering support via Jina Reader."""
    url = url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    async with httpx.AsyncClient(
        timeout=25.0,
        follow_redirects=True,
        limits=httpx.Limits(max_connections=5),
    ) as client:

        # ── 1. Jina Reader (handles JS, cleans markdown) ──────────────────────
        jina_result = await _fetch_via_jina(client, url)
        if jina_result and len(jina_result.strip()) > 100:
            return jina_result

        # ── 2. Direct httpx + trafilatura ─────────────────────────────────────
        traf_result = await _fetch_via_trafilatura(client, url, extract_mode)
        if traf_result and len(traf_result.strip()) > 100:
            return traf_result

        # ── 3. BeautifulSoup tag-strip ────────────────────────────────────────
        bs_result = await _fetch_via_bs(client, url)
        if bs_result and len(bs_result.strip()) > 50:
            return bs_result

    return (
        f"Could not extract content from {url}.\n"
        "The site may block automated access, require login, or be temporarily unavailable."
    )


async def _fetch_via_jina(client: httpx.AsyncClient, url: str) -> str | None:
    """Jina Reader: r.jina.ai/{url} -- JS rendering, clean markdown output."""
    try:
        encoded = urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%")
        jina_url = f"https://r.jina.ai/{encoded}"
        resp = await client.get(jina_url, headers=_JINA_HEADERS, timeout=22.0)

        if resp.status_code == 200:
            text = resp.text.strip()
            # Jina prefixes with "Title: ..." and "URL: ..." lines
            if text and "Error:" not in text[:100]:
                # Truncate to reasonable size
                return _truncate(text, 4000)

        logger.debug("Jina Reader returned %d for %s", resp.status_code, url)
    except Exception as e:
        logger.debug("Jina Reader failed for %s: %s", url, e)
    return None


async def _fetch_via_trafilatura(
    client: httpx.AsyncClient, url: str, extract_mode: str
) -> str | None:
    """Direct fetch + trafilatura for plain HTML news/blog sites."""
    try:
        resp = await client.get(url, headers=_BROWSER_HEADERS, timeout=12.0)
        if resp.status_code not in (200, 203):
            return None
        html = resp.text

        # Detect JS-only shells early (save trafilatura the effort)
        body_text = re.sub(r"<[^>]+>", " ", html)
        body_text = re.sub(r"\s+", " ", body_text).strip()
        if len(body_text) < 200:
            logger.debug("Likely JS-only shell for %s (body_text=%d chars)", url, len(body_text))
            return None

        try:
            import trafilatura
            favour_recall = (extract_mode == "full")
            text = trafilatura.extract(
                html,
                include_comments=False,
                include_tables=True,
                favour_recall=favour_recall,
                no_fallback=False,
            )
            if text:
                meta = trafilatura.extract_metadata(html)
                title = meta.title if meta and meta.title else _parse_title(html) or url
                return _truncate(f"*{title}*\n{url}\n\n{text}", 4000)
        except ImportError:
            pass

    except Exception as e:
        logger.debug("trafilatura path failed for %s: %s", url, e)
    return None


async def _fetch_via_bs(client: httpx.AsyncClient, url: str) -> str | None:
    """BeautifulSoup fallback: strip scripts/styles, get visible text."""
    try:
        resp = await client.get(url, headers=_BROWSER_HEADERS, timeout=10.0)
        if resp.status_code not in (200, 203):
            return None
        html = resp.text
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "lxml")
            for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe"]):
                tag.decompose()
            title = soup.title.string.strip() if soup.title else url
            text = soup.get_text(separator=" ", strip=True)
            text = re.sub(r"\s{2,}", " ", text)
            return _truncate(f"*{title}*\n{url}\n\n{text}", 4000)
        except ImportError:
            # Pure regex fallback
            text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            title = _parse_title(html) or url
            return _truncate(f"*{title}*\n{url}\n\n{text}", 4000)
    except Exception as e:
        logger.debug("BS fallback failed for %s: %s", url, e)
    return None


def _parse_title(html: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n[... content truncated at {max_chars} chars]"
