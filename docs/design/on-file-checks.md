# On-file checks: what the organization keeps under document control

Status: built. Builds on the observation vocabulary (`observation-vocabulary.md`), rule coverage (`rule-coverage.md`) and the lock order (`lock-order.md`).

## The question

Every check here answers one question: **is this on file, and which record is it?** Never "is it adequate".

- **Supported** names the record: its title, its revision and the date it came into force. "In force: “Safety policy”, revision 3, since 2026-03-01."
- **Not on file** says what is missing: "No safety policy on file." It is `insufficient`, `pending`, reason `record_not_on_file`, so the coverage view counts it under "No record on file" and opens no finding.
- A result is never a finding about quality. No wording says an organization conforms, is ready, is complete or has a compliant program. Each rule's `forAPerson` says that whether the content meets the paragraph is for a person.
- Ledger is not a safety management system and does not make anyone conform to a regulation. It reports what is on file and what is not.

## 1. What Ledger records about the organization

When something changes what the organization keeps on file, Ledger records a neutral observation about the organization, `organization.record-in-force@1` (timing `interval`, subject the organization). It says what kind of record it is, its title, its revision, the dates it is in force (the interval) and the purposes it serves. It never holds the record's content, and never anything from a safety report.

| Record kind | Recorded when | In force | Title and revision |
| --- | --- | --- | --- |
| `document` | a revision is issued, superseded, withdrawn or retired, or expires | from its effective date until the earliest of its expiry, the effective date of the next issue of the same document, and the document's retirement; a withdrawn issue, or one retired before it took effect, has none | the issued revision's title and revision label |
| `risk_matrix` | a matrix version is adopted | from its adoption until the next adoption of any matrix | the matrix version's title, "Version N" |
| `hazard` | a hazard is opened, assessed, accepted, closed or reopened | from its opening until it is closed | none: only whether its risk is assessed and accepted |
| `assurance` | a safety assurance record is signed or one of its actions is closed | the record: from its first signature, with no end; each action it set: from that signature until it is closed (`assurance-records.md`) | none: only its type, its class and, for an action, when it is due |

A hazard carries no title, because a hazard can be opened from a safety report and its title can repeat the report's words. A safety report itself is never recorded here, nor is a restricted attachment.

Each change re-states the record's observations from its decisions: an observation whose interval changed is replaced (`replaces`), one that no longer applies is withdrawn, a new one is accepted. The observations come from the source `ledger.records-on-file`, under the person who recorded the decision, in the same transaction, with no grant (the decision's own capability authorized them). Rules read them like any other observation: a replacement or withdrawal queues the rules that read it.

Because they are about the organization, these observations sit on streams that the evaluation of almost any subject reads. The newer evidence shown on a hazard opened from a finding leaves them out, as it leaves out recorded evaluations: they are derived from Ledger's own safety decisions (opening that hazard among them), not evidence about the finding. Until the worker projects one, an indicator read reports evaluations as pending, as for any input not yet projected.

The basis a person's decision rests on leaves out the streams of these records and the organization's own rule evaluations, which these records cause when a pack reads them (`decision-basis.md`). Indicator reads do not wait for these records to be projected.

Core code names record kinds of Ledger's own safety records. It names no rule, pack, regulation or purpose.

## 2. Purposes

A pack declares the purposes it looks for, as data on the pack version (`purposes`): an id, a title a person understands, the paragraph it quotes, and optionally the controlled-document types that serve it by being what they are (`documentTypes`; the Part 108 safety policy purpose names the safety policy type). A document of such a type serves the purpose with no tick, and the purposes control shows it as served; a document of another type serves it when a person ticks it. The observation of an issued revision carries its document type. A pack description (`pack.yaml`) and a pack file declare purposes the same way. A person editing a controlled document ticks the purposes that document serves, from the packs their organization has adopted (`GET /v1/organization/document-purposes`). The ticked ids are part of the document's revision body (`purposes` on `sms.document.2`), so they are reviewed, signed and issued like the rest; a revision refuses an id no adopted pack declares. A purpose ticked on a draft says nothing until that revision is issued and in force.

A rule asks for a purpose through `record.in-force`'s `serves` parameter, and its result says how each document serves it: by its type, or ticked as serving it. (A read condition `oneOf` on a field that holds a list also matches when the list holds one of the values.)

## 3. The check kind

`record.in-force@1` reads observations with intervals (input `records`) and, optionally, an operator record that may stand instead (input `record`):

- The records selected and in force at the evaluation instant support the rule. The result names each (title, revision, in force since) and returns the earliest end as its next boundary.
- With `counts`, the result also counts the records in force that meet each condition ("2 of them assessed on the risk matrix"). A count is on file or not; it is never a judgment.
- With none in force, the operator record, when the rule reads one, stands instead: complete, it supports the rule and the result says it read the operator record; incomplete, it needs attention as `record.complete` does.
- Otherwise the result is `record_not_on_file`: no record, or one that is no longer or not yet in force, named with its dates. A record taking effect later returns its start as the next boundary.

The read of these observations declares `plans: true`, so an issue scheduled for next week is read today and its start is the boundary at which the rule is evaluated again.

## 4. Locks

A decision that changes what is on file takes, before any row, the advisory key `records-on-file:<tenant>:<record or kind>` and the `observation-correction:` key of each current observation it may correct, in id order (group 2). The observations are recorded last, after the decision's own record and stream, through observation intake; that takes the organization's subject `FOR UPDATE` after the record. Nothing that holds the organization's subject waits for a safety record, its subject or its stream, so no cycle closes; the accepted-controls path ends the same way. Reads take no locks.

## 5. Where it applies

- The Part 108 NPRM pack (version 3, shadow only, proposed): one rule per item an applicant must submit under proposed § 108.505(b), each quoting its item and asking whether a document in force serves that purpose; the name of the operations supervisor reads the role assignment instead and says so; the item for additional information the Administrator requests stays a person's check. Proposed § 108.560 is read as: a safety policy in force, a risk matrix adopted, a procedure for receiving safety reports in force, the accountable executive designated (a role assignment, `accountable_executive`), and hazards recorded and assessed (counts on file). Paragraphs (b) and (c) stay a person's check.
- The waiver library's `procedure.on-file` accepts a controlled document in force serving the procedure's purpose, or the `organization.procedure` record it read before, and says which it read.
