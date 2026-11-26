# Crewed operations: what core would need

Status: a question looked into, nothing built. The question: what would an operation flown under 14 CFR Part 91, or under Part 135, need to keep on file in Ledger and have checked, that core cannot hold today? Which of it would a pack that declares record types cover ([declared-record-types.md](declared-record-types.md)), and what is left for core?

This note is a list for a contributor who wants to try. It does not say Ledger is ready for such an operation, and nothing in it makes anyone meet a rule. [How far this note goes](#how-far-this-note-goes) says who should correct it.

**Sources.** The regulation text is the eCFR as published on 23 November 2026: Part 91 (§§ 91.3, 91.103, 91.151, 91.203, 91.207, 91.213, 91.403 to 91.417), Part 135 (§§ 135.21, 135.63, 135.65, 135.95, 135.99, 135.107, 135.117, 135.185, 135.243, 135.244, 135.247, 135.263 to 135.267, 135.293, 135.297, 135.299, 135.411, 135.415, 135.419, 135.439, 135.443), and, where Parts 91 and 135 send the reader elsewhere, §§ 61.56, 61.57, 119.69 and 39.7. eCFR links an amendment to §§ 91.409 and 135.411 published on 10 November 2026; it was not read. The code is this repository's `main` as of the same week; paths are relative to the checkout.

## What core has today

- **Six kinds of subject**: `flight`, `aircraft`, `person`, `site`, `organization`, `component` (`observationSubjectKindValues` in `packages/contracts/src/observations/envelope.ts`; "a physical part with its own identity" is the component). A record has one subject and at most one related (secondary) subject, each of a kind its type lists. Other subjects are named by reference fields: `person`, `aircraft`, `site`, `component`, and `duty_period` for a duty or rest period (`operatorRecordReferenceKindValues` in `packages/contracts/src/observations/operator-records/define.ts`). No record can name a flight by reference.
- **Built-in record types**, in `packages/contracts/src/observations/operator-records/`: people (`person.standing`, `person.certificate`, `person.training`, `person.employment`, `crew.duty-period`, `person.rest-assessment`, `person.aircraft-experience`, `person.readiness-declaration`); aircraft and parts (`aircraft.identity`, `aircraft.time-in-service`, `aircraft.inspection`, `aircraft.condition`, `aircraft.system-availability`, `aircraft.detect-and-avoid`, `aircraft.payload`, `maintenance.action`, `component.life-limit`, `component.inspection`); operations (`operation.role-assignment`, `organization.coordinator-requirement`, `operation.multiple-aircraft`, `flight.plan`, `flight.preflight-assessment`, `flight.record`, `organization.operating-area`, `site.status`, `operation.notification`, `organization.procedure`, `organization.report`, `organization.review`); and six occurrence types.
- **Declared record types** (`packages/contracts/src/declared-record-types.ts`): a pack declares a type about one or more of the six kinds, with fields of eight kinds and numbers in five units (`Hours`, `Meters`, `MetersPerSecond`, `Percent`, `Count`). Compared with a built-in type, a declaration cannot state a related subject, name fields, a field required unless another is filled, or a replay-only field; its references may name only `person`, `aircraft`, `site` and `component`; and it cannot add a field or an option to a built-in type.
- **Roles are two different things.** What a person may do in Ledger is a set of capabilities (`capabilityValues` in `packages/contracts/src/index.ts`), with presets to start from (`rolePresets` in `packages/contracts/src/people.ts`: dispatcher, pilot, safety manager, administrator). What a person is in the operation (pilot in command, operations supervisor) is a record: `operation.role-assignment`, one person in one role, about a flight or, as a standing designation, about the organization. This reading found nothing that links a principal who signs in to a `person` subject on file.
- **A flight on record is an id.** Records name it as their subject; `flight.plan` and `flight.record` name one aircraft as related subject; people are named by role assignments, one record per person and role, and a rule fans out over them (at most 50 per evaluation, [fan-out-and-related-reads.md](fan-out-and-related-reads.md)). Separately, the live flight (`flight_views`, `packages/persistence/migrations/0001_foundation.sql`) has one `aircraft` column set by `flight.assign`, and a mission (`packages/contracts/src/missions.ts`) has one `aircraftId`, a route of at most 256 points and a height band above ground.

## What a crewed operation keeps, and where it could go

Each item says where the rule asks for it and one of three things:

- **Today**: a built-in type or core feature holds it as it is.
- **Declared, on _kind_**: a pack can declare a type about that kind of subject; "honest" when the record is plainly about that subject, "stretch" when it is not quite.
- **Core**: a change in core is needed, named in [the list of core changes](#the-smallest-list-of-core-changes).

### Kinds of subject

| What | Where | How it could be held |
| --- | --- | --- |
| A crew member who is not the pilot in command (second in command, flight engineer, flight attendant) | §§ 135.99, 135.107 | Today: a `person`; the position is on the role assignment. The role list lacks the positions (core change 4). |
| Passengers | §§ 135.63(c)(1), 135.117 | Declared, on `flight`, honest, as a count on the load manifest. Do not record a passenger as a `person`: a rule whose population is every person on record would then cover passengers; the Part 108 pack's rules about operations personnel are such rules. A record per passenger needs a new kind of subject. |
| Engine, propeller, rotor, appliance with its own times | §§ 91.417(a)(2)(i)-(iii), 135.439(a)(2)(i)-(iii) | Declared, on `component`, honest. Its installation on an aircraft is an interval record with an `aircraftId` reference, as `component.life-limit` already is. |
| Airport | § 91.103(b) | Declared, on `site`, honest: an airport is a place the operation uses, under its identifier. |
| Airworthiness directive | §§ 39.7, 91.417(a)(2)(v), 135.439(a)(2)(v) | Declared, on `aircraft` (or `component` for an engine's or propeller's), honest as a status record per aircraft. An AD is not a subject; a result for each AD needs a check kind over each record (core change 7), or a new kind of subject. Hanging an AD on `component` as if it were a part would be a stretch. |
| Inoperative equipment deferred under a minimum equipment list | § 91.213(a)(4) | Declared, on `aircraft`, honest. A result per open item needs core change 7. |
| A trip or a duty period of several legs | §§ 135.265, 135.267 | Today: each leg is a flight; the duty period is a `crew.duty-period` about the person, found by its time. No subject for the trip is needed for the time limits. |
| The certificate holder, its operations specifications and manual | §§ 135.21, 119.69(c) | Today: the `organization`, with the manual and the specifications as procedures or controlled documents on file. |

### Record types

| What | Where | How it could be held |
| --- | --- | --- |
| Each pilot's record: name, certificate and ratings, current duties and their date | § 135.63(a)(4)(i)-(iv) | Today, in part: `person.standing` holds name and duties. `person.certificate` offers a remote pilot certificate, a type rating or "other", and no ratings; a pilot certificate as "other" is a stretch. Declared, on `person`, honest: an airman certificate with its grade, number and ratings. |
| Medical certificate, class and date | § 135.63(a)(4)(v) | Declared, on `person`, honest. How long it lasts depends on its class and the pilot's age; one rule per class, each with its months, is the nearest today. |
| Competency tests, proficiency checks, instrument proficiency checks, line checks, with date, result and aircraft type | §§ 135.63(a)(4)(vi), 135.293, 135.297, 135.299 | Declared, on `person`, honest, with the check pilot as a `person` reference. |
| Flight review | § 61.56(c) | Today: `person.training` (kind "other"), or declared on `person`, honest. |
| Takeoffs and landings, by day and night, with the aircraft's category, class and type | §§ 61.57(a)-(b), 135.247(a) | Declared, on `person`, honest, as the pilot's logbook entry for a flight. It must name the flight it was flown on, which a declaration cannot (core changes 1 and 2). |
| Each crew member's flight time | §§ 135.63(a)(4)(vii), 135.265, 135.267 | Declared, on `person`, honest, as flight-time intervals; or the intervals of the crew member's role assignments, a stretch unless the operator records them from block out to block in. |
| Duty and rest periods | § 135.267(c)-(d) | Today: `crew.duty-period`. Its role list names unmanned positions only (core change 4). |
| Operating experience on a make and model | § 135.244 | Today, as a stretch: `person.aircraft-experience` has the role, the make and model and the supervised hours, but also requires recent hours, a recent period and a supervisor reference shaped for the proposed Part 108. Declared, on `person`, honest. |
| Training program phases | § 135.63(a)(4)(x) | Today: `person.training` with program "the operator's own training program". |
| Release from employment for disqualification | § 135.63(a)(4)(ix) | Today: `person.employment` (separation for cause and its details). |
| Current list of aircraft and what each is equipped for | § 135.63(a)(3) | Today: `aircraft.identity`. Category, class, seats and engines are declared, on `aircraft`, honest. |
| Airworthiness and registration certificates | § 91.203(a) | Today, in part: `aircraft.identity` holds the registration and its expiry. The airworthiness certificate is declared, on `aircraft`, honest. |
| Load manifest: passengers, loaded weight, maximum takeoff weight, centre of gravity and its limits, registration or flight number, origin and destination, crew and positions | § 135.63(c) | Declared, on `flight`, honest, with the crew as `person` references. It needs the aircraft as related subject (core change 1) and a unit of mass (core change 3). |
| Empty weight and centre of gravity from the last weighing | § 135.185 | Declared, on `aircraft`, honest. The weights need core change 3; the date of weighing needs nothing. |
| Annual, 100-hour and progressive inspections; altimeter, transponder and emergency locator transmitter tests | §§ 91.409, 91.411, 91.413, 91.207(c)-(d) | Today, in part: `aircraft.inspection` holds the result and the next due time or hours, but its kinds are "scheduled", "manufacturer interval" and the like, and its inspector is a name in text, so no rule can read whose certificate signed it. Declared, on `aircraft` (or `component` for a transmitter), honest, with the inspector as a `person` reference. |
| An inspection program and its items | §§ 91.409(e)-(g), 135.419 | Today: the program as a procedure or controlled document on file. Each item: declared, on `aircraft` or `component`, honest; a result per item needs core change 7. |
| Total time in service of the airframe | § 91.417(a)(2)(i) | Today: `aircraft.time-in-service` and later flights. |
| Total time, time since overhaul and life-limited parts of engines, propellers and rotors | §§ 91.417(a)(2)(i)-(iii), 135.439(a)(2)(i)-(iii) | Today for hours: `component.life-limit` and the aircraft's time in service, as the worked example in [fan-out-and-related-reads.md](fan-out-and-related-reads.md) reads them; an overhaul interval kept there as a life limit is a stretch. Declared, on `component`, honest, for time since overhaul and for cycles (`Count`). |
| AD status: number, revision, method, next action by time and date | §§ 91.417(a)(2)(v), 135.439(a)(2)(v) | Declared, on `aircraft` or `component`, honest; naming both needs core change 1. |
| Major alterations and repairs | §§ 91.417(a)(2)(vi), 135.439(a)(2)(vi) | Declared, on `aircraft` or `component`, honest, or a document on file. |
| Maintenance entries and the return to service, with the approver's certificate number | §§ 91.407(a), 91.417(a)(1), 135.443 | Today, in part: `maintenance.action` holds the work, the date and the return to service, but names the people in text and has no certificate number. Declared, on `aircraft` or `component`, honest, with `person` references. |
| Maintenance log of irregularities, their correction or deferral | § 135.65 | Today, in part: `occurrence.mechanical-irregularity` holds the irregularity and corrective action; a deferral is declared, on `aircraft`, honest. |
| Service difficulty reports | § 135.415 | Today: the irregularity record with its time reported to the authority, or a declared occurrence on `aircraft`. |
| Passenger briefing | § 135.117 | Declared, on `flight`, honest; or a rule with manual coverage that a person confirms. |
| Preflight action: weather, fuel, alternates, runway lengths, takeoff and landing distances | §§ 91.103, 91.151 | Declared, on `flight`, honest, with fuel endurance in `Hours`. `flight.preflight-assessment` requires a "control link, energy and load" determination, so it fits only as a stretch. |

### Roles

| What | Where | How it could be held |
| --- | --- | --- |
| Pilot in command | § 91.3 | Today: `operation.role-assignment`, role pilot in command. |
| Second in command, flight engineer, flight attendant, check pilot | §§ 135.99(b), 135.107, 135.63(a)(4)(viii) | Core change 4. A pack could declare its own crew assignment type on `flight` (honest), but the flights list and the shipped packs read `operation.role-assignment` only. |
| Director of operations, chief pilot, director of maintenance | § 119.69(a) (where Part 135's management positions are listed; the eCFR has no text for §§ 135.37 and 135.39) | A standing role assignment about the organization; the roles are missing (core change 4). The assignment's "authority notified of the change at" already holds the notice § 119.69(e)(3) asks for within 10 days. |
| Mechanic, repairman, inspector holding an inspection authorization, the person who signs a release | §§ 91.409(d)(1), 135.443(b)(3) | Declared certificate on `person`, honest. It helps only once the maintenance records name that person by reference (declared types, above). |
| Who may do what in Ledger | | Today: capabilities. A maintenance preset would be a convenience in `rolePresets`; none is needed. Ledger records a release a person signed; it never issues one. `mission:release` is a Ledger command about a mission, not an airworthiness release. |

### The flight model

- **More than one crew member on a flight**: today, as several role assignments; a rule fans out over them.
- **Legs and duty periods**: today, as above: legs are flights, duty is about the person, and `duty.within-limits` places a duty period against the window a rule reads.
- **Times**: `flight.record` holds takeoff and landing. Block times, landings and night are not on it; a declared type on `flight` can hold them, and the check kinds take the fields they read as parameters, so they read a declared type as readily. Two pieces of core read the built-in types by name instead (see [below](#unmanned-assumptions-that-live-in-core)).
- **One aircraft per flight**: fits crewed flying as it is.
- **The live flight and missions** are shaped for an unmanned aircraft (one aircraft column, a route and a height band above ground, an airspace authorization status). A crewed operation would keep its flights through records and not use them.

## Which check kinds express the common rules

| The rule | Check kind | Today |
| --- | --- | --- |
| A test, check or review within N calendar months: 24 for a flight review (§ 61.56(c)), 12 for tests and line checks (§§ 135.293, 135.299), 6 for an instrument proficiency check (§ 135.297), 36 for a weighing (§ 135.185) | `date.within-months@2` | Holds for "current today": it asks as of the evaluation clock and counts months by UTC date. Asked as of each flight ("before that service"), and in the organization's time zone, no kind does it (core change 5). |
| An inspection due by calendar or by hours in service (§§ 91.409(a)-(b), 91.411, 91.413, 91.207(d)) | `due.time-or-total@1` | Holds, as of each flight, comparing the aircraft's hours and the flight's time with the next due the operator records (for an annual, the last day of the twelfth month; for a 100-hour, the hours including any excess flown to reach the inspection). |
| A part's hours against its limit or overhaul interval | `value.within-limit@2` with a related aircraft, or `total.from-opening@1` | Holds for hours. Cycles need landings recorded per flight. |
| Duty at most 14 hours with 10 hours of rest before it (§ 135.267(c)-(d)) | `duty.within-limits@1` | Holds. |
| Flight time in any 24 consecutive hours, or 34 hours in any 7 consecutive days (§§ 135.265(a)(3)-(4), 135.267(b)) | `duty.within-limits@1`, rolling total | Holds over flight-time intervals recorded for the person (168 hours for seven days). |
| Flight time in a calendar month, quarter, two quarters or year (§§ 135.265(a)(1)-(2), 135.267(a)) | none | `local-days.total@1` totals N local days ending on the evaluation day, at most 366, not calendar months and not as of a flight (core change 6). |
| 13 rest periods of 24 hours in each calendar quarter (§ 135.267(f)) | none | `periods.each-recorded@1` asks for one record per period, not a count of qualifying intervals (core change 6). |
| Rest required stepped by scheduled flight time, and reduced rest made up later (§ 135.265(b)-(c)) | none | `duty.within-limits@1` takes one fixed rest minimum; a rule's applicability compares listed values, not numbers (core change 6). |
| Three takeoffs and landings in the 90 days before, in the same category, class and type, by night for a night flight (§§ 61.57(a)-(b), 135.247(a)) | none | `intervals.counted-before@1` counts flights in the days before a flight, not landings, and matches nothing about the aircraft; `local-days.total@1` sums a field but as of the evaluation day (core change 6). |
| Loaded weight at most the maximum takeoff weight; centre of gravity within limits (§ 135.63(c)) | `value.within-limit@2`, the limit read from the manifest, one rule per bound | Holds once a unit of mass exists (core change 3). |
| Manifest prepared before each takeoff; release or log entry before the next flight after maintenance (§§ 135.63(c), 91.407, 135.443) | `record.before-flight@1`, `value.recorded-as@1` | Holds. |
| A report within 96 hours, a weekend or holiday deadline moving to the next workday (§ 135.415(d)) | `events.answered-within@1` | Holds for the 96 hours; the move past a weekend or holiday is not expressed (`business-days.within@1` counts business days, not hours). |
| The authority told within 10 days of a change of management personnel (§ 119.69(e)(3)) | `events.answered-within@1` | Holds, on the role assignment's own field. |
| A second in command when 10 or more passenger seats; a flight attendant when more than 19 (§§ 135.99(b), 135.107) | `interval.covers-window@2` for the role, with an applicability condition on the aircraft | Holds once the roles exist (core change 4), and only if the operator records the seats as listed bands: applicability compares listed values, so "10 or more" cannot be written as a number. |
| Every applicable AD's recurring action not past due; every deferred item within its interval (§§ 91.417(a)(2)(v), 91.213) | none | `due.time-or-total@1` reads the latest due record, so one per rule; `records.each-in-force@1` asks only that values are held (core change 7). |
| Fuel to the first landing plus 30 minutes by day, 45 by night, 20 for a rotorcraft (§ 91.151) | `value.within-limit@2` on planned endurance beyond the first landing, in hours | Holds, as the operator's planned figure. |

## The smallest list of core changes

In an order someone could take them. Each is small enough to be one issue.

1. **A related subject, and name fields, on a declared type.** In `packages/contracts/src/declared-record-types.ts`, let a declaration state `secondarySubjectKinds` (and `nameFields`), carried into `declaredRecordDefinition`; in `packages/standard-packs/src/pack-files.ts`, refuse a later version that leaves one out, as it does for subject kinds. Import already offers a related-subject column for any type that has one (`packages/contracts/src/operator-record-import.ts`). An absent section leaves every digest as it is. Unblocks: a pilot's logbook entry naming its flight, a load manifest naming its aircraft, an AD status naming the engine.
2. **A reference to a flight.** Add `flight` to `operatorRecordReferenceKindValues` (`define.ts`) and `declaredReferenceKindValues`. The reference index and relations are generic. Unblocks: a record that names more than one flight, such as a duty period naming its legs, and a relation from a person's records to the flights they name.
3. **A unit of mass.** Add it to `operatorRecordUnitValues` and the maximum per unit (`define.ts`, `declared-record-types.ts`), to the units an import heading converts and a pack's limits are written in (`packages/standard-packs/src/pack-units.ts`, pounds and kilograms). The units a result states a quantity in (`textUnitSchema`, `packages/domain/src/quantities.ts`) sit inside the parameter schema of `value.within-limit@2`, whose definition digest every shipped pack pins: a new unit of text needs a new version of that kind, or the sentence states the stored unit only. Unblocks: weight and balance and the load manifest.
4. **Crewed positions in the built-in role lists.** Add second in command, flight engineer, flight attendant, check pilot, director of operations, chief pilot and director of maintenance to `operatingRoleValues` (`operation.ts`), and crewed roles to `crew.duty-period` in both places it is listed (`person.ts` and the observation schema in `packages/contracts/src/observations/types-v1.ts`). Ledger has no adopter to keep compatible, so the lists change in place. The other way, letting a pack add options to a built-in select, has the same difficulty as extra fields on a built-in type ([declared-record-types.md](declared-record-types.md)). Unblocks: crew composition, the management positions, and duty records by position.
5. **Calendar months as of a flight.** A check kind, or a new version of `date.within-months`, that asks whether a date falls within the N calendar months before the month of the flight's time, counted in the organization's time zone, following [record-check-kinds.md](record-check-kinds.md#evaluated-as-of-each-flight). Unblocks: §§ 61.56, 135.293, 135.297, 135.299 and 135.185 asked of each flight.
6. **Crew time over calendar periods and counts before a flight.** Either a new version of `duty.within-limits` with calendar-month periods (month, quarter, two quarters, year) in the organization's zone, a count of qualifying rest periods, and a rest minimum stepped by the period's flight time; and a kind that sums a numeric field over the records in the N days before a flight, with a condition that a field matches the flight's aircraft (as `field.matches@1` compares two inputs). Unblocks: §§ 135.265, 135.267(a) and (f), 61.57 and 135.247.
7. **A due check over each record of a set.** A kind that applies `due.time-or-total`'s arithmetic to every selected record in force and names each one past due. Unblocks: AD status, deferred items and inspection program items, where the number of items is the operator's and not the rule's.
8. **Core reads that name built-in types.** `getFlightsOnRecord` (`packages/domain/src/open-findings.ts`) builds the flights list from `flight.plan` and names one pilot per flight from `operation.role-assignment` with role pilot in command; the flight-hours exposure (`packages/domain/src/indicator-exposure-kinds.ts`) reads `flight.record` and `flight.report`. A crew assignment or flight-times type a pack declares is invisible to both. Unblocks: crewed flights recorded in declared types appearing in the flights list and in rates.

Not on the list, because declared types already do it: every record in the tables marked "Declared".

**A kind of subject a pack declares** would not remove most of this list. Changes 1 to 6 and 8 are about fields, units, roles and check kinds, not about what a record is about. It would remove the need for a new subject for passengers, and would give each AD or deferred item a subject, so that fan-out gives one result per item and change 7 becomes optional. What it would take: the closed list in `envelope.ts` becomes a list per organization, as record types are (`organizationRecordTypes` in `packages/domain/src/organization-record-types.ts`); the envelope's subject schema, which `operator.record` repeats as its own list (`recordSubjects` in `types-v1.ts`), takes a pack-scoped kind; reference kinds, rule targets (`checkedRuleSubjectKindValues`), the wording of each kind (`packages/domain/src/indicator-wording.ts`), the Records area's list (`apps/web/src/record-subject-kinds.ts`) and the subject picker read the organization's kinds instead of a constant. The database stores a kind as text and does not list them, so no migration is needed for the kind itself. It is the larger change and should wait until changes 1 to 7 show it is still wanted.

## Unmanned assumptions that live in core

The Part 107 and Part 108 packs keep their own assumptions: which roles a rule covers, which record types it reads, the quoted paragraphs, the records each requires, the federal holidays. Those are where they belong. What leaked into core:

- **Options in built-in types.** `person.certificate` (remote pilot certificate, security threat assessment), `person.training` program (remote pilot certificate), `crew.duty-period` role (remote pilot, visual observer, payload operator), `operatingRoleValues` (operations supervisor, flight coordinator, visual observer, payload operator), `person.aircraft-experience` roles, `flight.plan` (kind of operation, visual line of sight, pilot in the operating area, distance from the control station), `aircraft.identity` (remote identification), `occurrence.mechanical-irregularity` (a data service failure).
- **Required fields a crewed record cannot fill.** `aircraft.system-availability` requires a dock, a battery, a control link and their states; `flight.preflight-assessment` requires a control link, energy and load determination. A crewed operation would leave these types unused; nothing reads them for it.
- **People named in text in maintenance records.** `maintenance.action` (performed by, returned to service by), `aircraft.inspection` and `component.inspection` (inspected by) hold names, not references. This is not about unmanned aircraft, but it means no rule can follow a signature to the certificate behind it.
- **Core reads by type name**: the flights list and the flight-hours exposure, change 8 above.
- **Units** of length, speed, time and percent only, and the units of text inside a pinned check kind, change 3 above.
- **Calendar months in UTC** in `date.within-months@2`, change 5 above. It affects unmanned rules as well.
- **The live flight and missions**: one aircraft, a route and a height band above ground, an airspace authorization status. Not needed for a crewed operation's records.

## What is not in question

Everything below is not specific to unmanned aircraft and would carry over as it is:

- The observation envelope, intake and receipts, append-only history, corrections, withdrawals and subject resolution by alias.
- Operator records: import from CSV and JSON with a column mapping, entry and browse, completeness, dates written without a time of day, times in the organization's zone.
- Record types a pack declares, pack files built from a source text, rules that quote and pin their paragraphs, adoption in shadow and active, waivers and their relief of another pack's rule (for a crewed operation, a letter of authorization or an exemption).
- The check kinds listed above as holding, populations and coverage, "no record on file", fan-out and reads about a related subject.
- Findings and their work, a person's decisions pinning their basis, required records with their quoted retention (§ 135.63(b) states 6 and 12 months, § 135.63(d) 30 days), the recordkeeping plan, record productions and the offline verifier.
- The safety records: hazards, risk matrices, controlled documents, assurance records, protected reports.
- Tenant isolation, people and capabilities, notices, indicators.

## How far this note goes

This is a reading of the regulation text and of Ledger's code by someone who has not run a crewed operation, held a certificate under Part 135 or kept an aircraft's maintenance records. It lists what the text asks to be kept and checked as far as a first reading shows; it leaves out what the text leaves to operations specifications, manuals and approved programs, which vary by operator. A check kind said to hold was read in its code and its design note, not run against crewed records. A director of operations, a director of maintenance or a mechanic holding an inspection authorization should correct it, and their corrections belong in this note.
