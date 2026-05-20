# PocketClaw Build Learnings

## Environment
- Windows 11, PowerShell 7
- User has NO opencode account → DO NOT use task() with subagents
- All work must be done directly with bedrock (claude-opus-4-7)
- Branch: feature/pocketclaw-build (already correct, hook-compliant)

## Repo State (pre-execution)
- Repo is partial: nanoclaw-v2/ has docs/assets only, missing src/ groups/ package.json
- pyproject.toml currently for "azure-conversational-assistant-agentic" — needs renaming
- Has Python 3.13/uv setup AND will host TypeScript NanoClaw alongside it
- Pre-existing git hooks at .githooks/ (not yet installed in .git/hooks/)

## Conventions
- Commit format: `<type>(scope): <desc>` ≤72 chars, lowercase, imperative
- Allowed types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
- Branch pattern: feature/xxx fix/xxx bugfix/xxx hotfix/xxx chore/xxx
