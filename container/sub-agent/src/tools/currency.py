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
        data = None
        # Try frankfurter.app first
        try:
            resp = await client.get(
                "https://api.frankfurter.app/latest",
                params={"from": fc, "to": tc, "amount": amount}, timeout=6.0
            )
            if resp.status_code == 200:
                data = resp.json()
        except Exception:
            pass

        # Fallback: exchangerate-api.io (free, no key)
        if data is None or "rates" not in data:
            try:
                resp2 = await client.get(
                    f"https://open.er-api.com/v6/latest/{fc}", timeout=6.0
                )
                if resp2.status_code == 200:
                    er = resp2.json()
                    rate = er.get("rates", {}).get(tc)
                    if rate:
                        converted = amount * rate
                        return f"{amount:,.2f} {fc} = *{converted:,.2f} {tc}* (live rate)"
            except Exception:
                pass
            return f"Could not get rate for {fc} -> {tc}."
        converted = data["rates"].get(tc, "?")
        date = data.get("date", "today")
        return f"{amount:,.2f} {fc} = *{converted:,.2f} {tc}* (rate from {date})"
