#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
# Finder/Terminal may have a shorter PATH than the user's login shell.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null; then
  echo "Complete setup needs Node.js 24+. Use an existing installation on PATH or install Node with Homebrew."
  case " $* " in *" --plan "*) echo "After adding Node, rerun --plan to inspect Python and FFmpeg."; exit 0 ;; esac
  command -v brew >/dev/null || { echo "Install Node.js 24+, reopen Terminal and retry."; exit 1; }
  case " $* " in
    *" --yes "*) ;;
    *) read -r -p 'Run brew install node? [y/N] ' answer || exit 1
       [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]] || exit 0 ;;
  esac
  brew install node
fi
exec node scripts/preparation/setup.mjs all "$@"
