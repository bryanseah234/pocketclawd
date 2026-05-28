const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');

const SECRETS_DIR = path.join(process.env.USERPROFILE, '.clawd', 'secrets');
const CREDS_PATH = path.join(SECRETS_DIR, 'google_credentials.json');
const TOKEN_PATH = path.join(SECRETS_DIR, 'google_token.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

async function main() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web || creds;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3333');

  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('Opening browser for Google OAuth...');
  require('child_process').exec(`start "" "${authUrl}"`);

  // Listen for the callback
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:3333');
    const code = url.searchParams.get('code');
    if (code) {
      const { tokens } = await oauth2Client.getToken(code);
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      res.end('Google OAuth success! You can close this tab.');
      console.log('Token saved to:', TOKEN_PATH);
      server.close();
      process.exit(0);
    } else {
      res.end('No code received.');
    }
  });
  server.listen(3333, () => console.log('Waiting for OAuth callback on http://localhost:3333...'));
  setTimeout(() => { console.log('Timeout — no callback received in 120s'); process.exit(1); }, 120000);
}
main().catch(e => { console.error(e.message); process.exit(1); });
