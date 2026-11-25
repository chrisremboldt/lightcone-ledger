# The first operator: Example Ridge Survey

One operator, from its waiver and its spreadsheets to coverage, through the command line. Everything here is invented: the organization, its people, its aircraft, its flights and its waiver. Nothing in it is a real certificate.

Example Ridge Survey inspects transmission lines with small unmanned aircraft. It holds a Part 107 waiver for flights beyond visual line of sight (`waiver/source.txt`) and wants to see where its records stand against Part 107, its waiver, and the proposed Part 108.

This folder is the path of [Set up Ledger with a coding agent](../../docs/guides/set-up-with-a-coding-agent.md) for these files. Read the guide for the why of each step; this page says what each file is and runs the steps on them.

## What is here

| File | What it is |
| --- | --- |
| `waiver/source.txt` | The waiver exactly as issued: 19 special provisions. |
| `waiver/pack.yaml` | The waiver described for Ledger: each provision's words, quoted unchanged, and what it asks for. 16 are checked from records; 3 no record shows, so a person checks them. |
| `records/aircraft.identity.csv` | Three aircraft: make and model, serial number, registration. |
| `records/aircraft.inspection.csv` | The latest inspection of two of them, and when the next is due: `RIDGE-AC-1`'s at 120 hours in service, inspected on a day with no time written down; `RIDGE-AC-2`'s at a time. |
| `records/aircraft.time-in-service.csv` | `RIDGE-AC-1`'s hours in service as of a day, from its logbook. Ledger adds the flights since. |
| `records/aircraft.detect-and-avoid.csv` | The state of each aircraft's detect-and-avoid equipment when it was checked. |
| `records/maintenance.action.csv` | Two maintenance entries; one has no one recorded as having done the work. |
| `records/person.standing.csv` | Four pilots: name, qualifications, duties, employee number. |
| `records/person.certificate.csv` | Three remote pilot certificates. |
| `records/person.training.csv` | Recurrent training, a knowledge test, and the BVLOS course the waiver names. The `program` column says which program each counts towards: the Part 107 recurrent courses and the knowledge test are the remote pilot certificate's, the BVLOS course the operator's own, so the Part 107 rule reads only its own and the two are never taken as two dates for one course. |
| `records/organization.procedure.csv` | The lost link procedure the waiver asks for. |
| `records/organization.operating-area.csv` | The two areas it operates in, by its own ids: `RIDGE-AREA-1`, a circle of 5,000 m around the north substation, and `RIDGE-AREA-2`, a corridor 150 m either side of a transmission line through three points. Each names its approval and alternate landing areas; the corridor has no takeoff, landing and loading areas described yet. |
| `records/flight.plan.csv` | Four flights: window, place, route, planned height, distance and speed, the aircraft, and the waiver cited. |
| `records/operation.role-assignment.csv` | Who was pilot in command and visual observer on each flight. |
| `records/operation.notification.csv` | The notices filed before three of the flights; the third states only the day it was filed. |
| `records/flight.preflight-assessment.csv` | The preflight assessment of two flights, with the visibility recorded. |
| `records/flight.record.csv` | The logbook entry for three flown flights: takeoff and landing times in the organization's own time (Mountain time), places, the greatest height flown, and the wind at takeoff, battery at landing and visibility the pilots wrote down. Some cells carry their own unit (`45 m`, `18%`, `8 kt`). |
| `records/occurrence.emergency-deviation.csv` | A lost link and when it was reported. |
| `records/flight.plan.unfixed.csv` | Two flight plans as a spreadsheet saved them, before they were made into an import file. The check refuses both rows and says why. |
| `records/flight-log.export.csv` | The same three flown flights as `flight.record.csv`, as the operator's log service exports its flight log: its own headings (`Date/Time Up`, `Max Alt (ft AGL)`, `Wind (kts)`), US-style times in Mountain time (`11/10/2026 9:05 AM`), feet, knots and statute miles, the pilot, a remark, and a fourth flight with `Status` `Cancelled`. `run.sh` checks it through its mapping, which records nothing; the flights are imported from `flight.record.csv`, so they are not recorded twice. |
| `records/flight-log.mapping.yaml` | The column mapping that reads that export as `flight.record` records, as it is: which column is which field, the unit of each number, that its times are in the organization's zone and written `MM/DD/YYYY h:mm A`, and that a `Cancelled` row is left out. The pilot and the remarks are not read. |
| `run.sh` | Runs everything below in order. |

Each file is named after its record type, and each id is the operator's own: `RIDGE-AC-1` for an aircraft, `RIDGE-P-01` for a pilot, `FLT-2026-1101` for a flight. A pilot's certificate, training and assignments meet under one pilot id; the aircraft a flight plan names goes in `secondarySubjectId`. Heights, distances and speeds carry their unit in the column heading, such as `plannedMaxHeightAboveGround [ft]`, and Ledger keeps the conversion with the record. Times are in UTC (`2026-11-10T16:00:00Z`), or, under a heading that ends in `[local]` as in `flight.record.csv` (`takeoffAt [local]`), in the organization's time zone as the logbook keeps them (`2026-11-10 09:05`); Ledger stores UTC and keeps what was entered and the zone with the record. Dates are `2026-11-10`; the column that places a record takes a date alone when no time was written down (`2026-11-30`), and Ledger keeps it as that day. A cell may carry its own unit (`45 m` under a `[ft]` heading), which wins over the heading's. The unfixed file shows what is refused: a US-style date (`11/10/2026 9:00 AM`), a local time under a heading that does not say `[local]`, a value that is not one of the column's options (`BVLOS`), and words after a unit in a cell (`150 ft AGL`). An export need not be rewritten like that by hand: `flight-log.export.csv` is read as it is through its column mapping, which says the style of its times, its units and which rows to leave out, and Ledger keeps the export and the mapping with the records; without a mapping the unfixed file's rows are refused as before.

The records are made to show each kind of result: an ordinary flight the waiver does not cover (with a pilot and an aircraft that are not on its lists), a planned height above its limit, a course too old, a notice filed late, a notice dated only by its day, an inoperative detect-and-avoid unit, a lost link reported late, a maintenance entry missing a name, a flight of that aircraft after it with no return to service recorded, a wind and a battery beyond the waiver's limits as the pilot logged them, an inspection past its due date, and an aircraft past the hours its next inspection is due at.

## Run it

On a local, empty database (see the [README quickstart](../../README.md#quickstart), without `pnpm db:seed`):

```sh
examples/first-operator/run.sh prepare
```

This runs, from the checkout:

```sh
pnpm org:create --name "Example Ridge Survey" --time-zone America/Denver --admin "Avery Example"
pnpm pack:build examples/first-operator/waiver --out organization/packs
```

It writes the development token `pnpm org:create` prints to `.ledger/credentials` (git-ignored), and the waiver's pack file to `organization/packs` (git-ignored). Set `LEDGER_PACKS_DIR` in `.env` to the full path it prints, start Ledger with `pnpm dev`, and then:

```sh
examples/first-operator/run.sh
```

It runs these, in this order:

```sh
pnpm ledger me
pnpm ledger records check flight.plan examples/first-operator/records/flight.plan.unfixed.csv   # refused, row by row
pnpm ledger records check flight.record examples/first-operator/records/flight-log.export.csv \
  --mapping examples/first-operator/records/flight-log.mapping.yaml   # each column, what was not read, the row left out
pnpm ledger records check aircraft.identity examples/first-operator/records/aircraft.identity.csv
pnpm ledger records import aircraft.identity examples/first-operator/records/aircraft.identity.csv
# ... the same two for each records file, aircraft and people first, then flights
pnpm ledger packs list
pnpm ledger packs adopt ledger.part107 --mode active --from 2026-06-01 --until 2028-05-31 --reason "..."
pnpm ledger packs adopt ledger.part108-nprm --mode shadow --from 2026-06-01 --until 2028-05-31 \
  --set-all weekStartsOn=1 --reason "..."
pnpm ledger packs adopt example-ridge.waiver-107w-ex-2026-00417 --mode active --from 2026-06-01 --until 2028-05-31 --reason "..."
pnpm ledger coverage --pack example-ridge.waiver-107w-ex-2026-00417
pnpm ledger coverage --pack example-ridge.waiver-107w-ex-2026-00417 --result attention
pnpm ledger coverage --pack ledger.part108-nprm
pnpm ledger findings list         # the open findings grouped by rule, a count for each
pnpm ledger findings list --all   # every open finding, oldest first; --rule <rule> lists one rule's
```

The three adoptions are the one step here that is a person's in a real organization: the script runs them with Avery Example's development token and a reason written for the example. In your organization the agent prints the adoption without `--reason`, and the person who decides runs it with their own credential and their own reason.

## What coverage shows

For the waiver, among others:

| Rule | What it shows |
| --- | --- |
| Every provision, for `FLT-2026-1103` | Does not apply: its plan cites no certificate, so it is an ordinary Part 107 flight and the waiver's conditions are not checked against it. Its pilot `RIDGE-P-04` and its aircraft `RIDGE-AC-3` are not on the waiver's lists, and nothing is reported about them. |
| Provision 3, listed aircraft | Supported by the record for the three flights flown under the waiver: each plan names a listed aircraft. |
| Provision 4, maximum height | `FLT-2026-1102` needs attention: its planned height is above 200 feet. |
| Provision 6, BVLOS course | `FLT-2026-1102` needs attention: its pilot `RIDGE-P-02`'s course is older than 12 calendar months. `FLT-2026-1201`: no record of the course on file for its pilot, `RIDGE-P-03`. |
| Provision 8, lost link procedure | Supported by the record, once for the organization: the procedure is on file. |
| Provision 9, notice 24 hours before | `FLT-2026-1201` needs attention: its notice states only the day it was filed, 2026-11-30, so it is read as filed at the end of that day, after the time it was due. |
| Provisions 17 and 18, wind and battery | `FLT-2026-1102` needs attention: no aircraft or site reports them, so the pilot's log is read, and it states 24 kt at takeoff (above 10 m/s) and 18 % at landing (below 25 %). `FLT-2026-1201` has not flown: they do not apply to it yet. |
| Provision 19, inspection not overdue | `FLT-2026-1102` needs attention: `RIDGE-AC-2`'s inspection was due on 2026-10-01. `FLT-2026-1201` needs attention: `RIDGE-AC-1` has 120.2 h in service, its 119.5 h as of 2026-11-01 plus `FLT-2026-1101`, and its next inspection was due at 120 h. |
| Provision 1, the flight plan cites the certificate | Supported by the record for the three flights that cite it, each flown or planned within the dates the certificate states. A flight that cited it outside those dates would need attention, with the dates and the flight's own, and would not be relieved from Part 107's visual line of sight rule. |
| Provision 7, detect and avoid | `FLT-2026-1101` is supported: `RIDGE-AC-1`'s check is recorded before it took off. `FLT-2026-1102` needs attention: `RIDGE-AC-2`'s check before it records the equipment inoperative. `FLT-2026-1201`: no detect-and-avoid check of `RIDGE-AC-1` on file since `FLT-2026-1101` landed; the provision asks for one before each flight. |
| Provision 11, one aircraft at a time | Supported by the record for the flights that cite the waiver: no other flight of the same pilot overlaps each, counted from the pilots' assignments. |
| Provisions 14, 15 and 16 | A person reviews them; no record shows them. |

For the proposed Part 108, adopted in shadow, the coverage is printed section by section (`§ 108.40 Operator recordkeeping requirements`, `§ 108.165 Area of operations`, …), each rule beside the paragraph it reads. Among others:

| Rule | What it shows |
| --- | --- |
| § 108.165(a) and (b), the operating areas | Supported by the record, once for the organization: both areas in force, `RIDGE-AREA-1` and `RIDGE-AREA-2`, name their approval and their alternate landing areas. |
| § 108.165(c), takeoff, landing and loading areas | Needs attention: `RIDGE-AREA-2` describes none. |
| § 108.165(a), positions flown inside an operating area | Does not apply to these flights: no positions are on file for them. Positions a source reports are placed against every area in force, and a position inside either area is inside. |
| § 108.555(a), inoperative equipment | `FLT-2026-1102` needs attention: `RIDGE-AC-2`'s detect-and-avoid unit was recorded inoperative before the flight, and no one is recorded as having determined that it is not a hazard. |
| § 108.630(a), each flight after maintenance | `FLT-2026-1102` needs attention: the motor replacement on `RIDGE-AC-2` before it is not recorded as returned to service. |
| § 108.150(c) and § 108.620(a) | No record on file: no physical security policies and no battery monitoring program are recorded as procedures. |

These are what the records support, not a conclusion about the operation. A named person with the authority decides what each means. Some results depend on the date they are read: a course "within the previous 12 calendar months" is counted back from each flight, and a recurrent course from the time the rule was last evaluated.

`tests/integration/first-operator.integration.test.ts` runs the same path in the integration suite, from the organization `pnpm org:create` makes to these results, and with a credential issued to a service for importing and reading. If this page and that test disagree, the test is right.

## Its safety records

`safety/` holds Example Ridge Survey's safety program as it kept it before Ledger: `risk-matrix.yaml`, its matrix of four bands, the highest of which nobody may accept; `hazards.csv`, its hazard register with the mitigations of each hazard and the before and after positions; `safety-policy.md`; `internal-audit.yaml` and `management-review.yaml`, with their findings and actions; and `safety-report-SR-1.md`, a report received by email. [Bring your safety records](../../docs/guides/bring-your-safety-records.md) brings each in with `pnpm ledger safety`: a service drafts them, and the people the administrator adds (Rowan Example, the safety manager, and Jordan Example, the accountable executive) adopt, assess, accept, sign, issue and close with their own tokens. `tests/integration/safety-records-from-files.integration.test.ts` runs it.
