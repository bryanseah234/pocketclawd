"""Singapore PSI/haze via data.gov.sg (keyless)."""
import httpx

SG_PSI_TOOL = {
    "toolSpec": {
        "name": "get_sg_psi",
        "description": "Get Singapore PSI (Pollutant Standards Index) and PM2.5 levels. Use for haze queries.",
        "inputSchema": {"json": {"type": "object", "properties": {}}},
    }
}

PSI_LEVELS = [
    (50, "Good"), (100, "Moderate"), (200, "Unhealthy"), (300, "Very Unhealthy"), (999, "Hazardous")
]


def _psi_label(val: float) -> str:
    for threshold, label in PSI_LEVELS:
        if val <= threshold:
            return label
    return "Hazardous"


async def get_sg_psi() -> str:
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get("https://api-open.data.gov.sg/v2/real-time/api/psi")
        data = resp.json()
    items = data.get("data", {}).get("items", [])
    if not items:
        return "SG PSI data unavailable."
    latest = items[-1]
    readings = latest.get("readings", {})
    ts = latest.get("timestamp", "")
    psi_24 = readings.get("psi_twenty_four_hourly", {})
    pm25_24 = readings.get("pm25_twenty_four_hourly", {})
    national_psi = psi_24.get("national", psi_24.get("west", "?"))
    national_pm25 = pm25_24.get("national", pm25_24.get("west", "?"))
    label = _psi_label(float(national_psi)) if isinstance(national_psi, (int, float)) else "?"
    return (
        f"*Singapore Air Quality* ({ts[:16]})\n"
        f"PSI (24h): {national_psi} -- *{label}*\n"
        f"PM2.5 (24h): {national_pm25} μg/m³"
    )
