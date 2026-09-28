#!/bin/bash
cd "$(dirname "$0")" || exit 1

# Finder-launched scripts may not load the shell profile; add common Node.js locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fi

pause() { read -r -p "Press Return to close this window..." _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js LTS (https://nodejs.org), then open this file again."
  pause; exit 1
fi
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  echo "Install Google Chrome (https://www.google.com/chrome/), then open this file again."
  pause; exit 1
fi
if [ ! -f "node_modules/playwright/package.json" ]; then
  npm ci --ignore-scripts --no-audit --no-fund || npm install --ignore-scripts --no-audit --no-fund || { pause; exit 1; }
fi
node server.mjs
pause
