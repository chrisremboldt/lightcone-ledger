# Operator record import and entry

Status: built. Code: `packages/contracts/src/operator-record-import.ts` (shapes, parsing, conversion, time), `packages/contracts/src/operator-record-api.ts` (API schemas), `packages/domain/src/operator-record-import.ts` (preview, commit, reading), `apps/api/src/operator-records.ts` (routes), `apps/web/src/RecordsArea.tsx` and `apps/web/src/RecordForm.tsx` (screen). Sample files: `packages/contracts/fixtures/operator-records/`.

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
