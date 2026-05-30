"""Crypto prices via CoinGecko (keyless)."""
import httpx

CRYPTO_TOOL = {
    "toolSpec": {
        "name": "get_crypto_price",
        "description": "Get live cryptocurrency prices. E.g. BTC, ETH, SOL.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "coin": {"type": "string", "description": "Coin symbol or name (e.g. BTC, ethereum, solana)"},
                    "currency": {"type": "string", "description": "Currency to display in (default: usd)", "default": "usd"},
                },
                "required": ["coin"],
            }
        },
    }
}

COIN_IDS = {
    "btc": "bitcoin", "eth": "ethereum", "sol": "solana", "bnb": "binancecoin",
    "xrp": "ripple", "ada": "cardano", "doge": "dogecoin", "avax": "avalanche-2",
    "dot": "polkadot", "matic": "matic-network", "link": "chainlink",
}


async def get_crypto_price(coin: str, currency: str = "usd") -> str:
    coin_id = COIN_IDS.get(coin.lower(), coin.lower())
    cur = currency.lower()
    async with httpx.AsyncClient(timeout=6.0) as client:
        resp = await client.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin_id, "vs_currencies": cur, "include_24hr_change": "true"},
            headers={"User-Agent": "NanoClaw/1.0"}
        )
        data = resp.json()
        if coin_id not in data:
            return f"Could not find price for \"{coin}\". Try the full name (e.g. bitcoin, ethereum)."
        price = data[coin_id][cur]
        change = data[coin_id].get(f"{cur}_24h_change", 0)
        arrow = "↑" if change >= 0 else "↓"
        return f"*{coin.upper()}* {price:,.2f} {cur.upper()} {arrow} {abs(change):.1f}% (24h)"
