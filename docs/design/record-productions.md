# Records by subject, and producing them on request

Status: built. Code: `packages/contracts/src/operator-record-subjects.ts` (names, subject schemas), `packages/contracts/src/operator-record-production.ts` (produced CSV, format, schemas), `packages/domain/src/operator-record-reads.ts` (records by type, subject and time), `packages/domain/src/operator-record-subjects.ts` (subjects, a subject's file, names), `packages/evidence/src/record-productions.ts` and `record-production-assembly.ts` (the command and the file), `packages/evidence/src/zip.ts`, `apps/api/src/operator-record-subjects.ts` and `apps/api/src/record-productions.ts` (routes), `apps/web/src/RecordSubjects.tsx` (screen), `tools/verifier/record-production.mjs` and `record-production-cli.mjs`. Migration `0083_record_productions.sql`. Tests: `tests/unit/record-production.test.ts`, `tests/integration/record-productions.integration.test.ts`, `tests/browser/record-subjects.spec.ts`.

## The question

An operator is asked for its records: "provide access or copies upon request". It also needs to see everything it holds about one pilot, aircraft or flight. Ledger's exports were for a flight decision, a finding or a period of safety records, and records could only be read one record type at a time, with subjects shown by id.

## Records by subject

A record is **about** a subject in one of three ways: the subject is its subject; it is its related subject; or one of its reference fields names it and the field's `referenceKind` is the subject's kind (a role assignment's `personId` names a person). Which fields those are comes from the registered field metadata; no code names a record type.

`GET /v1/operator-records` takes:

- `recordType`: one type, several separated by commas, or none for every type;
- `subjectId` (the operator's own id), optionally `subjectKind`. Each record returned says how it is about the subject in `about`: `subject`, `related_subject` or `reference`. `subjectKind` without an id still narrows by the record's own subject kind; `subjectKind=organization` reads the records about the organization itself;
- `from` and `to`: records whose time ends at or after `from` and starts before `to`. A record's time is its interval, or its single time (`occurredAt`; for a standing record without a time field, the time it was recorded);
- `cursor` and `limit` (at most 500).

Records come newest first by the start of the time they are about, then by id, so paging is stable. Replaced records are included and carry `replacedBy`; corrections carry `replaces`. Subjects are read under one source, `operator-records` unless `sourceId` says otherwise.

## Names

A record type may declare `nameFields`: the fields that give its subject the name people know it by. Three types do: the personnel file (`fullName`), the aircraft identity (`aircraftMakeModel`, `registrationNumber`) and the flight plan (`windowStartsAt`, `windowEndsAt`, `routeSummary`). The name of a subject is taken from the latest current (not replaced, not withdrawn) record of a naming type about it, under the same source. Times are shown in the organization's time zone, two times in a row as one span: `2026-11-10 09:00 to 10:00 (America/Denver), Ridge line segment 4`. A subject with no such record is shown by its id alone.

Names are read when they are shown, never stored on other records. `subjectNames` (domain) uses the same read, so every screen that lists subjects (Coverage by rule, Findings by subject, the Records screen) shows the name beside the id. A new record type that names its subject declares `nameFields`; nothing else changes.

## Subjects and a subject's file

`GET /v1/operator-records/subjects?kind=person` lists the subjects of one kind that records are about, by id, with the name, how many records are about each (and how many of those are current), how many findings about it are open, and the latest time a record about it is about. It reads at most 2,000 subjects (`truncated` says when there are more) and pages by id; `search` matches the name or the id.

`GET /v1/operator-records/subjects/{kind}/{id}` is the subject's file: every record about it (newest 500; `records.truncated` says when there are more), grouped by type; each rule that has evaluated it under an adoption, with the result that stands for it now, counted as Coverage by rule counts it; and its open findings. For the organization itself, the id is the organization's subject id, which the subjects list gives.

The Records screen opens on these lists, by kind. A subject's file links to the records of each type and offers **Produce these records**.

## Producing records

`POST /v1/record-productions` with an idempotency key:

| Field | Meaning |
| --- | --- |
| `subjects` | `[{ kind, id }]`, at most 50; `{ kind: "organization" }` for the organization itself. Empty: every subject. |
| `recordTypes` | Empty: every type. |
| `from`, `to` | As for reading. |
| `includeOriginals` | Whether the original files are included. They are always listed with their SHA-256. |
| `withFlights` | Whether the records of the flights a selected person was assigned to are included. The flights are always listed. |
| `reason`, `requestedBy` | Required, in the organization's words. |

It needs `evidence:read`, the capability that reads records. It is a recorded command: the journal event `record-production.produce` on its own stream carries the selection, reason, who asked, counts, journal positions and digests, and an append-only row in `record_productions` keeps the same record (migration 0083: row-level security, no update or delete). The .zip is kept in object storage and served again by `GET /v1/record-productions/{id}/content`, checked against its recorded SHA-256 and length before it is sent. `GET /v1/record-productions` is the **Produced records** list: who, when, why, who asked, and the selection.

Only `operator.record` observations are read. Safety reports and restricted attachments are never `operator.record` observations, and restricted bytes never become artifacts, so they cannot be included.

### The file

A .zip (deflate or stored, UTF-8 names, one modification time for every entry, no extra fields; written by `packages/evidence/src/zip.ts`, with no new dependency). The same records and production give the same bytes.

- `index.html`: who produced the file, when (in the organization's zone and UTC), the reason, who asked, the selection in words, the statements below, a table per record type with each record's subject (name and id), time, fields, when and by whom it was recorded and whether it was replaced, and the original files with their SHA-256. Plain HTML with an inline print style (landscape, table headers repeated); no script, no remote resource.
- `manifest.json`: `format` (`ledger.record-production.1`), `productionId`, `organization` (id, name, time zone), `producedBy`, `producedAt`, `reason`, `requestedBy`, `selection`, `journal` (each stream the records' events are in, with its sequence and head hash when they were read), `counts`, `limits`, `files` (every other file: path, role, content type, length, SHA-256, and for a records file its type, version and row count), `originals` (every original file: artifact, file name, content type, length, SHA-256, how many records came from it, and its path when included), and `statements`.
- `records/<recordType>-v<version>.csv`: one per record type.
- In `manifest.json`, `flights`: for each selected person, every record about a flight that names them (as related subject or in a reference field, such as a role assignment's `personId`), with the flight's id, the record's time and id. The index lists them under **Flights assigned**. With `withFlights` the records about those flights are read too, within the same types, dates and bounds.
- Each original is listed with `otherRecords`: how many records from the same file this production does not hold, such as rows about other subjects. The counts give `originalsWithOtherRecords` and `otherRecords`; the index, the statements and the client's output say so, since an included original goes into the file whole.
- `originals/<artifactId>/<file name>`: when asked.

The SHA-256 of `manifest.json` is returned as `manifestSha256` and in the `X-Manifest-SHA256` header. It is the digest to keep apart from the file.

### The CSV

The import template's columns (`subjectId`, `subjectKind`, related subject columns, one per field, `replaces`), then `recordId`, `recordedAt`, `recordedBy`, `replacedBy`, `originalFile`, `originalSha256` and `notes`. Rows are in the order the records were recorded, so a correction follows what it corrects. Values are in the units the record type stores. Beside each number and time field, a column `<field> as entered` shows the value as it was entered, from what the import kept in `values.entered`: `400 ft`, `2026-09-22 10:00 in America/Chicago`; a value entered in the stored unit shows that unit (`121.92 m`). A record placed by a date alone is written as the date (`2026-10-05`), and its as-entered column says `2026-10-05 (date only)`; importing it again places it on that day. The conversion is also in `notes`. The importer reads the as-entered columns as produced columns, not values. Booleans are `yes`/`no`. A record about the organization itself has no `subjectId`. A reference or subject that is a Ledger id rather than the operator's own is written as its id and said so in `notes`.

**Importing a produced CSV.** The importer ignores the produced columns as values. When a row's `replaces` names the `recordId` of an earlier row of the same file, the row replaces the record that earlier row recorded; otherwise `replaces` names a record of the importing organization, as before. So a produced CSV imports into another organization as the same records, replaced ones still replaced. Values are not altered on export, so a cell a spreadsheet would read as a formula is written as it was recorded; open the CSV as text or import it.

### Bounds

At most 10,000 records (`production_too_large`, 413, asking to narrow by subject, record type or dates), 50 subjects, 64 MiB of included originals and a 96 MiB file. A CSV row is about 400 bytes, so 10,000 records is about 4 MB of CSV: several years of one aircraft's or person's records, or most of a year for a small fleet (about six records a flight). Originals are each at most 10 MiB, the upload limit. The read takes one more row than the bound; a test produces exactly at the bound and is refused one below it.

## Verifying

`node tools/verifier/record-production-cli.mjs records.zip --expected-manifest-sha256 DIGEST` reads the .zip with Node alone and imports no Ledger package. It checks the archive (no encryption, no ZIP64, names inside the archive, each entry's CRC-32 and length), that the manifest is the format, that every listed file is present with its length and SHA-256 and no file is unlisted, that `index.html` holds no script and loads nothing from elsewhere, that each records CSV has the produced columns and the rows the manifest states, that every row's `originalSha256` is a listed original, that the counts match, that included originals match their listed digests and are present only when asked for, and, with the digest, that the manifest is the one kept. Exit `0` verified, `2` consistent but not anchored, `1` failed with named issues. It cannot show that the records are complete, that the journal positions are the organization's, or that a record's values are true.
