"""
News headlines via RSS (keyless, no API key required).

All feeds verified working from AWS EC2 ap-southeast-1 (3.0.132.150).
Reuters / AP / CNBC block AWS IPs — not included.
"""
import html as html_module
import re
import xml.etree.ElementTree as ET
try:
    from lxml import etree as _lxml_etree
    _LXML = True
except ImportError:
    _LXML = False
import httpx
import logging

logger = logging.getLogger(__name__)

# Verified working from AWS EC2 ap-southeast-1 as of 2026-06-01
RSS_FEEDS = {
    # Singapore
    "cna":        ("CNA",              "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml"),
    "st":         ("Straits Times",    "https://www.straitstimes.com/news/singapore/rss.xml"),
    "mothership": ("Mothership",       "https://mothership.sg/feed/"),
    # Global
    "bbc":        ("BBC World",        "https://feeds.bbci.co.uk/news/world/rss.xml"),
    "guardian":   ("The Guardian",     "https://www.theguardian.com/world/rss"),
    "nyt":        ("New York Times",   "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    # Business/Tech
    "bbc_biz":    ("BBC Business",     "https://feeds.bbci.co.uk/news/business/rss.xml"),
    "guardian_tech": ("Guardian Tech", "https://www.theguardian.com/technology/rss"),
}

# Alias map so the LLM can use natural names
_ALIASES = {
    "sg": "cna", "singapore": "cna",
    "world": "bbc", "global": "bbc", "international": "guardian",
    "business": "bbc_biz", "finance": "bbc_biz", "economy": "bbc_biz",
    "tech": "guardian_tech", "technology": "guardian_tech",
    "local": "cna", "ms": "mothership",
}

NEWS_TOOL = {
    "toolSpec": {
        "name": "get_news",
        "description": (
            "Get latest news headlines, optionally filtered by topic keyword. "
            "Sources: cna (Singapore), bbc (global), guardian, nyt, st, mothership, "
            "bbc_biz (business), guardian_tech. "
            "Default source: cna. Always include the source name in your response."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "Optional keyword filter (e.g. 'Singapore', 'AI', 'economy')",
                    },
                    "source": {
                        "type": "string",
                        "description": (
                            "Feed key: cna, bbc, guardian, nyt, st, mothership, "
                            "bbc_biz, guardian_tech. "
                            "Aliases: sg, world, business, tech, local. Default: cna."
                        ),
                        "default": "cna",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Number of headlines (default 5, max 10)",
                        "default": 5,
                    },
                },
            }
        },
    }
}


def _clean(text: str) -> str:
    """Strip HTML tags and decode entities."""
    text = html_module.unescape(text)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()


async def get_news(topic: str = "", source: str = "cna", limit: int = 5) -> str:
    key = _ALIASES.get(source.lower(), source.lower())
    feed_name, feed_url = RSS_FEEDS.get(key, RSS_FEEDS["cna"])
    limit = min(max(1, int(limit)), 10)

    # Mothership uses Cloudflare which blocks bot UAs -- use browser UA for it
    _browser_ua = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    )
    _ua = _browser_ua if key == "mothership" else "NanoClaw/1.0 (+https://clawd.app)"
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            resp = await client.get(
                feed_url,
                headers={"User-Agent": _ua},
            )
            resp.raise_for_status()
            if _LXML:
                # lxml recovery mode handles malformed XML (bare &, invalid tokens)
                _parser = _lxml_etree.XMLParser(recover=True, encoding="utf-8")
                _lxml_root = _lxml_etree.fromstring(resp.content, _parser)
                # Convert to stdlib ET for uniform downstream processing
                root = ET.fromstring(_lxml_etree.tostring(_lxml_root, encoding="unicode"))
            else:
                root = ET.fromstring(resp.text)
        except Exception as e:
            logger.warning("RSS fetch failed for %s: %s", feed_name, e)
            return f"Could not fetch {feed_name} headlines right now — try again shortly."

    items = root.findall(".//item")
    results = []
    for item in items:
        title = _clean(item.findtext("title") or "")
        desc  = _clean(item.findtext("description") or "")[:140]
        link  = (item.findtext("link") or "").strip()
        if not title:
            continue
        if topic and topic.lower() not in (title + " " + desc).lower():
            continue
        line = f"• *{title}*"
        if desc and desc.lower() != title.lower():
            line += f"\n  {desc}"
        results.append(line)
        if len(results) >= limit:
            break

    if not results:
        msg = f"No {feed_name} headlines"
        if topic:
            msg += f' about "{topic}"' 
        return msg + ". Try a different source or topic."

    header = f"*{feed_name} Headlines*"
    if topic:
        header += f' — "{topic}"' 
    return header + "\n\n" + "\n\n".join(results)
