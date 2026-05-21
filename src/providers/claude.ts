/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 *
 * Bedrock pivot (PocketClaw): when CLAUDE_CODE_USE_BEDROCK=1 in the
 * host env, the SDK skips api.anthropic.com entirely and signs requests
 * to bedrock-runtime.<region>.amazonaws.com with SigV4. We forward the
 * standard AWS credential vars + region so the SDK's AWS credential
 * chain resolves them inside the container. Short-lived SSO creds are
 * refreshed by scripts/refresh-bedrock-creds.ps1.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const BEDROCK_FORWARDED_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

registerProviderContainerConfig('claude', () => {
  const env: Record<string, string> = {};

  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    ...BEDROCK_FORWARDED_ENV,
  ]);

  // Custom base URL path (OneCLI-routed)
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  // Bedrock path — forward AWS env vars when the SDK is configured to
  // use Bedrock. The credential chain inside the container will pick
  // them up directly; OneCLI is not in the request path for SigV4.
  if (dotenv.CLAUDE_CODE_USE_BEDROCK === '1' || dotenv.CLAUDE_CODE_USE_BEDROCK === 'true') {
    for (const key of BEDROCK_FORWARDED_ENV) {
      const value = dotenv[key];
      if (value) env[key] = value;
    }
  }

  return { env };
});
