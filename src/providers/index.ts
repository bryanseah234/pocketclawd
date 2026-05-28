// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude, mock) don't appear here.
//
// Skills add a new provider by appending one import line below.

// Clawd — register the claude provider so ANTHROPIC_BASE_URL
// passthrough is wired in. Idempotent if ANTHROPIC_BASE_URL is unset;
// the contribution is empty in that case.
import './claude.js';
