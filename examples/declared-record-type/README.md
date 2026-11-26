# A record type your own pack declares

Example Ridge Survey's operations manual asks for an airframe check that no record type built into Ledger holds: when it was made, who made it, what it found and the airframe hours at the time. Its pack declares the record type itself, as data, and a rule reads it with a check kind Ledger already has. No code changes. Everything here is invented: the operator, its manual, its people and its aircraft.

[Record types a pack declares](../../docs/design/declared-record-types.md) says how a declaration is versioned and pinned, and what becomes of records on file when it changes. [Write a rule pack](../../docs/guides/write-a-rule-pack.md#declare-a-record-type) is the guide.

| File | What it is |
| --- | --- |
| `source.txt` | The manual's chapter on airframe checks, as issued. |
| `pack.yaml` | The pack `example-ridge-procedures`: the record type `example-ridge-procedures.airframe-check` under `recordTypes`, and one rule quoting 6.1 that asks, with `value.one-of`, that the latest check of each aircraft found it serviceable. |
| `records/aircraft.identity.csv` | Three aircraft, `RIDGE-AC-1` to `RIDGE-AC-3`. |
| `records/example-ridge-procedures.airframe-check.csv` | Two airframe checks: `RIDGE-AC-1` serviceable, `RIDGE-AC-2` needing repair, checked on a day with no time written down. `RIDGE-AC-3` has none. |

## Run it

On a local Ledger with an organization of your own (see [Set up Ledger with a coding agent](../../docs/guides/set-up-with-a-coding-agent.md)):

```sh
pnpm pack:build examples/declared-record-type --out organization/packs
# LEDGER_PACKS_DIR names organization/packs; restart the API and the workers
pnpm ledger packs adopt example-ridge-procedures --mode active --from 2026-11-01 --until 2027-10-31 --reason "..."
pnpm ledger records columns example-ridge-procedures.airframe-check
pnpm ledger records import aircraft.identity examples/declared-record-type/records/aircraft.identity.csv
pnpm ledger records check example-ridge-procedures.airframe-check \
  examples/declared-record-type/records/example-ridge-procedures.airframe-check.csv
pnpm ledger records import example-ridge-procedures.airframe-check \
  examples/declared-record-type/records/example-ridge-procedures.airframe-check.csv
pnpm ledger coverage --pack example-ridge-procedures
```

`pnpm pack:build` prints the record type with each field. Until the pack is adopted, the organization does not have the type: `records columns` and `records import` say so. Once it is, the Records screen offers its form and lists its records like any other type's, and coverage shows the rule for each of the three aircraft: one serviceable, one needing attention, and one with no airframe check on file.

`tests/integration/declared-record-type.integration.test.ts` runs these steps through the API, reads an export of the same checks through a column mapping, and checks that another organization neither sees the type nor can record one. These commands were not run against a running local stack for this page; if the test and this page disagree, the test is right.
