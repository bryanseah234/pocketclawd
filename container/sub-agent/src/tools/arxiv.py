"""arXiv paper search (keyless)."""
import urllib.parse
import xml.etree.ElementTree as ET
import httpx

ARXIV_TOOL = {
    "toolSpec": {
        "name": "search_arxiv",
        "description": "Search arXiv for academic papers on any research topic.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "max_results": {"type": "integer", "default": 3},
                },
                "required": ["query"],
            }
        },
    }
}


async def search_arxiv(query: str, max_results: int = 3) -> str:
    encoded = urllib.parse.quote_plus(query)
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(
            f"http://export.arxiv.org/api/query?search_query=all:{encoded}&start=0&max_results={max_results}"
        )
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(resp.text)
    entries = root.findall("atom:entry", ns)
    if not entries:
        return f"No arXiv papers found for \"{query}\"."
    lines = []
    for e in entries:
        title = (e.findtext("atom:title", namespaces=ns) or "").strip()
        summary = (e.findtext("atom:summary", namespaces=ns) or "").strip()[:150]
        link = e.find("atom:id", ns)
        url = link.text if link is not None else ""
        lines.append(f"• *{title}*\n  {summary}\n  {url}")
    return "*arXiv results:*\n\n" + "\n\n".join(lines)
