---
name: auth
description: Connect Google or Microsoft so Clawd can include your calendar and email in morning briefings.
---

# /connect — link a cloud account

```
/connect google
/connect microsoft
/disconnect google
/disconnect microsoft
```

## `/connect google`

Sends you a link. Open it, approve Gmail + Calendar access, and Clawd confirms
here once connected. Tokens are stored encrypted in Redis — never shared.

Requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to be set on the server
(one-time admin setup). If the link returns "Google OAuth not configured", ask
the admin to add those env vars.

## `/connect microsoft`

Same flow — sends a link to the Microsoft login consent page. Approves
`Calendars.Read`, `Mail.Read`, `User.Read`.

Requires `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` on the server.

## `/disconnect <service>`

Removes stored tokens for that service. The next morning briefing will skip it.

## `/connect status`  (or `/auth status`)

Shows which integrations are active for your account:
- `google: ✅` — tokens present in Redis
- `microsoft: ✅` — tokens present in Redis

## Apple / iCloud

Not supported. Apple does not offer a standard OAuth API for third-party access
to iCloud Mail or Calendar. No iCloud ingestion is planned.
