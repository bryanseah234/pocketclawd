"""
Tools module — all Bedrock tool definitions and dispatch table.
"""
from __future__ import annotations

import logging
from typing import Any

from .web_search import WEB_SEARCH_TOOL, search_web
from .weather import WEATHER_TOOL, get_weather
from .currency import CURRENCY_TOOL, convert_currency
from .news import NEWS_TOOL, get_news
from .wikipedia import WIKIPEDIA_TOOL, search_wikipedia
from .stack_exchange import STACK_EXCHANGE_TOOL, search_stackoverflow
from .arxiv import ARXIV_TOOL, search_arxiv
from .crypto import CRYPTO_TOOL, get_crypto_price
from .stocks import STOCKS_TOOL, get_stock_price
from .sg_weather import SG_WEATHER_TOOL, get_sg_weather
from .sg_psi import SG_PSI_TOOL, get_sg_psi
from .sg_4d import SG_4D_TOOL, get_sg_lottery
from .maps import MAPS_TOOL, find_place
from .routing import ROUTING_TOOL, get_directions
from .timezone import TIMEZONE_TOOL, get_timezone
from .iss import ISS_TOOL, get_iss_location
from .image_gen import IMAGE_GEN_TOOL, generate_image
from .tts import TTS_TOOL, text_to_speech
from .fetch_url import FETCH_URL_TOOL, fetch_url

logger = logging.getLogger(__name__)

TOOL_DEFINITIONS = [
    WEB_SEARCH_TOOL,
    WEATHER_TOOL,
    CURRENCY_TOOL,
    NEWS_TOOL,
    WIKIPEDIA_TOOL,
    STACK_EXCHANGE_TOOL,
    ARXIV_TOOL,
    CRYPTO_TOOL,
    STOCKS_TOOL,
    SG_WEATHER_TOOL,
    SG_PSI_TOOL,
    SG_4D_TOOL,
    MAPS_TOOL,
    ROUTING_TOOL,
    TIMEZONE_TOOL,
    ISS_TOOL,
    IMAGE_GEN_TOOL,
    TTS_TOOL,
    FETCH_URL_TOOL,
]

# Map tool names to async callables
_DISPATCH: dict[str, Any] = {
    "web_search": search_web,
    "get_weather": get_weather,
    "convert_currency": convert_currency,
    "get_news": get_news,
    "search_wikipedia": search_wikipedia,
    "search_stackoverflow": search_stackoverflow,
    "search_arxiv": search_arxiv,
    "get_crypto_price": get_crypto_price,
    "get_stock_price": get_stock_price,
    "get_sg_weather": get_sg_weather,
    "get_sg_psi": get_sg_psi,
    "get_sg_lottery": get_sg_lottery,
    "find_place": find_place,
    "get_directions": get_directions,
    "get_timezone": get_timezone,
    "get_iss_location": get_iss_location,
    "generate_image": generate_image,
    "text_to_speech": text_to_speech,
    "fetch_url": fetch_url,
}


async def dispatch_tool(name: str, tool_input: dict) -> str:
    """Execute a tool by name with given inputs. Returns string result."""
    fn = _DISPATCH.get(name)
    if not fn:
        logger.warning("Unknown tool: %s", name)
        return f"Unknown tool: {name}"
    try:
        result = await fn(**tool_input)
        return str(result)
    except Exception as e:
        logger.error("Tool %s failed: %s", name, e, exc_info=True)
        return f"Tool error ({name}): {str(e)[:200]}"
