#!/usr/bin/env bash
# Example Ridge Survey, an invented operator, from its waiver and its spreadsheets to coverage, through pnpm ledger.
# README.md beside this file says what each step does and what a real organization's people do instead.
#
#   examples/first-operator/run.sh prepare   before Ledger starts: create the organization, build its waiver pack
#   examples/first-operator/run.sh           with Ledger running: import the records, adopt the packs, read coverage
#
# It runs on an empty local database. tests/integration/first-operator.integration.test.ts runs the same path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
packs="$root/organization/packs"
waiver_pack="example-ridge.waiver-107w-ex-2026-00417"
cd "$root"

ledger() { pnpm --silent ledger "$@"; }

prepare() {
  local output token
  output="$(pnpm --silent org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example")"
  printf '%s\n' "$output"
  token="$(printf '%s\n' "$output" | grep -oE 'ledger-dev-[A-Za-z0-9_-]+' | head -n 1 || true)"
  if [ -n "$token" ]; then
    if [ -e "$root/.ledger/credentials" ]; then
      echo "Left .ledger/credentials as it is. Put the token above in it yourself if it is for this organization."
    else
      mkdir -p "$root/.ledger"
      printf 'LEDGER_API_URL=http://127.0.0.1:4000\nLEDGER_TOKEN=%s\n' "$token" >"$root/.ledger/credentials"
      chmod 600 "$root/.ledger/credentials"
      echo "Wrote the token to .ledger/credentials (git-ignored)."
    fi
  fi
  pnpm --silent pack:build "$here/waiver" --out "$packs"
  echo
  echo "Next: set LEDGER_PACKS_DIR=$packs in .env, start Ledger with pnpm dev, then run $0"
}

# Waits until no rule of any adoption is still being evaluated, for up to two minutes.
settle() {
  for _ in $(seq 1 60); do
    if ledger coverage --json | node -e '
      let text = ""; process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
        const { adoptions } = JSON.parse(text);
        process.exit(adoptions.some((item) => item.coverage.rules.some((rule) => rule.incomplete === "evaluating")) ? 1 : 0);
      });'; then return 0; fi
    sleep 2
  done
  echo "Some rules are still being evaluated; the counts below will change."
}

records() {
  ledger me
  echo
  echo "== A flight plan file saved as it was kept, checked before import (it records nothing):"
  ledger records check flight.plan "$here/records/flight.plan.unfixed.csv" || true
  for type in aircraft.identity aircraft.inspection aircraft.time-in-service aircraft.detect-and-avoid maintenance.action \
    person.standing person.certificate person.training organization.procedure organization.operating-area \
    flight.plan operation.role-assignment operation.notification flight.preflight-assessment flight.record \
    occurrence.emergency-deviation; do
    echo
    echo "== $type"
    ledger records check "$type" "$here/records/$type.csv"
    ledger records import "$type" "$here/records/$type.csv"
  done

  echo
  ledger packs list
  local dates=(--from 2026-06-01 --until 2028-05-31)
  local reason="Avery Example adopts the rules the operation works under, as the waiver states them."
  echo
  ledger packs adopt ledger.part107 --mode active "${dates[@]}" --reason "$reason"
  echo
  ledger packs adopt ledger.part108-nprm --mode shadow "${dates[@]}" --set-all weekStartsOn=1 --reason "$reason"
  echo
  ledger packs adopt "$waiver_pack" --mode active "${dates[@]}" --reason "$reason"

  settle
  echo
  ledger coverage --pack "$waiver_pack"
  echo
  ledger coverage --pack "$waiver_pack" --result attention
  echo
  ledger coverage --pack ledger.part108-nprm
  echo
  # Grouped by rule, then every open finding.
  ledger findings list
  echo
  ledger findings list --all
}

case "${1:-records}" in
  prepare) prepare ;;
  records) records ;;
  *)
    echo "Usage: $0 [prepare]" >&2
    exit 2
    ;;
esac
