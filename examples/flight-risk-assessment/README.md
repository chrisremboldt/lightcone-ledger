# A scored assessment before each flight

Example Ridge Survey's operations manual scores each flight before it goes: so many points for the wind, for a site nobody has flown, for a pilot short on recent flights, and so on. The points are added up. At 5 points or more a second remote pilot reviews the assessment, and above a level the chief pilot sets, the chief pilot does. This folder is that procedure as a pack: it declares the assessment as a record type of its own, and its two rules add up the points with the check kind `record.points-total`. No code changes. Everything here is invented: the operator, its manual, its people and its flights.

The total is arithmetic over what the pilot recorded. Ledger looks nothing up to score a flight, gives the total no other name, and does not hold a flight: a result says what the answers total and what the manual asks at that total, and a named person does the review and records it.

[Write a rule pack](../../docs/guides/write-a-rule-pack.md#a-scored-assessment) is the guide; [Check kinds for record-keeping rules](../../docs/design/record-check-kinds.md#a-total-of-points) says how the kind reads a record and what it refuses.

| File | What it is |
| --- | --- |
| `source.txt` | The manual's chapter on the assessment, as issued. Paragraph 7.2 states the points of every answer and both levels. |
| `pack.yaml` | The pack `example-ridge-risk`: the record type `example-ridge-risk.flight-risk-assessment` under `recordTypes`, and two rules that quote 7.2. Both use the same points. `second-pilot-review` passes a total below 5; `chief-pilot-review` passes a total at most the level the organization sets when it adopts the pack. |
| `records/flight.record.csv` | Four flights, `RIDGE-F-701` to `RIDGE-F-704`. |
| `records/example-ridge-risk.flight-risk-assessment.csv` | Three assessments, each made before its flight's takeoff: `RIDGE-F-701` totals 4 points, `RIDGE-F-702` totals 5 and `RIDGE-F-703` totals 13. `RIDGE-F-704` has none. |

## The points

Each scored field is written under the check's `fields` as the manual states it:

- a number takes `bands`. `{ to: 5, points: 0 }` is "below 5", `{ from: 5, to: 8, points: 2 }` is "5 to under 8", `{ from: 8, points: 4 }` is "8 and above": a band's `from` is included and its `to` is not;
- a field with listed options takes `options`, the points of every option;
- a yes-or-no field takes `yes` and `no`.

Points are whole numbers, so the total is exact. `pnpm pack:build` refuses, naming the field, bands that overlap, leave a gap or stop short of the least or greatest value the field takes, and an option with no points. Changing the points is a new version of the pack.

## Run it

On a local Ledger with an organization of your own (see [Set up Ledger with a coding agent](../../docs/guides/set-up-with-a-coding-agent.md)):

```sh
pnpm pack:build examples/flight-risk-assessment --out organization/packs
# LEDGER_PACKS_DIR names organization/packs; restart the API and the workers
pnpm ledger packs adopt example-ridge-risk --mode active --from 2026-11-01 --until 2027-10-31 \
  --set example-ridge-risk.chief-pilot-review.level=8 --reason "..."
pnpm ledger records import flight.record examples/flight-risk-assessment/records/flight.record.csv
pnpm ledger records check example-ridge-risk.flight-risk-assessment \
  examples/flight-risk-assessment/records/example-ridge-risk.flight-risk-assessment.csv
pnpm ledger records import example-ridge-risk.flight-risk-assessment \
  examples/flight-risk-assessment/records/example-ridge-risk.flight-risk-assessment.csv
pnpm ledger coverage --pack example-ridge-risk
```

Adopting asks for the chief pilot's level, a whole number of points from 5 to 15; `--set` gives it. With it set to 8, coverage shows for each of the four flights:

| Flight | Total | Second remote pilot (below 5) | Chief pilot (at most 8) |
| --- | --- | --- | --- |
| `RIDGE-F-701` | 4 | supported by the record | supported by the record |
| `RIDGE-F-702` | 5 | needs attention | supported by the record |
| `RIDGE-F-703` | 13 | needs attention | needs attention |
| `RIDGE-F-704` | none | no flight risk assessment on file | no flight risk assessment on file |

A result's sentence lists every answer with the points it scored, so a person can check the sum by eye: "… scores Wind at launch: 6 m/s (2); The site: New to the operator (3); Pilot's flights in the last 90 days: 12 (0); People within 30 m of the planned path: No (0); Pilot's hours on duty at takeoff: 2 h (0). Total: 5 points; the level is below 5 points. At 5 points or more: a second remote pilot reviews the assessment before the flight." An assessment with a scored question left unanswered states no total and names the question; an assessment made after the takeoff is not read for the flight.

`tests/integration/flight-risk-assessment.integration.test.ts` builds and adopts this pack, checks these files against the record types, and reads flights below, at and above each level; `packages/standard-packs/tests/example-pack-folders.test.ts` keeps the folder building. The commands above were not run against a running local stack for this page; if a test and this page disagree, the test is right.
