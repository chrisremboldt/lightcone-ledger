# Lock order

Status: written after the first two fixes. It records the one order in which transactions take locks, who takes what, and the rule a new projection, command, worker job or trigger follows. Paths are relative to `packages/` unless they start with `apps/`; line numbers drift, so the function names are the reference.

## The order

A transaction takes the locks it needs in this order, and never goes back to an earlier group once it holds a later one:

| # | Group | What | Taken by |
|---|-------|------|----------|
| 0 | Caller | the caller's `principals` row, `FOR SHARE` (`FOR UPDATE` for an `authority.update` of the caller's own row) | `withScope` (persistence/src/index.ts), always first |
| 1 | Tenant rules | advisory `adopted-rules:<tenant>`: exclusive where an adoption becomes visible, shared where adopted rules are read to queue evaluations | `lockAdoptedRules` (domain/src/rule-evaluations.ts) |
| 2 | Identity keys | per-key advisory locks: the idempotency key, `order:`, `origination:` (sorted), `telemetry-session:`, `mission:`, `monitoring-window:`, `observation-event:`, `observation-correction:`, `subject-alias:`, `sms-reference|`, `control-window-revision`, `rule-evaluation:` | `idempotent`, `lockOrderIdentity`, `lockOriginationKeys`, the intake functions |
| 3 | Flight view | `flight_views` rows, `FOR UPDATE`, sorted by id when more than one | `requireRow(…,'flight_views',…,true)` and the explicit selects |
| 4 | Organization | the tenant's `organizations` row (`FOR SHARE` to read a basis, `FOR UPDATE` to change it), then the tenant's `mission_avoidance_register` row | `organization()` (domain/src/adoptions.ts), `ledger_lock_mission_avoidance_register()` |
| 5 | Subject | `subjects` rows, sorted by id; `FOR SHARE` over a basis closure, `FOR UPDATE` to retain evidence; a projection takes all of its subjects in one statement | `lockSubjects`, `readSubjectEvidence({lock:true})`, `lockSubjectAndClosure`, `retainSubjectEvidence` (domain/src/cuts.ts) |
| 6 | Record | the record behind the subject: `sms_records`, `receipts`, `finding_views`, `operational_orders`; then the stream head appended to (`streams`, in `appendEvent`) | the record's own module |
| 7 | Live head | `flight_live_heads`, by `UPDATE`, sorted by flight | `appendLiveChange` (persistence/src/index.ts) |
| 8 | Queue rows | `work_items`, `selection_work`, `evaluation_deadlines`, `rule_evaluation_work`, and the outbox's `notices` and `notice_deliveries` (`notices.md`): inserted with `ON CONFLICT DO NOTHING` | everyone, last |

This is the order the person-facing commands already take (they are what people wait on), written down. The first sketch put the subject before the flight view; no command does that. Every flight command takes the view first, then the organization row, then the flight's subject: `acceptCommand` (domain/src/index.ts, `requireRow` on the view, then `organization(…,'SHARE')`, then `readSubjectEvidence({lock:true})`, then `retainSubjectEvidence`), `acceptMissionRelease`, `acceptMissionDeparture`, `acceptMissionBriefing` and the acknowledgement. A record command takes the record's subject, then the record (`lockSmsRecord`, domain/src/sms-envelope.ts).

Two kinds of lock sit outside the order because they cannot close a cycle with it:

- A queue worker locks its own leased row first (`work_items`, `selection_work`, `evaluation_deadlines`, `rule_evaluation_work`, `FOR UPDATE`) before anything else, and the flight-scoped workers lock the flight view before their row (`lockDeadline`, `lockWork`). Only the lease functions and the holder of the lease lock an existing queue row; commands and projections only insert with `DO NOTHING`.
- A projection locks its stream's `projection_offsets` row first. Only projections of that stream take it.

A foreign key counts as a lock. Inserting a row that references `flight_views` (`timeline_items`, `claims`, `flight_live_heads`, `flight_live_changes`) takes `FOR KEY SHARE` on the view, which waits for a command holding `FOR UPDATE`. That is how the observation deadlock below closed: the live head was updated (group 7) and the insert into `flight_live_changes` then needed the view (group 3).

A basis closure is locked in rounds (`lockClosure` in domain/src/cuts.ts, behind `readSubjectEvidence({lock:true})` and `lockSubjectAndClosure`). A round reads the closure and locks it in id order: one statement `FOR SHARE` for a read basis, or, for a command that changes the subject, one statement for the ids that sort before the subject, one `FOR UPDATE` for the subject and one for the ids after it (a statement takes one lock strength). The closure is then read again. An edge is written only by a transaction that holds its subject `FOR UPDATE`, so once every subject of the closure is held no edge can be added to it: if the second read matches, the closure is final. If it grew, the edge committed between the first read and the locks, and the new subjects can sort before ones already held; taking them now would break the id order. The round's locks are released instead, by rolling back to a savepoint taken before them, and the larger closure is locked again from the start. Edges are never removed, so the rounds end.

## Who takes what

Groups by number from the table above. "Then" is runtime order. Conditional steps are in brackets.

### Commands (domain, through the API)

| Path | Locks in order |
|------|----------------|
| Flight `decision.record`, `evidence.correct`, `flight.assign` (`acceptCommand`) | [2 `observation-correction:` of the corrected report, evidence.correct] → 3 view → 4 org SHARE → 5 closure SHARE [with an input cut] → 6 `finding_views` [finding treatment] → 6 stream → 5 flight UPDATE → [2 again (held) → 6 stream → 5, evidence.correct bridge] → 7 → trigger `ledger_guard_flight_rule_selection` at commit (3 view, 4 org SHARE) |
| `identity.link` | [2 `observation-correction:` of the linked report] → 3 {target, the receipt's current flight} views, sorted → 6 receipt → 5 {target, previous} → 6 stream → 5 → 2 bridge (held) → 7 |
| `acceptInput` (generic kinds) | 2 → 3 views UPDATE, sorted → 6 stream → 5 sorted → 7 sorted |
| Observation intake | 2 → 3 sorted → 6 stream → 5 → 7 sorted |
| Mission revision intake | 2 `mission:` → 3 → 6 stream → 5 sorted → 7 |
| Monitoring window intake | 2 → 3 sorted → 4 org SHARE → 6 stream → 5 → 7 |
| `mission.release` | 3 → 4 org SHARE → 5 flight UPDATE → 4 register SHARE → 6 stream → 7 → trigger at commit (3, 4 register) |
| `mission.departure-authorize`, `mission.brief`, `mission.briefing-acknowledge` | 3 → 4 org SHARE → 5 flight UPDATE → [4 register SHARE] → 6 stream → 5 → 7 → trigger at commit (3, 0 author/recipients SHARE, 4 org SHARE, 4 register SHARE) |
| `rule-pack.adopt`, organization decision | 4 org UPDATE → 5 org closure SHARE → 6 stream → 5 org UPDATE → 8 |
| `sms.record.revise`, `sms.record.links`, `sms.attachment.add` | [2 `records-on-file:` and `observation-correction:` of the hazard's current on-file observation, for a hazard's revision] → 5 record → 6 record → [6 hazard record SHARE, for a control record] → 6 stream → 5 → [on file: 6 stream → 5 org UPDATE, for a hazard's revision] |
| SMS decision (`acceptSmsDecision`) | [4 org UPDATE, when the record kind and decision kind can change accepted controls] → 5 record UPDATE and closure SHARE, together in id order (`lockSubjectAndClosure`) → 6 record → 5 closure SHARE (held) → 6 stream → 6 record UPDATE (trigger: 4 register UPDATE when the record has accepted controls) → [4 org UPDATE again → 5 org closure → 6 stream → 5 org → 8, when the decision changes accepted controls] → [on file: 6 observation stream → 5 org UPDATE, per observation replaced, withdrawn or accepted, when the decision changes what is on file; its keys, 2 `records-on-file:` and the `observation-correction:` of each current on-file observation of the record (or of every risk matrix) in id order, are taken first, before the organization row] |
| `sms.record.open` | [2 `sms-reference|<tenant>|<kind>|<reference>`, when it carries the organization's own id] → [6 hazard record SHARE] [3 the finding's flight view, through its subject kind's `lockSubject` → 5 finding closure SHARE → 6 `finding_views`] → 6 stream → 5 new record → [on file, for a hazard: 6 observation stream → 5 org UPDATE] |
| Observation corrections, `subject.alias` | 2 → 6 stream → 5 |
| `finding.treat` | [3 the finding's flight view, through its subject kind's `lockSubject`] → 6 `finding_views` → 6 stream `finding:<id>` → [7, a flight's hook] |
| `finding.treat-many` | [3 every flight view of the set, through its subject kind's `lockSubject`, kind by kind, id order within a kind] → 6 every `finding_views` row of the set, one statement in id order → 6 stream `findings:<pack>:<rule>` → [7 per flight, its hook] |
| `authority.update` | 0 target `principals` UPDATE (taken by `withScope` itself when the target is the caller) → 6 stream |
| `person.add` | 0 new `principals` row (no other transaction can see it) → 6 stream |
| `credential.issue` | 0 target `principals` SHARE → 6 stream → new `api_credentials` row (no other transaction can see it) |
| Development token for a person (`issueDevelopmentToken`) | 0 target `principals` UPDATE (taken by `withScope` itself when the target is the caller) → 6 the person's unrevoked `api_credentials` rows UPDATE, in id order → 6 stream → new `api_credentials` row (no other transaction can see it) |
| `credential.revoke` | 6 `api_credentials` row UPDATE → 6 stream |
| Safety report submission, signed in or through a link (`submitSafetyReport`), as the reporting channel | 0 the channel's `principals` row SHARE → [6 the link's `safety_report_links` row UPDATE, link path (`countLinkReport`)] → 6 stream → 5 new record (no other transaction can see it) |
| Issue a reporting link | 6 stream → new `safety_report_links` row (no other transaction can see it) |
| Revoke a reporting link | 6 `safety_report_links` row UPDATE → 6 stream |
| Notice settings (`updateNoticeSettings`), a person's own or their address set by an administrator | 6 the person's `notice_settings` row (upsert) → 6 stream `notices:<person>` |
| Set or remove the organization's webhook (`setNoticeWebhook`) | 2 `notice-webhook|<tenant>` → 6 stream `notices:webhook` → the `notice_webhooks` row |
| Create flight (`createFlight`) | 2 `origination:` → 5 new → 6 stream → 4 org SHARE → 5 new → 8 |

### Projections (`projectEvent`, packages/projections/src/index.ts)

Every branch starts with its stream's `projection_offsets` row. Events whose projection queues flight-state evaluations (`flight.created`, `order.revision`, `intent.revision`, `flight.observation`, `evidence.correct`, `identity.link`) then take 1 shared.

A projection takes subjects once. Its first subject lock, wherever in the branch that is, takes in one statement in id order (`lockSubjects` while `projectEvent` has marked the connection with `beginProjectionSubjects`) the subjects that step asked for and every subject that retained the event's stream at or after the event, `FOR UPDATE`. Those are all the subjects a projection locks: a later step that retains evidence finds its subjects already held, or locks a subject the projection itself created, which no other transaction can see. A branch whose steps lock no subject takes them at the end, before its live heads (`lockProjectionSubjects`). Every branch ends with: [1 shared, for a bridged observation] → 8 inserts → 7 for each affected flight, sorted.

Before, the projection of a safety record locked the record's subject and then, at the very end, every subject that retained the stream, in id order: the second statement could include subjects that sort before the first, and a command locking its basis closure in id order (`lockSubjectAndClosure`) could hold one of them and wait for the record's subject. Test: `controls-as-rules.integration.test.ts`, "projects a control's opening while a decision on its hazard holds the hazard, in one lock order". It failed (a detected deadlock, 409) before the change.

| Branch | Locks in order |
|--------|----------------|
| SMS events (`projectSmsEvent`) | 5 record and the stream's subjects → 6 record → 8 |
| `observation` | 1 shared → 3 the receipt's flight → [3 again, by a projector such as the command-link one] → 5 (the projector's first subject lock, or at the end) |
| observation corrections, `subject.alias` | 1 shared → 5 |
| predeparture progress | 3 → 5 → 7 |
| `rule-pack.adopt` | 1 exclusive → 4 org UPDATE → 5 → 8 |
| organization decision | 4 org UPDATE → 5 |
| `monitoring.window` | 5 → 6 receipt SHARE |
| `mission.release`, `mission.departure-authorize`, `mission.brief`, `mission.briefing-acknowledge`, `mission.revision`, `command-link.baseline`, `command-link.status` | 3 → [6 receipt SHARE] → 5 (timeline) |
| `telemetry.segment` | 3 → 6 receipt → 5 |
| `order.revision`, `intent.revision` | 1 shared → 2 → 3 sorted → 6 order → per new flight: 2, 6 stream, 5 (the first: with the stream's subjects), 4 org SHARE, 5 new, 8 → per flight: 5 held |
| Generic receipt branch (`flight.observation`, `airspace.status`, other source kinds) | 1 shared → 3 → 6 receipt → 3 again → 5 → [2 bridge → 6 stream → 5 held] |
| `identity.link`, `evidence.correct`, flight `decision.record`, `flight.assign`, `flight.created` | [1 shared] → 3 sorted (identity.link only) or `FOR KEY SHARE` on 3 by the timeline insert → 5 |

Some branches still read or update a record (group 6: a receipt, an order) before their subjects, as they did before; none of them comes back to an earlier group after its subjects. Moving their subjects before the record means taking them right after the view in each branch's own projection function.

### Worker jobs (apps/workers/src)

| Job | Locks in order |
|-----|----------------|
| Projection (`processLease`) | 8 own `work_items` row → `projectEvent`; on failure: 8 → 7 [→ offsets] |
| Rule selection (`processRuleSelectionLease`) | 3 [flight lease] → 8 own row → `refreshFlightRuleSelection` (3, 4 org SHARE, 5 closure SHARE) or fan-out (inserts only) |
| Flight deadlines (`processEvaluationLease`) | 3 → 8 own row → 1 shared → 8 inserts |
| Notice sending (`sendLeasedNotice`) | reads under the lease, sends outside any transaction, then 8 own `notice_deliveries` row → insert into `notice_attempts` |
| Dated notices and digests (`processNoticeSchedule`) | 8 own `notice_schedules` row → reads without locks → 8 inserts into `notices` and `notice_deliveries` |
| Rule evaluation (`processRuleEvaluationLease`) | 8 own row → 2 `rule-evaluation:` → 3 [flight subject, through the subject kind's `lockSubject`] → 5 org and subject closures SHARE → 6 stream → 5 UPDATE → 6 `finding_views` → [3, 7 for a flight] → 8; a control-boundary row runs `refreshAcceptedControlRules` (4 org UPDATE → 5 → 6 stream → 5 → 8) |

### Triggers in the current schema

Each function at its latest definition; migration 0071 dropped the flight hazard tables and their functions.

| Function (table) | Locks in order |
|------------------|----------------|
| `ledger_guard_flight_rule_selection` (`command_records`, deferred) | 3 → 4 org SHARE |
| `ledger_check_mission_release_commit` (`mission_releases`, deferred) | 3 → 0 author SHARE → 4 register SHARE |
| `ledger_check_mission_departure_commit` (`mission_departure_authorizations`, deferred) | 3 → 0 author SHARE → 4 register SHARE |
| `ledger_check_mission_briefing_commit` (`mission_briefings`, deferred) | 3 → 0 author and recipients SHARE, sorted → 4 org SHARE → 4 register SHARE |
| `ledger_check_mission_briefing_acknowledgement_commit` (deferred) | 3 → 0 author SHARE |
| `ledger_publish_accepted_control_change` (`sms_records`, `accepted_hazard_controls`) | 4 register UPDATE |
| `ledger_check_monitoring_window` | 2 `monitoring-window-revision` → 0 source principal SHARE |
| `ledger_check_control_window_revision` | 2 `control-window-revision` |
| `ledger_check_command_link_baseline`, `ledger_check_control_effectiveness_calculation` | 0 source principal SHARE |
| `ledger_lease_*` | own queue rows, `FOR UPDATE SKIP LOCKED` |

All of them follow the order. A principals row taken `FOR SHARE` after the view (group 0 late) cannot close a cycle: the only writer of a principals row, `authority.update`, takes no later group.

## What changed

Each change has an integration test of the shape the first two fixes introduced: one transaction takes the first lock its command takes, the projection starts and is seen waiting (`lockWaitStarted`), then the command runs. Each test failed (409 `concurrent_change`, a detected deadlock) before its change and passes with it.

1. **Observation projection against a flight command.** The projection locked the flight's subject, updated its live head and then needed the view for the `flight_live_changes` foreign key; a flight command holds the view and waits for the subject. The `observation` branch now locks the receipt's flight view first. Test: `observations.integration.test.ts`, "projects an observation while a decision on its flight holds the flight, in one lock order".
2. **Report projection against an identity link.** The generic receipt branch updated the receipt and then locked the view; `identity.link` locks the view and then the receipt. The branch now locks the view first, as the telemetry branch already did. Test: `legacy-flight-report-bridge.integration.test.ts`, "projects a report while a link of the same report holds its flight, in one lock order".
3. **New flight against an adoption, both projections.** Projecting an intent or order that creates a flight took the organization row `FOR SHARE` (`registerFlightOrganization`) and then, at the end, the shared `adopted-rules:` lock; an adoption's projection takes that lock exclusively and then the organization row `FOR UPDATE`. Projections of the flight-state events now take the shared lock before any row lock. Test: `source-revisions.integration.test.ts`, "projects a new flight while an adoption is projected for its organization, in one lock order".

## Conflicts between commands

The audit found six places where two commands take two groups in opposite orders against each other. None involves a projection. They were fixed in this order; each fix has an integration test of the same shape as above, which failed (a detected deadlock, 409 `concurrent_change`) before it.


1. **Organization against avoidance register (SMS decision against mission commands). Fixed.** A decision on a hazard or control record with accepted controls updated the record, whose trigger updates the register (group 4, second row), and then `refreshAcceptedControlRules` took the organization row `FOR UPDATE`. `mission.release`, `mission.departure-authorize` and `mission.brief` take the organization row `FOR SHARE`, then the register `FOR SHARE`. Now a decision whose record kind and decision kind can change accepted controls (`changesAcceptedControls`: a hazard or control, `risk.accept`, `record.close` or `record.reopen`) takes the organization row `FOR UPDATE` before its record; the kind comes from an unlocked read, since a record's kind never changes. The commit triggers are unchanged. Test: `mission-briefings.integration.test.ts`, "withdraws an accepted control while a release holds the organization row and wants the register, in one lock order".
2. **Organization against subject (SMS decision against flight commands and adoptions). Fixed by the change for 1.** The SMS decision held its record's basis closure `FOR SHARE`, which can include a linked flight's subject and the organization's subject, and then wanted the organization row `FOR UPDATE`. A flight command holds the organization row `FOR SHARE` and then wants the flight's subject `FOR UPDATE`; an adoption holds the organization row and wants the organization's subject `FOR UPDATE`. The decision now holds the organization row before any subject. Test: `mission-briefings.integration.test.ts`, "closes a hazard with an accepted control while a flight command holds the organization row and wants a subject, in one lock order".
3. **`observation-correction:` advisory lock after the view and subject. Fixed.** `evidence.correct` and `identity.link` took it in the legacy report bridge after locking the flight and its subject; observation corrections and an observation that replaces another take it first, then the subject. Now both commands find the report the bridge will correct (fixed by the command's `correctionOf` or `receiptId`, followed to its current record) and take its lock before the flight view (`lockLegacyFlightReportCorrection`, `lockLegacyFlightReportLink`), following the record again until the one locked is current. The bridge takes the same lock again later, already held. Tests: `legacy-flight-report-bridge.integration.test.ts`, "corrects a report while a correction of its observation is held, in one lock order" and "links a report while a correction of its observation is held, in one lock order".
4. **`finding_views` against subject. Fixed.** `sms.record.open` from a finding took the flight's closure `FOR SHARE` and then the finding; a flight decision with a finding treatment takes the view, the closure `FOR SHARE`, the finding, then the flight's subject `FOR UPDATE`. Now the record open first has the module that owns the finding's subject kind lock its record (`subjectFindingView(kind).lockSubject`, the hook the evaluator already calls; for a flight, its view `FOR UPDATE`), so core code still names no subject kind. Test: `mission-briefings.integration.test.ts`, "opens a hazard from a finding while a decision treating the finding holds it, in one lock order".
5. **Two SMS records. Fixed.** Revising a control takes its own subject and record, then its hazard's record `FOR SHARE`; a decision on the hazard took the hazard's subject and record, then the control's subject through its closure, a subject after a record. Now the decision locks its record's subject `FOR UPDATE` and the rest of its basis closure `FOR SHARE` together in id order before its record (`lockSubjectAndClosure`), which also orders two decisions on records whose closures include each other. The revision is unchanged: it takes the hazard's record, never its subject, and the decision takes that record only once it holds every subject, so neither can hold what the other waits for. Test: `mission-briefings.integration.test.ts`, "closes a hazard while a revision of its control holds the control, in one lock order".
6. **Unsorted rows of one table.**
   - **`identity.link`. Fixed.** It locked the target view and later the previous one by `UPDATE`; two links in opposite directions, or a link and an intake that updates both views sorted, could deadlock. Now it reads the receipt's current flight first and locks the target and that view in one statement in id order. Test: `legacy-flight-report-bridge.integration.test.ts`, "links reports between two flights in opposite directions, in one lock order" (the second link now waits and is refused with `stale_revision`, as if sent after the first).
   - **Operator-record import. Fixed.** It took views, subjects and live heads row by row in file order. Now, before recording any row, it locks the flight views and the subjects every acceptable row's intake will lock, each table in one id-ordered pass (`lockObservationTargets`); the rows are then recorded in file order as before, finding those rows held, and the result lists them in file order. Live heads are covered by the views: every writer of a flight's live head holds its view first. The per-row identity keys (`operator-record-replacement:`, `observation-event:`, `observation-correction:`) are still taken row by row, after the views. Test: `operator-records.integration.test.ts`, "commits rows about two flights in file order while an intake holds the lower flight, in one lock order".
   - **`authority.update` on oneself. Fixed.** It upgraded the `FOR SHARE` that `withScope` holds, so two concurrent self-updates deadlocked. `withScope` takes an optional principal lock mode; the command route passes `UPDATE` when the command updates the caller's own authority, so the row is taken `FOR UPDATE` first and a second self-update waits. Test: `adoptions.integration.test.ts`, "updates a person's own authority twice at once, in one lock order" (the second is refused with `stale_authority`, as if sent after the first).

### What is on file, after the record

A safety-record command that changes what is on file (`on-file-checks.md`) records its observations about the organization last, through observation intake: the observation's stream, then the organization's subject `FOR UPDATE`, after the record's own subject, record and stream. That returns from group 6 to group 5, as the accepted-controls path already does. No cycle closes: what holds the organization's subject (an adoption, an evaluation of an organization rule, another such command) never then waits for a safety record, its subject or its stream; and a correction of one of these observations (group 2 then the organization's subject) cannot be waiting on the command, because the command took that correction key first. Two commands on one record, or two risk matrix adoptions, are ordered by the `records-on-file:` key.

## Reads at REPEATABLE READ take no row locks

The API runs reads in `withScope(…, consistentRead=true)`, at REPEATABLE READ. A `FOR SHARE` there on a row that another transaction changed after the read's snapshot raises a serialization failure, which `withScope` turns into 409 `concurrent_change`. Every projection of a flight updates its view's revision, every accepted-control change updates the register, and every adoption or organization decision updates the organization row, so a read that locked one of them failed whenever it changed while the read ran. In a read the snapshot already gives every statement one consistent view; the lock added nothing the response depends on.

Those locks were removed from reads. The functions shared with commands take a flag (`reading`, or a `NONE` lock mode), and only the read routes pass it; commands keep every lock they took:

| Read | Lock it took | Now |
|------|--------------|-----|
| `getOrganizationCoverage` (GET `/v1/organization/coverage`) | organization `FOR SHARE` | `organization(…,'NONE')` |
| `getOrganizationDecisions` (GET `/v1/organization/decisions`, GET `/v1/subject-exports`, GET `/v1/subject-exports/:id`) | organization `FOR SHARE` | `reading`; the two commands that call it for their response meta keep the lock |
| `getMissionAvoidanceSnapshot` (GET `mission-avoidance`, POST `mission/route-suggestion`, GET `controls` when a route review is in force, release validity) | view `FOR SHARE`, then register `FOR SHARE` (`ledger_lock_mission_avoidance_register`) | `reading`; `acceptMissionRelease` and `getMissionReleaseState` in commands keep both, where the register lock pins the register revision the release records until commit |
| `retainedRelease` (GET `mission-releases/:id`, its validity, GET `predeparture`, briefing acknowledgements) | view `FOR SHARE` (`flightForRelease`) | `flightForRelease(…,'NONE')` through `getMissionReleaseState(…, reading)`; departure and briefing commands keep it |
| `getMissionBriefing` (GET `briefings/:id` and its acknowledgements) | view `FOR SHARE` (`flightForBriefing`) | `flightForBriefing(…,'NONE')`; the commands pass `UPDATE`, and the acknowledgement's own call keeps `SHARE` |
| `readMissionAvoidanceControlContext` (POST simulation preparation context, a read) | register `FOR SHARE` | `reading` |

Tests: `adoptions.integration.test.ts` ("reads coverage while another transaction holds or has just changed the organization row", "reads organization decisions from the read's snapshot …") and `mission-briefings.integration.test.ts` (the three "… from the read's snapshot while the flight is projected"). Each failed with 409 before its change.

One read lock is left: `coordinator` in the simulation avoidance demo (GET `/v1/simulation/avoidance-demos/requests` and the preparation context) takes `principals … FOR SHARE OF p`, but only on the caller's own row, which `withScope` already holds, so it adds no lock. No other function reached from a read route takes a row or advisory lock.

## The rule

A new projection, command, worker job or trigger:

1. Takes its locks in the order of the table above, and takes every lock of a group before any lock of a later group. If it needs the flight's subject, live head, receipt or any record of a flight, it locks the flight view first, even when it only writes a row that references the view: the foreign key will need the view later anyway.
2. Takes the shared `adopted-rules:` lock before any row lock if it will queue evaluations of adopted rules (`lockAdoptedRules`).
3. Locks several rows of one table in id order, in one statement where it can (`ORDER BY id COLLATE "C" … FOR UPDATE`). The order is byte order, never the database's locale; code that sorts ids for a lock loop compares them by code unit, never with `localeCompare`.
4. Does not upgrade a lock it holds `FOR SHARE` to `FOR UPDATE` on a row others also hold `FOR SHARE`, unless every such holder takes the same earlier lock first.
5. Inserts queue rows with `ON CONFLICT DO NOTHING` and locks no existing queue row but its own lease.
6. Comes with a test of that shape when it takes a lock a command also takes in a new place.
