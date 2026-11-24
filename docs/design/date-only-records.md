# Records placed by a date alone

Status: accepted. Builds on operator record import (`operator-record-import.md`) and the record check kinds (`record-check-kinds.md`).

An operator's log often has the day something happened and no clock time: the day a notice was filed, the day an inspection was done, the day an occurrence happened. Until now the column that places such a record in time refused a date, so the record could not be imported at all, and every rule that looks for it reported it missing. This note says how a date alone is taken, stored, shown and read.

## Which columns

Two kinds of column take a date alone. Every other time column takes a time, and a date alone there is refused with a sentence that says which columns take one and to write a time here.

| Columns | Why |
| --- | --- |
| The columns that place a record in time: a record type's time fields (`timeFieldNames`). That is the at field of an `event` or `as_of` type (`notifiedAt`, `performedAt`, `occurredAt`, `effectiveAt`, `coveredThroughAt`, `checkedAt`, …) and the start and end fields of an `interval` type (`inspectedAt` and `nextDueAt`, `takeoffAt` and `landingAt`, `startsAt` and `endsAt`, …). | A log often keeps only the day a thing was done. Without the record no rule can read it at all. |
| The columns that say when a report or a notice was made: `reportedToAuthorityAt`, `reportedToManufacturerAt` and `reportedToServiceProviderAt` on the occurrence records, `includedInSummaryAt` on an operation anomaly, and `authorityNotifiedAt` on a role assignment. A field takes a date alone when its definition says so (`takesDate`), so a record type names its own. | An occurrence log writes "FAA notified 8/17/26". The only question a rule asks of such a time is whether the report was made by a deadline, and that is answered from the day: the report is read as made at the end of that day. Refusing the day left the report off the record, so the rule said no report was made at all. |

Other time columns (`hazardDeterminedAt`, `sourcesRetrievedAt`, `followUpAt`, …) still take a time. Each either orders the record against another time on the same day, which a day cannot do, or is kept for a person to read and is never compared with a deadline; a date there is refused: "… is a date with no time. This column takes a time: a date alone is taken only in the column that places the record and in a column that says when a report or notice was made; write a time here in …". A record type recorded as its own observation type (`crew.duty-period`) takes a time in every column, since its observation has no place to keep the precision.

`records columns` and the import template mark each column that takes a date alone (`takesDate`), and the one that places the record (`placesRecord`).

An entirely empty placing column is still refused, as before: a record nothing places in time cannot be read by any rule. The refusal says which column places the record and that a date alone is accepted there.

## How it is taken and stored

- A cell holding a calendar date `YYYY-MM-DD`, under the plain heading or a `[local]` heading, is that day in the organization's time zone.
- The field stores the first instant of that day in the zone, as UTC (`2026-10-05` in America/Chicago is `2026-10-05T05:00:00Z`), so every existing read that places the record still places it on the right day.
- **A date alone in the column that ends a record's interval is the end of that day**, as an adoption's `--until` is: the field stores the first instant of the next day in the zone (`windowEndsAt` `2026-11-10` in America/Chicago is `2026-11-11T06:00:00Z`). This is the end field of an `interval` type (`windowEndsAt`, `landingAt`, `endsAt`, `removedAt`, `nextDueAt`); it widens no column: these already took a date alone. A flight plan window given the same date as its start and its end is then the whole of that day, where before it was refused as ending when it starts. A time in the start and a date alone in the end runs to the end of that day. The import's limitation says so: "Window ends at was entered as 2026-11-10, a date with no time; it ends the record, so it is recorded as the end of that day in America/Chicago, 2026-11-11T06:00:00Z." (`timeConversions[].endOfDay`).
- The precision is kept beside the body, in the carrier's `values.dayOnly`: one entry per field given as a day, `{ day, timeZone, nextDayAt }`, where `nextDayAt` is the first instant of the following day (for an end field, the instant the field holds). A record with no such field has no `dayOnly`.
- The import keeps what was entered as it does for a unit: the row's `timeConversions` entry has `precision: day`, and `limitations` says "Notified at was entered as 2026-10-05, a date with no time; it is recorded as that day in America/Chicago, from 2026-10-05T05:00:00Z to the end of the day."
- A record read (`GET /v1/operator-records`) returns `dayOnly`, and the Records screen and the command-line client show such a field as the date.

## How checks read it

A check that compares such a time with a deadline reads the instant of the day **least favourable to the operator**, and its sentence says that only a date is on record.

| Check kind | Time it reads | Reading of a day | Sentence |
| --- | --- | --- | --- |
| `record.made-before@1` | when the record was made | the last instant of the day: a record made on the day the deadline falls is counted as made after the deadline time | "A notice was made on 2026-10-05; only the date is on record, so it is read as made at the end of that day, …" |
| `events.answered-within@1` | when the event happened | the first instant of the day: the deadline is counted from the start of that day | "The event on 2026-10-06 (only the date is on record; its deadline is counted from the start of that day) has no …" |
| `events.answered-within@1` | when the answer was made: an answer record's at field, or a time on the event itself (`answerField`, such as `reportedToAuthorityAt`) | the last instant of the day: the report is read as made by the end of that local day | "… has its report to the authority on 2026-10-09 (only the date is on record; read as the end of that day), …" |
| `business-days.within@1` | the later time (`toField`, such as `reportedToAuthorityAt`) | the last instant of the day; the day is counted on its own local date, which is the same date | "The emergency deviation’s Reported to the authority at, on 2026-08-17 (only the date is on record; read as the end of that day), is within …" |
| `due.time-or-total@1` | when the due record (an inspection) was made | the last instant of the day: an inspection made on the day of a flight is not taken as made before its takeoff | "the inspection recorded on 2026-09-30 …" |
| `due.time-or-total@1` | the next due time | the first instant of the day: due at the start of that day, though the field holds the end of the day | "… was due on 2026-10-18 (only the date is on record; read as the start of that day)" |
| `record.before-flight@1` | when a check before a flight was made | below, "A check made for a flight" | |

Kinds that place a record on the organization's calendar days (`periods.each-recorded@1`, `local-days.total@1`) count by local dates already: a day alone falls on the same date whichever instant of it is read, so they are unchanged. `business-days.within@1` counts by local dates too, so its answer is the same; it reads the day as its end only so that the sentence says only the date is on record. Kinds that ask whether a record is in force, covers a window or adds to a total (`record.in-force@1`, `records.each-in-force@1`, `interval.covers-window@2`, `total.from-opening@1`, the window kinds) read the stored instant: a record dated a day is then in force, or adds to a total, from the start of that day, and a record whose end is a date alone is in force until the end of that day. For a total that is the higher figure (a flight on the day an opening balance is "as of" is counted again), so a total is never understated.

## A check made for a flight

A pilot's log often has a tick per flight, "DAA checked", and no time. Read as the end of its day, a check dated 10 November was before the aircraft's next flight on 12 November, so it was credited to that flight: a flight with no tick of its own passed, and every first flight of a day was reported as having no check, because its own check, dated that day, was read as made after it.

A record of a check made before flight may name the flight it was made for. The record types `record.before-flight@1` reads in the shipped packs, `aircraft.detect-and-avoid`, `aircraft.inspection` and `component.inspection`, take the flight as their related subject (`secondarySubjectId`, with `secondarySubjectKind` `flight` where the type has more than one kind). The kind tells a flight apart without naming the kind: a record names a flight when its secondary subject is of the kind of the subject the flight's time record is about, and it names this flight when the ids are the same.

| The record | Counts for | Since the previous flight |
| --- | --- | --- |
| Names this flight | this flight only: made at or before its takeoff, or, given as a date alone, on or before the local date of the takeoff | yes: it says which flight it was made for, so no time of day is needed |
| Names another flight | that flight only, never this one | |
| Names no flight, with a time | as before: the latest made at or before the takeoff | made after the previous flight ended |
| Names no flight, a date alone, under a rule that asks for a record since the previous flight (`previousEndField`) | only the flights that took off on that local date, in the day's own time zone, never a flight on a later day | only when the previous flight ended on an earlier local date: on the same day the order cannot be told, and the least favourable reading is taken |
| Names no flight, a date alone, under a rule that does not (an inspection within 30 days) | as before: read as made at the end of its day, so it counts for later days and is not taken as made before a flight that same day | |

The sentence says which it relied on: "The detect-and-avoid check of RIDGE-AC-1 made for this flight, RIDGE-F-12, on 2026-11-12 (only the date is on record), for takeoff at …, records the detect-and-avoid equipment’s State as Installed and serviceable." A date alone that names no flight says so: "made on 2026-11-12, which names no flight (only the date is on record, so it counts only for flights that took off that day)", and, when the aircraft flew earlier that day, "Only the date is on record, so it is not taken as made after a flight that ended that same day." When none counts, the sentence names the latest and why it does not: "No detect-and-avoid check of RIDGE-AC-1 is on file for takeoff at …; the latest, made on 2026-11-10, names no flight and gives a date only, so it counts only for flights that took off on 2026-11-10."

What to import from a log with a tick per flight and no time: one record per tick, dated the day, naming the flight it was ticked for in `secondarySubjectId`. A flight with no tick then has no record of its own, and the rule says none is on file for it, whatever was ticked for the flights around it.

The rule kept `record.before-flight@1` in place: no new version. Its digest, and the digests of the packs that use it, moved.

## Not covered

- Dates written in another order (`10/5/26`): refused as before, with the sentence that shows the accepted forms.
- A day alone in a time column that neither places the record nor says when a report or notice was made.
