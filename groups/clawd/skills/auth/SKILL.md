---
name: auth
description: Start OAuth / device-code flow for a cloud provider (google / microsoft / apple).
---

# /auth — start cloud auth flow

Usage:

```
/auth google
/auth microsoft
/auth apple
/auth status
```

Action:

### `/auth google`

1. Verify `~/.clawd/secrets/google_credentials.json` exists. If not, instruct the user to:
   - Visit https://console.cloud.google.com → create project "Clawd"
   - Enable Gmail API, Calendar API, People API
   - Create OAuth 2.0 client → Desktop app → download `credentials.json`
   - Place it at `~/.clawd/secrets/google_credentials.json`
2. Run the setup script that loads the credentials, opens the browser for consent, and saves the token to `~/.clawd/secrets/google_token.json`.

### `/auth microsoft`

1. Verify `MS_CLIENT_ID` env var is set. If not, instruct user to:
   - Register an app at https://portal.azure.com → App registrations
   - Add API permissions: `Mail.Read`, `Calendars.Read`, `Contacts.Read`
   - Add `MS_CLIENT_ID=<value>` to `.env`
2. Trigger the device-code flow → display the URL + code → save token to `~/.clawd/secrets/ms_token.json`.

### `/auth apple`

Apple has no OAuth. Instruct user to:

1. Visit https://appleid.apple.com → Security → App-Specific Passwords → generate
2. Add to `.env`: `APPLE_ID_EMAIL=...` + `APPLE_APP_PASSWORD=...`
3. Re-run `/ingest` to verify connectivity.

### `/auth status`

Show which providers have valid tokens (file present + non-expired):

- `google: ✅ / ❌`
- `microsoft: ✅ / ❌`
- `apple: ✅ / ❌`
