"""Singapore hyperlocal weather via data.gov.sg (keyless)."""
import httpx
from datetime import datetime, timezone

SG_WEATHER_TOOL = {
    "toolSpec": {
        "name": "get_sg_weather",
        "description": "Get Singapore 2-hour weather forecast by area. More accurate than Open-Meteo for SG.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "description": "SG area name (e.g. Jurong, City, Tampines). Leave empty for all areas."},
                },
            }
        },
    }
}


async def get_sg_weather(area: str = "") -> str:
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get("https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast")
        data = resp.json()
    items = data.get("data", {}).get("items", [])
    if not items:
        return "SG weather data unavailable."
    latest = items[-1]
    forecasts = latest.get("forecasts", [])
    updated = latest.get("timestamp", "")

    if area:
        area_lower = area.lower()
        matched = [f for f in forecasts if area_lower in f.get("area", "").lower()]
        if not matched:
            matched = forecasts[:5]
    else:
        matched = forecasts

    lines = [f"*SG 2-Hour Forecast* (as of {updated[:16]})"]
    for f in matched[:8]:
        lines.append(f"• {f['area']}: {f['forecast']}")
    return "\n".join(lines)
