# Fan-out and reads about a related subject

Status: built; see "As built" at the end for where the implementation differs from this note. The schemas are in `packages/contracts/src/checked-rules.ts` and `rule-evaluations.ts`. Builds on the generic evaluator (`packages/domain/src/rule-evaluations.ts`), the read features (`record-check-kinds.md`) and the correction records (`observation-corrections.md`). Line references are to `main`.

## Today

- A leaf names one `target.subjectKind` and reads `about: 'target' | 'organization'` (`packages/contracts/src/checked-rules.ts:46-49`). `gatherInputs` reads every read about the target or the organization (`rule-evaluations.ts:420-454`). One task is one target, pack and leaf (`rule-evaluations.ts:34-39`), and gives one record and at most one finding (`rule-evaluations.ts:499-543`).
- Reference fields in operator records are `{ id, scope }` objects stored as written; `source` ids are "resolved later through aliases" (`operator-records.md`, decision 6; `operator-record-import.md`, Limits). Nothing resolves them today, and nothing can find the records whose reference names a given subject: `listObservations` matches only the envelope subject roles (`observations.ts:519-524`).

## 1. Declaring it on the leaf

A leaf gains an optional `related` list (at most two entries, at most one with `fanOut`), and a read's `about` gains two forms: `{ "related": "<name>" }` (observations about that related subject, matched as `about: 'target'` matches the target today) and `{ "referencing": "<field path>" }` (observations whose reference at that path names the target). A relation takes the related subject from `from.field` of each observation of `from.read`, an earlier read or the subject-state read: a reference field, or `subject` / `secondarySubject` for the envelope roles. Validation in `checkedRuleProblem` (`checked-rules.ts:94-123`) is extended like `readAnchorProblem` (`:129-135`): `from.read` precedes every read about the relation, a read about a relation is not itself a relation's `from` (no chains in this pass), and `subjectKind` equals the reference field's `referenceKind` where the type declares one. A leaf without `related` keeps its digest (optional parts are left out, `checked-rules.ts:83-85`).

**Forward fan-out: every assigned person's training, per flight.** The assignments name the people; each person gets a result.

```json
{ "target": { "subjectKind": "flight" },
  "related": [{ "name": "person", "subjectKind": "person", "fanOut": true, "whenNone": "insufficient",
                "from": { "read": "assignments", "field": "values.record.personId" } }],
  "reads": [
    { "name": "assignments", "type": "operator.record", "versions": [1], "about": "target", "required": true, "select": "all",
      "where": [{ "field": "values.recordType", "oneOf": ["operation.role-assignment"] }] },
    { "name": "subject", "type": "operator.record", "versions": [1], "about": { "related": "person" }, "required": false, "select": "all",
      "where": [{ "field": "values.recordType", "oneOf": ["person.training"] },
                { "field": "values.record.trainingKind", "oneOf": ["recurrent"] }] } ],
  "check": { "kind": "date.within-months", "version": 2,
             "params": { "select": { "recordType": "person.training", "recordVersion": 1 }, "field": "values.record.completedOn" } },
  "adoptionParameters": [{ "name": "months", "title": "Months since recurrent training", "valueType": "integer", "minimum": 1 }] }
```

For each result the from-read is narrowed to the observations that named that subject, so the check sees only that person's assignments (a rule can add `where` on `values.record.role`).

**Related read without fan-out: a life-limited part reads its aircraft's time in service.**

```json
{ "target": { "subjectKind": "component" },
  "related": [{ "name": "aircraft", "subjectKind": "aircraft", "fanOut": false, "whenNone": "insufficient",
                "from": { "read": "limit", "field": "values.record.aircraftId" } }],
  "reads": [
    { "name": "limit", "type": "operator.record", "versions": [1], "about": "target", "required": true, "select": "latest",
      "where": [{ "field": "values.recordType", "oneOf": ["component.life-limit"] }] },
    { "name": "quantity", "type": "operator.record", "versions": [1], "about": { "related": "aircraft" }, "required": true, "select": "all",
      "where": [{ "field": "values.recordType", "oneOf": ["aircraft.time-in-service"] }] } ],
  "check": { "kind": "value.within-limit", "version": 2,
             "params": { "field": "values.record.totalTimeHours", "comparison": "at_most", "limitField": "values.record.lifeLimitHours",
                         "offsetField": "values.record.partTimeAtInstallHours", "measureFrom": "limit_start" } } }
```

**Reverse fan-out: the same rule per aircraft, one result per installed part.** The aircraft is the target; the life-limit records name it.

```json
{ "target": { "subjectKind": "aircraft" },
  "related": [{ "name": "part", "subjectKind": "component", "fanOut": true, "whenNone": "not_applicable",
                "from": { "read": "limit", "field": "subject" } }],
  "reads": [
    { "name": "limit", "type": "operator.record", "versions": [1], "about": { "referencing": "values.record.aircraftId" },
      "required": false, "select": "all", "where": [{ "field": "values.recordType", "oneOf": ["component.life-limit"] }] },
    { "name": "quantity", "type": "operator.record", "versions": [1], "about": "target", "required": true, "select": "all",
      "where": [{ "field": "values.recordType", "oneOf": ["aircraft.time-in-service"] }] } ] }
```

**Non-regulatory: battery reserve per flight, at the landing.** A new leaf in a version 2 of `packages/pack-example-operations` (version 1 is digest-pinned, `example-operations-v1.ts:8,52`). The aircraft is the flight report's secondary subject (`flight.report` allows aircraft there, `types-v1.ts:331`); the battery read uses the anchored selection across the relation.

```json
{ "target": { "subjectKind": "flight" },
  "related": [{ "name": "aircraft", "subjectKind": "aircraft", "fanOut": false, "whenNone": "insufficient",
                "from": { "read": "report", "field": "secondarySubject" } }],
  "reads": [
    { "name": "report", "type": "flight.report", "versions": [1], "about": "target", "required": true, "select": "latest",
      "where": [{ "field": "values.landingAt", "filled": true }] },
    { "name": "subject", "type": "battery.state", "versions": [1], "about": { "related": "aircraft" }, "required": true,
      "select": { "latestAtOrBefore": { "read": "report", "field": "values.landingAt" } } } ],
  "applicability": [{ "input": "report", "field": "values.activity", "oneOf": ["landed"], "whenAbsent": "not_applicable" }],
  "check": { "kind": "value.within-limit", "version": 1, "params": { "field": "values.totalRemainingPercent", "comparison": "at_least" } } }
```

## 2. Resolving a reference

Resolution happens in the engine while gathering, at the evaluation's evidence cut; no check kind sees it.

- **Envelope roles** (`subject`, `secondarySubject`): the observation's current subject as `listObservations` returns it (`observations.ts:377-388`): the latest subject resolution, else the alias resolution, else intake's. `ledgerId` gives a Ledger reference; otherwise the source identity `{ scope: 'source', sourceId: <observation's source>, kind, id }`, as `namedSubjects` builds it (`rule-evaluations.ts:111-127`).
- **Body references** `{ id, scope: 'ledger' }`: the Ledger subject, which must exist with `subjectKind` (the test intake uses, `observations.ts:50-63`).
- **Body references** `{ id, scope: 'source' }`: the id is the referencing observation's source's own id. Resolved by the latest alias resolution record (`observation_subject_resolutions` with `observation_id IS NULL`, written by `aliasSubjectIdentity`, `observation-corrections.ts:344-362`) for that source, kind and id, valid at the referencing observation's `occurredAt`, whose event lies in the cut: the same rule `resolutionJoin` applies to envelope roles (`observations.ts:343-354`). Not the `aliases` table, which has no journal position, so a replay at the recorded cut resolves the same way. Without such a record the related subject is the source identity, which is readable (source-scope reads exist, `observations.ts:523-524`).
- **Does not resolve**: the field is absent or blank, is not a `{ id, scope }` object, names a Ledger id that is not a subject of the kind, or an envelope role is `ambiguous`. The result is `insufficient`, `pending`, reason `related_reference_unresolved`, and its summary and `details` name the observation id, the field path and the value as written. It is never a pass and never skipped. A reference that resolves to a source identity with no records is not unresolved: the related read is empty and the check reports the missing record as it does today, with the summary naming the related subject.
- **No related subject, without fan-out, `whenNone: empty`**: the reads about the relation are empty and the check runs on the rest, for reads that only add to what the target's own records show (the flown positions of a planned aircraft, [observed-values.md](observed-values.md)). A fan-out cannot declare it.
- **Fan-out with no related subject**: one target-level result, per `whenNone`. **Without fan-out, two or more distinct related subjects**: `conflicting`, reason `related_subject_conflicting`, listing them.

## 3. Results, finding key and scope

- **Unit of work stays one target, pack and leaf** (`rule_evaluation_work`, `0049:42-60`; no change). One task, under the existing advisory lock (`rule-evaluations.ts:558-560`), evaluates every related subject and writes one record per result.
- **Records**: a per-related record carries `related: { name, subject, subjectKey, namedBy }` (`RelatedSubjectResultSchema`); `subject` stays the target. The target-level record (no `related`) is written for problems of the fan-out itself (no related subject, a reference that does not resolve where no key is possible because the value is blank, limit exceeded) and, once those clear, one `not_applicable` record, reason `evaluated_per_related_subject`, so the latest target-level record never shows a cleared problem.
- **Dropped related subjects**: a related key whose latest record is not already `related_subject_not_named` and which is no longer named gets a `not_applicable` record, reason `related_subject_not_named` (an unassigned person). Its finding keeps its status, as findings do today (`rule-evaluations.ts:538-542`).
- **Related key**: `subjectReferenceKey` of the resolved subject; for a reference that does not resolve but has a value, the key of the reference as written, so a corrected record moves the result to the right key and the old key is dropped as above.
- **Finding id**: `findingIdFor` (`rule-evaluations.ts:499-501`) is unchanged when there is no related subject, so every existing finding id stays exactly as it is. With one: `finding:` + digest of `{ tenant, subjectKey, packId, leafId, relatedKey, scope: 'related' }`. The finding belongs to the target and names the related subject; it is listed under either.
- **Dedupe**: the "same inputs" lookup (`rule-evaluations.ts:587-596`) adds `related_key`, so each result has its own boundary and epoch.

## 4. Queueing, cuts and digests

**Reference index.** A new table `observation_references` (section 7) holds one row per reference field of each accepted observation, written at intake in the same transaction. Which fields are references comes from the observation registry: a type may register a `referencesOf(observation)` function, and `operator.record` registers one that reads the record type's `reference` fields from its definition (`operator-records/define.ts:65`). Core code names no type. Envelope roles need no rows: `observations_by_subject` and `observations_by_secondary_subject` already index them (`0048:67-70`).

**Who is queued** (extending `readsObservation`, `rule-evaluations.ts:101-109`, and the two queue functions, `:163-209`), for a new observation O, or a correction's affected subject S:

1. Reads about the target: unchanged.
2. A read `about: { related: r }` of O's type, for each subject S that O names: the targets that name S, found by `targetsNaming(S, r)`: current observations of `r.from.read`'s type with a reference row at `r.from.field` equal to S (directly, or through an alias resolution in which S is the Ledger subject), or with S in the envelope role; their current subjects of the target kind. For the reverse form, the targets are the references at `referencing` in the current from-read observations about S.
3. A read `about: { referencing: f }` of O's type: the subjects O's reference rows at `f` resolve to.
4. A `subject.alias` event: `targetsNaming` for the aliased source identity, for every relation, since body references are not in the event's `affected` list (`observation-corrections.ts:308-315`).

So a new training record for person P queues exactly the flights whose current assignments name P (acceptance item 2), each once per event (`rule_evaluation_work_observation`, `0049:56-57`).

**Cost.** Intake: one insert per filled reference field (at most three for today's record types: `aircraft.system-availability`, `person.rest-assessment`). References to a `crew.duty-period` observation (`referenceKind: 'duty_period'`) are indexed too but name no subject, so no relation matches them. Queueing: one indexed lookup per relation that reads O's type, plus one work row per target found. A person named on many flights queues all of them; see open question 3.

**Cut.** `subjectCut` (`rule-evaluations.ts:266-304`) covers the organization and the target. Related subjects are only known after reading at a cut, and observations share session streams (`source:<principal>:<source>:<session>`, `observations.ts:171`), so widening the cut can change the target's own reads. The engine therefore: takes the target cut; reads; resolves the related set; merges each related subject's cut (`readSubjectEvidence` for Ledger subjects, the source-stream query of `:281-293` for source identities), taking locks in subject-key order; reads everything again at the merged cut and resolves again. It repeats while the set changes, at most three times, then records `pending`, reason `related_set_unstable`. Every read, including the target's, is taken at the one merged cut, which is recorded as `inputCut`; `dependencyBasis` adds each related subject's basis. A replay at the recorded cut therefore reads, resolves and fans out the same way.

**Digests.** `ruleEvaluationObservationDigest` (`rule-evaluations.ts:460-477`) gains an optional `related: { name, subjectKey, namedBy }` part, left out when absent like `subjectState`, so existing digests do not change. Each per-related result digests the shared reads, its own related reads and the observations that named it. `retainSubjectEvidence` (`:717`) also retains the evaluation event for each Ledger related subject.

## 5. Hazard origins and indicators

- **Hazard origin** (`sms-origins.ts:109-121`; `HazardFindingOriginSchema`, `contracts/src/sms.ts:246-259`): gains optional `related: { name, subject, subjectKey }`, copied from the finding. Existing origins keep their content. `findingBasis` (`sms-origins.ts:210-229`) combines the target's basis with the related subject's, so a new training record for the person after the reviewer looked makes promotion conflict, as a change to the flight does.
- **Indicators** (`indicators.ts:36-43,176-178`; `indicator-gathering.ts:113-157`): `IndicatorFinding` gains optional `related`; `eventSubjects` returns the target and the related subject, and `readFindings` lists findings by target or related key. A flight population counts each per-person finding (three people needing attention are three findings); a person population counts that person's findings across flights. Definitions and their digests do not change.

## 6. Limits

- At most `RELATED_SUBJECT_LIMIT` = 50 distinct related subjects per evaluation. More: one target-level `pending` / `insufficient` record, reason `related_limit_exceeded`, summary "N related subjects are named; one evaluation reads at most 50", and no per-related records (a partial set would read as complete). Earlier per-related records are left as they are.
- Each read keeps today's 500-observation page limit (`readMatching`, `rule-evaluations.ts:334-381`); a truncated read anywhere makes the affected result `input_limit_exceeded` as today (`:601-611`). Worst case per evaluation: 50 × 20 reads × 500 observations; this is the bound to load-test.

## 7. Migration (one file, `0054_rule_evaluation_related_subjects.sql`)

1. **`observation_references`**: `tenant_id`, `observation_id`, `field` (dot path, ≤400), `reference_kind`, `reference_scope` (`ledger`|`source`), `reference_id`, `reference_source_id` (the observation's source when scope is `source`, else null), `reference_key` (the `subjectReferenceKey` of the reference as written). Primary key `(tenant_id, observation_id, field)`; foreign key `(tenant_id, observation_id)` to `observations(tenant_id, id)`; `CHECK((reference_scope='source')=(reference_source_id IS NOT NULL))`; index `(tenant_id, reference_key, field)`. Row-level security as in `0049:98-103`; immutable-history trigger; `INSERT, SELECT` to `ledger_app`, `SELECT` to `ledger_worker`. Backfill of existing observations by a one-off command using the registry, not SQL (SQL would have to know which fields are references).
2. **`rule_evaluations`**: add `related_key text NOT NULL DEFAULT ''` (≤1000), `related_name`, `related_scope`, `related_kind`, `related_id`, `related_source_id`; `CHECK((related_key='')=(related_scope IS NULL))` and that `record->'related'->>'subjectKey'` matches. Replace `UNIQUE(tenant_id,subject_key,pack_id,leaf_id,leaf_version,input_digest)` (`0049:30`) with the same plus `related_key`; add `related_key` to `rule_evaluations_by_inputs` (`0049:37-38`); add index `(tenant_id, related_key, recorded_at DESC, id DESC) WHERE related_key<>''`. A constant default adds no row writes, so the immutable-history trigger is not fired.
3. **`findings`**: the same six columns, with a check that they are empty for flight findings; replace `findings_by_subject_rule` (`0049:78`) with `(tenant_id, subject_key, pack_id, leaf_id, related_key) WHERE subject_key IS NOT NULL`. **`finding_views`**: add `related_key` and index `(tenant_id, related_key) WHERE related_key<>''`.
4. No change to `rule_evaluation_work`, its lease function, or `hazards` (origins are JSON).

## 8. Implementation order

1. Migration and the reference index written at intake, with the `operator.record` `referencesOf`; integration test that references are indexed and that the backfill command fills earlier observations.
2. Contracts: move the proposed schemas in as optional parts of the leaf, read, evaluation record, finding and origin; `pnpm generate:client`. Unit tests that existing leaf, pack and origin digests are unchanged.
3. Leaf validation (`checkedRuleProblem`) for relations; unit tests.
4. Resolution and the related set (pure function over gathered observations plus a resolution lookup); unit tests for each "does not resolve" case and the conflicting case.
5. Gathering per related subject, the merged cut loop, digests and records; the finding key and the dropped-subject records. Integration test: three assigned people, three results and three findings (acceptance 1); the component reads its aircraft's time in service (acceptance 3).
6. Queueing through `targetsNaming`, including corrections and aliases. Integration test: a training record for one person queues only that person's flights (acceptance 2).
7. Hazard origin and basis, indicators, and the finding list showing the related subject. Then the example pack version 2 with the per-flight battery leaf.

## Open questions, with recommendations

1. **One task per target, or one per related subject?** Recommend per target (above): one lock, one cut, and dropped subjects are found in one place. Per-related tasks would need the set computed elsewhere.
2. **A target-level record beside per-related ones?** Recommend yes, only for fan-out problems and their clearing, as above, so "no one is assigned" and "a reference is blank" have somewhere to be reported.
3. **Bound re-queueing fan-in?** A person on 2,000 past flights queues 2,000 evaluations per new training record. Recommend no bound in this pass, and a follow-up to let a relation skip targets whose from-read observations ended before a horizon, once real volumes are known.
4. **Battery aircraft from the flight report or the flight state?** Recommend the report's secondary subject. Adding the aircraft to the flight state would change every flight's state revision and re-queue every rule that reads flight state.
5. **Aliases created with a flight** have no journal position (`observation-corrections.md`, Open questions) and so never resolve a body reference. Recommend accepting this; `subject.alias` is the path that does.
6. **Chains** (a related subject's own related subject, such as the aircraft of a person's assignment) are left out. Recommend waiting for a rule that needs one.

## Reviewer rulings

Recorded when the note merged. They settle the open questions above; the implementation follows them.

1. **One task per target.** Accepted: one lock, one cut, one place that notices a subject is no longer named.
2. **A target-level record beside the per-related ones.** Accepted, for fan-out problems and their clearing only. When a related subject is no longer named, the engine records `not_applicable` with reason `related_subject_not_named` for it. A finding that is open for that subject stays open until a person resolves it: Ledger does not close a finding because a name was removed.
3. **Resolving references.** Accepted: through the resolution records inside the evidence cut, never the live alias table, so a replay resolves the same way. A source reference with no alias resolves to the source identity and can be read. A missing or malformed reference, a Ledger id that does not exist, or an ambiguous one is `insufficient` and the result names the reference.
4. **The cut.** Accepted: merged across the target and the related subjects, found by re-reading at most three times. If the related set is still changing after the third round, the result is `insufficient` with reason `related_set_unstable` and the target is queued again; nothing is guessed.
5. **Re-queueing.** No cap in this pass, with two conditions: work is queued in pages so one event never holds a long transaction, and a test queues for 1,000 targets. The follow-up that lets a relation skip targets whose evidence window has closed is to be filed when this is implemented.
6. **Battery per flight.** Take the aircraft from the flight report's secondary subject, as recommended. It ships as version 2 of the example operations pack; version 1 stays pinned.
7. **Aliases created with a flight, and chains.** Accepted as out of scope.
8. **Limit.** 50 related subjects per evaluation. Above it the target-level record is `insufficient` with reason `related_subject_limit` and no per-subject result is written for that evaluation.
9. **Migration number.** The note says 0054; that number has since been taken. The implementation uses the number the reviewer assigns when it starts.
10. **Promotion basis.** A hazard opened from a fanned-out finding includes the related subject's basis, as section 5 proposes, so newer evidence about that subject makes a stale promotion conflict.

## As built

The implementation follows the note and the rulings. Where it differs or adds detail:

- **Migration** `0063_rule_evaluation_related_subjects.sql` (ruling 9). Besides section 7 it adds `rule_evaluation_work.continuation` and the trigger kind `related` for paged re-queueing (below), and indexes `observation_references` by source identity for alias lookups.
- **Code.** Validation and pure resolution: `packages/domain/src/related-subjects.ts`. The reference index and backfill: `observation-references.ts`. Evaluation: `related-subject-evaluation.ts`; queueing: `related-subject-queueing.ts`. `rule-evaluations.ts` keeps one task per subject, pack and leaf; its recording step (`recordEvaluation`) is shared by both paths.
- **Registry.** An observation type declares `referenceFields(registry)`: dot paths, the kind each names and, optionally, the field values that make the path a reference. `operator.record` declares every `reference` field of every registered record type, conditioned on `values.recordType` and `values.recordVersion`. Leaf validation uses the same declaration to check a relation's `subjectKind`.
- **Records.** `namedBy` may be empty: a subject no longer named is recorded with none. Each `inputs` entry of a read about a related subject carries that `subject`. A result without fan-out that reads related subjects digests them as `relatedSubjects`; a result the engine decides without the check digests its `relatedProblem` reason; both parts are left out otherwise, so existing digests are unchanged (pinned in `packages/domain/tests/related-subjects.test.ts`, as is an existing finding id).
- **Reason codes.** `related_reference_unresolved`, `related_subject_conflicting`, `related_subject_missing` (`whenNone: insufficient`), `related_subject_none` (`whenNone: not_applicable`), `related_subject_limit` (ruling 8), `related_set_unstable` (ruling 4; the target is queued again a second later), `related_subject_not_named` and `evaluated_per_related_subject`.
- **Cuts.** A source identity's cut also takes the head of its alias stream (`subject-alias:<source>:<kind>:<id>`), so an alias recorded since is found in the next round: an aliased reference settles in three rounds. A Ledger related subject is locked for update before its evidence is read, because the evaluation retains its event on it. A leaf with a `referencing` read also reads at a cut widened by the streams of the records whose reference names the target: a reference in a record body retains nothing on the subject it names.
- **Paged re-queueing** (ruling 5). The event that names a related subject queues at most 500 targets (`RELATED_QUEUE_PAGE`). If more remain it adds one `related` work row whose subject is the related subject and whose `continuation` holds the relation, the last observation id read and the original trigger kind; a worker leasing it queues the next page in its own transaction and adds the next row. Tested with 1,000 targets.
- **Follow-up**: letting a relation skip targets whose window has closed is built; see below.

## Indicators over issues of several rules

An `issues` event selection may name further rules (`alsoRules`, up to nine besides the named one) and say what is counted once (`countEach`: `issue`, the default, or `subject`). With `issue`, every distinct issue of every named rule is one event, so two stretches of wind above a limit on one flight are two. With `subject`, each subject in scope with at least one issue in the window is one event, whatever rules named it, so a flight with wind above the limit at takeoff and in flight is one flight. Gathering reads each subject's evaluations once for all the named rules. A definition that uses neither part keeps its digest (pinned in `tests/unit/shipped-pack-digests.test.ts`).

## Organization records a source names by its own id

An imported record about the organization arrives with the source's own id, `{ kind: 'organization', scope: 'source', id: '<id in the file>' }`, and a read `about: 'organization'` does not reach it. It is resolved through the same resolution records as any other reference: a `subject.alias` from that source id to the Ledger organization (`organization:<tenant>`). The alias attaches the earlier records (a resolution record inside the evidence cut, so a replay resolves the same way), queues the organization readers for every subject they have evaluated, and later records under the same id resolve at intake. No organization-specific code is needed; `tests/integration/related-subjects.integration.test.ts` covers it.

## Backfill

Observations accepted before migration 0063 have no reference rows. `pnpm db:backfill:references` (`apps/api/src/backfill-observation-references.ts`) reads observations in id order, a page per transaction, with the owner connection, and inserts the rows the registry declares, keeping rows already present. It can run again at any time; `--after <id>` resumes from the id it last printed. Run it once after migrating; until it has run, rules do not see references in older records and those records do not queue their targets.

## Skipping targets whose window has closed

A relation may say, as data, which targets are still worth evaluating again when a record about its related subject changes:

```json
"related": [{ "name": "person", "subjectKind": "person", "fanOut": true, "whenNone": "insufficient",
              "from": { "read": "assignments", "field": "values.record.personId" },
              "requeue": { "windowEnd": { "read": "assignments", "field": "values.record.endsAt" }, "endedWithinDays": 7 } }]
```

- **The window.** `windowEnd.read` names a read about the evaluated subject (`about: 'target'`) or the subject-state read; `windowEnd.field` is the field of its latest current observation (newest span start, meeting the read's conditions) or of the state that holds when the target's window ends. Leaf validation refuses any other read.
- **Who is queued.** When a new or corrected record about the related subject queues the targets that name it (section 4), a relation with `requeue` queues only targets whose window end is after now, or within `endedWithinDays` (default 0) before now. A target with no valid end instant, including one named only through a source alias the lookup does not follow, is queued: a missing end never skips a target. Records about the target itself, corrections to its own records and adoption revisions queue it as before; the declaration narrows only the re-queueing through the related subject.
- **Skipped targets** keep their last evaluation and findings; nothing is written for them. The skip is visible on the queueing work of the event: the page's `related` row in `rule_evaluation_work` carries `continuation.skipped`, the number of targets that page named and did not queue. It is the pending row a worker continues from when more pages remain, and otherwise a row recorded as completed, written only when something was skipped.
- **Digests.** `requeue` is optional and left out when absent, so every existing leaf and pack digest is unchanged; without it queueing is exactly as before, and no row is written.
- **Cost.** One lookup per candidate target on each page (at most 500), against the subject state or at most 50 observations newest first. No migration.

## Records naming a related subject

A read about a related subject may add `referencing`: `about: { related: "pilot", referencing: "values.record.personId" }` takes the records whose reference at that field names the related subject, about any subject, as `about: { referencing }` does for the evaluated subject. It answers questions about a flight that need the pilot's other flights (`docs/design/record-check-kinds.md`, "Kinds asked as of one flight"). The related subject's cut is widened by the streams of the records whose reference names it, as the target's cut is for a referencing read. A new record naming the related subject in that field queues the targets whose own records name it, through the same index and pages as a record about it.

