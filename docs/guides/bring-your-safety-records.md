# Bring your safety records

This guide is for an organization that already keeps a safety program: a policy and a manual, a risk matrix, a hazard register with its mitigations, audits and reviews with their findings and actions, and safety reports received by email or on paper. It brings them into Ledger as they are, in the organization's own words and ids, with the command-line client, and gives the same thing as an API request beside each step.

Ledger keeps these records and says what is on file and what is not. It is not a safety management system and does not make anyone conform to a regulation. It never says a risk is acceptable: a named person with the authority accepts it, and Ledger keeps what they saw.

The rule throughout: **the client prepares, a person decides.** A coding agent may write the files, check them and open them as drafts. Assessing a risk, accepting it, adopting a matrix or a document, signing, issuing and closing an action are a person's, sent only with their own credential and their own reason. So is entering a safety report.

`examples/first-operator/safety` holds the files of an invented operator, Example Ridge Survey: its matrix of four bands (the highest one nobody may accept), its policy, its hazard register, an audit, a management review and one report. Every command below runs on them. `tests/integration/safety-records-from-files.integration.test.ts` runs this whole guide through the client's own code; if the guide and the test disagree, the test is right.

## 1. Who does what

| A coding agent, with a service credential | A person, with their own credential |
| --- | --- |
| Write the files from the organization's own documents and spreadsheets | Adopt the matrix and the documents (`sms:adopt`), signing each |
| `pnpm ledger safety check` and `safety draft`: open the matrix, hazards, controls, documents and assurance records as drafts | Assess each hazard (`sms:write`, `decision:write`) |
| `pnpm ledger safety home`: read what is on file and what waits for a person | Accept a risk whose level their authority covers (`risk:accept:low`, `medium` or `high`), signing it |
| Print each decision without `--reason`, for the person to read | Review and issue a document; sign an audit or a review; close an action they own |
| | Enter a safety report received before Ledger (`sms:report:read`) |

**The service credential.** The guide's default credential ([Set up Ledger with a coding agent, step 3](set-up-with-a-coding-agent.md#3-your-own-credential)) cannot draft safety records. If the organization wants its agent to, the administrator issues it with these capabilities, and only these for safety: `sms:read` to read, `sms:write` to open hazards, controls, documents and assurance records, `sms:configure` to open a risk matrix.

```sh
pnpm credential:issue --organization <organization id> --for "Safety records agent" --label "Coding agent on <which computer>" \
  --add service --capability sms:read --capability sms:write --capability sms:configure
```

A service is never given `decision:write`, `sms:adopt` or a `risk:accept` capability. With a service's credential every decision command prints the decision and refuses to send it.

**The people.** The example has three: Avery Example, the administrator; Rowan Example, the safety manager, who may accept low risk; Jordan Example, the accountable executive, who may accept high risk and adopts and signs. The administrator adds them (`pnpm ledger people add ... --reason`, see [step 10 of the agent guide](set-up-with-a-coding-agent.md#10-what-comes-next-and-whose-it-is)), and on a local Ledger issues each a development token on the People screen or with `pnpm ledger people token "<name>" --reason "<why>"`. A capability someone lacks later, such as `risk:accept:high`, is added with `pnpm ledger people set`, prepared by you and sent by the administrator.

## 2. Read what is on file

```sh
pnpm ledger safety home
```

```http
GET /v1/sms/home
```

It says, in the organization's own ids: the risk matrix in force and who may accept each of its levels; the documents in force; who may accept low, medium and high risk and who may adopt; the drafts waiting for a person to adopt or sign; documents to review and to issue; hazards to assess; risks awaiting acceptance and who may accept each, or that nobody may; what is overdue; and the actions of audits and reviews due within 30 days or overdue, by owner. Run it before and after each step below.

## 3. Each file: an example, a check, a draft

```sh
pnpm ledger safety template hazards --out hazards.csv   # an example of the format, in your own ids
pnpm ledger safety check hazards hazards.csv            # what drafting it would open; records nothing
pnpm ledger safety draft hazards hazards.csv            # opens each item as a draft
```

The kinds are `matrix` (YAML or JSON), `hazards` (CSV), `document` (text or Markdown), `assurance` (YAML or JSON) and `report` (text or Markdown). In every file:

- Each record carries the organization's own **id** (`H-001`, `ERS-RM-1`, `ERS-IA-2026-1`). Ledger keeps it with the record, and no two records of one kind carry the same id. **Drafting a file again opens nothing twice**: a record already on file is reported with its Ledger id, and if the file now differs from it, the client says so and still opens nothing; a person revises it on its page.
- A **person** is named by their full name exactly as `pnpm ledger people list` shows it, or by their Ledger id. They must be someone who may read safety records.
- A **date** is a day in the organization's time zone (`2026-03-15`) or a time with its offset (`2026-03-15T09:00:00-07:00`).
- A **severity, likelihood or level** is named by the matrix's id for it or its label (`Now and then`).

Every draft is opened with one API request: `POST /v1/commands` with an `Idempotency-Key` header and an `sms.record.open` command carrying the organization's id as `reference`. The record's shape is in `docs/openapi.json` under `SmsRecordOpenCommand`. Before opening one, the client looks it up:

```http
GET /v1/sms/records?kind=hazard&reference=H-001
```

A second record of a kind under one reference is refused, whoever sends it: `409 reference_in_use`, naming the record that has it.

## 4. The risk matrix

`examples/first-operator/safety/risk-matrix.yaml` is the operator's own matrix: five severities and five likelihoods in its words, and four bands. A matrix has two to six levels, least to most serious, each with the organization's name for it, what it means, and who may accept a risk at that level: `low`, `medium` or `high`, the risk acceptance a person holds on the People screen, a higher one covering the lower, or `not_acceptable`, meaning nobody may. A later level needs at least the authority of the one before it.

```yaml
levels:
  - { id: green, label: Green, meaning: Carry on and review the hazard yearly., acceptance: low }
  - { id: yellow, label: Yellow, meaning: Acceptable when as low as reasonably practicable; written sign-off., acceptance: medium }
  - { id: orange, label: Orange, meaning: Mitigate before the next exposed flight; accepted for 30 days at most., acceptance: high }
  - { id: red, label: Red, meaning: Stop the affected operation., acceptance: not_acceptable }
grid: # one row per likelihood; one band per severity, least to most severe
  not_expected: [green, green, green, green, yellow]
  ...
```

```sh
pnpm ledger safety draft matrix examples/first-operator/safety/risk-matrix.yaml
```

```http
POST /v1/commands
Idempotency-Key: <a new id>

{ "kind": "sms.record.open", "reference": "ERS-RM-1",
  "record": { "kind": "risk_matrix", "schema": "sms.risk-matrix.1", "title": "Example Ridge risk matrix",
              "ownerId": "<Avery's id>", "body": { "name": "...", "severities": [...], "likelihoods": [...],
              "levels": [{ "id": "green", "label": "Green", "meaning": "...", "acceptance": "low" }, ...],
              "cells": [{ "severity": "negligible", "likelihood": "not_expected", "level": "green" }, ...] } } }
```

The draft is in force only once a person who may adopt signs it. The accountable executive reads what they would sign, then signs:

```sh
pnpm ledger safety adopt matrix ERS-RM-1                                    # prints what they would sign
pnpm ledger safety adopt matrix ERS-RM-1 --reason "Our matrix as in the safety manual"
```

The API request is in section 9, Signing.

## 5. Controls

A register's mitigations are sentences. In Ledger each becomes a **control** on its hazard, of the plain control type `control.described-measure`: it states what is done, the control's owner owns it, and it is in effect from its date. Nothing checks it against flights; a person reads it.

```sh
pnpm ledger safety control-types   # every control type, whether it is checked against flights, what a control of it needs
```

```http
GET /v1/sms/control-types
```

A control names its type by id, version and digest; the read gives all three. Other control types, such as an operating limit or a route avoidance area, are checked from flights; a person proposes them on the hazard's page.

## 6. The hazard register

`hazards.csv` has one row per hazard. `pnpm ledger safety template hazards` prints the columns; the ones the draft reads are `id`, `title` (optional), `hazard`, `consequence`, `operation`, `owner`, `raised`, `reviewDue` (the hazard is overdue after it), `controls` (the mitigations, separated by `;`) and `controlsFrom`. The draft opens each hazard, identified and waiting to be assessed, and one plain control per mitigation, with the id `<hazard id>/<n>`:

```sh
pnpm ledger safety draft hazards examples/first-operator/safety/hazards.csv
# 14 in the file: 14 opened, 0 already on file, 0 refused.
```

```http
POST /v1/commands
{ "kind": "sms.record.open", "reference": "H-001",
  "record": { "kind": "hazard", "schema": "sms.hazard.1", "title": "Crewed aircraft along the line", "ownerId": "<Rowan's id>",
              "dueAt": "2027-03-02T07:00:00.000Z",
              "body": { "description": "...", "consequence": "...", "operation": "Line inspection",
                        "source": { "kind": "manual_identification", "reference": "Raised 2025-03-04" } } } }

POST /v1/commands
{ "kind": "sms.record.open", "reference": "H-001/1",
  "record": { "kind": "control", "schema": "sms.control.1", "title": "Traffic receiver on every aircraft", "ownerId": "<Rowan's id>",
              "body": { "hazardId": "<H-001's Ledger id>",
                        "controlType": { "id": "control.described-measure", "version": 1, "digest": "<from the read>" },
                        "parameters": { "measure": "Traffic receiver on every aircraft" },
                        "effectiveFrom": "2025-03-04T07:00:00.000Z" } } }
```

**Assessing** is the safety manager's. The columns `severityBefore`, `likelihoodBefore`, `severityAfter`, `likelihoodAfter` and `newHazards` (`none`, or the new hazards the controls may introduce) hold the register's before and after positions. The assessment cites the matrix in force and every control proposed on the hazard:

```sh
pnpm ledger safety assess examples/first-operator/safety/hazards.csv     # prints each assessment
# Hazard H-001: would record before Catastrophic × Now and then = Orange, a person who may accept high risk may accept it;
#   with 3 controls, Catastrophic × Not expected = Yellow, a person who may accept medium risk may accept it.
# Hazard H-005: not assessed. Give severityBefore and likelihoodBefore.
pnpm ledger safety assess examples/first-operator/safety/hazards.csv --reason "As on our register"
```

`--hazard H-001` assesses only that row. A hazard already assessed so on the matrix in force is not assessed again. Ledger computes the level from the matrix; the request names positions only:

```http
POST /v1/commands
{ "kind": "decision.record", "subject": { "kind": "sms", "id": "<H-001's id>" },
  "expectedRevision": <record.revision>, "expectedDependencyBasis": "<basis.dependencyBasis>",
  "decision": { "kind": "risk.assess", "note": "As on our register",
                "matrix": { "recordId": "<matrix id>", "versionNumber": 1 },
                "initial": { "severity": "catastrophic", "likelihood": "now_and_then" },
                "controls": [{ "recordId": "<H-001/1's id>", "versionNumber": 1 }, ...],
                "residual": { "severity": "catastrophic", "likelihood": "not_expected" },
                "newHazardCheck": { "answer": "none_identified" } } }
```

`expectedRevision` and `expectedDependencyBasis` are the `record.revision` and `basis.dependencyBasis` of `GET /v1/sms/records/<id>`, read just before.

**Accepting** the residual risk is signed by a person whose authority covers its level:

```sh
pnpm ledger safety accept H-003 --reason "Stand-off in place"                       # Rowan: Green, low risk
pnpm ledger safety accept H-001 --reason "Traffic receiver and notices in place"    # Jordan: Yellow, medium risk
pnpm ledger safety accept H-004 --reason "..."
# Not sent. “Example Ridge risk matrix” says Red risk may not be accepted: Stop the affected operation.
#   Reassess it with further controls.
```

A risk at a level nobody may accept is refused to everyone, in the matrix's own words (`409 risk_not_acceptable`). It stays awaiting acceptance, waiting on nobody, until a person reassesses it with further controls; the Safety home says so.

## 7. Documents

A document is a text or Markdown file with a few stated values above it, between two lines of three dashes:

```markdown
---
id: ERS-POL-1
title: Safety policy
type: safety_policy
owner: Avery Example
number: ERS-POL-1
revision: "2"
summary: Example Ridge Survey's commitment to safety, how it reports, and who is accountable.
changeReason: The policy in force since January, entered in Ledger as it is.
reviewDue: 2027-01-15
---
# Safety policy
...
```

`type` is one of `safety_policy`, `accountable_executive_designation`, `roles_and_authority`, `emergency_response_plan`, `sms_manual`, `procedure`, `safety_notice`, `oem_manual`, `service_bulletin`, `specification`, `certificate`, `recordkeeping_plan` or `other`. `purposes` may list the purposes an adopted rule pack offers (`GET /v1/organization/document-purposes`). The draft is a controlled revision (`sms.document.2`, authored by the organization):

```sh
pnpm ledger safety draft document examples/first-operator/safety/safety-policy.md
pnpm ledger safety review ERS-POL-1 --reason "Matches the signed paper copy"    # a person with sms:write
pnpm ledger safety adopt document ERS-POL-1 --reason "Our policy"              # a person who may adopt; signed
pnpm ledger safety issue ERS-POL-1 --recipient everyone --reason "The policy in force"
```

```http
POST /v1/commands  { "kind": "decision.record", ..., "decision": { "kind": "document.review", "note": "...", "versionNumber": 1, "attachmentIds": [] } }
POST /v1/commands  { "kind": "decision.record", ..., "decision": { "kind": "document.issue", "note": "...", "versionNumber": 1,
                     "adoptionId": "<the document.adopt decision's id>", "recipientIds": ["<person id>", ...] } }
```

An issue takes effect when it is recorded, or later with `--from <date>`; it cannot be backdated. Each reader acknowledges it in the web app.

## 8. Audits and reviews

An audit, a management review, an investigation or another safety assurance record is a YAML or JSON file with its findings and the actions it sets, each action with an owner and a due date:

```yaml
id: ERS-IA-2026-1
title: Internal audit, February 2026
owner: Rowan Example
type: audit
performedOn: 2026-02-10
completedOn: 2026-02-12
scope: Line inspection flights against the waiver and the operations manual, September to January.
examined: 40 flight records, the training records of four pilots, two flights observed from the operations room.
findings:
  - { id: F1, text: Three preflight checklists were not signed by the pilot in command. }
actions:
  - { id: A1, what: Brief every pilot on signing the preflight checklist., owner: Rowan Example, due: 2026-03-15, finding: F1 }
```

`type` is one of `audit`, `program_evaluation`, `occurrence_investigation`, `noncompliance_investigation`, `management_review`, `change_assessment`, `hazard_notice_sent` or `hazard_notice_received`; some ask for one more value ([Safety assurance records](../design/assurance-records.md)).

```sh
pnpm ledger safety draft assurance examples/first-operator/safety/internal-audit.yaml
pnpm ledger safety sign ERS-IA-2026-1 --reason "The audit as completed"                      # a person who may adopt; signed
pnpm ledger safety close-action ERS-IA-2026-1 A1 --reason "Briefed every pilot on 2026-03-10" # the action's owner
```

```http
POST /v1/commands  { "kind": "decision.record", ..., "decision": { "kind": "action.close", "note": "Briefed every pilot on 2026-03-10", "actionId": "A1" } }
```

Signing sets the record's actions. An action not closed by its due date is listed as overdue under its owner on the Safety home. An action is closed by its owner or the record's owner, with their own credential, saying what was done.

## 9. Signing

Adopting a matrix or a document, signing an assurance record and accepting a risk are signed decisions. Ledger shows the signer the exact content first:

```http
GET /v1/sms/records/<id>/signing?meaning=matrix.adopt      # or document.adopt, assurance.sign, risk.accept
```

It returns `intent`, the sentence the person signs, `contentDigest`, `available` (with a `reason` when it is not), `basis`, and `reauthentication`: how this Ledger confirms that the signer is who they say. The decision repeats the intent and the digest:

```http
POST /v1/commands
Idempotency-Key: <a new id>
x-ledger-reauthentication: <grant>          # on a local Ledger only

{ "kind": "decision.record", "subject": { "kind": "sms", "id": "<id>" },
  "expectedRevision": <basis.revision>, "expectedDependencyBasis": "<basis.dependencyBasis>",
  "decision": { "kind": "matrix.adopt", "note": "<their reason>", "versionNumber": 1,
                "signature": { "intent": "<intent>", "contentDigest": "<contentDigest>", "reviewed": true } } }
```

Without a fresh confirmation it is refused with `403 reauthentication_required`.

- **On a local Ledger** (`reauthentication` is `local_fixture`, and `GET /v1/sign-in` reports `developmentTokens: true`), the person confirms with their own development token: `POST /v1/local/reauthentications` with `{ "credential": "<their token>" }` and the same token as bearer returns a `grant`. It lasts five minutes and is spent by one signature, sent in the `x-ledger-reauthentication` header. The client does this itself for a person's development token, and keeps the grant nowhere.
- **On a deployment** (`openid_connect`), the confirmation is a sign-in at the identity provider within the last five minutes, which only the browser does. The client prints the decision and says the person signs it on the record's page; the Safety home lists it as waiting for a person.

## 10. Safety reports received before Ledger

A report is a text or Markdown file with its stated values above the narrative:

```markdown
---
id: ERS-SR-1
owner: Rowan Example
received: email          # in_person, phone, email, paper or app
receivedAt: 2026-10-03
occurredAt: 2026-10-02
operation: Line inspection
---
What the reporter wrote, as they wrote it.
```

`reporterName`, `reporterContact`, `site` and `title` are optional. A report's title, narrative and reporter are readable only by people cleared to read reports, so a report is entered by such a person (`sms:write` and `sms:report:read`) with their own credential; the client refuses a service's. It names a report only by its id and its Ledger id: nothing of the narrative, the title or the reporter reaches what it prints, its errors or its `--json` output.

```sh
pnpm ledger safety draft report examples/first-operator/safety/safety-report-SR-1.md
```

```http
POST /v1/commands
{ "kind": "sms.record.open", "reference": "ERS-SR-1", "confidentiality": "safety_report",
  "record": { "kind": "report", "schema": "sms.report.1", "title": "Safety report ERS-SR-1", "ownerId": "<Rowan's id>",
              "body": { "narrative": "...", "occurredAt": "2026-10-02T06:00:00.000Z", "operation": "Line inspection",
                        "received": { "channel": "email", "receivedAt": "2026-10-03T06:00:00.000Z" } } } }
```

New reports come in through Ledger itself: anyone signed in reports from any screen, and a reporting link a person issues on the Safety reports screen takes them without sign-in.

## The commands

| Command | What it does | Needs |
| --- | --- | --- |
| `pnpm ledger safety home` | What is on file and what is not, what waits for a person, actions due and overdue | `sms:read` |
| `pnpm ledger safety control-types` | Every control type and what a control of it needs | `sms:read` |
| `pnpm ledger safety template <kind> [--out <file>]` | An example file of the kind | Any credential |
| `pnpm ledger safety check <kind> <file>` | What drafting the file would open; records nothing | `sms:read` |
| `pnpm ledger safety draft <kind> <file>` | Opens each item as a draft under the organization's own id; nothing twice | `sms:write`; `sms:configure` for a matrix; a person with `sms:report:read` for a report |
| `pnpm ledger safety assess <hazards.csv> [--hazard <id>]...` | Prints each assessment; sends it only with `--reason` and a person's credential | `sms:write`, `decision:write`, a person |
| `pnpm ledger safety accept <hazard>` | Prints the acceptance a person would sign; signs it only with `--reason` | `decision:write` and the risk acceptance the level needs, a person |
| `pnpm ledger safety adopt matrix\|document <id>` | The same, adopting | `decision:write`, `sms:adopt`, a person |
| `pnpm ledger safety review <document>` / `issue <document> --recipient ...` | Reviews or issues a document revision, only with `--reason` | `decision:write`, `sms:write`, a person |
| `pnpm ledger safety sign <assurance record>` | Signs it, which sets its actions, only with `--reason` | `decision:write`, `sms:adopt`, a person |
| `pnpm ledger safety close-action <assurance record> <action>` | Closes an action, only with `--reason`: what was done | `decision:write`, `sms:write`, the action's or the record's owner |

`<id>` is the organization's own id or the Ledger id. Add `--json` to any command for the API's data. Printed without `--reason`, a decision is only shown, and the command exits with 0 whatever credential runs it, yours included: its last line says who sends it and how. This holds for every command that prepares a person's decision, `packs adopt`, `people add`, `people set`, `people token` and `findings take` and `close` as well as the safety ones. A command exits with code 1 when Ledger refused something or the client would not send what it was asked to send (a decision with `--reason` under a service's credential, a row of a file with a problem), and with 2 for a mistake in the command.
