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


async def find_place(query: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(
            f"https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 3, "countrycodes": "sg", "addressdetails": 1},
            headers={"User-Agent": "NanoClaw/1.0"}
        )
        results = resp.json()
        if not results:
            # Retry without country restriction
            resp2 = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 3, "addressdetails": 1},
                headers={"User-Agent": "NanoClaw/1.0"}
            )
            results = resp2.json()

    if not results:
        return f"Could not find \"{query}\" on the map."

    lines = []
    for r in results[:3]:
        name = r.get("display_name", "")[:120]
        lat, lon = r.get("lat"), r.get("lon")
        maps_url = f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"
        lines.append(f"• {name}\n  {maps_url}")
    return "\n\n".join(lines)
