"""Stock/SGX prices via Yahoo Finance (keyless)."""
import httpx

STOCKS_TOOL = {
    "toolSpec": {
        "name": "get_stock_price",
        "description": "Get current stock price. For SGX stocks add .SI suffix (e.g. D05.SI for DBS). US stocks: AAPL, TSLA, etc.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string", "description": "Stock ticker symbol (e.g. AAPL, D05.SI, U11.SI)"},
                },
                "required": ["ticker"],
            }
        },
    }
}


async def get_stock_price(ticker: str) -> str:
    symbol = ticker.upper()
    async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
        resp = await client.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
            params={"interval": "1d", "range": "1d"},
            headers={"User-Agent": "Mozilla/5.0"}
        )
        data = resp.json()
        meta = data.get("chart", {}).get("result", [{}])[0].get("meta", {})
        price = meta.get("regularMarketPrice")
        prev = meta.get("previousClose")
        currency = meta.get("currency", "")
        name = meta.get("shortName", symbol)
        if not price:
            return f"Could not fetch price for {symbol}."
        change = price - prev if prev else 0
        pct = (change / prev * 100) if prev else 0
        arrow = "↑" if change >= 0 else "↓"
        return f"*{name}* ({symbol})\n{price:,.2f} {currency} {arrow} {abs(change):.2f} ({abs(pct):.1f}%)"
