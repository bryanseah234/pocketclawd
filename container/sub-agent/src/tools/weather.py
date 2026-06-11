"""Weather via Open-Meteo (keyless)."""
import httpx
import logging

logger = logging.getLogger(__name__)

WMO_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    95: "Thunderstorm", 96: "Thunderstorm+hail", 99: "Thunderstorm+heavy hail",
}

WEATHER_TOOL = {
    "toolSpec": {
        "name": "get_weather",
        "description": (
            "Get current weather and 3-day forecast for a location. "
            "ALWAYS ask the user to specify a city or place -- never assume a default."
        ),
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "City or place name (e.g. Singapore, Tokyo, Jurong East)"
                    }
                },
                "required": ["location"],
            }
        },
    }
}


async def get_weather(location: str) -> str:
    async with httpx.AsyncClient(timeout=8.0) as client:
        # Geocode
        geo = await client.get(
            f"https://geocoding-api.open-meteo.com/v1/search",
            params={"name": location, "count": 1, "language": "en", "format": "json"}
        )
        geo_data = geo.json().get("results", [])
        if not geo_data:
            return f"Could not find a location called \"{location}\". Try a city name."
        place = geo_data[0]
        lat, lon = place["latitude"], place["longitude"]
        name = place.get("name", location)
        country = place.get("country", "")

        # Forecast
        fc = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code",
                "timezone": "auto",
                "forecast_days": 3,
            }
        )
        data = fc.json()
        cur = data.get("current", {})
        daily = data.get("daily", {})

        temp = cur.get("temperature_2m", "?")
        feels = cur.get("apparent_temperature", "?")
        code = cur.get("weather_code", 0)
        wind = cur.get("wind_speed_10m", "?")
        humidity = cur.get("relative_humidity_2m", "?")
        condition = WMO_CODES.get(code, "Unknown")

        lines = [f"*{name}, {country}* -- {condition}"]
        lines.append(f"{temp}°C (feels {feels}°C) | Humidity {humidity}% | Wind {wind} km/h")

        # 3-day forecast
        dates = daily.get("time", [])
        max_t = daily.get("temperature_2m_max", [])
        min_t = daily.get("temperature_2m_min", [])
        precip = daily.get("precipitation_sum", [])
        d_codes = daily.get("weather_code", [])
        if dates:
            lines.append("")
            for i in range(min(3, len(dates))):
                day_cond = WMO_CODES.get(d_codes[i] if i < len(d_codes) else 0, "")
                rain = f"{precip[i]:.0f}mm rain" if i < len(precip) and precip[i] > 0 else "no rain"
                hi = max_t[i] if i < len(max_t) else "?"
                lo = min_t[i] if i < len(min_t) else "?"
                lines.append(f"{dates[i]}: {lo}-{hi}°C, {day_cond}, {rain}")

        return "\n".join(lines)
