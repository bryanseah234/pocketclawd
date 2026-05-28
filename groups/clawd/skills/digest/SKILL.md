---
name: digest
description: Manually trigger the morning digest delivered to Telegram (NOT YET WIRED).
---

# /digest — generate and send morning digest

## Status

**Not yet wired.** The morning digest is a 07:00 local host cron that:

1. Recalls yesterday's email facts from the knowledge base.
2. Recalls today's calendar events.
3. Recalls pending commitments.
4. Composes a summary in the format from PRD §8.2 and sends it to the user's Telegram DM session.

Today the cron is a no-op stub: the audit log shows `morning-digest | SKIP | no-handler`. Re-wiring it needs:

- A host-side handler that uses `kb_recall` (now available since M0) to gather context.
- A `send_message` path from the host into the user's DM session.

That's a separate follow-on plan.

## What to do when the user types `/digest`

1. Acknowledge the cron is currently parked.
2. Offer to do a manual quick-look digest right now by chaining `kb_recall` calls:

   - `kb_recall(query="yesterday email", k=5)`
   - `kb_recall(query="today calendar", k=5)`
   - `kb_recall(query="pending commitments owe will send", k=5)`

3. Format the result like the PRD §8.2 morning summary (📧 emails, 📅 calendar, 📋 commitments) and reply.

This gives the user the same shape of message they'd get from the auto-digest, just on demand. It's not a substitute for the cron — once-off manual invocation only.

## Forward link

Tracked in: the follow-on `.omo/plans/clawd-morning-digest-rewire.md` (to be written). Will use the M0 host-side kb_request handler as the read path.
