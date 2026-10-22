#!/usr/bin/env bash
# PreToolUse hook: refuse git commit/push/merge/rebase with --no-verify (it skips pnpm verify).
# Text inside quotes (e.g. a commit message) is ignored.
input=$(cat)
if printf '%s' "$input" | grep -Eq "git +(commit|push|merge|rebase)[^|;&\"']*--no-verify"; then
  echo "Blocked: git --no-verify skips pnpm verify. Push normally; on vitest SIGKILL retry with VITEST_MAX_WORKERS=1." >&2
  exit 2
fi
exit 0
