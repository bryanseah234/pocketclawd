"""Stack Overflow / Stack Exchange Q&A lookup (keyless)."""
import urllib.parse
import httpx

STACK_EXCHANGE_TOOL = {
    "toolSpec": {
        "name": "search_stackoverflow",
        "description": "Search Stack Overflow for programming and technical questions.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"}
                },
                "required": ["query"],
            }
        },
    }
}


async def search_stackoverflow(query: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(
            "https://api.stackexchange.com/2.3/search/advanced",
            params={
                "order": "desc", "sort": "relevance", "q": query,
                "site": "stackoverflow", "pagesize": 3, "filter": "withbody",
                "accepted": "True",
            }
        )
        items = resp.json().get("items", [])
        if not items:
            return f"No Stack Overflow results for \"{query}\"."
        lines = []
        for item in items[:3]:
            title = item.get("title", "")
            link = item.get("link", "")
            score = item.get("score", 0)
            lines.append(f"• [{title}]({link}) (score: {score})")
        return "*Stack Overflow:*\n" + "\n".join(lines)
