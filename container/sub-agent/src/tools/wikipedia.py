"""Wikipedia lookup (keyless)."""
import urllib.parse
import httpx

WIKIPEDIA_TOOL = {
    "toolSpec": {
        "name": "search_wikipedia",
        "description": "Look up encyclopaedic facts, history, definitions. Good for general knowledge questions.",
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


async def search_wikipedia(query: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    async with httpx.AsyncClient(timeout=8.0) as client:
        # Search for the page
        search = await client.get(
            "https://en.wikipedia.org/w/api.php",
            params={
                "action": "query", "list": "search", "srsearch": query,
                "srlimit": 1, "format": "json"
            }
        )
        results = search.json().get("query", {}).get("search", [])
        if not results:
            return f"No Wikipedia article found for \"{query}\"."
        title = results[0]["title"]

        # Get summary
        summary = await client.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{urllib.parse.quote(title)}"
        )
        data = summary.json()
        extract = data.get("extract", "")[:600]
        url = data.get("content_urls", {}).get("desktop", {}).get("page", "")
        return f"*{title}*\n{extract}\n{url}"
