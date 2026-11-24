# Required records and the recordkeeping plan

Status: built. Contracts: `RulePackRequiredRecordSchema` in `packages/contracts/src/rule-packs.ts`, `PackFileRequiredRecordSchema` in `pack-files.ts`, the read and the draft in `required-records.ts`. Code: `packages/pack-part108-nprm/src/required-records.ts` and `packages/pack-part107/src/required-records.ts` (the declarations), `packages/standard-packs/src/pack-builder.ts` and `pack-files.ts` (`records:` in a description), `packages/domain/src/required-records.ts` (the read and the plan's text), the blank check in `packages/domain/src/sms-documents.ts`, `apps/api/src/required-records.ts` (routes), `apps/web/src/RequiredRecords.tsx` (screen), `packages/cli/src/records-plan.ts` (commands). Tests: `tests/unit/required-records.test.ts`, the pack tests named `*required-records.test.ts`, `packages/standard-packs/tests/pack-files.test.ts`, `packages/cli/tests/cli.test.ts`, `tests/integration/recordkeeping-plan.integration.test.ts`, `tests/browser/recordkeeping-plan.spec.ts`. Builds on `on-file-checks.md` (purposes, controlled documents), `pack-files.md` (pack descriptions and files) and `record-productions.md` (producing records on request).

## The question

A rule text lists records an operator must keep, says how long, and asks that they be produced on request. Proposed § 108.505(b)(7) asks an applicant for "a recordkeeping plan as required under § 108.40". Ledger is meant to be the method such a plan describes, but nothing in it states, for each record the text lists, where Ledger holds it, for how long the text asks it to be kept, or how it is produced. Nothing reads a retention period.

Ledger answers only: **which records does the text list, which Ledger records hold them, how many are on file and what time they cover, and what does the text say about keeping them.** It never says a requirement is met, a record is kept long enough or a plan is adequate.

## 1. A required record on a pack version

A pack version may carry `requiredRecords`, data like its `purposes`. Each:

| Field | What it is |
| --- | --- |
| `id` | Unique in the pack, prefixed like a purpose (`part108-nprm.records.flights`). |
| `title` | What must be kept, in plain words: "Record of each flight". |
| `source` | The paragraph that lists it, quoted and pinned exactly as rules quote: a retained document span with its SHA-256, or an organization's own provision carried whole. |
| `keptBy` | Who the text says keeps it, in the text's own words ("Each operator"). |
| `heldBy` | The Ledger records that hold it, at least one: `{ kind: "operator_record", recordType }` for an operator record type, or `{ kind: "safety_record", recordKind }` for one of Ledger's own safety records (`document`, `risk_matrix`, `hazard`, `control`, `assurance`, `report`). |
| `retention` | Optional: `{ source }`, the words that say how long it is kept, quoted and pinned the same way. Absent when the text states no period. |

There is no number of months. The retention is the text's own words, so nothing is computed that the text does not say, and nothing is ever removed because a period ran out. The fields are part of the pack version and its digest.

The Part 108 pack (version 3) declares proposed § 108.40(a) to (e), each with its timeframe from (f). The Part 107 pack (version 2) declares what § 107.7 and § 107.21(b) require to be produced on request; the text states no period for them. A `heldBy` record type must be one this Ledger registers; a pack file naming one it does not have is refused when it is loaded.

## 2. In a pack description and a pack file

A `pack.yaml` may list `records:`, each with `id` (the builder prefixes the pack id), `title`, `quote` (exact words of the source, located as rule quotations are, with `occurrence` when they repeat), `keptBy`, `heldBy` (a list of record type names, or `safety:<kind>`) and optionally `retention: { quote }`. The builder writes them into the pack file as `requiredRecords`, each quotation as `{ source, start, end, reference }`; loading turns each into an `operator_procedure` source carrying the quoted bytes. A waiver description thus declares the records its conditions ask for.

## 3. The read

`GET /v1/organization/required-records` (needs `evidence:read`) lists, for the packs the organization has adopted (the adoptions that stand: in effect or still to come, neither revised nor succeeded, so a version a later one replaced from its first day is not among them; the same function decides which adoptions every such list reads), each required record once by id, taking the declaration of the highest version adopted:

- the pack versions that declare it, the quoted paragraph, `keptBy`, the quoted retention or none;
- for each record that holds it, and in total: how many are on file now (current: not replaced, not withdrawn), how many earlier versions corrections replaced (kept, never removed), and the earliest and latest time a record starts (an interval's start, or the time of a single record). An interval's end is not read: for many record types it is a schedule or a validity, such as an inspection's next due time or a plan's window, not a time anything was recorded. Safety records count their opening time.

Operator records are counted under every source, and whether a record type is carried as `operator.record` or recorded as its own observation type (a duty or rest period is recorded as `crew.duty-period`, the observation the duty and rest rules read). A count is what is on file, never a judgment: the read's wording says "on file", never "kept", "met" or "complete".

## 4. The recordkeeping plan

A controlled document of its own type, `recordkeeping_plan`. The Part 108 recordkeeping-plan purpose names that type (`documentTypes`), so an issued plan serves proposed § 108.505(b)(7) by being what it is, as a safety policy serves its purpose.

`GET /v1/organization/recordkeeping-plan/draft` returns a draft built from the read at that moment: a title, a `sms.document.2` body ready for `sms.record.open`, and the blanks it holds. Starting a plan (web or command line) opens that body as a draft document through the ordinary command; nothing new is recorded by the read. The text has these sections, in neutral words that describe what this Ledger does and nothing fictional:

1. **What this plan covers**: the organization, the packs whose required records it lists, and the date the list was read.
2. **Who is responsible**: a blank.
3. **The records**: for each required record, its title, the quoted paragraph and reference, who the text says keeps it, the Ledger records that hold it, what was on file when the draft was made, and the retention as the text states it (or that the text states no period).
4. **How records are kept**: every record, input and correction is appended; a correction is a new record naming the one it replaces and both are kept; none is changed or removed. Original uploaded files are kept with their SHA-256 digests.
5. **How records are produced on request**: by subject, record type and dates, as a .zip with a manifest, a CSV per record type and, when asked, the original files; each production is itself recorded (who, when, why, who asked); the file is checked offline with `tools/verifier/record-production-cli.mjs` against the manifest digest kept apart.
6. **Where the records are held**: blanks for where the deployment runs and how its database and stored files are backed up.
7. **How long**: Ledger removes no record; keeping the deployment and its backups for as long as the periods above ask is the organization's. A blank for how long the organization undertakes to keep them.

A blank is written `[To be filled in: <what>]` so it is visible as a blank wherever the text is read. A person edits the draft like any document. Reviewing or issuing a revision of a `recordkeeping_plan` whose text still holds a blank is refused (`plan_blank_unfilled`), with a sentence naming the first blank. The plan is then signed and issued like any controlled document; once issued and in force it serves the purpose, and the rule on § 108.505(b)(7) names it.

Nothing in the draft says the plan is adequate or that the records meet the text. Ledger names no rule or regulation in core code: the required records are pack data, and the plan's wording is about this Ledger's own behaviour.

## 5. Command line

- `pnpm ledger records produce [--subject <kind>:<id> | organization]... [--type <record type>]... [--from <date>] [--until <date>] [--originals] --reason "<why>" --requested-by "<who>" --out <file>` produces records over `POST /v1/record-productions`, downloads the .zip, saves it only when it matches its recorded length and SHA-256, and prints the manifest digest to keep apart with the verifier command. A date is a day in the organization's zone, as for adoptions.
- `pnpm ledger plan draft [--out <file>] [--open]` prints the draft text (or writes it); with `--open` and a person's credential it opens it as a draft controlled document and prints its id.

## 6. What it does not do

It does not decide that a record is kept long enough, that the list is the whole of what the text requires, or that the plan meets § 108.505(b)(7) or § 108.40. It does not delete, archive or expire anything. It cannot see the deployment's backups.
