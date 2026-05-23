/**
 * Claude provider container config.
 *
 * Two paths:
 *
 * (1) Custom Anthropic-compatible endpoint via OneCLI proxy.
 *     ANTHROPIC_BASE_URL set in .env -> forward base URL + a placeholder
 *     auth token; OneCLI rewrites the Authorization header on the wire.
 *
 * (2) AWS Bedrock (PocketClaw default).
 *     CLAUDE_CODE_USE_BEDROCK=1 set in .env -> the SDK signs requests to
 *     bedrock-runtime.<region>.amazonaws.com with SigV4 inside the
 *     container. Containers are Linux + have no ~/.aws/ mount + no AWS
 *     CLI, so the host must inject short-lived role credentials at spawn
 *     time. We do that by shelling out to:
 *
 *         aws configure export-credentials --profile <p> --format process
 *
 *     on the HOST (which has the SSO cache), parsing the JSON, and
 *     forwarding AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN as `-e` flags.
 *     Region + model identifiers come from .env unchanged.
 *
 *     SSO session refresh (the once-per-8h Chrome login) is the user's
 *     responsibility via `aws sso login`. Between logins, every spawn
 *     mints fresh ~1h role credentials transparently.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

// Config (not credentials) read from .env and forwarded into the container.
const BEDROCK_FORWARDED_CONFIG = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

// Profile to call `aws configure export-credentials` with. Override via
// AWS_PROFILE in .env; defaults to `hermes` (the SSO profile shared with
// the rest of the bryan-host AWS stack).
function resolveAwsProfile(dotenv: Record<string, string>): string {
  return dotenv.AWS_PROFILE || process.env.AWS_PROFILE || 'hermes';
}

interface ProcessCreds {
  Version: number;
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  Expiration?: string;
}

/**
 * Mint short-lived role credentials by exchanging the host's SSO cache
 * via `aws configure export-credentials`. Throws on failure so the
 * spawn aborts loudly rather than producing a silent 403 inside the
 * container — the message stays pending and the next sweep retries.
 */
async function mintBedrockCreds(profile: string): Promise<ProcessCreds> {
  const { stdout } = await execFileAsync(
    'aws',
    ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
    { timeout: 20_000, windowsHide: true },
  );
  const parsed = JSON.parse(stdout) as ProcessCreds;
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey || !parsed.SessionToken) {
    throw new Error('aws export-credentials returned incomplete credential set');
  }
  return parsed;
}

registerProviderContainerConfig('claude', async () => {
  const env: Record<string, string> = {};

  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'AWS_PROFILE',
    ...BEDROCK_FORWARDED_CONFIG,
  ]);

  // Custom base URL path (OneCLI-routed)
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = '***';
  }

  // Bedrock path — mint fresh creds at spawn time.
  if (dotenv.CLAUDE_CODE_USE_BEDROCK === '1' || dotenv.CLAUDE_CODE_USE_BEDROCK === 'true') {
    // Forward config (region, model ids) verbatim from .env.
    for (const key of BEDROCK_FORWARDED_CONFIG) {
      const value = dotenv[key];
      if (value) env[key] = value;
    }

    const profile = resolveAwsProfile(dotenv);
    try {
      const creds = await mintBedrockCreds(profile);
      env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
      env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
      env.AWS_SESSION_TOKEN = creds.SessionToken;
      log.info('Bedrock creds minted at spawn', {
        profile,
        expiresAt: creds.Expiration ?? 'unknown',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Failed to mint Bedrock creds at spawn — aborting container start', {
        profile,
        error: msg,
        hint: 'Run `aws sso login --sso-session hermes-sso` if SSO has expired.',
      });
      // Re-throw so router/host-sweep leaves the inbound message pending.
      throw new Error(`Bedrock credential mint failed (profile=${profile}): ${msg}`);
    }
  }

  return { env };
});
