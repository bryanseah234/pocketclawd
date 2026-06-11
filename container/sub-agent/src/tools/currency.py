"""Currency conversion via frankfurter.app (keyless, daily rates)."""
import httpx

CURRENCY_TOOL = {
    "toolSpec": {
        "name": "convert_currency",
        "description": "Convert between currencies using live rates. E.g. 100 USD to SGD.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "amount": {"type": "number"},
                    "from_currency": {"type": "string", "description": "3-letter code e.g. USD"},
                    "to_currency": {"type": "string", "description": "3-letter code e.g. SGD"},
                },
                "required": ["amount", "from_currency", "to_currency"],
            }
        },
    }
}


async def convert_currency(amount: float, from_currency: str, to_currency: str) -> str:
    fc = from_currency.upper()
    tc = to_currency.upper()
    async with httpx.AsyncClient(timeout=6.0) as client:
        # Primary: open.er-api.com (free, no key, reliable from AWS)
        try:
            resp = await client.get(
                f"https://open.er-api.com/v6/latest/{fc}", timeout=6.0
            )
            if resp.status_code == 200:
                er = resp.json()
                if er.get("result") == "success":
                    rate = er.get("rates", {}).get(tc)
                    if rate:
                        converted = amount * rate
                        date = er.get("time_last_update_utc", "")[:16]
                        return f"{amount:,.2f} {fc} = *{converted:,.2f} {tc}* (rate: {date})"
        except Exception:
            pass

        # Fallback: frankfurter.dev (newer endpoint, replaces frankfurter.app)
        try:
            resp2 = await client.get(
                "https://api.frankfurter.dev/v1/latest",
                params={"base": fc, "symbols": tc}, timeout=6.0
            )
            if resp2.status_code == 200:
                data = resp2.json()
                converted = data.get("rates", {}).get(tc)
                if converted:
                    date = data.get("date", "today")
                    result = amount * converted
                    return f"{amount:,.2f} {fc} = *{result:,.2f} {tc}* (rate from {date})"
        except Exception:
            pass

        return f"Could not get rate for {fc} -> {tc}."
