# A1 — Caddy + Let's Encrypt TLS for Clawd (Wave 5)

## What this gives you
HTTPS at https://clawd.<your-domain> instead of plain HTTP at http://3.0.132.150:3000. Browsers stop screaming about insecure pages, the admin login isn't sent in clear text, and webhooks from Telegram/etc that require TLS will work.

## Prerequisites
1. Domain pointed at EC2 (e.g. `clawd.example.com`). A record: `clawd -> 3.0.132.150`.
2. Ports 80, 443 open on EC2 SG for 0.0.0.0/0.
3. Orchestrator container binding 0.0.0.0:3000 (default).
4. SSH/SSM access with sudo.

## Run on the EC2 (paste-ready)

```bash
DOMAIN="clawd.YOURDOMAIN.com"   # <-- EDIT
EMAIL="you@YOURDOMAIN.com"      # <-- EDIT

# Amazon Linux 2023:
if [ -f /etc/amazon-linux-release ]; then
  sudo dnf install -y dnf-plugins-core
  sudo dnf copr enable -y @caddy/caddy
  sudo dnf install -y caddy
fi
# Ubuntu:
if [ -f /etc/lsb-release ]; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update && sudo apt-get install -y caddy
fi

sudo tee /etc/caddy/Caddyfile > /dev/null << CADDY_EOF
{
  email ${EMAIL}
}
${DOMAIN} {
  encode gzip zstd
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Forwarded-Proto {scheme}
    header_up X-Real-IP {remote_host}
  }
}
CADDY_EOF

sudo systemctl enable --now caddy
sudo systemctl reload caddy
sleep 60
curl -fsv "https://${DOMAIN}/health"
```

## After it's up
1. Optional orchestrator env:
   ```
   FORCE_HTTPS=true
   PUBLIC_BASE_URL=https://clawd.YOURDOMAIN.com
   ```
2. New bookmark: `https://clawd.YOURDOMAIN.com/admin`.
3. Optional: tighten SG to drop direct :3000 from internet, keep only :80/:443.

## Failure modes
- LE 'unauthorized': DNS not propagated. Wait, then `sudo systemctl restart caddy`.
- LE 'too many requests': hit weekly rate limit (~5/domain). Use ZeroSSL via `acme.zerossl.com` in Caddyfile, or wait.
- Caddy 502: orchestrator not on :3000. `docker ps | grep nanoclaw-orchestrator`.

## Rollback
```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
```
