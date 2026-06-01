---
name: digest
description: Manually trigger or explain the morning digest (07:00 SGT auto-delivery).
---

# /digest — morning digest

The morning digest runs automatically at **07:00 SGT** every day for any user who
has connected Google (`/connect google`) or Microsoft (`/connect microsoft`).
It delivers upcoming calendar events and unread email subjects directly to your chat.

## What to do when the user types `/digest`

1. Explain that the auto-digest fires at 07:00 SGT to users with connected accounts.
2. If the user wants it **right now**, trigger a manual one-off:
   - `kb_recall(query="today calendar", k=5)`
   - `kb_recall(query="unread email", k=5)`
   - Format as: 📅 Calendar / 📧 Email / 📋 Commitments
   - Reply with the formatted summary.
3. If the user has no accounts connected, direct them to `/connect google` or
   `/connect microsoft`.

## Delivery channels

Digest is sent to whatever channel the user's `userId` prefix indicates:
`wa:` → WhatsApp, `tg:` → Telegram.
