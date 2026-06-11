"""Maps and geocoding via OpenStreetMap Nominatim (keyless)."""
import urllib.parse
import httpx

MAPS_TOOL = {
    "toolSpec": {
        "name": "find_place",
        "description": "Find a location, address, or type of place nearby. E.g. nearest 7-Eleven to Orchard, coffee near Jurong East.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "What to search for, including context (e.g. 7-Eleven near Tampines)"},
                },
                "required": ["query"],
            }
        },
    }
}


import re as _re_maps


def _normalize_map_query(query: str) -> str:
    """Nominatim does not understand natural-language proximity phrases.
    Strip them so "7-Eleven near Orchard MRT" -> "7-Eleven Orchard"
    and "nearest coffee to Tampines" -> "coffee Tampines".
    """
    q = query.strip()
    # Remove leading "nearest" / "find me a" / "where is the"
    q = _re_maps.sub(r"^(?:find\s+me\s+(?:a|an)?|where\s+is\s+(?:the)?|nearest)\s*", "", q, flags=_re_maps.I).strip()
    # Replace "near X" / "nearest to X" / "close to X" -> X (put location after name)
    q = _re_maps.sub(r"\s+(?:near(?:est)?\s+to|near|close\s+to|next\s+to|in)\s+", " ", q, flags=_re_maps.I)
    return q.strip()


async def find_place(query: str) -> str:
    clean_query = _normalize_map_query(query)
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": clean_query, "format": "json", "limit": 5, "countrycodes": "sg", "addressdetails": 1},
            headers={"User-Agent": "NanoClaw/1.0"}
        )
        results = resp.json()
        if not results and clean_query != query:
            # Retry with original query as fallback
            resp2 = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 5, "addressdetails": 1},
                headers={"User-Agent": "NanoClaw/1.0"}
            )
            results = resp2.json()
        if not results:
            # Final fallback: drop country restriction
            resp3 = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": clean_query, "format": "json", "limit": 5, "addressdetails": 1},
                headers={"User-Agent": "NanoClaw/1.0"}
            )
            results = resp3.json()

    if not results:
        return f"Could not find \"{query}\" on the map."

    lines = []
    for r in results[:3]:
        name = r.get("display_name", "")[:120]
        lat, lon = r.get("lat"), r.get("lon")
        maps_url = f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"
        lines.append(f"• {name}\n  {maps_url}")
    return "\n\n".join(lines)
