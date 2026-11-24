# Safety assurance records

Design note. Builds on the safety record envelope (`sms-envelope.ts`, migrations 0040 to 0042), hazard origins (`one-hazard-model.md`, migration 0050), on-file checks (`on-file-checks.md`), the decision basis (`decision-basis.md`) and the lock order (`lock-order.md`). Migration 0085.

## The gap

Ledger keeps a safety program's policy, hazards, risk decisions, controls, documents and reports. It has no record of its own for what 14 CFR part 5 calls safety assurance: an audit, an evaluation of the safety program, an investigation, the accountable executive's review of safety performance, the analysis of a new or changed system, and a hazard notice sent to or received from another organization. Each could only be kept as a controlled document of type "other", with nothing a rule could count and no actions with owners.

Ledger is not a safety management system and nothing here says a program conforms to part 5. It keeps these records and says which are on file.

## 1. One record kind

A safety assurance record is an `sms_records` row of kind `assurance`, subject kind `sms`, with body schema `sms.assurance.1`. It is an ordinary (not restricted) record. Its type is chosen when it is opened and never changes.

| Type (`assuranceType`) | What a person calls it | Part 5 | § 5.97 class |
| --- | --- | --- | --- |
| `audit` | Audit of operational processes and systems | § 5.71(a)(3) | `safety_assurance_output` |
| `program_evaluation` | Evaluation of the safety program | § 5.71(a)(4) | `safety_assurance_output` |
| `occurrence_investigation` | Investigation of an incident or accident | § 5.71(a)(5) | `safety_assurance_output` |
| `noncompliance_investigation` | Investigation of a report of possible non-compliance | § 5.71(a)(6) | `safety_assurance_output` |
| `management_review` | Review of safety performance by the accountable executive | § 5.25, § 5.73 | `safety_assurance_output` |
| `change_assessment` | Description and analysis of a new or changed system | § 5.51, § 5.53 | `srm_output` |
| `hazard_notice_sent` | Hazard notice sent to another organization | § 5.57 | `safety_communication` |
| `hazard_notice_received` | Hazard notice received from another organization | § 5.71(a)(8) | `safety_communication` |

The class is set from the type when the record is opened, as every other kind's class is set from its kind. A change assessment is an output of safety risk management, not of assurance, so it carries that class. The paragraph references are the reading of this note; the records and the screens name only the type in plain words.

## 2. The body

Every type records:

- **performed**: the date the activity was done (`performedOn`), or the dates it ran (`performedOn` to `completedOn`). Neither may be in the future.
- **scope**: what it covered.
- **examined**: what it looked at: the processes, records, flights, places or people.
- **findings**: what it found, each with a short id (`F1`, `F2`) and its text. None is allowed: an audit can find nothing.
- **actions**: what it set, each with a short id (`A1`), what is to be done, an owner (an active person of the organization) and a due date. An action may name the finding it answers.

The type selects the fields the form asks for, beside those:

| Type | Also asks for |
| --- | --- |
| `occurrence_investigation` | when the occurrence happened (`occurredOn`, required) |
| `occurrence_investigation`, `noncompliance_investigation` | the safety report it started from, optional (`fromReport`) |
| `change_assessment` | the system or change described (`system`, required) |
| `hazard_notice_sent`, `hazard_notice_received` | the other organization (`counterpart`, required) |

One validation function (`assuranceBodyProblems` in the contracts) is used by the web form and by the domain, so a form never shows a record as ready that Ledger then refuses. It refuses a type-specific field on a type that does not ask for it, a missing required one, a duplicate finding or action id, an action naming a finding the record does not hold, dates in the future and a completion before the start.

**An investigation from a safety report** names the report in `fromReport`. Ledger checks that it is a report of the organization and writes a `derived_from` link to it. Nothing is copied from the report: the link shows the report's restricted title ("Safety report recorded 2026-03-04"), and the investigation stays an ordinary record that anyone who reads safety records can read. Opening one needs no permission to read reports; reading the report itself still does.

## 3. Drafted, signed, revised, never deleted

- **Opened** by a person who holds `sms:write`, as a draft (`draft`). It has an owner, as every safety record does.
- **Revised** as a new version by a person who holds `sms:write`. A revision of a signed record returns it to `draft` until it is signed again. The type cannot change. A closed action stays in every later version exactly as it was closed.
- **Signed** with decision `assurance.sign` and signature meaning `assurance.sign`, by a person who holds `sms:adopt`, the authority the organization grants to adopt its safety documentation, with re-authentication. The signature binds the version's body and every attached file, as an adoption does. Status `signed`. A separate capability was considered and not added: the person an organization trusts to adopt its safety documentation is the one it trusts to put its name to an audit or a review, and one more capability would be one more thing an operator must grant before the first record can be signed.
- **Never deleted**, and not closed: a record of what was done stays on file. Every version, signature and closed action stays on the record.

## 4. Actions

An action is **set** when a version listing it is signed. Actions on a draft that was never signed are proposed: they are shown on the record but not counted and not listed as due.

- **Open** from the signature of the first version that lists it until it is closed.
- **Owned** by the person it names. Changing the owner, the text or the due date of an open action is a revision, signed again. An open action that a later signed version no longer lists is no longer set; a closed one cannot be removed.
- **Closed** with decision `action.close`: the action's id and what was done (the decision's note). The action's owner or the record's owner closes it, holding `sms:write` and `decision:write`. The outcome keeps the action as it was set (text, owner, due date, the version that set it) beside who closed it. Closing changes no version, so the signature stays current.
- **Overdue** when it is open after its due date. Days are the organization's own: an action due on a day is overdue from the start of the next day in the organization's time zone, and a date in the future is one after today there.

The Safety home lists, for everyone who reads safety records, the open actions due in the next 30 days and the overdue ones, grouped by owner, overdue first.

## 5. A hazard from a finding or an action

A hazard can be opened from a finding or an action of an assurance record. Its origin is `assurance`: the record, the version (which must be the current one) and its body digest, the record's type, and the finding or action id. The hazard's `source.kind` is `assurance`, and a `derived_from` link to the assurance record is written, as for a hazard from a report. The origin is set once and never changes. The assurance record lists, per finding and action, the hazards opened from it.

## 6. What is on file

An assurance record is a new record kind of `organization.record-in-force@1` observations (`on-file-checks.md`), recorded when it is signed or an action is closed. Each observation says only which record it is, its type and class, and dates. Never its title, scope, findings, actions' text or anything from a report.

| Item (`values.item`) | One per | In force | Values |
| --- | --- | --- | --- |
| `record` | assurance record once a version is signed | from its first signature, with no end | `recordKind: assurance`, `recordId`, `assuranceType`, `recordClass` |
| `action` | action of the latest signed version, and each closed action | from the signature that set it until it is closed | the same, plus `actionId` and `dueAt`, the instant it becomes overdue |

A new check kind, `records.counted@1`, counts them for a rule. Version 1 of `record.in-force` asks what is in force at an instant; this asks how many records started within the dates of the adoption the rule runs under, and how many items are open now and past their due time:

- The records selected whose interval starts on or after the adoption's start and no later than the evaluation instant (and before the adoption's end) are counted, with a count for each condition the rule gives ("2 audits; 1 review of safety performance by the accountable executive").
- The open items selected (in force now) are counted, and those whose due field is past.
- With at least one record counted the result is supported and names the counts; with none it is `record_not_on_file`, says how many started before the adoption's start and when the latest did, and still gives the open and overdue counts. A count is on file or not; it is never a judgment.
- The next boundary is the earliest due time still ahead among the open items, so an action becoming overdue is evaluated again without new data, or the adoption's end.

A record is counted from the moment it went on file, its first signature, not the day the activity was performed. Two reasons. An adoption made on the Rules screen starts at the moment it is made, and the activity's date is a day: a record of an audit done that morning would start before the adoption and never count. And "on file in the adoption's dates" is what Ledger can say; whether the activity happened in a period is in the record's own dates, for a person. An audit from last year entered and signed after the adoption counts in its dates; the record's page shows when it was performed.

It names no record kind. The Part 108 pack's safety management rules read it: one rule on proposed § 108.560(a) counts the safety assurance records by type in the adoption's dates and the actions open and overdue. That rule, and the sentence of the remainder of § 108.560(a) that lists what the rules beside it read, are the only changes to the pack.

## 7. Safety training

The operator record type `person.training@1` gains one optional field, `safetyTraining` (boolean): "Safety training under the safety program". Nothing else about training changes. A rule may select on it.

## 8. Locks

Each command takes the locks of the envelope command it is (`lock-order.md`):

- **Open, revise**: as `sms.record.open` and `sms.record.revise`. Opening with `fromReport` reads the report record without a lock, as a hazard opened from a report does. The record's opening and revisions put nothing in or out of force, so they take no `records-on-file:` key.
- **`assurance.sign`, `action.close`**: as an SMS decision (`acceptSmsDecision`). Both change what is on file, so they first take `records-on-file:<tenant>:<record>` and the `observation-correction:` key of each current on-file observation of the record, in id order (group 2), and record the observations last (observation stream, then the organization's subject). They change no accepted control and take no organization row.
- **A hazard from an assurance record**: as `sms.record.open` for a hazard from a report: the assurance record is read without a lock, and its version is pinned by number and body digest. A revision of the assurance record committed between the read and the opening makes the pinned version not current; the hazard is refused (`stale_basis`) only when the read already saw it, otherwise the origin names the version the person saw, which stays on record.

No new lock is taken in a new place, so no new ordering test is needed.

## 9. Migration 0085

- `sms_records.kind` admits `assurance`. (The check already admitted unused kinds such as `audit` and `review`; they stay unused.)
- `decisions_target` admits `assurance.sign` and `action.close`.
- `sms_hazard_origins` admits kind `assurance` with `assurance_record_id`, `assurance_version_number` and a check that exactly one of the finding or action id is in the origin.

Nothing is rewritten and no old row needs changing.

## 10. Not done here

- A channel for anyone to submit a safety report, and the report's own procedure, are separate work.
- Nothing fictional is seeded: an organization made with `pnpm org:create` has no assurance record until a person records one.
