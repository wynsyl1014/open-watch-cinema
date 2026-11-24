#!/bin/bash
set -eu
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null; then
  echo "Install Node.js 24+ using your usual setup (Homebrew: brew install node), reopen Terminal and retry."
  exit 1
fi
exec node scripts/preparation/setup.mjs audio "$@"
