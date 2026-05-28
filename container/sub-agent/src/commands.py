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


HELP_TEXT = """*Clawd — Available commands*

📄 *Documents*
/list — Show your uploaded documents
/delete <filename> — Delete a document

🔗 *URL ingestion*
/ingested — Last 20 URLs Clawd has indexed for you
/forget-url <url> — Remove a URL from your knowledge base

👤 *Your profile*
/profile — Show or edit how Clawd talks to you
/forget — Delete ALL your data (PDPA right of erasure)

ℹ️ *About*
/about — What Clawd is and what it can do
/privacy — Privacy policy and data rights
/help — Show this help message

*Tips*
• Upload documents via the admin portal
• Ask questions about your documents naturally
• Send a photo and Clawd will read + remember it
• Send a URL and Clawd will index the page"""


async def handle_forget(redis: Redis, user_id: str) -> str:
    """
    PDPA right-of-erasure: delete every record we hold for this user.
    Triggers a single delete_user_documents request which the DataGateway
    fans out across DynamoDB chat history, OpenSearch chunks, and S3 prefix.
    Best-effort — returns a confirmation regardless of the gateway result so
    the user always sees a reply (the DG audit log still records the request).
    """
    resp = await _dg_request(redis, user_id, {"action": "delete_user_documents"})
    if resp and resp.get("success"):
        return (
            "✅ All your data has been deleted — chats, documents, and embeddings.\n"
            "If you message me again I'll start fresh and re-ask for consent."
        )
    return (
        "⚠️ Deletion request sent but the gateway did not confirm immediately. "
        "Your data will still be removed in the next sweep — contact admin if "
        "you don't see this take effect within an hour."
    )

PRIVACY_TEXT = """*Privacy & Data Rights*

Your data is protected under PDPA.

• All messages are stored to provide personalised responses
• You can request a full export of your data at any time
• To withdraw consent and delete all data, type *withdraw consent*
• For questions, contact your administrator

Your consent was recorded when you first used this service."""


ABOUT_TEXT = """*Clawd — Your personal life assistant*

I help you remember what matters: documents you upload, photos you send, URLs you share, and the conversations we have. Everything stays private under PDPA.

*What I can do*
• Read & summarise PDFs, docs, photos
• Remember conversations across days
• Ingest URLs you send and answer questions about them
• Maintain a personal knowledge base only you can access

*What I won\'t do*
• Share your data with anyone
• Use your conversations to train models
• Hold data after you /forget

Send /help to see commands. Just chat naturally otherwise — slash commands are optional."""


async def handle_profile(redis: Redis, user_id: str, arg: str) -> str:
    """
    /profile — show current preferences. Optional arg parses simple
    'depth=detailed' / 'depth=high-level' / 'domain=frontend|infrastructure|data'
    edits and writes them back via put_user_preference.
    """
    from src.persona.preference_probe import probe_user_preferences

    if not arg.strip():
        ctx = await probe_user_preferences(redis, user_id)
        if ctx.is_new_user:
            return (
                "*Your profile*\n"
                "No preferences saved yet. Chat with me a bit and I\'ll learn how you like things.\n\n"
                "Or set them directly:\n"
                "  /profile depth=detailed\n"
                "  /profile depth=high-level\n"
                "  /profile domain=frontend\n"
                "  /profile domain=infrastructure\n"
                "  /profile domain=data"
            )
        depth = ctx.technical_depth or "(unset)"
        domain = ctx.primary_domain or "(unset)"
        return (
            "*Your profile*\n"
            f"• Technical depth: {depth}\n"
            f"• Primary domain: {domain}\n\n"
            "Edit with `/profile depth=...` or `/profile domain=...`"
        )

    parts = arg.split("=", 1)
    if len(parts) != 2:
        return (
            "Usage:\n"
            "  /profile depth=detailed\n"
            "  /profile domain=frontend"
        )
    key = parts[0].strip().lower()
    value = parts[1].strip().lower()

    valid_depth = {"detailed", "high-level"}
    valid_domain = {"frontend", "infrastructure", "data"}

    update: dict[str, str] = {}
    if key in ("depth", "technical_depth"):
        if value not in valid_depth:
            return f"depth must be one of: {', '.join(sorted(valid_depth))}"
        update["technical_depth"] = value
    elif key in ("domain", "primary_domain"):
        if value not in valid_domain:
            return f"domain must be one of: {', '.join(sorted(valid_domain))}"
        update["primary_domain"] = value
    else:
        return "Only `depth` and `domain` can be edited via /profile."

    ctx = await probe_user_preferences(redis, user_id)
    payload_prefs = {
        "technical_depth": update.get("technical_depth", ctx.technical_depth),
        "primary_domain": update.get("primary_domain", ctx.primary_domain),
        "discoveryCompleted": True,
    }

    request_id = uuid_mod.uuid4().hex
    request = {
        "action": "put_user_preference",
        "user_id": user_id,
        "request_id": request_id,
        "preferences": payload_prefs,
    }
    try:
        await redis.lpush(DATA_GATEWAY_QUEUE, json.dumps(request))
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to enqueue /profile update for user_id=%s: %s", user_id, exc)
        return "⚠️ Could not save your profile change right now — try again."

    return f"✅ Updated: {key}={value}"


async def handle_ingested(redis: Redis, user_id: str) -> str:
    """/ingested — last 20 URLs Clawd has indexed for this user."""
    resp = await _dg_request(redis, user_id, {"action": "list_ingested_urls", "limit": 20})
    if resp is None:
        return "⚠️ Could not fetch ingested URLs (timeout). Try again."
    if not resp.get("success"):
        err = resp.get("error", "")
        if "unknown action" in err.lower() or "unsupported" in err.lower():
            return (
                "URL ingestion history isn\'t surfaced yet — coming soon.\n"
                "For now, send `/forget` to wipe everything if needed."
            )
        return f"⚠️ {err or 'unknown error'}"
    urls = resp.get("urls", [])
    if not urls:
        return "No URLs ingested yet. Send me a link and I\'ll index it."
    lines = ["*Recently ingested URLs*"]
    for i, u in enumerate(urls, 1):
        title = u.get("title") or u.get("url", "")
        url = u.get("url", "")
        lines.append(f"  {i}. {title}\n     {url}")
    lines.append("\n`/forget-url <url>` to remove a specific one.")
    return "\n".join(lines)


async def handle_forget_url(redis: Redis, user_id: str, arg: str) -> str:
    """/forget-url <url> — remove a single URL from the knowledge base."""
    url = arg.strip()
    if not url:
        return "Usage: /forget-url <url>"
    resp = await _dg_request(redis, user_id, {"action": "delete_ingested_url", "url": url})
    if resp is None:
        return "⚠️ Could not complete the request (timeout). Try again."
    if not resp.get("success"):
        err = resp.get("error", "")
        if "unknown action" in err.lower() or "unsupported" in err.lower():
            return (
                "Per-URL deletion isn\'t wired yet — coming soon.\n"
                "Use `/forget` to wipe everything for now."
            )
        return f"⚠️ {err or 'unknown error'}"
    return f"✅ Removed: {url}"


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
    if cmd == "/forget":
        return await handle_forget(redis, user_id)
    if cmd == "/about":
        return ABOUT_TEXT
    if cmd == "/profile":
        return await handle_profile(redis, user_id, arg)
    if cmd == "/ingested":
        return await handle_ingested(redis, user_id)
    if cmd == "/forget-url":
        return await handle_forget_url(redis, user_id, arg)
    return f"Unknown command: {cmd}\nType /help for available commands."
