"""
Document management slash commands for the NanoClaw sub-agent.
Handles /list, /delete, /help, /privacy commands.
"""
import json
import logging
import uuid as uuid_mod

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
RESPONSE_TIMEOUT = 10


async def _dg_request(redis: Redis, user_id: str, payload: dict) -> dict | None:
    """Send a request to the data-gateway worker and await the response."""
    request_id = str(uuid_mod.uuid4())
    payload["userId"] = user_id
    payload["requestId"] = request_id
    response_key = f"queue:agent:{user_id}:dg_response:{request_id}"
    await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(payload))
    result = await redis.blpop(response_key, timeout=RESPONSE_TIMEOUT)
    if not result:
        return None
    _, raw = result
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


async def handle_list_documents(redis: Redis, user_id: str) -> str:
    """List all documents uploaded for this user."""
    resp = await _dg_request(redis, user_id, {"action": "list_files"})
    if resp is None:
        return "⚠️ Could not retrieve document list (timeout). Please try again."
    if not resp.get("success"):
        return f"⚠️ Error listing documents: {resp.get('error', 'unknown error')}"
    files: list[str] = resp.get("files", [])
    if not files:
        return "No documents found."
    lines = ["📄 *Your documents:*"]
    for i, name in enumerate(files, 1):
        lines.append(f"  {i}. {name}")
    lines.append("\nUse /delete <filename> to remove a document.")
    return "\n".join(lines)


async def handle_delete_document(redis: Redis, user_id: str, filename: str) -> str:
    """Delete a document by filename for this user."""
    if not filename.strip():
        return "Usage: /delete <filename>\nExample: /delete report.pdf"
    resp = await _dg_request(redis, user_id, {"action": "delete_file", "filename": filename.strip()})
    if resp is None:
        return "⚠️ Could not complete deletion (timeout). Please try again."
    if not resp.get("success"):
        return f"⚠️ Error deleting '{filename}': {resp.get('error', 'unknown error')}"
    return f"✅ '{filename}' has been deleted."


HELP_TEXT = """*Available commands:*

/list — Show your uploaded documents
/delete <filename> — Delete a document
/privacy — Privacy policy and data rights
/help — Show this help message

*Tips:*
• Upload documents via the admin portal
• Ask questions about your documents naturally
• Type /list to see what's available"""

PRIVACY_TEXT = """*Privacy & Data Rights*

Your data is protected under PDPA.

• All messages are stored to provide personalised responses
• You can request a full export of your data at any time
• To withdraw consent and delete all data, type *withdraw consent*
• For questions, contact your administrator

Your consent was recorded when you first used this service."""


async def handle_command(redis: Redis, user_id: str, content: str) -> str | None:
    """
    Returns a response string if content is a slash command, else None.
    """
    stripped = content.strip()
    if not stripped.startswith("/"):
        return None

    parts = stripped.split(None, 1)
    cmd = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""

    if cmd == "/list":
        return await handle_list_documents(redis, user_id)
    if cmd == "/delete":
        return await handle_delete_document(redis, user_id, arg)
    if cmd == "/help":
        return HELP_TEXT
    if cmd == "/privacy":
        return PRIVACY_TEXT
    return f"Unknown command: {cmd}\nType /help for available commands."
