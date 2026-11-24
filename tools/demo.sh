#!/usr/bin/env bash
# Fresh local demo: resets the local dev database, loads both scenarios anchored to now,
# then keeps a continuous operation running until Ctrl-C.
set -euo pipefail
set -m
cd "$(dirname "$0")/.."

if lsof -iTCP:4000 -iTCP:5173 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stop the running dev stack (pnpm dev) first; the demo starts its own." >&2
  exit 1
fi

mkdir -p .local/demo
log=.local/demo/dev.log
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

echo "Resetting the local database and object store"
docker compose -f infra/compose.yaml down -v >/dev/null 2>&1
docker compose -f infra/compose.yaml up -d --wait >/dev/null 2>&1
rm -rf .local/simulator
pnpm vendor:airspace
pnpm build >/dev/null
pnpm db:migrate
pnpm db:seed
pnpm broker:files:dev >/dev/null
docker compose -f infra/compose.yaml restart mqtt >/dev/null 2>&1

echo "Starting the dev stack (log: $log)"
pnpm dev >"$log" 2>&1 &
pids+=($!)
until curl -sf http://127.0.0.1:4000/readyz >/dev/null && curl -sf http://127.0.0.1:5173 >/dev/null; do sleep 1; done

start=$(node -e 'console.log(new Date().toISOString())')
SIMULATOR_START=$start pnpm scenario
pnpm scenario:telemetry

echo "Starting the continuous operation: a new flight every three minutes, flying on the map"
SIMULATOR_AUTORUN=1 SIMULATOR_TELEMETRY=1 SIMULATOR_INTERVAL_MS=180000 \
  SIMULATOR_TELEMETRY_FAULTS=duplicate,late,reconnect \
  node --env-file=.env --import tsx apps/simulator/src/trickle.ts >>"$log" 2>&1 &
pids+=($!)

echo
echo "Demo ready at http://localhost:5173 (Ctrl-C to stop)"
wait
