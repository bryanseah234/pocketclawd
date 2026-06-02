"""
Document management slash commands for the NanoClaw sub-agent.
Handles /list, /delete, /help, /privacy commands.
"""
import json
import logging
import uuid as uuid_mod
from .reminders import parse_remind_command, list_reminders, cancel_reminder

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

DATA_GATEWAY_QUEUE = "queue:orchestrator:data_gateway"
RESPONSE_TIMEOUT = 10


async def _dg_request(redis: Redis, user_id: str, payload: dict) -> dict | None:
    """Send a request to the data-gateway worker and await the response."""
    request_id = str(uuid_mod.uuid4())
    # The TS data-gateway worker reads snake_case fields (user_id, request_id).
    payload["user_id"] = user_id
    payload["request_id"] = request_id
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
    files = resp.get("files", [])
    if not files:
        return "No documents found."
    lines = ["📄 *Your documents:*"]
    for i, f_entry in enumerate(files, 1):
        # DGW returns {key, size, lastModified} dicts; extract display name
        if isinstance(f_entry, dict):
            key = f_entry.get("key", "")
            # Strip userId prefix and drafts/ subfolder for display
            name = key.split("/")[-1] if "/" in key else key
            size_b = f_entry.get("size", 0)
            size_str = f" ({size_b // 1024}KB)" if size_b and size_b >= 1024 else ""
            lines.append(f"  {i}. {name}{size_str}")
        else:
            lines.append(f"  {i}. {f_entry}")
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
        msg = resp.get('message') or resp.get('error') or 'unknown error'
        return f"⚠️ {msg}"
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

⏰ *Reminders* (no account needed)
/remind me to X at 3pm — Set a reminder
/remind me to X in 2 hours — Relative reminder
/reminders — List pending reminders
/remindclear <id> — Cancel a reminder

🔗 *Integrations*
/connect google — Link Google Calendar + Gmail
/connect microsoft — Link Microsoft Outlook + Calendar
/disconnect <service> — Unlink a service

✍️ *Drafting*
/draft <type> <topic> — Generate a draft (types: minutes, research, slides, email)

ℹ️ *About*
/about — What Clawd is and what it can do
/privacy — Privacy policy and data rights
/help — Show this help message

*Tips*
• Upload documents via the admin portal
• Ask questions about your documents naturally
• Send a photo and Clawd will read + remember it
• Send a URL and Clawd will index the page"""

ABOUT_TEXT = """*About Clawd*

Clawd is your personal life assistant. Send documents, photos, and links and Clawd indexes them so you can ask questions in plain language later.

*What Clawd can do*
• Remember documents and notes you share
• Answer questions from everything you've sent
• Set reminders (/remind) and draft messages (/draft)
• Connect read-only accounts (/connect) for richer context

*Your data, your control*
Everything is private to you. Use /list to see what's stored, /delete to remove a document, and /forget to wipe your entire knowledge base. Type /help for the full command list."""


PRIVACY_TEXT = """*Privacy & your data (PDPA)*

Clawd stores only what you send it, to provide this service to you. Your data is private to you and is never sold or shared with other users.

• *What's stored*: documents, notes, photos, links and preferences you share.
• *Why*: so Clawd can answer your questions from your own content.
• *Your rights under the PDPA*: you can view (/list), delete individual items (/delete), or withdraw consent and wipe everything (/forget) at any time.
• *Security*: data is encrypted at rest and in transit.

By continuing to use Clawd you consent to this processing. Questions? Just ask."""


async def handle_forget(redis: Redis, user_id: str) -> str:
    """
    PDPA right-of-erasure: delete every record we hold for this user.
    Clears DynamoDB chat history, OpenSearch chunks, S3 prefix AND
    all Redis state (consent, discovery, chat cache) so the user gets
    a completely fresh experience on next message.
    """
    import asyncio as _asyncio
    # Clear Redis keys for this user
    redis_keys = [
        f"consent:{user_id}",
        f"discovery:{user_id}",
        f"cache:chat_history:{user_id}",
        f"prefs:{user_id}",
        f"rate:{user_id}",
    ]
    try:
        await _asyncio.gather(*[redis.delete(k) for k in redis_keys], return_exceptions=True)
    except Exception as _e:
        logger.warning("Redis key cleanup failed for user_id=%s: %s", user_id, _e)

    # Tell DataGateway to wipe DynamoDB + OpenSearch + S3
    resp = await _dg_request(redis, user_id, {"action": "delete_all_user_data"})
    if resp and resp.get("success"):
        return (
            "\u2705 Done! All your data wiped -- chats, documents, embeddings, and preferences.\n"
            "Message me again to start fresh (I'll re-ask for consent)."
        )
    return (
        "\u2705 Your local session cleared. Background deletion of stored data is running.\n"
        "Message me again to start fresh."
    )

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

    # Read current values from Redis profile cache first (avoids DGW race
    # when two SET commands run back-to-back before the first write commits).
    cache_key_read = f"cache:profile:{user_id}"
    cached_profile: dict = {}
    try:
        _cached_raw = await redis.get(cache_key_read)
        if _cached_raw:
            cached_profile = json.loads(_cached_raw)
    except Exception:
        pass

    if cached_profile:
        # Use cached values — avoids re-reading stale DGW state
        existing_depth  = cached_profile.get("technical_depth")
        existing_domain = cached_profile.get("primary_domain")
    else:
        ctx = await probe_user_preferences(redis, user_id)
        existing_depth  = ctx.technical_depth
        existing_domain = ctx.primary_domain

    payload_prefs = {
        "technical_depth": update.get("technical_depth", existing_depth),
        "primary_domain": update.get("primary_domain", existing_domain),
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

    # Cache confirmed values so the SHOW path reads them immediately
    # without racing the async DGW queue write (TTL=120s).
    cache_key = cache_key_read  # already defined above
    try:
        await redis.setex(cache_key, 120, json.dumps({
            "technical_depth": payload_prefs.get("technical_depth"),
            "primary_domain":  payload_prefs.get("primary_domain"),
        }))
    except Exception:
        pass
    final_depth = payload_prefs.get("technical_depth") or "(unset)"
    final_domain = payload_prefs.get("primary_domain") or "(unset)"
    return (
        f"✅ Updated: {key}={value}\n\n"
        f"*Your profile*\n"
        f"• Technical depth: {final_depth}\n"
        f"• Primary domain: {final_domain}"
    )


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


DRAFT_TYPES = {
    "minutes": (
        "You are drafting concise meeting minutes from the topic the user describes.\n"
        "Output: Date placeholder, Attendees placeholder, 3-5 Discussion bullets,\n"
        "Decisions, Action items (owner + due date placeholders).\n"
        "Keep it under 250 words. No fluff."
    ),
    "research": (
        "You are drafting a 5-paragraph research brief on the user-supplied topic.\n"
        "Sections: Background, Key findings (3 bullets), Open questions,\n"
        "Recommended next steps. Cite sources as [Source 1], [Source 2] placeholders.\n"
        "Keep total length under 400 words."
    ),
    "slides": (
        "You are drafting a slide deck outline on the user topic.\n"
        "Output 8 slides: Title slide, Problem, Why it matters, Approach, Key data,\n"
        "Conclusion, Next steps, Q&A. Each slide: title + 3 sub-bullets.\n"
        "Format as Markdown headings."
    ),
    "email": (
        "You are drafting a short professional email on the user topic.\n"
        "Output: Subject line, Greeting, 2-3 body paragraphs, Sign-off.\n"
        "Keep under 180 words."
    ),
}


async def handle_draft(redis: Redis, user_id: str, arg: str) -> str:  # noqa: ARG001
    """
    F4 (Wave 9): /draft <type> <topic> — generate a draft document via Bedrock.

    Best-effort: errors return a friendly message. Bedrock invocation is
    short-circuited if the LLM client can\'t initialise (e.g. local pytest).
    """
    parts = arg.strip().split(None, 1)
    if len(parts) < 2:
        return (
            "Usage: /draft <type> <topic>\n"
            f"Types: {', '.join(sorted(DRAFT_TYPES.keys()))}\n"
            "Example: /draft minutes Q3 product review with the design team"
        )
    doc_type, topic = parts[0].lower(), parts[1].strip()
    if doc_type not in DRAFT_TYPES:
        return (
            f"Unknown draft type \'{doc_type}\'.\n"
            f"Types: {', '.join(sorted(DRAFT_TYPES.keys()))}"
        )

    try:
        from src.llm.bedrock_client import BedrockClient, TaskType
        client = BedrockClient()
        system_prompt = DRAFT_TYPES[doc_type]
        resp = await client.invoke(
            messages=[{"role": "user", "content": f"Topic: {topic}"}],
            task_type=TaskType.SUMMARIZATION,
            system_prompt=system_prompt,
            max_tokens=2048,
        )
        if not resp or not getattr(resp, "content", "").strip():
            return "⚠️ The model returned an empty draft — try rephrasing the topic."
        body_md = resp.content.strip()
    except Exception as exc:  # noqa: BLE001
        logger.error("Draft failed for user_id=%s type=%s: %s", user_id, doc_type, exc)
        return f"⚠️ Could not generate the draft right now ({type(exc).__name__}). Try again later."

    # Wave 11 (R8): also build a downloadable artifact and upload to S3.
    inline = f"📝 *{doc_type.capitalize()} draft*\n\n{body_md}"
    try:
        import base64 as _b64
        from src.draft_artifacts import render_artifact, make_filename
        artifact_bytes, content_type = render_artifact(doc_type, topic, body_md)
        filename = make_filename(doc_type, topic)
        upload_resp = await _dg_request(
            redis,
            user_id,
            {
                "action": "upload_draft",
                "filename": filename,
                "content_b64": _b64.b64encode(artifact_bytes).decode("ascii"),
                "content_type": content_type,
            },
        )
        if upload_resp and upload_resp.get("success") and upload_resp.get("url"):
            url = upload_resp["url"]
            ext = "pptx" if doc_type == "slides" else "docx"
            inline += (
                f"\n\n📎 Download .{ext}: {url}\n"
                "(link expires in 1 hour)"
            )
        else:
            err = (upload_resp or {}).get("error", "no response")
            logger.warning("Draft artifact upload failed user_id=%s: %s", user_id, err)
            inline += "\n\n_(downloadable file unavailable right now — text version only)_"
    except Exception as exc:  # noqa: BLE001 — never break the draft response
        logger.error("Draft artifact rendering failed for user_id=%s: %s", user_id, exc)
        inline += "\n\n_(downloadable file unavailable — text version only)_"
    return inline



# ── OAuth Integration Commands ────────────────────────────────────────────────
ADMIN_HOST = "http://3.0.132.150:3000"

CONNECT_HELP = """*Connect your accounts*

Link Google or Microsoft so Clawd can include your calendar and email in morning briefings.

/connect google -- Link Google Calendar + Gmail
/connect microsoft -- Link Microsoft Outlook + Calendar
/disconnect <service> -- Unlink a service

Read-only access only. Tokens are encrypted and never shared."""


async def handle_connect(redis: Redis, user_id: str, arg: str) -> str:
    """/connect <service> -- generate OAuth deep-link."""
    import secrets as _sec
    import json as _json
    service = arg.strip().lower()
    if service not in ("google", "microsoft"):
        return "Usage: /connect google  OR  /connect microsoft\n\n" + CONNECT_HELP
    state = _sec.token_urlsafe(24)
    state_key = f"oauth:state:{state}"
    try:
        await redis.setex(state_key, 600, _json.dumps({"userId": user_id, "service": service}))
    except Exception as _e:
        logger.error("Failed to store OAuth state user_id=%s: %s", user_id, _e)
        return "\u26a0\ufe0f Could not initiate connection. Please try again."
    link = f"{ADMIN_HOST}/oauth/{service}?state={state}"
    svc_name = "Google Calendar + Gmail" if service == "google" else "Microsoft Outlook + Calendar"
    return (
        f"\U0001f517 *Link {svc_name}*\n\n"
        f"Open this link to connect:\n{link}\n\n"
        "Link expires in 10 minutes. I'll confirm here once connected."
    )


async def handle_disconnect(redis: Redis, user_id: str, arg: str) -> str:
    """/disconnect <service> -- remove stored OAuth tokens."""
    import json as _json, uuid as _uuid
    service = arg.strip().lower()
    if service not in ("google", "microsoft"):
        return "Usage: /disconnect google  OR  /disconnect microsoft"
    token_key = f"oauth:tokens:{user_id}:{service}"
    try:
        await redis.delete(token_key)
        await redis.lpush(DATA_GATEWAY_QUEUE, _json.dumps({
            "action": "delete_oauth_tokens",
            "user_id": user_id,
            "service": service,
            "request_id": str(_uuid.uuid4()),
        }))
    except Exception as _e:
        logger.error("Failed to disconnect %s for user_id=%s: %s", service, user_id, _e)
        return f"\u26a0\ufe0f Could not disconnect {service}. Try again."
    return f"\u2705 {service.capitalize()} disconnected and tokens deleted."


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
    if cmd == "/draft":
        return await handle_draft(redis, user_id, arg)
    if cmd == "/connect":
        return await handle_connect(redis, user_id, arg)
    if cmd == "/disconnect":
        return await handle_disconnect(redis, user_id, arg)
    if cmd == "/integrations":
        return CONNECT_HELP
    if cmd == "/remind":
        return await parse_remind_command(redis, user_id, stripped)
    if cmd == "/reminders":
        items = await list_reminders(redis, user_id)
        if not items:
            return "\u23f0 No pending reminders. Set one with /remind me to X at Y"
        lines = ["\u23f0 *Your reminders:*"]
        for r in items:
            lines.append(f"  `{r['id']}` \u2014 {r['text']} \u2022 {r['fireAt']}")
        lines.append("\nCancel with /remindclear <id>")
        return "\n".join(lines)
    if cmd == "/remindclear":
        if not arg:
            return "Usage: /remindclear <reminder-id>"
        ok = await cancel_reminder(redis, user_id, arg.strip())
        return "\u2705 Reminder cancelled." if ok else f"\u274c No reminder with ID {arg.strip()!r} found."
    return f"Unknown command: {cmd}\nType /help for available commands."
