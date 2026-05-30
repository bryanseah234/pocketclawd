"""ISS location via open-notify.org (keyless)."""
import httpx

ISS_TOOL = {
    "toolSpec": {
        "name": "get_iss_location",
        "description": "Get the current location of the International Space Station.",
        "inputSchema": {"json": {"type": "object", "properties": {}}},
    }
}


async def get_iss_location() -> str:
    async with httpx.AsyncClient(timeout=6.0) as client:
        resp = await client.get("http://api.open-notify.org/iss-now.json")
        data = resp.json()
    pos = data.get("iss_position", {})
    lat = pos.get("latitude", "?")
    lon = pos.get("longitude", "?")
    ts = data.get("timestamp", "")
    maps_url = f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=4/{lat}/{lon}"
    return f"*ISS Location*\nLat: {lat}, Lon: {lon}\n{maps_url}"
