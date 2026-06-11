"""Timezone lookup via timeapi.io (keyless)."""
import urllib.parse
import httpx

TIMEZONE_TOOL = {
    "toolSpec": {
        "name": "get_timezone",
        "description": "Get the current local time in any city or timezone.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "location": {"type": "string", "description": "City name or timezone (e.g. Tokyo, London, UTC+8)"},
                },
                "required": ["location"],
            }
        },
    }
}


async def get_timezone(location: str) -> str:
    async with httpx.AsyncClient(timeout=6.0) as client:
        # First try as a timezone name
        tz_map = {
            "singapore": "Asia/Singapore", "kl": "Asia/Kuala_Lumpur",
            "kuala lumpur": "Asia/Kuala_Lumpur", "tokyo": "Asia/Tokyo",
            "london": "Europe/London", "new york": "America/New_York",
            "sydney": "Australia/Sydney", "dubai": "Asia/Dubai",
            "jakarta": "Asia/Jakarta", "bangkok": "Asia/Bangkok",
        }
        tz = tz_map.get(location.lower())
        if not tz:
            tz = location.replace(" ", "_")

        encoded = urllib.parse.quote(tz)
        resp = await client.get(f"https://timeapi.io/api/time/current/zone?timeZone={encoded}")
        if resp.status_code == 200:
            data = resp.json()
            dt = data.get("dateTime", "")[:19].replace("T", " ")
            tz_name = data.get("timeZone", tz)
            day = data.get("dayOfWeek", "")
            return f"*{location}* ({tz_name})\n{day}, {dt}"
        return f"Could not get time for \"{location}\"."
