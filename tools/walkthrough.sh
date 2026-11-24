#!/usr/bin/env bash
# Fresh local SMS walkthrough: resets the local dev database and object store, seeds the
# fictional utility (adopted risk matrix and a draft safety policy), then runs the dev stack
# until Ctrl-C.
set -euo pipefail
cd "$(dirname "$0")/.."

if lsof -iTCP:4000 -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stop the running dev stack (pnpm dev) first; the walkthrough starts its own." >&2
  exit 1
fi

echo "Resetting the local database and object store"
docker compose -f infra/compose.yaml down -v >/dev/null 2>&1
docker compose -f infra/compose.yaml up -d --wait >/dev/null 2>&1
pnpm build >/dev/null
pnpm db:migrate
pnpm db:seed

echo
echo "Starting the dev stack. Open http://127.0.0.1:5173 as Fictional Valley Power once it is listening (Ctrl-C to stop)."
VITE_LEDGER_WALKTHROUGH=1 exec pnpm dev
