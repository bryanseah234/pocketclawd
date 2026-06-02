"""Routing and directions via OSRM (keyless)."""
import urllib.parse
import httpx

ROUTING_TOOL = {
    "toolSpec": {
        "name": "get_directions",
        "description": "Get driving time and distance between two places.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "from_place": {"type": "string"},
                    "to_place": {"type": "string"},
                    "mode": {"type": "string", "description": "driving, walking, or cycling", "default": "driving"},
                },
                "required": ["from_place", "to_place"],
            }
        },
    }
}


async def _geocode(place: str, client: httpx.AsyncClient) -> tuple[float, float] | None:
    resp = await client.get(
        "https://nominatim.openstreetmap.org/search",
        params={"q": place, "format": "json", "limit": 1},
        headers={"User-Agent": "NanoClaw/1.0"}
    )
    results = resp.json()
    if not results:
        return None
    return float(results[0]["lon"]), float(results[0]["lat"])


async def get_directions(from_place: str, to_place: str, mode: str = "driving") -> str:
    async with httpx.AsyncClient(timeout=10.0) as client:
        from_coords = await _geocode(from_place, client)
        to_coords = await _geocode(to_place, client)
        if not from_coords:
            return f"Could not find \"{from_place}\"."
        if not to_coords:
            return f"Could not find \"{to_place}\"."

        profile = {"driving": "driving", "walking": "foot", "cycling": "bike"}.get(mode, "driving")
        url = f"http://router.project-osrm.org/route/v1/{profile}/{from_coords[0]},{from_coords[1]};{to_coords[0]},{to_coords[1]}"
        resp = await client.get(url, params={"overview": "false"})
        data = resp.json()
        routes = data.get("routes", [])
        if not routes:
            return "Could not find a route."

        dist_km = routes[0]["distance"] / 1000
        # OSRM duration is network-optimised and unrealistic for human travel.
        # Override with real-world average speeds:
        #   cycling: 15 km/h (leisure rider on PCN/road mix)
        #   walking: 5 km/h
        #   driving: use OSRM (road network is accurate)
        if mode == "cycling":
            duration_min = (dist_km / 15.0) * 60  # 15 km/h leisure cycling
            speed_note = "at ~15 km/h leisure pace"
        elif mode == "walking":
            duration_min = (dist_km / 5.0) * 60   # 5 km/h walking
            speed_note = "at ~5 km/h walking pace"
        else:
            duration_min = routes[0]["duration"] / 60
            speed_note = ""
        time_str = f"{int(duration_min)} min" if duration_min < 90 else f"{duration_min/60:.1f} hr"
        note = f" ({speed_note})" if speed_note else ""
        return (
            f"*{from_place}* to *{to_place}*\n"
            f"{dist_km:.1f} km | ~{time_str} {mode}{note}"
        )
