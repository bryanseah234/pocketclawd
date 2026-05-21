// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// PocketClaw — register the claude provider so Bedrock env-var passthrough
// is wired in (CLAUDE_CODE_USE_BEDROCK + AWS_*). Idempotent if no Bedrock
// or custom base URL is set; the contribution is empty in that case.
import './claude.js';
