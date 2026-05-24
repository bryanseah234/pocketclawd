/**
 * Claude provider container config.
 *
 * Path: Custom Anthropic-compatible endpoint via OneCLI proxy.
 *   ANTHROPIC_BASE_URL set in .env -> forward base URL + a placeholder
 *   auth token; OneCLI rewrites the Authorization header on the wire.
 *
 * (The Bedrock path was removed when PocketClaw moved to the Claude Code
 * subscription model. Containers no longer mint AWS creds at spawn.)
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', async () => {
  const env: Record<string, string> = {};

  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);

  // Custom base URL path (OneCLI-routed)
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder-onecli-rewrites';
  }

  return { env };
});
