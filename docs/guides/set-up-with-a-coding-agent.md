# Set up Ledger with a coding agent

This guide is written to you, the coding agent an operator asked to set Ledger up for their organization. Follow it in order. You need nothing else from this repository: every command is here, and `pnpm ledger --help` lists the client's commands. If you speak the Model Context Protocol, `pnpm ledger mcp` offers the same commands as tools under the same credential ([AGENTS.md](../../AGENTS.md#an-agent-that-speaks-mcp)); the steps and the rules below are the same either way, and a tool named `prepare_` gives you the command the person runs.

Ledger keeps an operator's records and reports, rule by rule, what is on file and what is not. It never says an operation is compliant, authorized, safe or may fly. Neither do you: a named person with the authority decides, and Ledger keeps what they saw. Ledger is not a safety management system and does not make anyone conform to a regulation.

`examples/first-operator` is the whole path below run for an invented operator, Example Ridge Survey: its waiver, its records as CSV files, and one script. When a step here is unclear, look at what that example does.

## What you do, what you prepare, and what only a person does

| You do it yourself | You prepare it, and a person decides | Only a person does it |
| --- | --- | --- |
| Start Ledger on a local computer and create the organization there | The list of people who sign in and what each may do, printed with `people add` and `people set` | Add people, change what they may do, issue a credential or a development token: granting authority |
| Read what Ledger expects: record types, their columns, the packs | Each import file, for the person to compare with their spreadsheet when you are unsure of a value | Adopt a rule pack, with their own credential and reason |
| Turn the operator's spreadsheets into import files, or write a column mapping for an export, check them and import them | The waiver as `source.txt` and `pack.yaml`, and the build's printout read back to the person, provision by provision | Accept a risk, sign a decision, a safety policy or a risk matrix |
| Read coverage and open findings, and report them in Ledger's words | The adoption, printed without `--reason` | Decide what a finding means, and whether the operation goes ahead |

When a step needs a person, stop, say which person (by role: the administrator, the person who adopts rules, the responsible person on the waiver), say exactly what they will run or click, and wait.

## Where the operator's files live

The operator's files are theirs: their spreadsheets, their waiver, the import files you make, the pack files you build. Keep them in a folder outside this checkout, or in `organization/` at the checkout's root, which git ignores. Never commit them and never copy them into another folder of the repository. The repository's rule "fictional data only" is about what is committed to this repository; the operator's own names and records belong in their own files, and that is where you put them.

A layout that works:

```text
organization/
  received/       the spreadsheets and documents as the operator gave them; you never edit these
  records/        one import file per record type, named <record type>.csv, and a column mapping per export
                  read as it is, named <export>.mapping.yaml, and the flights read from each aircraft log,
                  named <log>.flight.record.csv (the logs themselves stay in received/)
  waiver/         source.txt and pack.yaml
  packs/          the pack files you build; LEDGER_PACKS_DIR points here
```

The credential you use goes in `.ledger/credentials` at the checkout's root (git ignores `.ledger/`), never in a command and never in a committed file:

```text
LEDGER_API_URL=http://127.0.0.1:4000
LEDGER_TOKEN=<the credential>
```

`LEDGER_API_URL` and `LEDGER_TOKEN` in the environment take precedence over the file. `pnpm ledger` looks for `.ledger/credentials` from the folder you run it in upward, then from the checkout.

## 1. Start Ledger

**Or with Docker alone.** If the operator is only trying Ledger on this computer, `infra/compose.try.yaml` starts it with Docker and nothing else, as [Try Ledger on one computer](deploy.md#try-ledger-on-one-computer) shows. Run its two commands in place of the ones below and of step 2's `pnpm org:create`, and type `docker compose -f infra/compose.try.yaml run --rm client <command>` wherever this guide says `pnpm ledger <command>`. Building the waiver's pack file (step 6) still needs the checkout's Node and pnpm.

On a local computer, with Node 24, Docker and the pnpm that Corepack provides:

```sh
corepack enable
cp .env.example .env
pnpm install --frozen-lockfile
docker compose -f infra/compose.yaml up -d --wait
pnpm build && pnpm db:migrate
```

If `corepack enable` is refused (it writes to a system folder), do not ask for more rights: type `corepack pnpm` wherever this guide says `pnpm`, or make a one-line `pnpm` that does it for you, `mkdir -p ~/.local/bin && printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > ~/.local/bin/pnpm && chmod +x ~/.local/bin/pnpm`, with `export PATH="$HOME/.local/bin:$PATH"` in each shell you run.

Do not run `pnpm db:seed`: it adds fictional organizations the operator does not need, and do not run `pnpm vendor:airspace`: it downloads schemas for the emulators of the demonstration, which Ledger does not need for the operator's own records. Delete the last block of `.env`, the one headed "The seeded fictional organizations": everything in it configures those organizations, and Ledger starts without it. You start Ledger with `pnpm dev` after step 2 and leave it running: every `pnpm ledger` command talks to it. You restart it once, in step 6, so that it reads the waiver's pack file. On a database without the fictional organizations the local sign-in screen offers none of them and asks for the development token `pnpm org:create` prints (step 2); Enter in that field opens it.

**Running `pnpm dev` from an agent's shell.** Start it in the background with its output in a git-ignored log, and keep its process id:

```sh
mkdir -p .local
pnpm dev > .local/dev.log 2>&1 &
echo $! > .local/dev.pid
```

Wait for `curl -sf http://127.0.0.1:4000/readyz` to answer before the first `pnpm ledger` command: `/healthz` answers while the API is listening, `/readyz` only while it also reaches its database as its own restricted role; the web app is at http://127.0.0.1:5173. To stop Ledger, `kill $(cat .local/dev.pid)`, which stops the API, the workers and the web app with it; to restart it, stop it and run the three lines above again. Never stop it by a process name or a pattern: that can end your own shell. While the database restarts, the API answers 503 with "Ledger cannot reach its database right now" and carries on once it is back; nothing waiting in the queue is lost. If `pnpm dev` has stopped all the same, read the end of `.local/dev.log`, tell the operator what it says, and start it again.

**Another stack on this computer.** Ledger's local stack uses fixed ports unless you change them: the API on 4000, the web app on 5173, the emulators on 4002 and 4003, PostgreSQL on 54329, object storage on 9090 and the broker on 1883 and 1884. If `docker compose up` or `pnpm dev` stops with "port is already allocated" or `EADDRINUSE`, another stack holds them, and `/readyz` on 4000 may answer "ready" from that stack, which is not yours. Do not stop or reuse it. Run your own on other ports with settings only: start the services with `docker compose -p <a project name of your own> -f infra/compose.yaml -f infra/compose.other-ports.yaml up -d --wait`, and set the ports in `.env` as the table in [AGENTS.md, "Running a second stack"](../../AGENTS.md#running-a-second-stack) lists (`PORT`, `LEDGER_WEB_PORT`, `CORS_ORIGINS`, the three database URLs, `S3_ENDPOINT`, the emulator and simulator ports, `LEDGER_API_URL`). Use your API's port everywhere this guide says 4000, also in `.ledger/credentials`. Whichever ports you use, once you have a credential (step 3), `pnpm ledger me` must name the organization you created in step 2: that, not `/readyz`, says the stack that answers is your own.

**A server is a person's job.** If the operator wants Ledger on a server other people use, the installer follows [Deploy Ledger](deploy.md): the database, the identity provider, backups. You can then do every later step against that server's address, with a credential issued to you (step 3). There the pack files you build go in `packs/` at the server's checkout, which the deployment mounts ([Your own rule packs in the deployment](deploy.md#your-own-rule-packs-in-the-deployment)), and the nightly backup is `infra/backup.mjs` on a schedule ([section 9](deploy.md#take-a-backup)).

## 2. Create the organization

```sh
pnpm org:create --name "<the organization's name>" --time-zone <its IANA time zone, such as America/Denver> --admin "<the first administrator's name>"
```

Ask the operator for the three values; do not guess the time zone. Every screen and every date you give later is read in that zone. Running it again changes nothing.

On a local database it prints a development token once: it is the administrator's, and it acts as that person. Tell them it is theirs and have them keep it: they sign in to the web app with it, and they give it as `LEDGER_TOKEN` in their own terminal when they adopt a pack (step 7). It does not go in `.ledger/credentials`, which holds your credential (step 3). On a server the administrator signs in through the identity provider instead, and no token is printed. If the token is lost, the person at this computer replaces it, and the lost one stops working:

```sh
pnpm development-token:issue --organization <organization id> --for "<the administrator's name>"
```

Now start Ledger and leave it running, in its own terminal or in the background as step 1 shows:

```sh
pnpm dev
```

## 3. Your own credential

Work under a credential issued to you as a service, not under a person's. A service may import records and read; it cannot adopt a pack through this client, sign or accept a risk. Issuing it grants authority, so the administrator runs this (on a server, the installer, with the server's environment):

```sh
pnpm credential:issue --organization <organization id> --for "Records agent" --label "Coding agent on <which computer>" \
  --add service --capability input:write --capability evidence:read --capability flight:read \
  --grant operator-records:operator.record
```

The organization id is the `tenant-…` id `pnpm org:create` printed. The secret is printed once; the person puts it in `.ledger/credentials`. Do not ask for `pack:adopt`, `decision:write`, `authority:write` or any `risk:accept` capability for yourself. Then check who you are:

```sh
pnpm ledger me
```

It prints the name, whether it is a person or a service, the organization and its time zone, and what the credential may do. If you are trying Ledger on a local computer with the person beside you, you may use their development token for importing and reading while they watch; the adoption is still theirs to send.

## 4. Read what Ledger expects

```sh
pnpm ledger records types                    # every record type and what it is about
pnpm ledger records columns flight.plan      # each column: required or not, what it holds, what it means
pnpm ledger records template flight.plan --out organization/records/flight.plan.csv
pnpm ledger packs list                       # the latest version of each rule pack this Ledger offers (--all: every version)
pnpm ledger packs show ledger.part107        # a pack's rules, how each is checked, what it asks on adoption
pnpm pack:kinds duty.within-limits           # what a check kind asks, its inputs and every parameter (all kinds without a name)
```

Start with the record types the operator's rules read. For a Part 107 operator with a waiver these are usually: `aircraft.identity`, `aircraft.inspection`, `maintenance.action`, `person.standing`, `person.certificate`, `person.training`, `organization.procedure`, `flight.plan`, `operation.role-assignment`, `operation.notification`, `flight.preflight-assessment`, `flight.record`, and `occurrence.emergency-deviation`. An operator whose rules read duty and rest adds `crew.duty-period` and `person.rest-assessment`. `pnpm ledger packs show <pack>` and the build's printout (step 6) name the record types each rule reads. `records columns` also ends with how a rule reads that record type: the observation type, the selection if any, and the path of each column. Most record types are read inside `operator.record`; duty or rest periods (`crew.duty-period`) are stored as observations of their own type, and the printout says so.

**A record no type holds.** When the operator keeps a record, or a field of one, that no record type has, do not force it into another type's columns and do not change Ledger's code. Declare the type in the operator's own procedure pack (step 6): its fields in the operator's words, the unit of each number, the options of each choice, and what the record is about. [Write a rule pack, "Declare a record type"](write-a-rule-pack.md#declare-a-record-type) shows how, and `examples/declared-record-type/` is a pack to copy. The organization has the type once a person adopts the pack, with or without rules; from then on `records types`, `columns`, `template`, `check` and `import` take it like any other. Ask the person for each field's label, unit and options rather than guessing them: a later version of a declared type may add fields, but never removes one or changes its unit.

The template's headings are the stored form. A heading may name the unit or the time zone the spreadsheet uses instead, and Ledger converts and keeps what was entered. For a logbook kept in local time and feet:

```csv
subjectId,secondarySubjectId,takeoffAt [local],landingAt [local],maxHeightFlownAboveGround [ft]
FLT-2026-1101,RIDGE-AC-1,2026-11-10 09:05,2026-11-10 09:47,148
```

## 5. Turn the spreadsheets into import files

Make one CSV file per record type, with the header row from `records template`. Leave the operator's own files in `received/` untouched.

**An export the operator already has.** When the records come from a log service's or a spreadsheet's CSV export with its own headings, US-style dates, feet and knots and its own words, do not rewrite it and do not write a script for it. Write a column mapping instead: a small YAML file, kept beside the export, that says which column is which field, the unit of each number, whether the times are in the organization's zone or UTC and how they are written, the export's words for a field's options, values the export never states because they are the same on every row, and rows to leave out. Start one from the export's header row; it lists every column, unassigned, and the record type's fields as comments, and guesses nothing:

```sh
pnpm ledger records mapping flight.record organization/received/flight-log.csv --out organization/records/flight-log.mapping.yaml
pnpm ledger records check flight.record organization/received/flight-log.csv --mapping organization/records/flight-log.mapping.yaml
pnpm ledger records import flight.record organization/received/flight-log.csv --mapping organization/records/flight-log.mapping.yaml
```

Give each column the field it holds, or leave it `~` (not read). Ask the person for the zone and the unit when the export does not say; a mapping never assumes one, and a number column without a unit, or a time column without a zone, is refused when the mapping is loaded. The check prints what each column of the export became, which columns were not read, the values the mapping states, the rows it left out, and every refused row with its reason, in the same words as for an import file. Ledger keeps the export as it was received and the mapping beside it, and each record cites the export's own row and names the mapping. A mapping holds no formula: a value that needs arithmetic or two columns put together is not something a mapping does, so ask the person. `examples/first-operator/records/flight-log.mapping.yaml` reads `flight-log.export.csv`, and [Operator record import, "Column mappings"](../design/operator-record-import.md#column-mappings) lists every key. Everything below about ids, times, units and missing values holds for a mapped export too.

- **Their own ids.** An aircraft, a pilot or a flight exists in Ledger once a record names it, under the id the operator already uses: the fleet or tail number, the employee or pilot number, the job or flight number. Use the same id in every file, exactly: `AC-1` and `ac1` are two aircraft. Do not invent ids where the operator has them; where they have none, ask, and write down the ones you agree.
- **Who a record is about.** `subjectId` is the aircraft, person or flight the record is about. A flight plan's aircraft goes in `secondarySubjectId`; a role assignment is about the flight and names the person in `personId`. A record about the organization itself, such as a procedure, has no `subjectId`. The Part 107 rules about a remote pilot (the certificate, knowledge recency) cover the people a role assignment names as `pilot_in_command`, and those about the crew (fitness, alcohol and drugs) the people it names in a crew role; a maintenance lead or a safety manager no assignment names is not counted by them. A pilot who flies none of the flights on file is designated by a role assignment about the organization (`subjectKind` `organization`, `role` `pilot_in_command`, `endsAt` empty). The proposed Part 108 rules about operations personnel still cover every person on record.
- **Times and dates.** Keep the spreadsheet's local times and say so in the heading: under `takeoffAt [local]` a time written `2026-11-10 09:05` (or `2026-11-10T09:05`) is read in the organization's time zone. A time with its offset (`2026-11-10T09:05-07:00`) or in UTC (`2026-11-10T16:05:00Z`) is read under any heading. Ledger stores UTC and keeps what was entered, and the zone, with the record. A local time the clocks skip or repeat when daylight saving changes is refused with a sentence saying so: give that one with its offset. Anything else, such as `11/10/2026 9:05 AM`, is refused in an import file: read the export through a column mapping that names its style (`style: MM/DD/YYYY h:mm A`) rather than rewriting it, and ask the person when the spreadsheet does not say which zone it used. A date is `2026-11-10`.
- **The column that places a record.** Each record type has one time column that places it in time (`records columns` marks it "places the record"), such as `notifiedAt` for a notice or `inspectedAt` for an inspection. A row with it empty is refused, not recorded as incomplete. When the operator wrote down only the day, write the date alone there (`2026-10-05`): it is read as that day in the organization's time zone, kept as a day, and a check with a deadline reads the instant of that day least favourable to the operator and says only a date is on record. Never make up a time of day. A date alone in the column that ends a record's period (`windowEndsAt`, `landingAt`, `endsAt`, `removedAt`, `nextDueAt`) is the end of that day, as an adoption's `--until` is: a flight plan whose window has only the day of the flight gives that date as both `windowStartsAt` and `windowEndsAt`, and the window is the whole day. The columns that say when a report or a notice was made take a date alone too (`reportedToAuthorityAt`, `reportedToManufacturerAt`, `reportedToServiceProviderAt`, `includedInSummaryAt`, `authorityNotifiedAt`): "FAA notified 8/17/26" is `2026-08-17`, and a rule reads the report as made by the end of that day and says only the date is on record. `records columns` marks every column that takes a date alone. Other time columns take a time.
- **Units.** Heights, distances and speeds are stored in metres and metres per second. Keep the operator's unit and name it in the heading, such as `plannedMaxHeightAboveGround [ft]` or `plannedMaxGroundSpeed [kt]`; the names a pilot writes are accepted (`ft`, `mi` or `sm`, `nm`, `kn`, `kt` or `kts`, `mph`), and `records columns` lists them for each column. A cell may carry its own unit after the number (`300ft`, `104 m`, `35%`), which wins over the heading's, so a column where pilots wrote different units imports as it is; what was entered is kept. Words after the unit, such as `380 ft AGL`, are refused with a sentence saying what to remove. Never convert by hand.
- **Fixed values.** A column with a list of values takes one of them, such as `beyond_visual_line_of_sight`, or its label, in any case and with spaces around it (`Inspection` is `inspection`). Nothing else is guessed: map the operator's other words to the list, such as `BVLOS`, under `words` in a column mapping, and show the person the mapping when it is not obvious.
- **Duty and rest periods.** Each period from the operator's schedule is a `crew.duty-period` record under the operator's own period id (`periodId`), with its kind (`duty`, `flight_duty` or `rest`), start and end. A `person.rest-assessment` names the periods it relied on by those ids. These are the periods the duty and rest rules read. Do not make rest periods up from the gaps in a sheet that records duty alone: when the organization records every duty period, the person who adopts the crew pack says so (`dutyRecordComplete`), and the rules then read the time between two recorded duty periods as rest and say so.
- **What a logbook row holds.** A flight record (`flight.record`) holds, besides takeoff, landing and height, the wind and gust at takeoff, the visibility at takeoff and the battery remaining at landing, so rules can compare them with the operator's limits when no aircraft or site reports them. An inspection (`aircraft.inspection`) states when the next is due as a time (`nextDueAt`), as hours in service (`nextDueTimeInServiceHours`), or both; the aircraft's hours come from its latest total (`aircraft.time-in-service`) and the flight records since. A detect-and-avoid check the pilot ticks before a flight is an `aircraft.detect-and-avoid` record of that aircraft. From a log with a tick per flight and no time, import one record per tick: `checkedAt` the date alone, and the flight it was ticked for in `secondarySubjectId` (the flight's own id, as in its plan). The check then counts for that flight only, and a flight with no tick gets no record, so the waiver's check says none is on file for it, whatever was ticked for the flights around it. A check dated a day that names no flight counts only for the aircraft's first flight that day and never for a later day, so name the flight whenever the log says which one it was. A check with a time needs no flight named: it counts for the aircraft's next flight. An inspection made for a flight may name it the same way (`secondarySubjectKind` `flight` for `aircraft.inspection`).
- **Docks, ground stations and sensors.** A dock, a ground station, a battery or a sensor kept apart from an aircraft is a `component`, under the operator's own id for it (`D-03`). Its inspections are `component.inspection` records about it, its repairs and replacements `maintenance.action` records with `subjectKind` `component`, and a life-limited part installed on an aircraft is a `component.life-limit`. A flight plan names the dock or ground station a flight uses in `dockId`. What the rules read: the waiver obligation `maintenance.dock-inspected-within-days` reads the inspections of the dock the plan names ("The latest inspection of D-03 on file before takeoff … was made …, 45 days before it; the rule allows at most 30 days.") and, where a plan names none, says no dock or ground station is named on the flight plan; `maintenance.inspected-within-days` reads only the aircraft's own `aircraft.inspection`, so never record a dock's inspection as the aircraft's. A dock's and a sensor's availability for an aircraft are fields of `aircraft.system-availability` (`dockId`, `dockStatus`, `sensorStatus`), which the proposed Part 108 rules read; a dock's own wind measurement reaches the site's rules through an adapter as a `weather.wind` report, not as a record.
- **Training of two programs.** A training record's `program` says which program it counts towards: `remote_pilot_certificate` for the Part 107 knowledge test and its recurrent training, `operator_program` for the operator's own courses. Fill it on every row; the Part 107 recurrent rule reads only its own, so a company recurrent course on another date is never taken as a second date for it.
- **Missing values.** Leave a cell empty when the spreadsheet has nothing. Never fill in a value that is not in the operator's records: a record without a required value is still recorded, marked incomplete, and that is what the operator needs to see.

Check each file, then import it:

```sh
pnpm ledger records check flight.plan organization/records/flight.plan.csv
pnpm ledger records import flight.plan organization/records/flight.plan.csv
```

`check` makes no record: no row is recorded and no rule reads the file. Ledger keeps the file itself as an upload, as it keeps every file it is sent, and the command says so. It says, row by row, what would be recorded, what is incomplete, each unit it converted, and why a row would be refused, in plain words. Fix the file and check again until nothing is refused that should not be. `import` first says who the records will be recorded as, then records them; a refused row never stops the others, and the command exits non-zero when any row was refused. When no row was recorded it says so. Importing the same file again records nothing twice.

A flight that has flown gets a `flight.record`: the operator's own logbook entry, with `takeoffAt` and `landingAt`. Where no aircraft or service reports to Ledger, that record is what rules read for the flight's times, its duration and the height flown, and what an aircraft's time in service is added up from.

**Operating areas** are records too, one row per area in `organization.operating-area`, by the operator's own id for it (`RIDGE-AREA-1`). A circle is a `center` written `39.5000, -105.2000` (latitude, longitude, in decimal degrees) and a `radiusMeters`; a corridor along a line is its `corridorPoints`, latitude, longitude pairs separated by semicolons, and a `corridorHalfWidthMeters`. A radius or half-width is at most 50,000 m. `startsAt` is when the area came into force; leave `endsAt` empty while it is. Take the shapes from the approval or the operator's maps, and ask when they are not written down. `examples/first-operator/records/organization.operating-area.csv` has one of each.

An occurrence the operator determined needs no report to the authority (a bird seen near the aircraft, say) is still recorded, with `notReportable` true and `notReportableDecidedById` the person who decided; a reporting rule then leaves it out and says who decided. A property or unauthorized-area event says the same with `meetsReportingCriteria` `no`.

Import what flights name before the flights: aircraft and people first, then plans, assignments, notices, assessments, flight records and occurrences. `pnpm ledger records list flight.plan --subject <id>` shows what is on file, with each record's Ledger id.

**A correction** is a new row whose `replaces` column holds the Ledger id of the record it corrects. Nothing is edited or deleted; the earlier record stays, marked as replaced.

### From an autopilot's log

When the operator's flights are in the aircraft's own logs rather than in a logbook, read each log with `records read-log`. It reads a PX4 log (`.ulg`), an ArduPilot DataFlash log (`.bin`), a MAVLink telemetry log a ground station saved (`.tlog`), or a GUTMA flight log a fleet or dock product exported (a JSON file; [what differs for one](#a-gutma-flight-log) is below). It tells which from the file's own first bytes, never from its name (or take `--format ulog|dataflash|tlog|gutma`), runs offline and sends nothing to Ledger:

```sh
pnpm ledger records read-log organization/received/logs/2026-11-10-ridge.ulg --out organization/records/2026-11-10-ridge.flight.record.csv
pnpm ledger records check flight.record organization/records/2026-11-10-ridge.flight.record.csv --original organization/received/logs/2026-11-10-ridge.ulg
pnpm ledger records import flight.record organization/records/2026-11-10-ridge.flight.record.csv --original organization/received/logs/2026-11-10-ridge.ulg
```

It writes one `flight.record` row per whole flight in the log, in the import template's columns, and prints per flight what it read and what it could not. A flight runs from the moment the log's land detector says the aircraft left the ground after arming to the last moment it says it is on the ground again before disarming; a log with no land detector (a PX4 log without `vehicle_land_detected`, an ArduPilot log without its landing events, a telemetry log without `EXTENDED_SYS_STATE`) gives flights from arming to disarming, and the printout says which rule each flight used. Arming and disarming without leaving the ground is not a flight. What it fills in, and only when the log holds it:

- `takeoffAt` and `landingAt` in UTC, from the log's absolute time: the GPS receiver's UTC time in a PX4 log, the GPS week and time less leap seconds in an ArduPilot log, and the ground station's clock in a telemetry log. A log with no absolute time (no GPS, as on a bench test) gives no times, and the printout says so; the duration is still printed, from the log's own clock. A row without `takeoffAt` is refused by `check` until a person writes the time.
- `takeoffLocation` and `landingLocations` as latitude, longitude: the estimator's position, or the GPS receiver's with a 3D fix when the log has no estimate. Every touchdown of the flight is listed, the last one where it landed.
- `heightNotes`: the greatest height with the reference the log states (above home in an ArduPilot or telemetry log; above the takeoff point, the greatest altitude less the altitude at takeoff, in a PX4 log) and the greatest altitude above mean sea level. No autopilot's log holds the height above the ground, so `maxHeightFlownAboveGroundMeters` is left empty and the row is incomplete until a person writes it.
- `flightPathReference`: the log's file name, its SHA-256, the flight's number and where its messages are in the file.

The flight's own id (`subjectId`), the aircraft (`secondarySubjectId`), the wind, the battery and everything else are left empty: ask the person and write them in the CSV before `check`. A PX4 log may name the vehicle by its processor id (`sys_uuid`) and a telemetry log by the autopilot's `uid`; the printout shows it, but it is not the operator's own id for the aircraft. A log that ends early or is damaged is read up to that point: the printout says where the reader stopped and which flights before it are whole, and a flight it does not hold to its end is not written. With `--original`, Ledger keeps the log itself as each record's original and the CSV as the reading of it, as it keeps an export beside its mapping; a log larger than 10 MB cannot be kept yet. `--original` and `--mapping` are not given together.

**How far each reader has been checked.** Each was built from the format's published description (the PX4 "ULog File Format" page, ArduPilot's `LogStructure.h` and `AP_Logger.h`, the MAVLink serialization and common message set, and the Global UTM Association's `Flight_logging_protocol.md`), and its unit tests read logs built by encoders written from the same descriptions, with invented coordinates. On 2026-11-25 each of the three autopilot readers was also run against public sample logs, kept out of this repository:

- PX4 ULog: four samples from the `pyulog` project's tests. `sample_px4_events.ulg` gave one flight of 11.4 s from the land detector, with UTC from `vehicle_gps_position` and positions from `vehicle_global_position`; `sample_log_small.ulg` gave one 1.1 s flight (the land detector said in the air for that long) and the vehicle's `sys_uuid`; `sample.ulg` and `sample_appended_multiple.ulg` never show the vehicle armed (no flight; the first has no GPS and so no absolute time, the second has appended data). Not checked: a log from PX4 1.14 or later with `sensor_gps`, a multi-flight log, a plane or VTOL log.
- ArduPilot DataFlash: a 5 MB ArduCopter log from the ArduPilot Methodic Configurator's vehicle templates gave one flight of 1 min 57 s from the landing events, with UTC times that match the local time in the log's file name, and heights above home from `POS`. The file ends part-way through its last message, which the reader reports. The `pymavlink` test file `test.BIN` (64 KB of an ArduPlane log, cut short) gave no flight. Not checked: ArduPlane or Rover flights, logs older than the `TimeUS` clock (read from the description only), a log with more than one GPS.
- MAVLink telemetry log: `vtol.tlog` from the UAV Log Viewer project gave one flight of 2 min 56 s, and `flight.tlog` from `pymavlink`'s test data gave 11 flights, all from arming to disarming because neither holds `EXTENDED_SYS_STATE`; every packet the reader decodes passed its checksum, including the one `AUTOPILOT_VERSION` in `vtol.tlog`, whose `uid` is zero, so no vehicle identifier was read. Both are MAVLink 1. Not checked: a log with `EXTENDED_SYS_STATE` or a nonzero `uid`, MAVLink 2 packets (built from the description and the unit tests only), a signed stream.
- GUTMA flight log: built from the description in the Global UTM Association's `flight-logging-protocol` repository (approved for release in March 2018; its example gives the protocol version as 1.0.0) and checked against logs the unit tests built from that description. It has been checked against no product's real export, and will say so here until someone with one reports what it read. Test it against your own product's export, comparing the times and places it reads with what the product shows, before you rely on it for an operation. Not checked: an export from FlytBase, Auterion Suite or any other product; which name a product gives a landing event; whether a product writes one flight or several to a file.

No reader has read a log from the operator's own aircraft. Read the printout of the first log against the operator's own logbook for that day before importing many.

#### A GUTMA flight log

Some fleet and dock products do not hand out the autopilot's log. They export a flight as a GUTMA flight log: the Flight Logging Protocol the Global UTM Association publishes, a JSON file. FlytBase and Auterion Suite each document such an export. `records read-log` reads one with the same three commands and writes the same columns. What differs:

- **Recognition.** The file is recognised by its content, a JSON document that begins with an `exchange` object. A JSON file that is something else is not a format the command reads. A file that is not valid JSON, is larger than 10 MB, names another `exchange_type` or `message_type`, or says it follows a later version of the protocol is refused with a sentence saying which.
- **Flights.** A flight runs from the log's take-off event to its landing event, and a log with two of each gives two flights. The format's description names the take-off event (`event_info` `TAKE_OFF`) and no landing event, so the reader takes `TAKE_OFF` or `TAKEOFF` as a take-off and, by its own choice, `LANDING`, `LANDED` or `LAND` as a landing; an event with any other name is listed in the printout as not read. Where the log records no take-off event, the flight begins at the start of logging; where it records no landing event at all, the flight ends at the last sample. That is the description's own rule (the start of logging "describes the beginning of the flight", and the last sample's time is the flight's duration), the printout says it for each flight, and a person checks those times and places against what happened. The samples are never searched for a takeoff or a landing. A take-off with no landing after it, in a log that does record landings, is reported as not whole and is not written.
- **Times.** `takeoffAt` and `landingAt` are the start of logging the log states (`logging_start_dtg`) plus the event's or sample's seconds from it, in UTC. A log that states no start, or states one with no time zone, gives no times, and the printout says why.
- **Heights.** The greatest altitude (`gps_altitude`) goes to `heightNotes` with the datum exactly as the log names it in `altitude_system`: `MSL`, `WGS84` or `AGL`. Only when the log says `AGL` is it also written to `maxHeightFlownAboveGroundMeters`, for a person to check. With no `altitude_system`, one the description does not document, or units other than `Metric`, no height is written and the printout says why.
- **The aircraft.** The manufacturer, model, name, serial number, firmware and hardware the log gives are printed for a person. No id column is filled from them: `secondarySubjectId` is the operator's own id for the aircraft.
- **What is not read.** Of each sample the reader reads `timestamp`, `gps_lon`, `gps_lat` and `gps_altitude`, by name whatever their order. Every other key in the file (speed, battery voltage, the ground station, the payloads, the project) is listed in the printout as not read.
- **`flightPathReference`** gives the whole file as each flight's bytes, since a JSON document has no messages to point at.

## 6. The waiver as a rule pack

The waiver becomes two files, and the operator reviews both.

```sh
pnpm pack:new organization/waiver --kind waiver
```

**`source.txt` is the waiver exactly as issued.** Copy its text from the document the authority issued: every word, number and line of the special provisions. Do not reword, summarise, correct spelling or reorder. If you have only a scan, type it out and ask the person to compare it with the original line by line.

**`pack.yaml` describes the certificate and each provision.** The comments `pnpm pack:new` wrote list every obligation type and its parameters.

Under `waiver`, state what the certificate itself says: its number, the dates it is effective, and which flights its conditions cover. Most operators fly some flights under the waiver and the rest under the regulation alone: then the conditions cover `flights whose plan cites the certificate`, and a flight plan cites it by carrying the certificate number in `operatingAuthorityReference`. Ask the person which it is; the build refuses a waiver that does not say. A flight the waiver does not cover is recorded as "Does not apply" under each provision.

For each special provision:

- `quote` is words copied from `source.txt` unchanged, usually the whole sentence that carries the obligation.
- `obligation` is the type that asks what the provision asks, with the values the waiver states as `parameters`: the listed pilots by the ids you used in the records, the registration numbers as written, the height in feet, the hours of notice.
- A provision that permits what a regulation otherwise forbids names that regulation's rule under `relieves`. `pnpm pack:list ledger.part107` prints the rule ids.
- A provision no record can show, such as keeping one aircraft at a time, gets `coverage: manual` and a `waitingFor` sentence saying what a person confirms. Do not stretch an obligation type over a provision it does not fit.

`examples/first-operator/waiver/` is a sixteen-provision waiver described this way. Build it:

```sh
pnpm pack:build organization/waiver --out organization/packs
```

The build prints every rule it made: the words it quotes and from which line, who it covers, what it reads and the values it uses. **Read this printout back to the person, provision by provision,** next to the waiver, and change `pack.yaml` until they agree each rule asks what the provision says. When the build refuses a quotation, it says how many words matched and what the source says after them.

Then set `LEDGER_PACKS_DIR` to the full path of `organization/packs` in `.env` (on a server, copy the pack files into the deployment's `packs/` folder instead, as [Your own rule packs in the deployment](deploy.md#your-own-rule-packs-in-the-deployment) says) and restart Ledger: stop `pnpm dev` and start it again. Ledger reads the folder only when it starts. `pnpm ledger packs list` then shows the pack as "your file".

A rule written by check kind, for a provision no obligation type fits or for the operator's own procedures, takes each record type the way `pnpm ledger records columns <type>` prints at its end: the read's `type`, its `where` if any, and the path of each field (`values.record.<field>` for most types, `values.<field>` for duty or rest periods), with `.id` after a field that names a site, person or aircraft (`values.record.siteId.id`). `pnpm pack:kinds <kind>` prints what a check kind asks, the inputs a rule names its reads after, and every parameter with whether it is required and its unit. Write a limit with the unit the source uses (`limit: 5 sm`, `limit: 22 kt`, `maxDutyHours: 12 h`); the build keeps it in the stored unit and refuses a misspelt field, a unit of the wrong quantity, or a read that selects duty periods inside `operator.record`, where none are. [Write a rule pack](write-a-rule-pack.md#a-rule-by-check-kind-start-to-finish) works one through from a manual's sentence, with a table of which check kind fits which provision, and a complete rule over duty and rest periods.

The operator's own manual is described the same way with `pnpm pack:new organization/manual --kind procedure`. A paragraph one of the waiver's obligation types fits, such as a dock inspected within so many days, goes under `provisions` exactly as in a waiver; an obligation written under `rules` is refused with that sentence.

The printout names every record and field by the label the Records screen shows. Building a new version with `--out` into the folder that holds the earlier one, the build compares each rule with that version: a rule whose definition changed gets the next rule version, the others keep theirs, and the printout lists the rules that changed.

A pack version never changes once built. To change a rule, raise `version` in `pack.yaml`, build again and restart; then prepare the adoption of the new version exactly as in step 7. The client sees the earlier version adopted and prints that the new version replaces it, which adoption, and when the earlier one ends and the new one starts. Without `--from` the new version takes over from now, and every day before stays under the earlier one. A correction usually belongs on every day the earlier version covered: give `--from` the earlier adoption's first day (or earlier), and the new version replaces it for its whole period. The client then prints that the earlier version is in effect at no time; it stays on the record as replaced, every flight, person and aircraft it covered is evaluated again under the new version, and a finding it opened stays open with the new version's result as its latest, so a finding the correction answers shows as cleared for its owner to close. An `--until` given with it is at or after the earlier adoption's end. A `--from` after the earlier first day takes over from that time only.

## 7. Prepare each adoption for the person

An adoption is a person's decision: which pack, which version, active or shadow, from when until when, with which values, and why. The client sends it only with that person's credential and reason. Prepare it by printing it:

```sh
pnpm ledger packs adopt ledger.part107 --mode active --from 2026-06-01 --until 2028-05-31
```

It prints the pack and version, how many rules are checked automatically or by a person, the mode, the exact instants of the dates in the organization's time zone, each value it will set, and who it would be recorded as, and sends nothing. A date is a day in the organization's time zone: `--from` is the start of that day, `--until` the end of that day.

- **Mode.** Adopt as `active` what the operator works under now: Part 107, its waiver. Adopt a proposed rule, such as `ledger.part108-nprm`, as `shadow`: its results are recorded and labelled and never counted in what a person attests to. Ledger refuses a proposed rule in active mode.
- **Dates.** For a waiver pack that states its certificate's dates, the printout shows them, and without `--from` and `--until` the adoption runs over them and says so. For a regulation, ask the person. An adoption checks the flights inside its dates: to have earlier flights checked, the dates start on or before the earliest of them. With a start after them, flights already imported are not checked and flights imported later are, so do not rely on either; say which dates the person chose and why.
- **Values a pack asks for.** The printout names any value still needed. Give one with `--set <rule>.<name>=<value>`, or one value for every rule that asks for it with `--set-all <name>=<value>`. A rule that asks for a time zone gets the organization's, and the printout says so. Ask the person for every other value; do not choose one. The proposed Part 108 asks only for the first day of the organization's week (`--set-all weekStartsOn=1` for Monday). It asks for no operating area: its rules read the operating areas the organization records (step 5).

Show the person the printout. They adopt by running the same command with their own credential and `--reason "<their reason, in their words>"`:

```sh
pnpm ledger packs adopt ledger.part107 --mode active --from 2026-06-01 --until 2028-05-31 --reason "..."
```

Printing is all the client does without `--reason`, under any credential: it exits 0 and its last line says who sends it and how. With `--reason` and a service's credential it refuses to send, says why, and exits 1. Do not write the person's reason for them.

The same command handles a pack the organization has adopted already. For a newer version (a corrected waiver, say) it prints that the new version replaces the adoption over those dates, which one, and exactly when the earlier version ends and the new one starts, in the organization's time zone; the values the earlier adoption set are kept unless `--set` gives new ones. For the version already adopted it prints a revision with whatever `--mode`, `--from`, `--until` or `--set` changes, and keeps the rest. It never asks for an adoption id, and `--json` shows the command it sent. When Ledger is busy evaluating and answers `409 concurrent_change`, the client sends the adoption again on a fresh basis, up to six times in all, waiting longer each time (about 15 seconds in all), and says so each time. If it still gives up, nothing was recorded: it says so, and the same command is safe to send again a minute later.

## 8. Read coverage and findings, and report them

Rules are evaluated a few seconds after records and adoptions arrive. Then:

```sh
pnpm ledger coverage                                    # every adopted pack, rule by rule
pnpm ledger coverage --pack <pack> --result attention   # the subjects behind a count, with the sentence for each
pnpm ledger coverage --pack <pack> --rule provision-4   # one rule's subjects, every result
pnpm ledger findings list                               # the open findings grouped by rule, the rules with the fewest first
pnpm ledger findings list --rule 107.49.a               # one rule's findings, oldest first, with owner and sentence
pnpm ledger findings list --all                         # every open finding, oldest first
pnpm ledger findings list --proposed                    # the findings of rules adopted in shadow: recorded, never counted
```

Coverage prints a pack's rules under its sections, such as `§ 108.165 Area of operations`, each section with how many rules it holds and how many have a subject needing attention or a record not on file, and each rule beside the paragraph it reads. It prints each rule's title, how it is checked (automatically, by a person, not checked yet), who it covers, and its counts in the Rules screen's words: *Supported by the record*, *Needs attention*, *No record on file*, *Waiting for a record or a time*, *Relieved by a waiver*, *Does not apply*, *Not yet evaluated*. "Still being evaluated; the counts will change." means read it again shortly. `--result` takes those words, or their first word (`--result waiting`, `--result "no record"`), as well as the values (`attention`, `no_record`, `pending`, `supported`, `relieved`, `not_applicable`, `not_evaluated`). `--json` gives the same as data.

Report to the person in those words, with the operator's own ids, and nothing more. Say what is on file and what is not:

- "Provision 4 (maximum height): 2 flights supported by the record; FLT-2026-1102 needs attention: its planned height is above the 200 feet the provision states. FLT-2026-1103 does not apply: its plan does not cite the certificate."
- "Provision 6 (BVLOS course): no record of the course on file for RIDGE-P-03, the pilot in command of FLT-2026-1201."
- "Four provisions are for a person to review; no record shows them."

**"No record on file" is not a finding.** A rule that finds no record of what it reads (no detect-and-avoid check before a flight, no initial training for a pilot) says so in coverage, as *No record on file*, and opens no finding. Working `findings list` alone would miss every one of them.

Two kinds of rule are different: for them the absence is itself what the rule is about, so nothing recorded *needs attention* and opens a finding.

- **A rule about a deadline.** A notice that must be made before operations (a NOTAM 24 hours ahead), or a report that must be sent within a period after an event (to the FAA within 10 days): when no notice or report is recorded by the time it was due, the rule says "No record was made by …" or "has no report … recorded within …", and a finding opens. If the operator's log never kept when notices were made, every flight gets one; say so to the person rather than inventing the records.
- **A limit on a value the rule says must be reported**, such as the gust during a flight: when the flight's window has closed and no value was reported or recorded, the rule says "No value is reported for … in the window …" and a finding opens.

Everything else that finds no record is *No record on file*. The list therefore ends, for each adopted pack, with how many results say a record is not on file and the command that lists them, each with its rule, subject and sentence:

```text
Not on file is not a finding: a rule that finds no record of what it reads says so in coverage and opens no finding. Read these as well:
  Waiver 107W-EX-2026-00417 (example-ridge.waiver-107w-ex-2026-00417 version 1): 3 results under 2 rules say a record is not on file. Each, with its rule, subject and sentence: pnpm ledger coverage --pack example-ridge.waiver-107w-ex-2026-00417 --result no_record
```

Run that command and report each result as you report a finding, in its sentence and the operator's ids. Some are expected (a rule that reads a record the operator never kept); some are the gaps that matter most. Which is which is for the person to say.

Never turn a count into a conclusion: do not write that the operator is compliant, non-compliant, authorized, ready, safe, cleared or may fly, and do not say how a finding should be resolved. Taking, assigning and closing a finding are a person's decisions, made on the **Open findings** list under **Rules** or with `pnpm ledger findings take` and `close` and their own credential; the API refuses them from a service credential, as it refuses an adoption. A rule a person reviews is not passed because nothing is missing. If the person asks whether they may fly, say that Ledger reports what the records support and the decision is theirs.

**After importing history, expect many findings.** A few rules repeated for every flight make up most of them: a rule that reads a record the old log never held (a preflight assessment, a briefing) finds it missing on each flight. `findings list` prints the rules with the fewest findings first, so the rare ones lead: a pilot flying on expired training, a flight above its height, an event with no report. Report those first, by rule and in the operator's ids ("322 open findings under 14 rules; the first five rules hold one to three findings each: ..."). For a rule repeated on every flight, tell the person what it reads and that the log did not hold it; whether that is an answer is theirs. A person works such a rule down in two decisions, each covering every open finding of the rule, optionally narrowed by `--subject-kind` and by the days the findings are about (`--from`, `--until`):

```sh
pnpm ledger findings take --rule 107.49.a --until 2026-10-31 --reason "<their words>"
pnpm ledger findings close --rule 107.49.a --until 2026-10-31 --as accepted --reason "<their words>"
```

Each prints the findings first and sends nothing without `--reason` and a person's credential; `close` needs the person to own each finding (one `take` does that) and `--as` one of `corrected-by-record`, `accepted`, `condition-ended`, `recorded-in-error`. One decision covers at most 500 findings; narrow a larger set by its days. Ledger refuses the decision if the set changed after it was printed, as when a new flight was evaluated; run it again. Closing many says what closing one says: nothing is suppressed, and a later flight the rule finds the same about opens a new finding. An operator that wants a rule not to count adopts differently (in shadow, or a pack version without it); that is the person's decision. Do not run `take` or `close` for them, and do not write their reason.

When a count looks wrong, check the records before anything else: the id in two files that should match, the unit in a heading, the time zone of a time. Fix the import file and import a correction (step 5).

## 9. The records the rules require, and the recordkeeping plan

Once the packs are adopted, `pnpm ledger plan draft` prints a recordkeeping plan drafted from the records they require: for each, the words that list it, who the text says keeps it, the record types that hold it, what is on file, and how long the text says to keep it, in its own words. Read it to the person as it stands. It leaves blanks written `[To be filled in: …]` that only the operator can fill: who is responsible, where the deployment runs, how it is backed up, and for how long they undertake to keep it. Do not fill them yourself; ask. `--out plan.txt` writes the text to a file in the operator's folder for them to edit. `pnpm ledger plan draft --open` opens it as a draft controlled document owned by the person whose credential it is; with a service's credential the client refuses to open it and exits 1. Reviewing, signing and issuing it are the person's, under Safety, Documents; review and issue are refused while a blank remains.

Tell the person plainly: Ledger keeps every record and correction and removes none, but keeping the deployment and its backups for as long as each text asks is theirs. Never say the plan is adequate or that records are kept long enough.

When the operator is asked for records, a person decides what to produce and why:

```sh
pnpm ledger records produce --subject aircraft:RIDGE-AC-1 --type flight.record --from 2026-11-01 --until 2026-11-30 \
  --reason "<why, in their words>" --requested-by "<who asked>" --out ridge-flights.zip
```

It saves the .zip after checking it against its recorded SHA-256 and prints the manifest digest, which they keep apart from the file, and the verifier command that checks it offline. `--subject organization` takes the records about the organization itself; `--originals` includes the original files, and the output says when an original also holds rows about other subjects and how many, since it goes into the file whole. Each CSV shows every number and time as it was entered (`200 ft`, `2026-09-22 10:00 in America/Chicago`, `2026-10-05 (date only)`) beside the stored value. For a person (`--subject person:RIDGE-P-1`) the file lists the flights their records assign them to, with ids and times; `--with-flights` includes those flights' records as well.

## 10. What comes next, and whose it is

- **People who sign in** (the administrator): these are the people who use Ledger, not the crew list; a pilot who never signs in needs no entry. Prepare the list as names and presets: `pnpm ledger people presets` prints each preset (Dispatcher, Pilot, Safety manager, Administrator, Reader) and exactly the capabilities it grants; add a capability a preset lacks by name, such as `sms:adopt` for the person who signs the safety policy and risk matrix, or `decision:write` for someone who closes the actions they own. Adding a person grants authority, so the administrator adds each one, on the People screen or with their own token:

  ```sh
  pnpm ledger people add --name "<full name>" --preset safety --capability sms:adopt   # prints what it would record
  pnpm ledger people add --name "<full name>" --preset safety --capability sms:adopt --reason "<their reason>"
  pnpm ledger people list
  ```

  With your service credential `people add` prints the addition, exits 0 and says the administrator sends it; with `--reason` it refuses to send and exits 1. To change what someone already added may do (a capability the safety manager lacks, `risk:accept:high` for the person who accepts high risk), prepare `people set` the same way; it prints what they may do now and after, and the administrator sends it with their reason, which is kept with the change:

  ```sh
  pnpm ledger people set "<full name>" --capability risk:accept:high          # prints now and after
  pnpm ledger people set "<full name>" --capability risk:accept:high --reason "<their reason>"
  ```

  `--preset` and `--capability` add, `--remove-capability` takes one away, and `--grant` and `--remove-grant` do the same for what a person may record. The person is named by their full name or their Ledger id, as `people list` shows them.

  **Several people on one computer:** on a local database each person signs in with their own development token. The administrator issues it with `pnpm ledger people token "<full name>" --reason "<their reason>"` and their own token (without `--reason` it only prints what it would do), or on the People screen with "Issue a development token", and gives it to the person; it is shown once, and issuing another replaces the earlier one at once. Each person opens the web app, chooses "Use a development token" and pastes theirs, so a signature, an acknowledgement or a closed action is recorded as the person who made it. Development tokens are for a trial on a computer that faces no network. Real use by several people needs each person to sign in through the organization's identity provider: [Deploy Ledger, section 6](deploy.md#6-sign-in).
- **Safety records** (a safety manager and the people who sign): when the operator already keeps a safety program, follow [Bring your safety records](bring-your-safety-records.md). You write its matrix, hazard register, documents, audits and reviews as files in its own ids, check them, and, if the administrator gave your credential `sms:write` (and `sms:configure` for the matrix), open them as drafts with `pnpm ledger safety draft`; drafting a file again opens nothing twice. `pnpm ledger safety home` lists what is on file and what is not, what waits for a person, and actions due and overdue. Adopting the matrix and the documents, assessing and accepting a risk, reviewing and issuing a document, signing an audit or a review, closing an action and entering a safety report received before Ledger are a person's: print each with `pnpm ledger safety ...` without `--reason` and give it to the person, who runs it with their own credential and reason, or signs on the record's page in the browser on a deployment. Printing them, like `safety home` and every other safety command, reads the safety records and needs `sms:read`, which the step 3 credential does not have: print with the safety records agent's credential from [Bring your safety records](bring-your-safety-records.md) (`sms:read`, `sms:write`, `sms:configure`), given as `LEDGER_TOKEN` for those commands, or Ledger refuses with `403 capability_required`. A risk at a level the operator's matrix says nobody may accept cannot be accepted by anyone. The Safety screens show the same: who may adopt and accept risk, a risk matrix in force, a safety policy in force, who receives safety reports. Mark a training record `safetyTraining` yes when the operator says it is part of the safety program. A reporting link is issued by a person on the Safety reports screen and shown to them once; do not issue one yourself or keep a copy of it.
- **Aircraft, docks and airspace services** reporting directly: [Deploy Ledger, section 10](deploy.md#10-connect-a-source-run-an-adapter). Each source gets its own credential from the administrator.

## The client's commands

| Command | What it does | Needs |
| --- | --- | --- |
| `pnpm ledger me` | Who the credential is, its organization and time zone, what it may do | Any credential |
| `pnpm ledger records types` / `columns <type>` / `template <type>` | The record types, their columns, an empty CSV file | `evidence:read` |
| `pnpm ledger records check <type> <file> [--mapping <file> \| --original <file>]` | What importing the file would record; makes no record (the file is kept as an upload). With `--mapping`, the file is an export read through its column mapping | `input:write` |
| `pnpm ledger records import <type> <file> [--mapping <file> \| --original <file>]` | Imports a CSV or JSON file, or an export through its column mapping, keeping the export and the mapping, or a file read from a log, keeping the log as the original | `input:write` and the `operator-records:operator.record` grant |
| `pnpm ledger records mapping <type> <export.csv> [--out <file>]` | Starts a column mapping from an export's header row: every column listed and unassigned | `evidence:read` |
| `pnpm ledger records read-log <log> [--format ulog\|dataflash\|tlog\|gutma] [--out <file.csv>]` | Reads an aircraft's log, or a GUTMA flight log a product exported, into a `flight.record` CSV, one row per whole flight with only what the log holds, and prints what it could not read; offline | Nothing: it sends nothing |
| `pnpm ledger records list <type> [--subject <id>]` | The records on file, newest first | `evidence:read` |
| `pnpm ledger packs list [--all]` / `show <pack>` | The latest version of each pack this Ledger offers (`--all`: earlier versions too), and a pack's rules; for the organization's own pack file, the fields each rule reads | `flight:read` |
| `pnpm ledger packs adopt <pack> ...` | Prints the adoption, with a waiver's stated dates, and what it replaces: an earlier version adopted over the dates, or the same version, which it revises; sends it only with `--reason` and a person's credential | `pack:adopt`, a person |
| `pnpm ledger coverage [--pack] [--rule] [--result]` | Coverage by rule, and the subjects behind a count | `flight:read` and `evidence:read` |
| `pnpm ledger findings list [--pack] [--rule] [--all] [--proposed] [--subject-kind] [--from] [--until]` | The open findings grouped by rule, fewest first, ending with each adopted pack's results that say a record is not on file and the command that lists them; `--rule` one rule's findings and `--all` every one, oldest first, with owner; `--proposed` for rules in shadow | `evidence:read`, and `flight:read` for the count of what is not on file |
| `pnpm ledger findings take` / `close --rule <rule> ...` | Prints every open finding of one rule, then takes or closes them all as one decision, only with `--reason` and a person's credential; `close` needs `--as` | `decision:write`, a person |
| `pnpm ledger records produce ... [--from] [--until]` | Produces records on request as one .zip, saves it checked against its digest, prints the manifest digest | `evidence:read` |
| `pnpm ledger people list` / `people presets` | Everyone in the organization and what each may do; each role preset and exactly what it grants | `authority:write` for the list; any credential for the presets |
| `pnpm ledger people add --name ... [--preset] [--capability]... [--grant]...` | Prints the addition; sends it only with `--reason` and a person's credential | `authority:write`, a person |
| `pnpm ledger people set <person> [--preset] [--capability]... [--remove-capability]... [--grant]... [--remove-grant]...` | Prints what the person may do now and after; sends the change only with `--reason` and a person's credential, the reason kept with it | `authority:write`, a person |
| `pnpm ledger people token <person>` | On a local Ledger, prints the issue of a development token for the person; issues it, shown once, only with `--reason` and a person's credential | `authority:write`, a person |
| `pnpm ledger safety home` / `control-types` | What safety records are on file and what is not, what waits for a person, actions due and overdue; every control type and what a control of it needs | `sms:read` |
| `pnpm ledger safety template` / `check` / `draft <kind> <file>` | An example file; what drafting a file would open; opens each item as a draft under the organization's own id, nothing twice ([Bring your safety records](bring-your-safety-records.md)) | `sms:write` to draft (`sms:configure` for a matrix; a report: a person with `sms:report:read`) |
| `pnpm ledger safety assess` / `accept` / `adopt` / `review` / `issue` / `sign` / `close-action` | Prints a person's safety decision; sends it only with `--reason` and a person's credential, signing where it is signed | `decision:write` and the decision's own authority, a person |
| `pnpm ledger plan draft [--out] [--open]` | A recordkeeping plan drafted from the required records; opens it as a draft document only with `--open` and a person's credential | `evidence:read`; `sms:write` and a person to open |

Add `--json` to any command for the API's data. A command that prepares a person's decision exits 0 when it prints it without `--reason`, whatever the credential, and its last line says who sends it; with `--reason` under a credential that is not a person's, it refuses and exits 1. When Ledger refuses something the command exits with code 1 and prints Ledger's own sentence, such as `Ledger refused this (403 capability_required): Capability pack:adopt is required`; a mistake in the command itself exits with code 2, and so does an option the command does not read: it names the option and does nothing. The API reference, with what each route records or returns and the capability it needs, is `docs/openapi.json`, also served at `/openapi.json`.

## What was run for this guide

`tests/integration/first-operator.integration.test.ts` runs `examples/first-operator` through the client's own code in the integration suite: the organization as `pnpm org:create` makes it, the waiver built and loaded from a pack folder, every records file checked and imported, the unfixed file refused row by row, the flight log export checked through its column mapping, Part 107 and the waiver adopted as active and Part 108 in shadow, coverage and findings read; and, with a credential issued to a service as in step 3, records imported and read, coverage read, and an adoption refused by the client. `tests/integration/recordkeeping-plan.integration.test.ts` adopts Part 108 in shadow for a new organization with records on file, reads the required records, opens the plan with `plan draft --open`, fills its blanks, signs and issues it, and produces records with `records produce` and verifies the file offline. `tests/integration/development-tokens.integration.test.ts` changes what a person may do with `people set` and issues their token with `people token`, each with the reason kept. `packages/cli/tests/cli.test.ts` checks the command line's parsing and printing, and `packages/cli/tests/preparing-commands.test.ts` that every command preparing a person's decision exits 0 when it only prints under a service's credential and 1 when asked to send. `tests/integration/safety-records-from-files.integration.test.ts` runs [Bring your safety records](bring-your-safety-records.md) on `examples/first-operator/safety`. `run.sh` in the example was not run against a running local stack for this guide. If a test and this guide disagree, the test is right.
