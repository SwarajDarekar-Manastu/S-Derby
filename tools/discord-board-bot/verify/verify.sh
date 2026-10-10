#!/usr/bin/env bash
# Verification harness for the Discord Board bot. See .claude/skills/verify-discord-board-bot/SKILL.md.
set -euo pipefail
exec node "$(dirname "$0")/harness.ts" "$@"
