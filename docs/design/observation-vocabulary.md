# Observation vocabulary, version 1

Status: accepted, with the reviewer's rulings applied (see Decisions). Schemas: `packages/contracts/src/observations/`. Tests: `packages/contracts/tests/observations.test.ts`.

## Purpose

Adapters translate what a source sends into **observations**. Rules read observations only, never a source's field names. A new source then means a new adapter; a new kind of fact means a new observation type (or a new version of one). This note defines the types, the envelope and the registry. It wires nothing: intake, the adapter contract, the evaluator and operator records build on it. The existing input kinds are unchanged.

## Envelope

Every observation is one closed JSON object (unknown properties are rejected at every level):

| Field | Required | Meaning |
| --- | --- | --- |
| `type`, `version` | yes | `domain.noun` id and integer version, e.g. `battery.state`, `1`. Together they select the schema. |
| `subject` | yes | `{ kind, id, scope }`. `kind` is one of flight, aircraft, person, site, organization, component (a physical part with its own identity, such as a battery pack or a life-limited part); each type lists the kinds it accepts. `scope` is `ledger` (the id is a Ledger id the adapter is bound to) or `source` (the source's own id). Intake resolves a source-scoped subject to a Ledger subject through aliases and retains both. |
| `secondarySubject` | no | Same shape, e.g. the aircraft on a flight-scoped link report, or the organization of a duty period. |
| `occurredAt` | yes | UTC instant (`Z`, at most millisecond precision). Meaning depends on the type's timing (below). |
| `interval` | interval types | Half-open `[start, end)`. `end` may be absent: the interval is still in effect as of `occurredAt`, as far as the source has said. Not allowed on instant and event types. |
| `position` | no (required by `position.fix`) | `latitudeDegrees`, `longitudeDegrees` (WGS84), optional `altitude: { meters, datum }`. `datum` is one of `wgs84_ellipsoid`, `mean_sea_level`, `takeoff_point`, `ground_level`, `unknown`; an altitude without a datum is rejected. |
| `sourceEventId`, `sourceSessionId` | no | The source's own event and session identity, when it has them. Intake uses them for idempotency. |
| `fidelity` | yes | Existing `FidelitySchema` values. |
| `limitations` | yes (may be empty) | Plain strings, at most 20. |
| `originalArtifactId` | yes | The retained original bytes this observation was derived from. For hand-entered records the retained bytes are the submitted payload. |
| `originalLocator` | no | Where in that original the observation came from, when one original yields many: `{ kind: 'json_pointer', value: '/a/2' }` (RFC 6901) or `{ kind: 'byte_range', value: { offsetBytes, lengthBytes } }`. |
| `values` | yes | The type's closed value object. |

Not in the observation: receipt time and the authenticated `sourceId`. Ledger records both at intake, as today.

**Timing.** `instant`: a state that held at `occurredAt` (a sample). `event`: something the source says happened at `occurredAt`. `interval`: a state over `interval`; `occurredAt` is when the source made the statement.

**Units.** Every numeric field name ends in its unit: `Meters`, `MetersPerSecond`, `Percent` (0 to 100), `Degrees`, `Volts`, `Celsius`, `Seconds`, `Hours` (decimal hours as recorded; used by operator records for time in service, life limits, experience and duty totals, see `operator-records.md`), `Count`, `Index`, `Bytes`. The only exceptions are `altitude.meters` (the unit is the whole name) and version integers. A test walks every schema and fails on a numeric field that breaks this. I chose names over a `units` field because a rule then cannot read a number without seeing its unit, and the schema can bound each value in that unit. Times are always UTC strings ending in `At`, or `interval.start`/`end`. Durations from sources (e.g. "duration in minutes") are converted by the adapter into an interval end.

**Naming.** Type ids are lowercase `domain.noun` (hyphens allowed inside a segment). No vendor name appears in any type id, field name, description or inference statement; a test enforces this with a word list.

## Version 1 types

"May not infer" statements are part of each type's definition (`mayNotInfer` in code) so the evaluator and pack authors can read them.

| Type | Timing | Subjects (secondary) | Required values | Optional values |
| --- | --- | --- | --- | --- |
| `link.status` | instant | flight, aircraft (same) | `link` (command_control, video, payload_data), `state` (up, degraded, down, unknown), `report` (transition, sample) | `sourceEpisodeId`, `signalQualityPercent` |
| `battery.state` | instant | aircraft, flight (aircraft, flight, component) | `totalRemainingPercent` | `packs[]` {`serialNumber`, `slotIndex`, `remainingPercent`, `voltageVolts`, `temperatureCelsius`}, `forcedLandingRemainingPercent`, `returnHomeRemainingPercent`, `remainingFlightTimeSeconds`, `lowWarningThresholdPercent`, `criticalWarningThresholdPercent` |
| `position.fix` | instant | aircraft, flight, person (same) | envelope `position`, `fix` (none, two_dimensional, three_dimensional, differential, rtk_float, rtk_fixed, unknown) | `method`, `satelliteCount`, `horizontalAccuracyMeters`, `verticalAccuracyMeters`, `groundSpeedMetersPerSecond`, `verticalSpeedMetersPerSecond`, `courseDegrees` |
| `weather.wind` | instant | flight, aircraft, site (same) | `method` (measured, estimated, forecast), `speedMetersPerSecond` | `gustSpeedMetersPerSecond`, `directionFromDegrees`, `directionVariable` (true), `directionVariesFromDegrees`, `directionVariesToDegrees`, `heightAboveGroundMeters` |
| `weather.visibility` | instant | flight, aircraft, site (same) | `method` (observed, forecast), `visibilityMeters`, `bound` (stated, at_least, less_than) | — |
| `airspace.authorization` | interval (optional) | flight, organization (same) | `authorizationId`, `reportedStatus` (requested, approved, denied, cancelled, rescinded, revoked, expired, invalid, unknown) | `sourceStatusCode` (verbatim), `ceiling` (altitude with datum), `area` (`boundary`: the outer boundary's corners) |
| `flight.report` | event | flight (aircraft, person) | at least one of the optional values | `activity` (planned, active, landed, cancelled), `takeoffAt`, `landingAt` |
| `traffic.alert` | event | flight, aircraft (same) | `level` (advisory, caution, warning, unknown) | `detection`, `intruderKind`, `intruderIdentity`, `intruderPosition`, `horizontalSeparationMeters`, `verticalSeparationMeters` |
| `aircraft.fault` | event | aircraft, flight (aircraft, flight, component) | `change` (raised, cleared), `severity`, `system`, `sourceFaultCode` | `summary` |
| `crew.duty-period` | interval (required) | person (organization, flight) | `period` (duty, flight_duty, rest) | `role` |
| `operator.record` | interval (optional) | all six (all six) | `recordType`, `recordVersion`, `record` | — |
| `organization.record-in-force` | interval (required) | organization (none) | `recordKind` (document, risk_matrix, hazard, assurance), `recordId`, `purposes` | `decisionId`, `title`, `revision`, `riskAssessed`, `riskAccepted`, `item`, `assuranceType`, `recordClass`, `actionId`, `dueAt` |

What a rule may and may not infer (abridged; the full list is in code):

- **link.status**: may read the reported state at `occurredAt`; a down/up transition pair with the same `sourceEpisodeId` bounds one reported loss. May not: treat absence of a link-status observation as evidence the link was up; treat an `up` sample as covering the time since the last sample; treat `unknown` as `down`; close a loss with an `up` that carries no matching episode id.
- **battery.state**: may compare reported charge with thresholds in the same observation or in the rule. May not: treat percentages as measured energy (they are the aircraft's state-of-charge estimate); treat user-set thresholds as manufacturer or regulatory minimums; treat the forced-landing or return-home level or the remaining flight time as fixed (the aircraft recomputes them); treat absent voltage or temperature as normal; interpolate between samples.
- **position.fix**: may place the subject at the position; may compare altitude with a limit only when datums match. May not: rely on a `none`/`unknown` fix; read absent accuracy as good; compare an `unknown`-datum altitude with anything; infer the path, or packet loss, from gaps.
- **weather.wind**: may read the wind obtained by the stated method. May not: treat an estimated value as a measurement, a forecast as an observation, an aircraft-estimated wind as ground or site wind, absent gusts as no gusts, absence of wind observations as calm, or an absent direction as calm or variable (only `directionVariable` says the source reported a variable direction). A direction range (`directionVariesFromDegrees` clockwise to `directionVariesToDegrees`) says only between which directions the source reported the wind varying.
- **weather.visibility**: may read the visibility obtained by the stated method; with `bound` `at_least` or `less_than` only that the visibility was at least or below the value. May not: treat a bound as the visibility itself, a forecast as an observation, the visibility reported for a place as the visibility from a control station or along a flight path, or absence of visibility observations as good visibility. A source that reports for a place some distance away (a weather station for a site) says so in the observation's limitations, with the distance when the configuration states it.
- **airspace.authorization**: may read the status the issuing party reported (`reportedStatus` is that party's statement, never a Ledger result) and whether an instant falls inside a reported interval that has an end. May not: treat a reported approval as legal clearance; place a status without an interval anywhere but `occurredAt`; prefer the later of two disagreeing reports silently; read `unknown` as either outcome.
- **flight.report**: may read the reporter's activity and times; two different `landingAt` values for one flight disagree. May not: use `occurredAt` as the landing time; get a landing time from `activity: landed` alone; average or pick the most recent of disagreeing times; treat absence of a landing report as still airborne.
- **traffic.alert**: may read that an alert of this level was raised. May not: treat an alert as lost separation; treat separation values as measured; treat absence of alerts as absence of traffic (coverage is not stated by this type).
- **aircraft.fault**: may read the raised/cleared fault with its severity and system. May not: treat source severity as an airworthiness finding; treat `cleared` as repaired; match on `sourceFaultCode` at all (rules read the normalised `system` and `severity`, which the adapter maps from source codes; the code is kept for people); treat absence of faults as healthy.
- **crew.duty-period**: may read the recorded period. May not: treat an absent `end` as still on duty; treat gaps as rest; treat scheduled or self-reported periods as recorded (fidelity and limitations say which).
- **organization.record-in-force**: Ledger's own statement, from its decisions, that a controlled document revision, risk matrix version, hazard, signed safety assurance record or open action it set was on file over the interval ([on-file-checks.md](on-file-checks.md), [assurance-records.md](assurance-records.md)). May not: read anything about the record's content; treat an absent end as staying in force; read a hazard count as a judgment of severity.
- **operator.record**: may read only records whose `recordType@recordVersion` is registered. May not: treat a record as independent verification.

## Operator records

`operator.record` is a carrier. `values.recordType` (a `domain.noun` id) and `values.recordVersion` name a record type registered with `registerOperatorRecordType`. Validation is two steps: the envelope against `operator.record@1`, then `values.record` against the registered record schema. A record type states its own subject kinds and inferences. Operator records ([operator-records.md](operator-records.md)) add concrete record types; it should not need a new carrier version unless the envelope changes.

## Registry

`packages/contracts/src/observations/registry.ts`: a frozen plain object `{ types, recordTypes }` keyed `type@version`, plus pure functions: `registerObservationType` and `registerOperatorRecordType` (return a new registry; throw on a duplicate key, a malformed id or a non-positive version), `findObservationType`, `findOperatorRecordType`, `listObservationTypes`. `observationRegistryV1` holds the twelve built-in types. `ObservationHeaderSchema` validates only `type` and `version`, so intake can find the schema before validating the whole observation. Compiling schemas stays with callers (adapters and API already use Ajv); contracts stays dependency-free apart from TypeBox.

## Evolution

A published `type@version` is never edited structurally. Any structural change, including adding an optional field, is a new version registered beside the old one; adapters may emit either, and rules declare which versions they read. The test `never edits the structure of a published version` pins a digest of each v1 definition's structure (id, version, timing, subject kinds and the schema with `description` and `title` removed); wording, including the inference statements, can be corrected without a new version. Removing a version is out of scope for v1. Before Ledger had users, `airspace.authorization@1` gained the optional `area` in place, and its pinned digest moved with it ([observed-values.md](observed-values.md)); `weather.wind@1` gained `directionVariable` and the direction range in place the same way, for published weather reports, which state a variable direction (`VRB`) and the range a direction varied over (`010V080`).

## Mapping of today's inputs

**`flight.observation` → `flight.report@1`**

| Today | Vocabulary | Notes |
| --- | --- | --- |
| `subject.flightId` | `subject {flight, scope: ledger}` | |
| `subject.originationKey` / `externalFlightId` | `subject {flight, scope: source}` | Intake resolves it as today. |
| `subject.orderId` | — | Does not fit: orders are not a subject kind. |
| `occurredAt` | `occurredAt` | |
| `payload.activity` / `state` / `phase` | `values.activity` | Three aliases become one field. The adapter maps source words (`departed`, `airborne` → `active`); unknown words are rejected by the adapter, not passed through. |
| `payload.landingTime` / `landedAt` | `values.landingAt` | Two aliases become one; must be UTC `Z`. Today an invalid time is kept and reported as invalid; under the vocabulary it is rejected at the adapter. |
| `payload.title` | — | Does not fit: presentation text, not a fact. |
| `artifactId`, `fidelity`, `sourceSessionId` | `originalArtifactId`, `fidelity`, `sourceSessionId` | Today `artifactId` and `fidelity` are optional. |

**`airspace.status` → `airspace.authorization@1`**

| Today | Vocabulary | Notes |
| --- | --- | --- |
| `subject.originationKey` | `subject {flight, scope: source}` | |
| `payload.authorizationId` | `values.authorizationId` | |
| `payload.status` (source codes such as `STATUS_DENIED`) | `values.reportedStatus` + `values.sourceStatusCode` | The code-to-status table now in `packages/domain/src/rules/authorization-evidence-v1.ts` (`nonapprovalStatuses`) moves into the adapter, so the rule stops naming source codes. |
| `authorizationRecord.startTime` / `endTime` | `interval.start` / `end` | |
| `callback.startTime` + `callback.duration` (minutes) | `interval.start` / `end` | The adapter computes `end`. |
| `occurredAt` (record update time or callback status date) | `occurredAt` | |
| `payload.operationId`, the declared schema fields, full `authorizationRecord` / `callback` | — | Stay in the original bytes. The declared schema belongs to source capability, not to an observation. |
| `payload.limitations` (callback) | `limitations` | |

**`command-link.status` and `command-link.baseline` → `link.status@1`** (`link: command_control`)

| Today | Vocabulary |
| --- | --- |
| `subject.flightId` | `subject {flight, scope: ledger}` |
| `payload.aircraftId` | `secondarySubject {aircraft, scope: source}` |
| `occurredAt`, `sourceSessionId`, `payload.sourceEventId` | same names in the envelope |
| `payload.incidentId` | `values.sourceEpisodeId` |
| `payload.status` `lost` / `restored` | `state: down` / `up`, `report: transition` |
| baseline `state` `up` / `down` / `unknown` | `state`, `report: sample` |
| `payload.position {longitude, latitude}` | `position {longitudeDegrees, latitudeDegrees}` |
| `artifactId`, `fidelity` | `originalArtifactId`, `fidelity` |

Does not fit: the baseline's rules (first accepted record of an unused session, permanently bound to one flight and aircraft, shared event-id namespace) are intake and evidence rules, not vocabulary; they stay with intake and the command-link rule.

**Telemetry decoded by `packages/adapters/src/dji-osd.ts` → `position.fix@1`**, one observation per sample:

| Decoded field | Vocabulary | Notes |
| --- | --- | --- |
| source `timestamp` (Unix ms) → `occurredAt` | `occurredAt` | |
| `latitude`, `longitude` | `position.latitudeDegrees`, `longitudeDegrees` | |
| `altitudeMeters` + `altitudeReference` | `position.altitude {meters, datum}` | `ellipsoid` → `wgs84_ellipsoid`; `relative` → `takeoff_point` only if the source says relative to takeoff, else `unknown`; `null` altitude → no `altitude`. |
| `speedMetersPerSecond` (source horizontal speed) | `values.groundSpeedMetersPerSecond` | |
| — | `values.fix` | The decoder reads no fix quality, so the adapter sends `unknown`. |
| device id | `subject {aircraft, scope: source}` | |
| `sequence` (adapter capture order) | — | Does not fit: not source identity. The source's transaction id is a better `sourceEventId`. |
| `original.topic` / `bytesBase64` | `originalArtifactId` + `originalLocator` | One segment artifact holds up to 120 samples; the locator points at the sample. |
| `DJI_LIMITATIONS` | `limitations` | The text must be reworded without the vendor name. |

**Realism check (battery and wind).** A common vendor's aircraft state message publishes: total remaining charge as a percentage; per pack a percentage and a serial number; the charge at which the aircraft will land on its own; user-set low and critical warning percentages; and an estimated wind speed (with a direction code). Voltage and temperature are not always present. `battery.state@1` fits all of these: only `totalRemainingPercent` is required, packs are keyed by `serialNumber`, voltage and temperature are optional, and the thresholds are explicitly user settings. The same message also publishes a return-to-home charge level and remaining flight time; both are optional fields in v1. The wind value fits `weather.wind@1` with `method: estimated`; its direction is a coarse sector code, which an adapter can convert to degrees only with stated loss (or leave out).

## Decisions

Recorded from the review of this note.

1. Subjects keep `scope` (`ledger` or `source`); intake resolves source-scoped subjects through aliases and retains both.
2. `component` is a subject kind now. Per-pack battery values stay in `packs[]`; a pack serial there is the same identity a `component` subject uses.
3. `sourceId` and receipt time stay out of the observation.
4. `originalArtifactId` stays required; `originalLocator` (JSON pointer or byte range) is optional.
5. An absent `interval.end` means still in effect as of `occurredAt`.
6. The interval is optional on `airspace.authorization` and `operator.record`, required on `crew.duty-period`.
7. The source's status words stay, in a field named `reportedStatus`, described as the issuing party's statement, not a Ledger result.
8. `battery.state` gains optional `returnHomeRemainingPercent` and `remainingFlightTimeSeconds`.
9. Rules never match on `sourceFaultCode`; they read `system` and `severity`, which the adapter maps.
10. `position.fix` requires `fix`, with an explicit `unknown`.
11. The version pin covers structure only, not wording.
12. Orders are not a subject kind.
13. `fidelityValues` and `FidelitySchema` live in `packages/contracts/src/fidelity.ts`, re-exported unchanged.

## For later work

- Intake: check that `interval.start` is before `interval.end` (the schema cannot).
- The evaluator: move the source status-code table in `authorization-evidence-v1.ts` into the adapter, and switch the rule-pack bindings in `rule-packs.ts` from payload field names to `type@version`.
- The vendor-named limitation strings in the telemetry decoder must be reworded before they become observation `limitations`.

## Reading by time: recorded, about, and plans

### How a read selects records today

A rule's read selects records on three clocks at once. All three are in `gatherInputs` and `readMatching` (`packages/domain/src/rule-evaluations.ts`), which call `listObservations` (`packages/domain/src/observations.ts`).

1. **By recorded time: the evidence cut.** An evaluation reads only what was recorded inside the subject's accepted input cut (`subjectCut`): the journal stream positions of the organization, the subject and, for a source identity, every stream naming it. `listObservations` keeps an observation only when its journal event, and any replacement or withdrawal of it, lies inside that cut (`inCut`, option `evidenceCut`). This is what makes an evaluation repeatable: the same cut gives the same records.
2. **By the time the record is about: its span start.** Every observation has a span start, `COALESCE(interval_start, occurred_at)` (the generated column `span_start`, migration 0048): the start of the interval it is about, or the instant it states. `gatherInputs` reads up to `to = min(evaluatedAt, bound) + 1 ms`, and `listObservations` keeps `span_start < to`. So a read sees only records about a time that has begun by the evaluation instant. `bound` is the anchor of a `latestAtOrBefore` read or the end of a `within` window (`readUpperBound` in `packages/domain/src/checked-rules.ts`), which only narrows it further.
3. **By window overlap.** A `within` read starts at its window's start (`readWindow`); any other read starts at 1970. `listObservations` keeps a record whose interval ends after `from` (`interval_end > from`), or with no end, whose `GREATEST(occurred_at, span_start) >= from`: a record that overlaps the window, or a statement made inside it. `narrowRead` then keeps span starts inside `[start, bound]`, newest first, and a `latest` read keeps those sharing the newest span start.

**Where a record about a later window is left out.** A record whose span starts after the evaluation instant (a planned flight window tomorrow, a duty period next week) fails `span_start < to` in step 2, however long ago it was recorded. Recording it queues the rules that read its type (`queueRuleEvaluationsForObservation`), but the evaluation they run does not read it. A `within` read whose window (named by another record) starts after the evaluation instant reads nothing at all: `from >= to` in `gatherInputs`. Nothing schedules a later evaluation at the record's start either: `recordEvaluation` queues a deadline only for the `nextBoundary` a check returns. So the record is read the next time something else causes an evaluation after its start. The rules demo scene opens its flight window a minute in the past for this reason.

Indicators place what they count by their own times: a finding by when it opened (`eventPlacement` in `packages/domain/src/indicators.ts`, from `readFindings` in `indicator-gathering.ts`), an issue by the time its check gives it or else by the evaluation that first named it (`issueEvents`).

### The choice: a read may declare that it reads plans

Reading by recorded time stays the rule: every read is bounded by the evidence cut. What a read is about stays bounded by the evaluation instant, except where the rule says otherwise, as data:

- A read may set `plans: true` (`RuleReadSchema`, `packages/contracts/src/checked-rules.ts`). Its upper bound is then the anchor or window end alone, not the evaluation instant: a record whose span starts later is read as soon as it is recorded and inside the cut. A `within` read with `plans` reads a window that has not started yet. Everything else about the read (cut, conditions, selection, window start) is unchanged.
- It is optional and absent by default. Rule digests are computed over the leaf as written, so no shipped leaf or pack digest moves, and every existing read selects exactly what it did.
- An evaluation that read such records says so. `readAsPlans` on the evaluation record (`RuleEvaluationRecordSchema`, `packages/contracts/src/rule-evaluations.ts`) lists the observations a plans read took whose span started after the evaluation instant, and `from`, the earliest of those starts. The finding's explanation carries it and the card says that the record was read as a plan, about a time that had not come. A finding on a plan therefore reads as what it is.
- `readAsPlans` is derived from the observation ids read and the evaluation instant. It is not part of the observation digest. When the plan's time comes, the rule reads the same observations, so an evaluation that runs then finds the same inputs and records nothing new (`recordEvaluation` returns early). The finding's history stays one line of evaluations and one finding; the plan is never counted twice.
- A plan withdrawn, replaced or corrected before its window re-evaluates like any correction (`queueRuleEvaluationsForCorrection`): the next evaluation reads the current records, and `readAsPlans` follows them.
- Indicators place a finding opened on a plan at the start of the time the plan is about, not at the instant it opened: at the later of `openedAt` and `readAsPlans.from` of the finding's latest evaluation, or else of the evaluation that opened it. An issue placed by its evaluation (the check gave it no time) is placed the same way. A plan's finding is therefore never counted in a window the plan is not about. A finding that read no plans is placed exactly as before.

Which reads read plans is the rule's own declaration, never an option an author or organization sets. The Part 107 pack and the waiver library declare it on every read whose question is about a plan or a record made for a planned window (the flight plan, the remote pilot designated for the window, a notice given before the planned start, a preflight item recorded ahead), so a planned flight is checked as soon as its plan is recorded. Reads about what happened (an accident report, a completed training, a flown value) do not.
