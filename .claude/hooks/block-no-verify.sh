#!/usr/bin/env bash
# Launcher for block-no-verify.mjs: finds node (PATH or nvm) and passes the hook input through.
NODE=$(command -v node) || { . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; NODE=$(command -v node); }
if [ -z "$NODE" ]; then
  echo "block-no-verify: node not found, hook skipped" >&2
  exit 0
fi
exec "$NODE" "$(dirname "$0")/block-no-verify.mjs"
