"""News headlines via RSS (keyless)."""
import xml.etree.ElementTree as ET
import httpx
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

RSS_FEEDS = {
    "cna": ("CNA", "https://www.channelnewsasia.com/rss/8395884"),
    "bbc": ("BBC", "https://feeds.bbci.co.uk/news/rss.xml"),
    "st": ("Straits Times", "https://www.straitstimes.com/news/singapore/rss.xml"),
}

NEWS_TOOL = {
    "toolSpec": {
        "name": "get_news",
        "description": (
            "Get latest news headlines. Optionally filter by topic keyword. "
            "Sources: CNA, BBC, Straits Times."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string", "description": "Optional topic to filter by (e.g. Singapore, economy, tech)"},
                    "source": {"type": "string", "description": "Optional: cna, bbc, or st. Defaults to cna."},
                },
            }
        },
    }
}


async def get_news(topic: str = "", source: str = "cna") -> str:
    feed_name, feed_url = RSS_FEEDS.get(source.lower(), RSS_FEEDS["cna"])
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
        try:
            resp = await client.get(feed_url, headers={"User-Agent": "NanoClaw/1.0"})
            root = ET.fromstring(resp.text)
        except Exception as e:
            return f"Could not fetch {feed_name} headlines: {e}"

    items = root.findall(".//item")
    results = []
    for item in items:
        title = (item.findtext("title") or "").strip()
        desc = (item.findtext("description") or "").strip()[:120]
        pub = item.findtext("pubDate") or ""
        if topic and topic.lower() not in (title + desc).lower():
            continue
        results.append(f"• *{title}*\n  {desc}")
        if len(results) >= 5:
            break

    if not results:
        return f"No {feed_name} headlines found" + (f" about \"{topic}\"" if topic else "") + "."

    header = f"*{feed_name} Headlines*" + (f" -- \"{topic}\"" if topic else "")
    return header + "\n\n" + "\n\n".join(results)
