"""Singapore Pools 4D/TOTO results (scrape, keyless)."""
import httpx
import re

SG_4D_TOOL = {
    "toolSpec": {
        "name": "get_sg_lottery",
        "description": "Get Singapore Pools 4D or TOTO latest results.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "game": {"type": "string", "description": "4d or toto", "enum": ["4d", "toto"]},
                },
                "required": ["game"],
            }
        },
    }
}


async def get_sg_lottery(game: str = "4d") -> str:
    game = game.lower()
    url = "https://www.singaporepools.com.sg/en/product/sr/Pages/4d_results.aspx" if game == "4d" else           "https://www.singaporepools.com.sg/en/product/sr/Pages/toto_results.aspx"
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        try:
            resp = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
            html = resp.text
        except Exception as e:
            return f"Could not fetch Singapore Pools results: {e}"

    if game == "4d":
        # Extract draw date
        date_m = re.search(r"Draw No\.?\s*[\d,]+\s*/\s*([\w\s,]+20\d\d)", html)
        date_str = date_m.group(1).strip() if date_m else ""
        # Extract 1st/2nd/3rd prize
        prizes = re.findall(r"(?:1st|2nd|3rd)\s+Prize.*?(\d{4})", html, re.DOTALL)
        if prizes:
            return f"*4D Results* {date_str}\n1st: {prizes[0] if len(prizes)>0 else '?'} | 2nd: {prizes[1] if len(prizes)>1 else '?'} | 3rd: {prizes[2] if len(prizes)>2 else '?'}"
        return "Could not parse 4D results. Check singaporepools.com.sg directly."
    else:
        # TOTO
        nums = re.findall(r"(?:Winning Numbers?|TOTO).*?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})", html, re.DOTALL)
        if nums:
            winning = " - ".join(nums[0])
            return f"*TOTO Winning Numbers:* {winning}"
        return "Could not parse TOTO results. Check singaporepools.com.sg directly."
