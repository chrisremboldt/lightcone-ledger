# Which accepted controls are candidates for a flight's review

Design note. Builds on [controls-as-rules.md](controls-as-rules.md) (sections 7a and 7b) and keeps [lock-order.md](lock-order.md). Paths are relative to `packages/` unless they start with `apps/` or `tools/`; line numbers drift, so the function names are the reference.

## Status

Built, and described here as built. The owner read the first version of this note on 2026-11-20 and said to build it, and that Ledger has no users yet, so backward compatibility of records and behaviour does not matter. Three things follow, and they hold for the whole note:

- **Shapes changed in place.** No record version was added beside an old one. Superseded versions of the briefing, release and departure issuance records were deleted first, and every record kept its version id and took the new shape.
- **Digests moved** where the design needed it, and each pin was updated in the same commit: the area control type, the area reach rule and its golden records, and the release policy. The avoidance calculation's did not.
- **Databases are recreated.** Migrations 0075 and 0076 refuse rows of an older shape, as 0071 does. Seeds and recordings are remade.

The owner's answers to the questions in section 11: (1) the reach is measured from the edge of the area; (2) one review evaluates at most 512 overlapping area controls; (3) a control that would not apply, but whose hazard assessment has changed since it was accepted, applies until a person signs again; (4) an area control that declares no reach says so, and that it applies to every flight in its interval.

Not built: a demo scene that shows a control that does not apply. The simulated day exercises it (section 9); `pnpm db:seed` seeds no area control, and the demo's own selected control declares no reach, so it stays a candidate.

Terms, defined once:

- **Considered control**: an accepted control version whose type describes an area and whose effective interval overlaps the flight's operating interval. Today every considered control is a candidate.
- **Candidate**: a considered control that applies. Route review must find the route `outside` it, the release lists it, and departure needs it listed by an acknowledged briefing.
- **Reach**: a parameter of the control itself: how near the planned route must come to the control's area for the control to apply.
- **Applicability rule**: code a control type declares that decides, from the control's parameters and the flight's recorded plan, whether the control applies. It is pinned by id, version and digest.
- **Applicability record**: what the evaluation recorded for one control: outcome, what was measured, what the parameters declare, the inputs by digest and the rule's identity.

## 1. Summary

A control type may declare an applicability rule. Core runs it, through one generic evaluator, on the control's accepted parameters and the exact mission revision. A control applies unless its rule ran on complete inputs and found it does not; no rule, no declared reach, missing inputs or an error all mean it applies. A control that does not apply stays on every list with its applicability record, and the release pins that record; it is not a candidate. A change of mission revision evaluates every considered control again.

| Who | Before | After |
|---|---|---|
| Dispatcher | Route review lists 102 area controls and must find the route outside each. Release is impossible above 64. | Route review lists 2 candidates and, under "Does not apply", 100 others, each with the distance measured and the reach it was compared with. |
| Pilot | One briefing listing 64 controls at most, most of them far away. | One briefing listing the 2 candidates. The other 100 are one click away, each with its sentence. |
| Auditor | The release lists 102 candidates, each `outside`. | The release lists 2 candidates and 100 applicability records, each naming the mission revision, the control version and the rule by digest. The verifier checks their shape and digests. |

## 2. Today (verified)

**Selection.** `acceptedAreaControls` (domain/src/mission-avoidance.ts:187) reads every accepted control version on a hazard's latest acceptance whose registered type has `area()` (`areaControlTypes`, control-types.ts:168) and whose interval overlaps the operating interval (SQL at mission-avoidance.ts:92-111). Location plays no part. `getMissionAvoidanceSnapshot` (:295) runs the avoidance calculation `ledger.demo.mission-site-avoidance` version 1 on every row (:351). It pins the calculation by id, version and digest (mission-avoidance-definition.ts) and digests `{version:'mission.avoidance-context.1', mission, calculation, candidates, candidateCompleteness}` as `contextDigest` (:374-383).

**A far-away control** becomes a candidate with `geometry: 'outside'`. It enters the release basis (`basis.avoidance.candidates` and its preimage in `basis.candidateContexts`, contracts/src/mission-release.ts:160 and :287). On the controls list it reads `pass`, "The planned route keeps clear of this area." (mission-release-controls.ts:149-150). Departure on the human path needs it listed by an acknowledged briefing (`uncoveredCandidates`, flight-predeparture.ts:337-341, briefing-coverage.ts). The briefing trigger accepts only exact candidates (migration 0074:140-170).

**Limit 1: 64.** `MISSION_AVOIDANCE_CANDIDATE_LIMIT = 64` (contracts/src/mission-avoidance.ts:4). The query reads 65 rows (mission-avoidance.ts:111). At 65 the read returns `candidate_limit_exceeded` (:205), `contextDigest` is null and status `insufficient`. A release needs `outside` with complete candidates, so release is impossible. A 2 MiB read budget (`record_budget_exceeded`, :207) can bind earlier.

**Limit 2: boundaries.** `nextAcceptedControlBoundary` (accepted-control-rules.ts:116) returns the next start or end of any accepted control in the organization. It caps:

- a briefing's `valid_until` (mission-briefing.ts:303-307);
- the departure lease, in the application (mission-departure.ts:157-163) and in `ledger_check_mission_departure_commit` (0071:314-320, which demands that exact value).

A release refuses to record if the boundary had already passed when the snapshot was read (mission-release.ts:186). After it is recorded, the boundary is only the recheck time its validity reports (:435-438). Its status changes only when `contextDigest` changes, and a boundary cannot change that: overlap is computed against the recorded operating interval, not the clock. So the first sketch's statement holds for briefings and leases. For a release it holds only as the recheck time. Assumption: acknowledgement and readiness treat a briefing past `valid_until` as unusable; I found `valid_until` checked where the briefing is projected (mission-briefing-projection.ts:220-221).

## 3. The rule

Built in phases 1 and 2. Nothing calls the evaluator from a command, a read or a projection yet; that is phase 3.

### The hook

`ControlType` (domain/src/control-types.ts) has one optional member beside `area()` and `rules()`:

```ts
applicability?: {
  rule: { id: string; version: number; digest: string };  // pinned; enters the type's digest (section 5)
  definition: Readonly<{ id: string; version: number }>;   // the frozen description the digest covers
  evaluate(parameters: P, plan: ApplicabilityPlan): ControlApplicabilityOutcome;
};
interface ApplicabilityPlan {
  mission: Pick<MissionRevisionRecord,
    'aircraftId' | 'sourceMissionId' | 'route' | 'lateralToleranceMeters' | 'altitude' | 'operatingInterval'>;
}
type Measure = { name: string; value: number | string; unit?: string };   // ControlApplicabilityMeasure
type ControlApplicabilityOutcome =                                         // contracts/src/control-applicability.ts
  | { applies: boolean; measured: Measure[]; declared: Measure[]; summary: string }
  | { applies: 'undetermined'; reasons: string[]; summary?: string };
```

`evaluate` is pure. It receives deep-frozen copies of the control's accepted parameters and of the six plan fields above, and nothing else: no clock, no database client, no registry. Every plan field is in the exact mission revision record. `summary` is one sentence of measurement, recorded as is; an `undetermined` result may give one (the area rule says why it applies), otherwise the evaluator's own sentence is used. The outcome is checked against `ControlApplicabilityOutcomeSchema` (at most 16 measures each, names in camelCase, finite numbers, reasons in snake_case, a summary of at most 500 characters).

### The generic evaluator

`evaluateControlApplicability(pinnedType, parameters, plan, inputs)` in `domain/src/control-applicability.ts` returns `{ record, digest }`: the applicability record (section 4) and its `canonicalDigest`. `inputs` is `{ mission: MissionAvoidanceMissionReference | null, control: { controlId, versionNumber, controlEventId, bodyDigest }, reviewRequired: boolean }`; the caller passes as `reviewRequired` what route review already knows as `review_required`. The evaluator names no type, rule or vendor (a unit test scans it for every registered type id), and it fails towards applying, in this order:

| Case | Outcome | `basis` | `reasons` | `rule` |
|---|---|---|---|---|
| Pinned type not registered here, or registered with another digest | applies | `no_rule` | `control_type_unavailable` | null |
| Parameters invalid for the type | applies | `no_rule` | `control_parameters_invalid` | null |
| Type declares no `applicability` (described measure, operating limit) | applies | `no_rule` | none | null |
| The control's hazard assessment changed since acceptance (`reviewRequired`); the rule is not consulted | applies | `under_review` | `review_required` | the type's |
| No plan, or no mission reference | applies | `inputs_incomplete` | `mission_unavailable` | the type's |
| `evaluate` throws | applies | `error` | `rule_failed` | the type's |
| `evaluate` returns a shape that fails the schema | applies | `error` | `rule_result_invalid` | the type's |
| `evaluate` returns `undetermined` | applies | `undetermined` | the rule's | the type's |
| `evaluate` returns `applies: true` / `false` | `applies` / `does_not_apply` | `rule` | none | the type's |

The evaluator's own sentences: "This control's type or parameters cannot be read here, so it applies to every flight in its interval."; "This control's type declares no applicability rule, so it applies to every flight in its interval."; "The hazard assessment has changed since this control was accepted, so it applies until a person signs again."; "The flight's mission revision cannot be read, so the control applies."; "The applicability rule could not be evaluated, so the control applies."; and for an undetermined result without its own sentence, "The applicability rule could not settle whether this control bears on the flight, so it applies." Measured and declared are empty in every case but `rule`. The same inputs give the same record and digest; this is tested.

### The area control's rule

`control.avoidance-area` stays version 1 (domain/src/control-type-library.ts) and gains one optional parameter and the rule:

- `appliesWithinMeters`: number, 0 to 50 000. Form title: "Applies to flights whose planned route comes within (metres)". Description: "Measured from the edge of the area. Leave empty to apply to every flight in the control's interval."
- `describe` adds, only when the reach is declared: "Applies to flights whose planned route comes within 500 m of the area." Wording for parameters without a reach is unchanged.
- `applicability` is `ledger.control-applicability.area-reach` version 1 (domain/src/area-reach-rule.ts). Its frozen definition `areaReachDefinition` names the avoidance calculation it takes its geometry from (`geometryFrom`: id, version, digest), the library, ellipsoid, 0.001 m margin, the threshold formula, the first bound, the per-segment bound, the sample and interval bounds, depth 48, the 4 096 budget, the 50 000 m reach limit, the clearance formula and `uncertainty: 'applies'`. Its digest constant `4667a798…9f62` (`ffd0f33f…60af4` before phase 3 added the per-segment bound) is checked when the module loads, and again by `registerControlType`.

The rule, step by step:

- **No reach declared:** `undetermined`, `no_reach_declared`: "This control declares no reach, so it applies to every flight in its interval."
- **Profile:** the circle's centre must satisfy the calculation's position profile (|latitude| ≤ 80), radius at most 10 000 m, reach 0 to 50 000 m, and the route the calculation's route profile (`missionSegments`: 2 to 256 positions, corridor tolerance ≤ 1 000 m, curve ≤ 50 km, no antimeridian crossing). Otherwise `undetermined` with the calculation's reason, and "The distance from this route to the area could not be settled, so the control applies."
- **Threshold:** `T = radiusMeters + appliesWithinMeters + lateralToleranceMeters`, so the reach is measured from the area's edge to the corridor.
- **Step 1, one distance:** `d0` is the geodesic distance from the centre to the route's first position; `L` is the sum of the calculation's segment curve-length bounds, each plus 0.001 m. If `d0 − L − 0.001 > T`, the control does not apply, with that bound.
- **Step 2:** otherwise the kernel's `corridorBound(segments, centre, T, budget)` runs, with the one distance of step 1 already counted against the rule's own budget of 4 096. A sample with upper bound ≤ T: applies. Every interval's lower bound > T: does not apply, with the smallest lower bound. Anything else is `undetermined` with the kernel's reasons; with `distance_budget_exhausted` the sentence is "The distance from this route to the area could not be settled (distance budget used up), so the control applies."
- **Clearance (phase 3):** once step 1 or 2 has settled that the control does not apply, the rule also computes, if the remaining budget allows, a per-segment bound: for each segment the smaller of the distances from the centre to its two ends, less half the segment's length bound and twice the 0.001 m margin; the route's bound is the smallest of these. Every point of a segment lies within half its length of one of its ends, so this is a true lower bound. Whether the control applies never depends on it.
- **Measured:** `clearanceAtLeastMeters` = floor(largest of the first bound, the per-segment bound and the bisection's bound, less radius and tolerance) when it does not apply, so a control 20 km away no longer reads as only the route's length short; `comesWithinMeters` = the reach when it applies. **Declared:** `appliesWithinMeters`, `radiusMeters`. Units `m`.
- **Summary:** "The planned corridor stays at least 3 200 m from the area; the control applies within 500 m." or "The planned corridor comes within 500 m of the area; the control applies within 500 m." Metres are grouped by thousands with a space; a fractional reach shows at most three decimals.

**Reuse.** The kernel (domain/src/mission-avoidance-kernel.ts) exports `missionSegments`, `validPosition`, `geodesicDistance` and `corridorBound`, which is the bisection factored out of `evaluateCircle`; `evaluateCircle` maps its `within` / `beyond` / `uncertain` to `intersects` / `outside` / `insufficient` with the same reasons in the same order. The calculation's definition and digest constant did not move, and its golden tests pass unchanged.

**Golden vectors** (tests/unit/area-reach-rule.test.ts) pin the full record digest for: far (step 1), far by bisection, near, inside, the corridor exactly 0.002 m inside the reach (applies), exactly 0.002 m outside it (undetermined: inside the bounds' error band, so it applies), 0.003 m outside it (does not apply), outside the profile, budget used up, no reach declared and hazard under review.

### A second, different type without core change

`tests/unit/control-applicability.test.ts` registers the fictional `example.aircraft-limitation` version 1 as a pack does, with parameters `{ measure, aircraftIds? }` and its own rule `example.applicability.listed-aircraft` version 1, which reads `plan.mission.aircraftId` and returns `undetermined` when no aircraft are listed. The evaluator records "This flight's mission names aircraft AC-17; the control applies to aircraft AC-03 and AC-04." with `does_not_apply`. No core file changed for it.

## 4. What is recorded

Built in phase 3. Every record below kept its version id and changed shape in place.

**Applicability record** (`control.applicability.1`, contracts/src/control-applicability.ts). Its digest is `canonicalDigest` of the record.

```ts
{ version: 'control.applicability.1', outcome: 'applies' | 'does_not_apply',
  basis: 'rule' | 'no_rule' | 'inputs_incomplete' | 'undetermined' | 'error' | 'under_review',
  rule: { id, version, digest } | null,
  inputs: { mission: MissionAvoidanceMissionReference | null,              // eventId, contentDigest, recordDigest
            control: { controlId, versionNumber, controlEventId, bodyDigest }, controlType: { id, version, digest } },
  measured: Measure[], declared: Measure[], summary: string, reasons: string[] }
```

**Route review** (`getMissionAvoidanceSnapshot`, domain/src/mission-avoidance.ts). After the locks it already takes, it reads every considered control (the query reads 513 rows; above 512 the review is incomplete with `considered_limit_exceeded`). `reviewConsideredControls` evaluates each with `evaluateControlApplicability`, passing as `reviewRequired` whether the candidate's safety context is other than `current` (its hazard was reassessed, its control record revised or closed, or its acceptance cannot be read). Those that apply are compared with the route; above 64 the review is incomplete with `candidate_limit_exceeded`. It takes no new lock, and a read at REPEATABLE READ still takes none. The simulator's avoidance preparation context keeps its own bound of 64 considered controls.

**Avoidance preview** `flight.mission-avoidance.1`, changed in place:

- `candidates[]` (at most 64): the considered controls that apply, each also carrying `applicability` (outcome `applies`) and `applicabilityDigest`.
- `notApplicable[]` (at most 512): each a candidate reference without `geometry`, with its `context`, `safetyContextDigest`, `reasons`, `applicability` (outcome `does_not_apply`, basis `rule`) and `applicabilityDigest`, and the control version's `title` and its `area`: `{ center, radiusMeters }`, what the pinned type's own `area()` returns for the accepted parameters, read through the generic `controlArea`, or null when the type describes none or the answer cannot be read. Core names no type. The reach is not repeated: it is a parameter, and the record states it under `declared`. A screen lists and places the entry from these alone.
- `consideredTypes[]`: the `areaControlTypes()` read, by id, version and digest.
- `candidateCompleteness` is `{ status, count /* controls that apply */, limit: 64, considered, consideredLimit: 512 }`.
- `contextDigest` is the digest of `{version:'mission.avoidance-context.1', mission, calculation, candidates, notApplicable, consideredTypes, candidateCompleteness}` (`missionAvoidanceContextDigest`, domain/src/mission-avoidance-context.ts).

**Release** `flight.mission-release.2` under policy version 2, changed in place. The policy's title is "Recorded route avoidance release with open findings and control applicability"; it has `avoidance: 'applicable_outside_complete_current'` and `applicability: 'considered_controls_recorded'`, and its instruction says that every overlapping area control is considered, only those that apply must be outside, and each that does not is recorded with what was measured, the rule and its inputs. Its digest moved from `6860eec3…72ac` to `158378d5…e7b1`.

- `basis.avoidance` is the preview. Status is `outside`. Every candidate is `outside`, `current`, with no reasons and outcome `applies`. Every `notApplicable` entry is `current`, with no reasons, outcome `does_not_apply` and basis `rule`, and has a title and an area or null.
- `basis.candidateContexts` stays parallel to the candidates, at most 64, so the 0028 table check holds.
- `basis.notApplicableContexts` holds the safety context preimages, parallel to `notApplicable`.
- The command is unchanged. `expectedContextDigest` already covers every applicability record.
- `assertMissionReleaseRecord` checks each applicability record against its schema and digest, that its mission is the release's, that its control and type are the entry's own, and, for one that does not apply, that its rule is the one the entry's registered type declares, and the shape of its title and area. The area is not compared with the control's parameters, which the release does not hold.

**Controls list** `flight.controls-seen.1`, changed in place, in two parts, with a new top-level `mission`: the reference route review read for the list, or null when no listed control needed route review.

- `controls` (at most 200, `FLIGHT_CONTROL_LIMIT`): full entries as before, for every control in scope except those route review recorded as not applying. Upcoming and ended controls stay here. A route-review result may carry `applicability: { outcome, basis, measured, digest }`, where `digest` is the full record's.
- `notApplicable` (at most 512, the considered bound): one compact entry per control route review recorded as not applying, with no free text beyond the title: `hazardId`; `control: { id, versionNumber, bodyDigest, title }`; `applicability: { outcome, basis, measured, digest }`; and `summary`, the recorded sentence. Its wording and parameters are in the control version its body digest names.
- `complete` is false when either part overflows. The digest is that of `{version:'flight.controls-seen.1', controls, notApplicable, complete, mission}`. A command may name no controls digest only when both parts are empty.
- The applicability inputs are the list's `mission` plus the entry's own control fields, the rule is the one the entry's pinned type declares (the type's digest commits it) and what the control declares is in its parameters, so none of these is repeated per entry.
- Why two parts: with every not-applicable control as a full entry, a list of about 105 area controls was over the briefing's former 128 KiB, and above 200 controls the list was never complete, although route review evaluates 512. A person's briefing work, and what Ledger can record, should not grow with controls that do not apply.

**Briefing** `flight.mission-briefing.3`: unchanged in shape, except that its pinned `controls` is the changed list; its byte bound rose from 128 KiB to 1 MiB (contract, 0031's table check replaced in 0076). It lists candidates only, as before; the trigger accepts only exact candidates of its release, which are now the controls that apply. **Departure issuance basis** `mission.departure-issuance.2`: `avoidance` is the route review it re-checked without `notApplicable`, and there are no not-applicable contexts. It pins the release by id and digest, and its context digest, which must equal the release's, covers every not-applicable record, so it does not repeat them; its candidates and their contexts must equal the release's as before. The integrity check verifies the review with the release's not-applicable records. The permit is unchanged.

**Release size.** A release may be 4 MiB (`MISSION_RELEASE_MAX_RECORD_BYTES`, and 0028's table check replaced in 0076), since it records every considered control. A departure authorization may be 8 MiB (`MISSION_DEPARTURE_MAX_RECORD_BYTES`): its issuance basis embeds the whole release, so its bound must exceed the release's.

**Route suggestion** `flight.mission-route-suggestion.1` keeps clear of every considered area, whether or not it applies to the current route (`avoids: 'every_considered_area'`, `consideredAreas`); a control that does not apply to this route may apply to a new one. The planner's bound on areas rose from 64 to 512.

## 5. Pinning the rule

Built: options 2 and 1 together.

`area()`, `rules()`, `wording()` and `parameterChoices` sit outside the type's digest; the digest covers only the declared definition. The rule does not drift that way:

- **In the type's digest.** `controlTypeDefinitionContent` adds `applicability: { id, version, digest }` when, and only when, the type declares a rule, and `ControlTypeDefinitionSchema` (contracts/src/sms.ts) allows that optional member; `listControlTypes` shows it. A changed rule therefore means a new type version, and an accepted control keeps the version a person accepted. Types without a rule produce the same canonical object as before: the described-measure and operating-limit digests did not move, and a test pins them. The area type's digest moved from `3e0ace97…366c` to `ac149b8b…1b2d`, because it gained the parameter and the rule, and in phase 3 to `2395def9…f6d3`, because the rule's digest moved.
- **Registration checks the rule.** `registerControlType` refuses a declaration whose `definition` has another id or version than its `rule`, or whose `canonicalDigest(definition)` is not `rule.digest`. The rule module checks its own digest constant at load as well, as `mission-avoidance-definition.ts` does.
- **In every record.** Each applicability record repeats the rule's id, version and digest and the control type's, so a reader needs no registry.
- **Code behind the digest.** Like the calculation, the digest covers the definition, not the code. Each rule version therefore ships golden vectors (fixed parameters and plan giving a fixed record digest); a code change that alters a result fails `pnpm verify` unless the version moves.

Option 3, the rule reference in the control body, was rejected: it would change `sms.control.1` and ask the person to pick a rule.

## 6. The database

Migration 0076 (`0076_route_review_records_applicability.sql`). It refuses a database holding a release, briefing controls list or issuance basis of the earlier shape, with a message to recreate it, and deletes no rows. Nothing new is locked anywhere: the evaluation is computation inside the existing snapshot.

| Object | Change | Locks (unchanged) |
|---|---|---|
| `mission_releases_record_identity` | dropped and added again: `basis.avoidance.notApplicable` and `basis.notApplicableContexts` arrays of the same length; candidates plus not applicable at most 512 | none |
| `ledger_check_mission_release_commit` (0028) | unchanged. It reads the mission and `candidateContexts` only. | 3 → 0 → 4 register |
| `mission_briefings_record_identity` | dropped and added again: a pinned controls list has a `mission` (null or an object) and a `notApplicable` array | none |
| 0031's size check on `mission_briefings` | replaced by `mission_briefings_record_size`: 1 MiB instead of 128 KiB | none |
| `ledger_check_mission_briefing_commit` (0075) | unchanged. Candidates still come from `basis.avoidance.candidates`, now only the applicable ones. | 3 → 0 → 4 org → 4 register |
| `mission_departure_record_identity` | dropped and added again: the issuance basis holds no `notApplicableContexts` and no `avoidance.notApplicable`; the pinned list has a `mission` and a `notApplicable` array |
| 0028's size check on `mission_releases` | replaced by `mission_releases_record_size`: 4 MiB instead of 2 MiB | none | none |
| `ledger_check_mission_departure_commit` (0075) | redefined: also requires the issuance basis's context digest to equal the release's (its candidates and their contexts must equal the release's, as before), and lets a command name no controls digest only when both parts of the pinned list are empty | 3 → 0 → 4 register |
| `ledger_publish_accepted_control_change`, `ledger_lock_mission_avoidance_register` | unchanged. Every accepted-control change still bumps the register, which is what keeps a not-applicable record from going stale unnoticed. | 4 register |

As in 7a, a trigger cannot rerun a control type's registered code. Whether a control applies is the application's to compute, in the same transaction and under the same locks as the pin. The triggers check that what was pinned is exact and consistent.

## 7. The two limits

**64.** Recommendation: yes, 64 counts candidates only.

- 64 is the briefing's bound (0074:25) and the release's `candidateContexts` bound (0028). Those are the controls a person must read, and both stay.
- A new considered bound of 512 bounds the work. The query reads 513 rows, and above 512 the review is incomplete (`considered_limit_exceeded`).
- Each far control costs about one distance computation (step 1), and the 4 096 budget is per control. The 2 MiB read budget counts each control version once and each decision record once, however many controls cite it.
- Measured at the bound (512 considered, 2 candidates, 510 not applicable, `mission-controls.integration.test.ts`), with each not-applicable entry's title and area: release 1 678 922 bytes of 4 MiB (40%; 1 606 105 without them), briefing 311 718 of 1 MiB (30%), acknowledgement 1 225 of 16 KiB (7%), departure permit and issuance basis 1 999 384 of 4 MiB (48%; 1 926 567 before); the review read took about half a second. The test requires each record to stay under 60% of its bound. The release bound rose from 2 MiB to 4 MiB; the departure bound stays 4 MiB, and its issuance basis no longer repeats the release's not-applicable records.
- The controls list holds 200 full entries and 512 compact ones (section 4); the briefing's bound is 1 MiB.
- More than 64 *applicable* controls still makes release impossible. That case is real crowding, which a person should see.

**Boundaries.** Built in phase 6.

*What a boundary does.* `nextAcceptedControlBoundary` (accepted-control-rules.ts) gives the next start or end of any of the organization's accepted controls; route review reads it as the snapshot's `nextBoundary`. Four things use a boundary:

- a release refuses to record when it had already passed when the snapshot was read (mission-release.ts, `release_evidence_pending`);
- the departure lease ends at it, in the application (mission-departure.ts) and in `ledger_check_mission_departure_commit` (0076), which demands that exact value;
- a briefing's `valid_until` (mission-briefing.ts);
- a release validity's `nextBoundary`, its recheck time (`getMissionReleaseState`).

The first two are unchanged and still use every boundary in the organization. The last two now use only the boundaries that can matter to the flight.

*A briefing past its `valid_until` no longer counts.* A briefing describes the controls as they stood when it was written. Once its release window closes, or a control that can matter to the flight starts or ends, that picture is no longer known to hold, so the briefing lapses:

- **The rule.** `briefingStanding(bounds, at)` (domain/src/briefing-standing.ts) is the one rule: a briefing is in force before its `valid_until` and lapsed from that instant on. Its `boundary` says why it ends: `release_window_end` when `valid_until` is the release window's end, otherwise `control_boundary`. `briefingStandings` reads `valid_until`, the release window's end and `clock_timestamp()` in one query inside the caller's transaction, so the instant is always the database clock, never the caller's.
- **Recording a briefing.** Unchanged: `ledger_check_mission_briefing_commit` refuses a commit that reaches `valid_until` with 40001, and `valid_until` may not pass the release window's end. Projection checks it against the briefing's own receipt time.
- **Acknowledgement.** `mission.briefing-acknowledge` reads the standing after it locks the flight and refuses a lapsed briefing with `409 briefing_lapsed`, saying when and why it lapsed, that its picture of the controls is no longer known to hold and that a new briefing is needed (details: `briefingId`, `validUntil`, `boundary`, `evaluatedAt`). Migration 0077 redefines `ledger_check_mission_briefing_acknowledgement_commit` with one change: it also reads the briefing's `valid_until` and refuses a commit that reaches it with 40001 (answered as `409 concurrent_change`; a retry meets `briefing_lapsed`). The application check alone would leave the moments between that check and the commit; the briefing's own trigger already closes that gap for briefings, and an acknowledgement is history that is never changed, so the database refuses it as well. Its locks and their order are unchanged: the flight, then the author. Projection also refuses an acknowledgement received at or after its briefing's `valid_until`.
- **Departure readiness.** A `ready` report refuses any named briefing that has lapsed with `409 briefing_lapsed`, even when every recipient acknowledged it in time. Those acknowledgements stay recorded; the briefing just stops counting, so a candidate covered only by lapsed briefings is uncovered. A new briefing, acknowledged, restores readiness. Other phases do not read the standing: once a permit is issued or departure is reported, the references are fixed and a briefing that lapses afterwards changes nothing already done.
- **Reads.** The briefing read and its acknowledgements read carry `standing`: `status` (`in_force` or `lapsed`), `validUntil`, `boundary` and `evaluatedAt`. Departure progress (`GET /v1/flights/{id}/predeparture`) carries the same `standing` on each named briefing.
- **Screens.** The briefing workspace badges a lapsed briefing "Lapsed" and says when and why ("Lapsed at <time> CT, when the release's departure window closed. Its picture of the controls is no longer known to hold; a new briefing is needed."); an in-force one says until when. The acknowledgement form shows the same sentence and offers no acknowledgement; a refusal with `briefing_lapsed` reads the briefing again. Departure progress counts a control whose briefing lapsed as needing a new one, says so, and offers "Prepare the controls briefing" for it with the controls that have none; a `ready` report whose briefing lapsed reads "A briefing this departure relies on has lapsed. A new briefing is needed."
- **Source coordinators.** Both simulated sources (`operation-ordinary-runtime.ts`, `operation-demo-runtime.ts`) pass over a lapsed briefing when they choose one, as if the control had none, and report `awaiting_briefing` with code `briefing_lapsed` until a person records a new one. A `ready` report refused for a lapse is rejected progress, as before, not a failure of the day; the next pass chooses again.
- **What stays the same.** A boundary of a control the release recorded as not applying leaves an existing briefing in force (it is not its `valid_until`). The release, the departure lease and the departure command do not read briefings.

Unit tests: tests/unit/briefing-standing.test.ts (the rule and the refusal), tests/unit/predeparture-ui.test.ts and tests/unit/briefing-form.test.ts (the screens). Integration tests (mission-controls.integration.test.ts): past a not-applicable area's end a briefing is still in force, acknowledged and counted; past a candidate's end the acknowledged briefing reads lapsed, readiness refuses it with `briefing_lapsed`, the unacknowledged one cannot be acknowledged, and a new briefing restores readiness; an acknowledgement whose commit reaches a briefing's `valid_until` is refused at commit and then with `briefing_lapsed`.

*The claim, checked in the code.* Route review considers every accepted area control whose effective interval overlaps the mission revision's recorded operating interval (`controlRecordSql` in mission-avoidance.ts: `effective_from` before the operating end, and `effective_until` null or after the operating start). The clock is not an input. An upcoming control, accepted and starting later but overlapping the operating interval, is therefore considered and evaluated at review time and recorded under `candidates` or `notApplicable` like any other; its start changes neither. A control's outcome depends on its accepted parameters, its safety context (which decides `reviewRequired`), the mission revision and the pinned rule. No instant changes any of these:

- a control or acceptance change, a reassessment or a closure changes the register or the safety context, so the release's `contextDigest` no longer matches (`safety_context_changed`);
- a new mission revision gives `mission_changed`;
- a changed rule is a new type version.

So a control recorded as not applicable cannot come to apply to the same mission revision without a register or safety-context change or a new mission revision, and its boundaries cannot change what the release recorded.

One thing such a boundary does change: the controls list. `flight.controls-seen.1` shows each control by its period at the instant it is read. An upcoming or ended area control is a full entry ("This control takes effect on …; it is not evaluated before then."), and only a current one carries route review's result, compact under `notApplicable`. The list's digest therefore changes at that boundary. That matters only to a command that pins the list (a briefing or a departure authorization), which reads it again in its own transaction and conflicts with `flight_controls_changed` as for any other change. Nothing compares an existing briefing's pinned list with a later one. It does not change whether the control is considered or applies, so it does not count.

*The rule.* `releaseControlBoundary(controls, release, after)` (domain/src/mission-release-boundary.ts) returns the earliest start or end after `after` of the organization's accepted controls, leaving out each control the release recorded under `basis.avoidance.notApplicable`, matched by hazard, control, version, control version event and acceptance. Every other boundary counts:

- candidates;
- rule controls and controls a person checks;
- area controls the release did not consider, because their interval does not overlap the operating interval;
- controls of any type route review does not consider;
- any control accepted or revised after the release: its version event or acceptance is not one the release names, and the change ends the release's validity through the register anyway.

`getMissionReleaseState` computes it once, as `controlBoundary`, from the controls read in the same transaction as the snapshot. The validity's `nextBoundary` is the earliest of the window's start, the window's end and `controlBoundary`; a briefing's `valid_until` is the earlier of the window's end and `controlBoundary`. Unit tests: tests/unit/mission-release-boundary.test.ts. Integration tests (mission-controls.integration.test.ts): a briefing committed across a not-applicable area's end is recorded, and after that instant a briefing is acknowledged and readiness accepts it; a briefing committed across a candidate's end, or a rule control's end, is refused, and a person-checked control's end is the next `valid_until`; accepting another area after the release, even one that does not apply, makes the release read `changed`.

Not narrowed, although the earlier recommendation named them: area controls of a considered type whose interval does not overlap the operating interval. Their boundaries cannot change the considered set either, but the ruling for phase 6 leaves out only controls a release recorded as not applying; when in doubt a boundary counts.

The boundary work itself changed no migration, record shape or digest. The briefing trigger still checks only that `valid_until` is after the commit and not after the release window's end, and the departure lease, and permit version 1's `expiry`, are as they were. Enforcing `valid_until` afterwards (above) added migration 0077 and a `standing` to three read responses; no record shape or digest changed.

## 8. Screens and wording

Built in phase 4. A control that does not apply is always visible and always says why, with the sentence its applicability record holds, shown as recorded. No screen uses verdict words, and no screen names a rule, a measure or a type: the sentence, the rule's id and version and the counts all come from the records. The wording lives in `apps/web/src/flight-controls.ts` beside the other words for controls, with unit tests (`tests/unit/control-applicability-ui.test.ts`). The badge reuses "Does not apply" (neutral tone).

| Screen | What it shows |
|---|---|
| Mission review (`MissionWorkspace.tsx`) | "Checked 14:02 · 2 accepted controls apply to this route; 100 more overlap the mission interval and do not apply." The candidates are listed as before, each `AreaControlSummary` also showing its own applicability sentence (for a control with no reach: "This control declares no reach, so it applies to every flight in its interval."). Then a collapsed section "Do not apply to this route (100)": each entry has its title, "Does not apply" with the recorded sentence, and "Decided by ledger.control-applicability.area-reach version 1 for mission revision 3 and control version 2." |
| Controls list (`FlightControls.tsx`) | The compact `notApplicable` entries under "Do not apply to this route (N)", each with the badge and recorded sentence. A route-review result that applies shows "Applies · " and its recorded sentence (no reach declared, hazard under review, could not be settled, or comes within the reach), looked up by the result's applicability digest in the route review or release the screen holds; the controls list itself does not carry that sentence. |
| Briefing form and review (`BriefingForm.tsx`, `BriefingWorkspace.tsx`) | The form offers and the release basis lists the candidates only. Under them one expandable line: "100 other accepted controls overlap this flight's interval and do not apply to its route; the release lists each with its measurement." Opened, it lists the release's not-applicable entries as mission review does. The recorded briefing shows the same line while its release is the one read. |
| Departure progress (`FlightPredeparturePanel.tsx`) | With a release: "2 controls need a briefing. 100 do not apply to this route." from the release's basis. Only candidates have briefing rows. |
| Release inspection (`MissionInspection.tsx`) | "planned route outside 2 accepted controls · 100 more do not apply to this route", and each candidate's sentence. |
| Map (`MissionRoute.tsx` through `SpatialMap.tsx`) | Candidates are drawn as before. A not-applicable area that reaches into the route's view is a thin dashed outline labelled "Does not apply", placed at the entry's `area` (an entry with a null area is listed, not drawn); a list under the map gives each one's title and recorded sentence (which states the clearance). These outlines never move the view, the fit, "Show all areas" or the count of areas outside the view. There is no ring at the reach: the reach is not in the entry, and reading the exact version for it would be a read per control that does not apply. |
| Area editor (`AvoidanceAreaEditor.tsx`) | `appliesWithinMeters` is a plain optional number field titled "Applies to flights whose planned route comes within (metres)", described "Measured from the edge of the area. Leave empty to apply to every flight in the control's interval." An empty field omits the parameter; a stored value is shown and kept. |

A declared reach is part of the control's own wording ("Applies to flights whose planned route comes within 500 m of the area."), which `AreaControlSummary` already shows, so it is not repeated.

**Long lists.** A review may list 512 controls that do not apply. The collapsed sections render their entries only when opened, 50 at a time with "Show more"; the controls list shows its compact entries 50 at a time. The map draws at most 50 outlines, only those reaching into the view, and says how many more there are.

**Reads.** Route review and the release carry each not-applicable control's title and area, so no screen reads the exact version of a control that does not apply: the lists (`NotApplicableControls`, through `avoidanceNotApplicableEntries`) and the map outlines (`notApplicableOutlines`) come from the entries alone, and the background reading of up to 512 exact versions in mission review and the per-page reads in the briefing screens are gone. Candidates are read as before, through `read-failure.ts`. `tests/browser/control-applicability.spec.ts` fails if the page requests an exact version of a control that does not apply.

## 9. Sources and the simulated day

- **Source coordinators.** `apps/simulator/src/operation-ordinary-runtime.ts` and `operation-demo-runtime.ts` read `avoidance.candidates`, now the applicable controls only, so they brief only those; they never read `notApplicable`. A not-applicable entry is always `current` (a control whose context is not current is evaluated as `under_review` and applies), so the ordinary runtime's checks for pending and current context, which look at candidates, still cover every control that needs a person. The demo's selected control declares no reach, so it stays a candidate and its route must still leave it. The demo's preparation context keeps its own bound of 64 considered circles and plans around every one of them, applying or not. The departure consumer (`operation-departure-consumer.ts`) recomputes the controls-list digest over both parts, and the simulator's copy of the release policy and context digest (`mission-release-plan.ts`, `mission-release-confirmation.ts`) follow the new shapes (phase 3).
- **Simulated day (phase 5).** `pnpm scenario` has 19 self-checks. After its ten flights it runs `runFarControlDay` (`apps/simulator/src/scenario-applicability.ts`) for the Alpha tenant through the public API: the dispatcher grants itself release and risk acceptance authority and the source a mission source where they lack them (and restores both afterwards), opens a fictional hazard by hand, proposes three avoidance areas with a reach (radius 400 to 600 m, reach 1 000 to 2 000 m), due north and south of the day's one route at 22 to 33 km, assesses and accepts the risk, records one mission on a new flight seventeen days ahead and releases it once route review lists all three under `notApplicable`. The self-check `far area controls with a reach are recorded as not applying, no briefing lists them and the second tenant sees none` then reads every release of this run's Alpha flights (at least one is required) and asks, for each of the three: in `notApplicable` and not a candidate, outcome `does_not_apply`, basis `rule`, rule `ledger.control-applicability.area-reach` version 1, and `clearanceAtLeastMeters` at least the distance it was placed at (a lower bound from the latitude difference alone) less the route's extent (1 500 m), its radius and the 30 m tolerance. No briefing of those flights lists one, the flight's controls list has each under `notApplicable` and none under `controls`, and the Beta tenant's reads of the three control records and of the release return not found. Unit tests over recorded fixtures cover the check, and run the area reach rule itself on the placements.
- **Verifier.** `tools/verifier/mission-release.mjs` pins policy 2 by its new digest and recomputes the context digest with `notApplicable` and `consideredTypes`. It checks the counts (`count === candidates.length`, `considered === candidates + notApplicable`, both within their limits), each safety context preimage, and each applicability record's shape and digest, that its mission is the release's and its control fields and type the entry's own. A record that does not apply must have basis `rule` and name a rule the verifier pins by digest (the area reach rule), and its entry must have a title (1 to 200 characters) and an area that is null or exactly `{ center: { latitude, longitude }, radiusMeters }` with finite values in range and a positive radius; it cannot show that the area is what the type describes for the control's parameters. `flight-controls-seen.mjs` checks the list's `mission` and its digest. As before, it states what it cannot show: it does not replay geometry or the rule, and it cannot show the considered set was complete.
- **Web app.** It reads `candidates` as before, now the applicable controls, and explains the controls that do not apply on every screen (section 8), from each entry's title and area without reading the control. The area control editor keeps a stored reach when an area is edited.

## 10. Phases

| # | Title | Changes | Files | Migration | Acceptance tests | Depends on |
|---|---|---|---|---|---|---|
| 1 | Control types may declare an applicability rule | Hook, generic evaluator, optional `applicability` in the definition content and contract, registration check | domain/src/control-types.ts, new control-applicability.ts, contracts/src/sms.ts | none | Every registered type's digest is unchanged. Each fail-towards-applying case of section 3 gives `applies`. A test type in a test pack gives `does_not_apply` with no core change. Same inputs, same record digest. | — |
| 2 | The route avoidance area declares a reach | Built: the type stays version 1 and gains the optional reach; rule `area-reach` 1 with frozen definition and digest; kernel `corridorBound` export | control-type-library.ts, mission-avoidance-kernel.ts, area-reach-rule.ts | none | Calculation 1 digest and golden results are unchanged. Rule golden vectors: far, near, inside, at the reach ± 0.002 m, outside the profile, budget exhausted, no reach declared, hazard under review. | 1 |
| 3 | Route review records applicability; only applicable controls are candidates | Built: preview, context, release policy and record, controls list, briefing and issuance basis changed in place; limits 64/512; route suggestion avoids every considered area; minimal screen and simulator changes; verifier; tighter recorded clearance | mission-avoidance*.ts, mission-release*.ts, mission-release-controls.ts, mission-departure*.ts, mission-route-suggestion.ts, mission-route-planner.ts, area-reach-rule.ts, contracts, client, tools/verifier | **0076** | Whole-system test below (mission-controls.integration.test.ts). Unit tests of the split and the limits. A concurrency test of the lockWaitStarted shape for the redefined departure trigger. | 2 |
| 4 | Screens explain controls that do not apply | Built: section 8. Re-record scenes whose screens change. | apps/web/src (listed in 8), tapes | none | Browser spec `control-applicability` shows the section, the sentences, the briefing line, the departure line and the map outline. `autopilot.spec.ts` passes. | 3 |
| 5 | Simulated day exercises applicability | Built: far controls with a reach accepted by the simulated day through the public API, one released route, self-check | apps/simulator | none | `pnpm scenario` gives 19 of 19 self-checks. | 3 |
| 6 | Briefings end at boundaries that can matter to the flight | Built (section 7): briefing `valid_until` and release recheck use the narrowed boundaries. The lease is unchanged. | accepted-control-rules.ts, new mission-release-boundary.ts, mission-briefing.ts, mission-release.ts | none | A boundary of a not-applicable control leaves an existing briefing valid. A boundary of a candidate, or of a rule or person control, still ends it. | 3 |

**Whole-system acceptance test (phase 3, built in `tests/integration/mission-controls.integration.test.ts`).** An organization accepts 102 area controls, each with `appliesWithinMeters: 500`. 100 lie 20 km or more from the flight's route and 2 lie 300 m from it, all overlapping the operating interval. Route review shows 2 candidates, both `outside`, and 100 `notApplicable`, each with `clearanceAtLeastMeters` ≥ 19 000 and rule `area-reach` 1. The release records them. One briefing lists the 2 and fits 128 KiB. Departure readiness asks for exactly those 2, and an acknowledged briefing listing them satisfies it. The controls list shows all 102.

**Detour (ruling 8, in the same test).** Mission revision 2 moves the route to 200 m from one of the 100. Route review now has 3 candidates, the new one with "comes within 500 m".

- The release of revision 1 reads `changed` (`mission_changed`). A new release is needed, and the route must be `outside` all 3.
- The old briefing names the old release, so readiness refuses it. A new briefing lists 3.
- A permit issued before is bound to revision 1's exact mission. It cannot be consumed for revision 2's route, and it expired within 30 seconds anyway.
- Every earlier record stays valid as history and verifies unchanged.

## 11. Risks and the owner's questions

Risks:

- **Rule code drifting behind its digest.** Golden vectors per rule version; see section 5.
- **Briefing size.** Resolved in phase 3: controls that do not apply are compact entries in the list's second part, and a briefing may be 1 MiB; at the 512 bound one measured 311 718 bytes.
- **One-time conflicts at deployment.** The controls-list digest version changes, so a command prepared on seen 1 gets `flight_controls_changed` once and is re-read.
- **People reading a reach as a centre distance.** The form says "from the edge of the area"; the wording repeats it.

Questions only the owner can answer:

1. **Is the reach measured from the area's edge or its centre?** Recommend the edge, since it reads like the circle's own words. Default if unanswered: edge.
2. **What considered bound?** Recommend 512. Default: 512.
3. **What happens to a control that would not apply, but whose hazard assessment has changed since it was accepted (`review_required`)?** Two positions:
   - *It still does not apply.* Record and show it, but do not count it. Its accepted version stays the rule until a person signs again (controls-as-rules.md section 2).
   - *It applies until a person signs again* (the reviewer's recommendation). The reach was attested against the earlier assessment; once that assessment has changed, the reach is in question, and every other doubtful case in this note fails towards applying. The evaluator would add one more row to its table: hazard under review, applies, `basis: 'under_review'`. The control then behaves as a candidate does today, which for `review_required` means the release waits for a person.

   Default if unanswered: it applies until a person signs again.
4. **Should the control page invite a person to declare a reach on existing area controls?** Recommend one neutral line on version 1 area controls: "This control declares no reach, so it applies to every flight in its interval." Default: no line.

## 12. What this note does not change

- Which controls are in force (controls-as-rules.md section 2) and the accepted-controls pack.
- Rule controls and their subject scoping.
- The avoidance calculation version 1.
- Briefing coverage: one briefing may cover several controls (7b).
- The departure lease and permit version 1.
- The lock order.
- The register.
- Every existing record version and digest.
- Described-measure controls. They can never declare a rule and always apply.
- Nothing is blocked or allowed automatically: a person still releases, briefs and authorizes.
