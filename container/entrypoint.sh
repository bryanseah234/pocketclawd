#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.
#
# Skill symlink hydration (Windows/exFAT compat):
# When the host filesystem can't create symlinks (exFAT, no admin SeCreateSymbolicLinkPrivilege),
# `syncSkillSymlinks` writes <skill>.symlink-target marker files instead.
# We convert them into real symlinks inside the container before agent-runner starts.

set -e

SKILLS_DIR="/workspace/.claude/skills"
if [ -d "$SKILLS_DIR" ]; then
  for marker in "$SKILLS_DIR"/*.symlink-target; do
    [ -e "$marker" ] || continue
    target="$(cat "$marker")"
    link="${marker%.symlink-target}"
    if [ ! -e "$link" ] && [ ! -L "$link" ]; then
      ln -sf "$target" "$link"
    fi
    rm -f "$marker"
  done
fi

mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
