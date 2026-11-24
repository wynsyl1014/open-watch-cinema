#!/bin/bash
set -u
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
cd "$(dirname "$0")/.."

printf '\n========================================\n'
printf '       Open Watch Cinema\n'
printf '========================================\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js was not found.\n'
  printf 'Install Node.js 24 or newer, then run this file again.\n\n'
  read -r -p 'Press Return to close...'
  exit 1
fi

if ! command -v ffprobe >/dev/null 2>&1; then
  printf 'FFprobe was not found.\n'
  printf 'Install FFmpeg and make sure ffmpeg and ffprobe are on PATH.\n\n'
  read -r -p 'Press Return to close...'
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf 'FFmpeg was not found.\n'
  printf 'Install FFmpeg and make sure ffmpeg and ffprobe are on PATH.\n\n'
  read -r -p 'Press Return to close...'
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'Note: Python 3 was not found. Ordinary playback will work,\n'
  printf 'but Prepare for AI viewing needs Python 3.\n\n'
fi

node server.mjs --default-browser
EXIT_CODE=$?

printf '\n'
if [ "$EXIT_CODE" -ne 0 ]; then
  printf 'The cinema stopped with exit code %s.\n' "$EXIT_CODE"
  printf 'Copy this terminal output when asking your AI for help.\n'
else
  printf 'The cinema has stopped.\n'
fi
printf '\n'
read -r -p 'Press Return to close...'
exit "$EXIT_CODE"
