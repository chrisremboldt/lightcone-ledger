# Operator record import and entry

Status: built. Code: `packages/contracts/src/operator-record-import.ts` (shapes, parsing, conversion, time), `packages/contracts/src/operator-record-mapping.ts` and `operator-record-mapping-file.ts` (column mappings), `packages/contracts/src/operator-record-api.ts` (API schemas), `packages/domain/src/operator-record-import.ts` (preview, commit, reading), `apps/api/src/operator-records.ts` (routes), `apps/web/src/RecordsArea.tsx` and `apps/web/src/RecordForm.tsx` (screen). Sample files: `packages/contracts/fixtures/operator-records/`.

Everything is generated from a record type's field metadata (`operator-records.md`). No code names a record type.

## File shapes

Both shapes use the same column names; one row or one JSON record is one record.

| Column | Meaning |
| --- | --- |
| `subjectId` | The operator's own id for the subject (a person, an aircraft, …). Recorded with scope `source` under the import's source. Not a column of a record type about the organization only (below); blank, or left out, when `subjectKind` is `organization`. |
| `subjectKind` | Only when the record type allows more than one subject kind. |
| `secondarySubjectId`, `secondarySubjectKind` | Optional related subject, for types that have one. |
| one column per field | The field name, in field order. Number fields end in their stored unit (`totalTimeHours`, `plannedMaxHeightAboveGroundMeters`). |
| `replaces` | Blank for a new record; the Ledger id of the record this row corrects, or, in a produced file, the `recordId` of an earlier row of the same file. |

A produced CSV (`record-productions.md`) adds `recordId`, `recordedAt`, `recordedBy`, `replacedBy`, `originalFile`, `originalSha256` and `notes` after these. The importer reads none of them as a value; `recordId` only lets a later row's `replaces` name the record an earlier row of the file recorded.

**Records about the organization.** A record type whose only subject kind is the organization (a procedure on file, a report provided, a review of a policy or program, a security occurrence) is about the operator's own organization. Its template and the entry form ask for no subject, and every row is recorded about the Ledger organization (`organization:<tenant>`, scope `ledger`): the subject that rules reading `about: organization` read and the one the coverage view counts. The same holds for a type that may be about a flight or the organization when a row's `subjectKind` is `organization`. A file that still gives a `subjectId` for such a row is told, in the row's `notes`, that the column is not used for it; the row is recorded. No second organization subject can appear from an import.

**Units.** A number may be entered in another unit by naming the unit in brackets after the field name or its stem: `plannedMaxHeightAboveGround [ft]`, `plannedMaxGroundSpeed [kt]`. Accepted, ignoring case: meters `m`, `ft`, `mi` or `sm` (statute miles), `nm` (nautical miles); meters per second `m/s`, `kn`, `kt` or `kts`, `mph`; hours `h`; count. Percent is `%` (or `percent`, `pct`); hours also `hr`, `hrs`. The value is converted to the stored unit, rounded to a millionth, and the conversion is kept in the observation's `limitations` with the unit as written ("… was entered as 25 kt and recorded as 12.861111 m/s."). A cell may also carry its own unit after the number (`300ft`, `104 m`, `35%`), which wins over the heading's, so one column where pilots wrote different units imports as it is; the conversion is kept the same way. Anything after the unit (`380 ft AGL`), or after the number when it is not a unit (`26G33`), is refused with a sentence saying what to remove.

**Times.** A time is written in UTC (`2026-11-10T15:00:00Z`) or with its offset (`2026-11-10T09:00-06:00`) under any heading. Under a heading that ends in `[local]`, as units are named (`windowStartsAt [local]`), it may also be written `2026-11-10 09:00` or `2026-11-10T09:00[:ss]`, which is read in the organization's time zone (the zone set when it was created). The stored value is always UTC; a time entered in the zone or with an offset is kept like a unit conversion, in the row's `timeConversions` and in `limitations` ("Window starts was entered as 2026-11-10 09:00 in America/Chicago and recorded as 2026-11-10T15:00:00Z."). A local time the zone skips when clocks move forward, or repeats when they move back, names no one instant and is refused with a sentence saying so and, for a repeat, the two offsets to choose from. A time with no zone under a plain heading, and any other form (`11/10/2026 9:00 AM`), is refused with a sentence that shows the accepted forms. A column that places the record takes a date alone (`2026-10-05`), which is that day in the organization's zone, kept as a day in `values.dayOnly` ([date-only-records.md](date-only-records.md)); any other time column refuses one. The entry form takes times in the organization's zone, says which, and submits them under `[local]` headings.

**Values.** Blank cells are absent fields. Booleans: yes/no or true/false. Dates `YYYY-MM-DD`. Selects: the option value or its label, ignoring case and surrounding spaces; nothing else is guessed. References: the operator's own id (JSON may also give `{ "id", "scope" }`).

**CSV**: UTF-8, comma separated, RFC 4180 quoting, one header row. **JSON**: `{ "recordType", "recordVersion", "records": [ { column: value, … } ] }`.

Templates: `GET /v1/operator-records/types/{recordType}/versions/{version}/template?format=csv|json`. `GET /v1/operator-records/types` returns every registered type with its fields and generated columns.

## Column mappings

An operator's history is often a log service's or a spreadsheet's export with its own headings, units, date style and words. A column mapping reads such an export as it is: a YAML file, kept beside the export, that says for one record type which column is which field. It is data, read by a pure function (`applyRecordMapping`) that turns each row of the export into a row of the import's own columns, which is then read exactly as a row of an import file is. Same export and mapping, same result. It never fills in a value the export did not hold, other than the constants the mapping states, and never guesses a unit or a zone. A mapping holds no expression, no code and no arithmetic: a value that needs a formula, or two columns put together, is not something a mapping does.

```yaml
recordType: flight.plan
recordVersion: 1
times:
  zone: organization
  style: MM/DD/YYYY h:mm A
subject:
  column: Job No.
relatedSubject:
  column: Aircraft
columns:
  'Window Start': windowStartsAt
  'Window End': windowEndsAt
  'Ceiling (ft AGL)': { field: plannedMaxHeightAboveGroundMeters, unit: ft }
  'Mission': { field: visualMode, words: { BVLOS: beyond_visual_line_of_sight } }
  'Crew': ~
constants:
  operatingAuthorityReference: 107W-EX-2026-00417
leaveOut:
  - { column: Status, is: [Cancelled] }
```

| Key | Meaning |
| --- | --- |
| `recordType`, `recordVersion` | The record type the mapping reads the export as. It must be the type the import names. |
| `times.zone` | `organization` (the organization's time zone) or `utc`: the zone of every time column. Required for every time column, here or on the column; a mapping never assumes one. |
| `times.style` | How a time is written, from `YYYY`, `MM` or `M` (month), `DD` or `D` (day), `HH` or `H` (hour 0 to 23), `hh` or `h` (hour 1 to 12, with `A` for AM or PM), `mm`, `ss`, and spaces, `/`, `-`, `.`, `:`, a comma or `T` between them: `MM/DD/YYYY h:mm A` reads `11/10/2026 9:05 AM`. Without one, times are read in Ledger's own form, `2026-11-10 09:05` (with `T` or seconds too). A cell written in another form is refused with the style it should have; a cell in UTC (`…Z`) or with its offset is read whatever the style. |
| `times.dateStyle` | How a date alone is written (`MM/DD/YYYY`), in a column that takes one; without it, `2026-11-10`. In a `utc` column a date alone is refused, since it is read as a day in the organization's zone. |
| `subject.column` | The column that holds the operator's own id for the subject. Required for a record type about a subject; absent for one about the organization only. |
| `subject.kind`, `subject.kindColumn` | When the record type allows more than one subject kind: the kind every row has, or the column that holds it. |
| `relatedSubject` | The same for the related subject (`secondarySubjectId`), for types that have one. |
| `columns` | Every column of the export by its heading. `~` leaves it unread. A field name reads it as that field. Or a set of: `field`; `unit`, the unit a number is written in (required for a number field unless its unit is written only one way, as percent and hours are; a unit in the cell still wins); `zone`, `style` and `dateStyle`, overriding `times` for this column; `words`, the export's words for the field's options (`BVLOS: beyond_visual_line_of_sight`), matched ignoring case and surrounding spaces, for a select or a yes/no field. A cell that is not one of the words is read as written, so an option's own value or label still reads. |
| `constants` | A value for a field the export never states because it is the same on every row: `field: value`. A number carries its unit (`120 ft`). A time is never a constant. The records say the mapping stated it. |
| `leaveOut` | Rows to leave out: each a `column` and the values (`is`) that leave a row out, ignoring case and surrounding spaces. A row left out is not refused and not recorded; the check lists it. |

A mapping is refused when it is loaded, with the line, when it names a field the record type does not have, an option a field does not offer, a unit a field does not accept, a style it cannot read, a time column without a zone, a number column without a unit, a key that is not one of these, or no subject column for a record type about a subject. An export that lacks a column the mapping reads is refused whole; the export's columns the mapping does not read are listed. A mapping reads a CSV export with one header row.

Import with a mapping: upload the export and the mapping, and give the mapping's artifact in `mappingArtifactId` beside the export's `artifactId` in preview and commit. The response's `mapping` says what each column became, which columns were not read, the constants and the rows left out (by their row number in the export; they are not in `rows`). Each record cites the export as its original, at the export's own row (`originalLocator`), as it was received, and its `limitations` begin with a sentence naming the mapping's artifact, and the fields the mapping stated, so that a later reader can repeat the reading. A time read through a style keeps the cell as the export wrote it in its conversion ("Takeoff at was entered as 11/10/2026 9:05 AM in America/Denver and recorded as 2026-11-10T16:05:00Z."). The export is the source session, so committing it again, with this mapping or another, finds the rows it already recorded. The command line's `records mapping <type> <export.csv>` starts a mapping from the export's header row: every column listed and unassigned, the type's fields as comments, nothing guessed; `records check` and `records import` take `--mapping`. The Import screen in the browser does not take a mapping yet.

## Records read from another file

A file in Ledger's own columns may have been read from another file the operator keeps, such as an aircraft's own log. Give that file's artifact in `originalArtifactId` beside the import file's `artifactId` in preview and commit. Each record then cites it as its original (`originalArtifactId`), with no `originalLocator`, since a row of the import file is no place within the original; its `limitations` begin with a sentence naming the original's artifact and the row of the import file it was read through, and saying that a value the original does not hold was added to the import file. The import file stays the source session, so committing it again finds the rows it already recorded. The original must be a retained file of the same organization, and is not read by the import; a mapping and an original are not given together, because a file read from another file is already in Ledger's own columns. The command line's `records check` and `records import` take `--original`.

The readers that make such a file are in `packages/flight-logs`, an extension point like the adapters: the only code that names an autopilot or a log format. `pnpm ledger records read-log <log>` runs one offline and writes a `flight.record` CSV. What was decided for them, and why:

- **Only what the log holds.** A reader writes the times, the places, the heights it can state and a reference to the log, and leaves the flight's own id, the aircraft's id and everything else empty. The vehicle identifier a log may hold (a PX4 `sys_uuid`, a MAVLink `AUTOPILOT_VERSION.uid`) is printed, never written as the aircraft's id: it is the processor's id, not the operator's.
- **Height above ground is left empty.** An autopilot's log states a height above home or above the takeoff point and an altitude above mean sea level, never above the ground under the aircraft. Writing either as `maxHeightFlownAboveGroundMeters` would turn a log's figure into a different measurement, so both go to `heightNotes` with their reference and the field is left for a person; the row is recorded incomplete until one writes it. Treating the height above the takeoff point as height above ground was considered and refused for that reason.
- **One flight rule, said with each flight.** From the land detector's first "in the air" after arming to its last "on the ground" before disarming; from arming to disarming when the log has no land detector. One armed period is one flight, its touchdowns all listed as landing places; an armed period that never leaves the ground is not a flight. A log that ends, or stops being readable, while armed holds an unfinished flight, which is reported and not written.
- **Absolute time from the log alone.** UTC comes from the GPS receiver's time in the log (ArduPilot's GPS week time less the leap seconds in force that day), or the ground station's clock for a telemetry log, and is paired with the log's own clock once. Without one, no time is written; the person writes it or the row is refused.
- **Streaming and stopping.** An autopilot log's reader holds only the message it is reading, so memory does not grow with the log. At a cut or a damaged message it stops, reports the byte offset and keeps the whole flights before it; it never resynchronises past damage, so nothing after a gap is read as if it continued what came before. A ULog with appended data is read on from the appended offset, as its description asks.
- **A GUTMA flight log is one JSON document, read from its description alone.** The reader (`gutma.ts`) was built from the Global UTM Association's published `Flight_logging_protocol.md` and from no product's export, and its header lists every key it reads; every other key is listed in the reading as not read. The file is parsed whole, up to the 10 MB Ledger keeps as an original, so each flight's bytes are the whole file. Three choices a later contributor would otherwise rediscover:
  - *Events.* The description names a take-off event (`TAKE_OFF`) and no landing event. Reading only the documented name would mean no log could ever record a landing, so the reader also takes `TAKEOFF`, and `LANDING`, `LANDED` or `LAND` as a landing, and lists every other event by name so a person with a real export sees what a product writes. The set is the reader's choice, not the description's, and should be corrected from real exports.
  - *A missing event.* The description says the start of logging "describes the beginning of the flight" and that the last sample's time is the flight's duration. So a flight with no take-off event begins at the start of logging and, in a log with no landing event at all, ends at the last sample; each such flight says so and asks the person to check. Finding a takeoff or a landing in the samples (height or speed returning to zero) was considered and refused: it would invent a landing the log does not record. Refusing every log without both events was refused too, since the description does not require events. A take-off with no landing after it in a log that does record landings is unfinished and not written.
  - *Height.* The altitude goes to `heightNotes` under the datum the log names (`AGL`, `MSL` or `WGS84`, the three the description allows). Only `AGL` is the log itself saying the figure is above the ground, so only then is it also written to `maxHeightFlownAboveGroundMeters`; no height above the takeoff point is derived. An undocumented datum, no datum, or units other than `Metric` give no height.
- **The CLI reads the log, not the API.** The import does not parse logs: core code never names an autopilot. The original is kept as bytes and the CSV is what is read, so a later reader can run the same reader on the retained log and compare.

## Flow

1. Upload the file with `/v1/uploads` (create, put bytes, finalize). The retained artifact is the original.
2. `POST /v1/operator-records/imports/preview` with `{ artifactId, recordType, recordVersion, sourceId? }`. Every row is parsed, read against the field metadata, then validated as the observation intake would validate it. Each row comes back `acceptable` (with the record, the derived time, conversions and missing required fields), `already_recorded`, or `refused` with plain reasons. File-level problems (not UTF-8, bad JSON, duplicate header, wrong record type, too many rows) are listed in `problems`. Nothing is written.
3. `POST /v1/operator-records/imports` with the same body records every acceptable row through `acceptInput` (generic observation intake) in one transaction and returns the per-row outcome and a summary. A refused row never stops the others. It answers 201 when at least one row was recorded, and 200 with the same body when none was (every row refused or already recorded).

Each row is an `operator.record@1` observation with `originalArtifactId` = the file, `originalLocator` = the row's byte range (CSV) or JSON pointer (`/records/n`), `sourceSessionId` = the file and `sourceEventId` = `row-n`. Committing the same file again finds those rows and records nothing new.

**Time.** The body's time fields are the source of truth. `as_of` and `event` types with an at field get `occurredAt` from it; `interval` types get `interval` from their start and end fields and `occurredAt` = the time of recording (or the start, if later). `as_of` types without an at field are recorded as of the time of recording. A row without its time field is refused, because it cannot be placed in time; the sentence says the column places the record and that a date alone is accepted there. Generic intake now refuses any carried record whose envelope time disagrees with its body (`record_time_disagreement`).

**Incomplete records** are recorded and reported with their missing required fields.

**Records recorded as their own observation type.** A record type may declare `observed: { idField }`: each record is then recorded as an observation of the registered observation type of the same name and version, the one rules already read, and never inside `operator.record`. `crew.duty-period` is one: a duty, flight-duty or rest period from the operator's schedule is the same `crew.duty-period@1` observation a crew roster adapter reports, so the duty and rest rules read it unchanged. The id field (`periodId`) is the operator's own id for the record and becomes the observation's source event id; the time fields become its interval; every other field is a value of the same name. A `person.rest-assessment` names periods by these ids. A row whose id is already held by a current record under the source is refused unless it replaces that record, and two rows of one file may not give the same id. The template, the form, the preview, the reads by type and subject, and productions treat such a record like any other; recording one needs the same `operator.record` grant.

## Hand entry and correction

The form is generated from the same metadata. A submission is a one-record JSON document in the shape above; it is uploaded (so the submitted payload is the retained original) and committed through the same two routes.

A correction is a new record whose `replaces` names the record it corrects; nothing is edited. It is sent through intake with the envelope's first-class `replaces` field (`observation-corrections.md`), and the original document keeps `replaces` as the operator wrote it. The replaced record must exist, be of the same record type and subject, have been recorded under the same source, and be neither replaced nor withdrawn. `GET /v1/operator-records` reports `replaces` and `replacedBy`.

## Reading

`GET /v1/operator-records` returns records by record type (one, several, or every type), by subject and by the time they are about, newest first with a cursor, with completeness (`complete`, `missingRequired`, `missingReplay`), origin (artifact, filename, content type, locator, who recorded it), and replacement links. Named by subject, a record is about it as its subject, its related subject or through a reference field, and says which. Subjects are the operator's own ids; Ledger does not create subjects for them. The subjects list, a subject's file and producing records are in `record-productions.md`.

## Permission

Import and entry are observation intake, so they need `input:write` and an observation grant for `operator.record` under the source. People use one conventional source per organization, `operator-records`. The seed grants it to each fictional organization's dispatcher (alpha, beta) and safety manager (utility). Preview needs `input:write`; reading needs `evidence:read`.

## Limits

At most 2,000 rows per file and 10 MiB (the upload limit). Source-scoped references are recorded as given; resolving them through aliases is left to the readers that need it.
