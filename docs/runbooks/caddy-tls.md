# Caddy TLS Setup (C9 -- pending domain purchase)

Once a domain is purchased, run this on EC2 i-0f9cd20350cfdc1a6.

## Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key'   | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt'   | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

## Caddyfile

Create /etc/caddy/Caddyfile:

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

## Start

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
sudo systemctl status caddy
```

Caddy handles Let's Encrypt certificate issuance and renewal automatically.

## After TLS is live

1. Update WEBHOOK_URL in nanoclaw/app-config to https://your-domain.com/telegram/webhook
2. Register the Telegram webhook:
   ```
   curl -X POST https://api.telegram.org/bot<TOKEN>/setWebhook      -d url=https://your-domain.com/telegram/webhook
   ```
3. Remove long-poll loop from src/channels/telegram.ts (set USE_TELEGRAM_WEBHOOK=true)
4. Restrict EC2 security group: close port 3000 to public, keep only 443 and 80
5. Proceed to C10 (Singapore IP lockdown)
