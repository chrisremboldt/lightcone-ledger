# Safety records from an organization's own files

Design note. Builds on the safety record envelope (`sms-envelope.ts`), risk levels (`risk-levels.md`), controls as rules (`controls-as-rules.md`), assurance records (`assurance-records.md`) and report submission (`report-submission.md`). Migration 0089.

## The gap

An operator arrives with a safety program already kept: a policy and a manual, a risk matrix, a hazard register with its mitigations, audits and reviews with findings and actions, reports received by email or on paper. Bringing it in was described only as browser steps; through the API it worked, but signing was undocumented, a register's mitigations had nowhere to go, and nothing kept a second import from opening every record twice.

The rule here is the one the adoption commands follow: **the client prepares, a person decides.** A service may open drafts; every decision is sent only with a person's credential.

## 1. The files

Each kind has one file format, written in the organization's own ids. `pnpm ledger safety template <kind>` prints an example; `pnpm ledger safety check <kind> <file>` says what drafting it would open and records nothing.

| Kind | File | One file holds |
| --- | --- | --- |
| `matrix` | YAML or JSON | One risk matrix: its name, five severities, five likelihoods, two to six levels with who may accept each, and the level of each cell, as a grid (one row per likelihood, one level per severity) or a list of cells |
| `hazards` | CSV | A hazard register: one row per hazard, its mitigations in one column separated by `;`, and the before and after positions a person assesses with |
| `document` | Text or Markdown, with a few stated values in a front matter block between `---` lines | One document revision: its type, number, revision, summary, reason for the revision, review date and purposes, and its text |
| `assurance` | YAML or JSON | One safety assurance record: its type, dates, scope, what it examined, its findings and its actions with owners and due dates |
| `report` | Text or Markdown, with stated values in a front matter block | One safety report received before Ledger: how and when it was received, and its narrative |

A person is named by their Ledger id or by their full name exactly as `pnpm ledger people list` shows it; a name that matches nobody, or more than one active person, is refused. A date is a day in the organization's time zone or a time with its offset. Severity, likelihood and level are named by the matrix's id or its label.

## 2. What a draft is, for each kind

| Kind | Drafting opens | Status after drafting |
| --- | --- | --- |
| `matrix` | A risk matrix record (`sms.risk-matrix.1`) | Draft, waiting for a person to adopt it |
| `hazards` | A hazard (`sms.hazard.1`) per row, and a control (`sms.control.1`, type `control.described-measure`) per mitigation, effective from the row's `controlsFrom` or the day the hazard was raised, owned by the hazard's owner | Hazard identified, waiting for a person to assess it; controls proposed |
| `document` | A controlled document revision (`sms.document.2`, authored by the organization) | Draft, waiting for a person to review, adopt and issue it |
| `assurance` | A safety assurance record (`sms.assurance.1`) | Draft, waiting for a person to sign it, which sets its actions |
| `report` | A safety report (`sms.report.1`, confidentiality `safety_report`) | Received |

A hazard is not assessed by drafting. Its before and after columns stay in the file until a person runs `pnpm ledger safety assess` with their own credential.

## 3. Idempotency by the organization's own id

`sms.record.open` takes an optional `reference`: the organization's own id for the record, such as `H-001`, `IA-2026-02` or `ERS-SMS-001`, 1 to 80 characters. It is set once when the record is opened, kept on `sms_records.reference` and never revised. Migration 0089 adds the column and a unique index on (organization, kind, reference): two records of one kind can never carry the same reference, whoever opens them and however many processes race.

- Opening a record with a reference already in use for that kind is refused with `409 reference_in_use`, naming the record that has it.
- `GET /v1/sms/records?kind=<kind>&reference=<reference>` finds it; every record summary carries its `reference`.
- `pnpm ledger safety draft` looks each item up first. One on file opens nothing and is reported as on file, with its Ledger id; if the file's content differs from the version on file, the client says so and opens nothing. Revising it is a person's work on the record's page.
- A control drafted from a hazard row carries the reference `<hazard reference>/<n>`, its place in the row's list.

So importing the same file again opens nothing twice, under any credential.

A safety report's reference is not its narrative, title or reporter; it is an ordinary column, readable with `sms:read`, like the record's status.

## 4. Which capability lets a service draft

A service may open drafts where the organization grants it:

- `sms:write` opens hazards, controls, documents and safety assurance records;
- `sms:configure` opens a risk matrix;
- `sms:read` reads the Safety home and the register.

The guide's default service credential has none of these. An administrator adds them by issuing the credential with `--capability sms:read --capability sms:write` (and `--capability sms:configure` for the matrix). A service is never given `decision:write`, `sms:adopt` or a `risk:accept` capability.

## 5. What stays a person's

These are sent only with a person's credential. The client prints exactly what the person would record (the decision, its note, and for a signature the intent statement and content digest Ledger computes), and sends it only with that person's `--reason`:

| Command | Decision | Signed |
| --- | --- | --- |
| `safety assess <hazards file>` | `risk.assess`, with the hazard's proposed controls | no |
| `safety accept <hazard>` | `risk.accept` | yes |
| `safety adopt matrix <id>` / `safety adopt document <id>` | `matrix.adopt` / `document.adopt` | yes |
| `safety review <document>` | `document.review` | no |
| `safety issue <document> --to ...` | `document.issue` | no |
| `safety sign <assurance record>` | `assurance.sign` | yes |
| `safety close-action <assurance record> <action>` | `action.close` | no |
| `safety draft report <file>` | opens a safety report | no; needs `sms:report:read` |

With a service's credential each prints the decision and refuses to send it.

**Signing.** A signed decision needs a fresh confirmation that the signer is who they say, presented in the header `x-ledger-reauthentication`:

- On a local Ledger, when `GET /v1/sign-in` reports `developmentTokens: true` and the credential is a development token, the client asks `POST /v1/local/reauthentications` with the person's own token for a grant, sends it once in the header with the decision, and never writes it anywhere. A grant lasts five minutes and is spent by one signature.
- On a deployment, a person confirms by signing in again at the identity provider, which only the browser can do. The client prints the decision, says the person signs it on the record's page, and sends nothing. The Safety home lists the drafts waiting for a person.

**Reports.** A report received before Ledger is entered by a person cleared to handle reports (`sms:write` and `sms:report:read`), with their own credential. The client refuses a service's credential for it. Nothing of a report's narrative, title or reporter reaches a line the client prints, an error message or its `--json` output: the client names a report by its reference and its Ledger id only.

## 6. Reads

- `GET /v1/sms/control-types` lists every registered control type with what a control of it needs (its parameter schema) and whether Ledger checks it against flights; `pnpm ledger safety control-types` prints it. `control.described-measure` is the plain control: it states what is done, its record's owner owns it and it is in effect from its date, with no check against flights.
- `GET /v1/sms/home` and `pnpm ledger safety home`: what is on file and what is not (a matrix in force, the documents in force by type), what needs assessment, what awaits acceptance and by whom, drafts waiting for a person, and actions due and overdue.

## 7. The API reference

Every route that needs a fresh confirmation says so in `docs/openapi.json`, with the header and both ways of obtaining it: `POST /v1/commands` (for `risk.accept`, `matrix.adopt`, `document.adopt` and `assurance.sign`) and `POST /v1/local/reauthentications`.
