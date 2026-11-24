# Observed values in regulatory rules

Status: built; section 6 adds the operator's own flight record; section 7 the flown values a logbook row holds. Builds on the observation vocabulary (`observation-vocabulary.md`), the adapter contract (`docs/guides/write-an-adapter.md`), related reads (`fan-out-and-related-reads.md`) and rule coverage (`rule-coverage.md`).

Rules about height, speed, place and airspace authorization used to read only what the operator planned. An operator with the aircraft and the airspace service connected got no regulatory check from what they reported. This note says which reported values bear on such a rule, exactly what each one measures, and how a rule reads them beside the plan.

## 1. What the adapters report

| Source | Adapter | Observation | Value | What it measures |
| --- | --- | --- | --- | --- |
| Aircraft telemetry (periodic state message) | position adapter (`dji-osd-position.ts`) | `position.fix@1` about the aircraft | `position.latitudeDegrees`, `longitudeDegrees` | Where the aircraft reported itself, WGS84. |
| | | | `position.altitude` `{ meters, datum: wgs84_ellipsoid }` | Height above the WGS84 ellipsoid, as the source documents it. Not height above the takeoff point, the ground or mean sea level. |
| | | | `values.groundSpeedMetersPerSecond` | The aircraft's horizontal speed over the ground, as it reported it. |
| | | | `values.fix: unknown` | The message carries no fix quality. |
| Airspace service (authorization records of an operation) | authorization adapter (`airspace-authorization.ts`) | `airspace.authorization@1` about the flight the operation was requested for | `values.authorizationId`, `reportedStatus`, `sourceStatusCode` | The issuing party's statement of the authorization's status, at `occurredAt` (when the record was last updated). |
| | | | `interval` | The start and end of the time the authorization covers. |
| | | | `values.ceiling` `{ meters, datum: ground_level }` | The highest height above ground level it covers (the source states feet; the adapter converts). |
| | | | `values.area.boundary` | The outer boundary of the area it covers, WGS84 corners in order. |

`values.area` is new on `airspace.authorization@1`; no other observation changed. Before this note the airspace service's records were kept only as the older `airspace.status` input, which no checked rule reads. Each poll of an operation's authorizations now also yields one observation per authorization.

Nothing an adapter reports today states the control station's position, a height above ground level from the aircraft, or the aircraft's height above its takeoff point. Another adapter may report a `takeoff_point` or `ground_level` height; the rules below read it when one does.

## 2. Which flight the values belong to

The flight plan (`flight.plan@1` operator record) names the aircraft as its secondary subject and states the planned window (`windowStartsAt` to `windowEndsAt`). A rule about a flight reads, as the flight's **flown values**, the aircraft's `position.fix` observations whose time falls in the planned window: a read about the related aircraft, `within` the plan's window. A plan that names no aircraft has no flown values (`whenNone: empty`, below). A flight flown outside its planned window is therefore read on its plan; the result says so.

## 3. Planned or flown

A rule about height, speed, place or the operating area reads the **flown** value when the flight's flown values are on record, and the **planned** value otherwise. The check kind `value.flown-or-planned@1` does this for a value and a limit:

- The plan's planned value (for example `plannedMaxHeightAboveGroundMeters`) is the planned value. It describes itself in words the rule gives ("the planned maximum height above ground level").
- Each flown observation is read through the rule's `measures`: conditions on the observation, the words for what it measures, and whether the rule compares it with its limit. Height measures: a `ground_level` height is "the flown height above ground level", a `takeoff_point` height "the flown height above the takeoff point"; both are compared with a limit above ground level, and the result names which it read. An ellipsoid, mean-sea-level or unknown height is never compared with such a limit: it is named and counted, and the result rests on the plan.
- With flown values the result is the worst flown value against the limit: within it passes, beyond it needs attention, whatever the plan said. A plan within the limit and a flown value beyond it needs attention once the flown value arrives, and the summary says both.
- With none, the result is the operator's own recorded value when the rule reads one (section 6), and otherwise the plan against the limit; it says that no flown value is reported (or that those reported state a measure the rule does not compare). A flight without telemetry is never left pending for want of it.
- Every result says which it read, in its summary and as data: details `basis` (`flown`, `recorded` or `planned`), `measured` (the words), `value`, `valueAt`, `plannedValue`, `recordedValue`, `limit`, `margin`, `flownValues`, `flownNotCompared`, and `reading`, the sentence a rule's wording can quote.

The plan is read as soon as it is recorded: every read of the plan, and of records made for the planned window, declares `plans: true`, so a flight planned for next week is checked on its plan the day it is planned. The flown read does not: it reads what has been reported. Before the flight the result rests on the plan and says so; once flown values arrive they are read instead.

A flight's flown read holds at most 500 positions, the page limit of every read. A flight with more in its planned window is `insufficient` (`input_limit_exceeded`) rather than read in part; dense telemetry over a long window needs that limit raised or the positions thinned, which this note does not do.

The operating area reads the flown positions against the area with `position.in-area@2`, `coverage: optional`. A plan states no path, so a flight with no positions in its window does not have this rule apply, and the result says the plan states no path to place.

The airspace authorization check, `authorization.covers-flight@1`, reads the same flown positions and the plan:

- The flight's time is from its first to its last flown position, or the planned window. Its height is the highest compared flown height, or the planned maximum height. Its place is the flown positions; the plan states no place, so with no flown positions the place is not compared and the result says so.
- For each authorization on record about the flight, the status it read is the latest report made by the end of the flight's time (a later report, such as closing the authorization after landing, does not change what held during the flight).
- One reported approved, covering the flight's time, with every flown position inside its area and a ceiling at or above the height read, supports the rule, and the result names it.
- Otherwise each authorization on record is named with what it lacks: its status, an end before the flight's (expired), a start after it, positions outside its area (another place), a ceiling below the height read. That needs attention. One only requested, or of unknown status, is awaited (`pending`).
- None on record is "No airspace authorization on file" (a required read with `onFile`): never a finding, because an authorization may have been obtained another way, and whether the flight needed one is for a person.

## 4. When a reported value arrives

A position about the aircraft re-evaluates each flight whose current plan names that aircraft, through the queueing for related reads (`related-subject-queueing.ts`). The relation declares `requeue` on the plan's window end with `endedWithinDays: 7`, so telemetry uploaded after the flight still re-evaluates it and an aircraft's older flights are not queued for every new position. An authorization about the flight queues the flight like any record about it.

`whenNone: empty` is new on a relation: when the from-read names no related subject, the reads about the relation are empty and the check runs, instead of the result being `insufficient` or `not_applicable`. It exists for reads that only add to what the target's own records support.

## 5. Where it applies

- Part 107 (current version, in place): § 107.51(a) ground speed and § 107.51(b) height read flown values; § 107.41 reads authorizations.
- The Part 108 NPRM pack (version 3, in place): proposed § 108.175(a) height reads flown height; § 108.180(d)(1) reads authorizations; § 108.165(a) reads flown positions against a circle the organization sets on adoption as its approved operating area.
- The waiver library: `condition.max-height` reads flown height; `condition.operating-area` reads flown positions with a planned fallback; `condition.max-distance` reads the plan only and says why (no observation states the control station's position). Pack files built from text get the same rules through the obligation types.
- No check kind, rule or core file names a source or vendor. Which source reported a value is on the observation; the rule reads only the vocabulary.

## 6. A flight's times and flown height from the operator's own record

An operator with no connected aircraft keeps its flights in its own log. The `flight.record` operator record is that log entry: it carries `takeoffAt` and `landingAt` (both needed; a record whose landing is not after its takeoff is refused on import with a sentence naming both fields) and `maxHeightFlownAboveGroundMeters`. Its interval is takeoff to landing, so a read by time finds it at the flight, not at the day it was typed in.

**The order of what a rule rests on.** A source's report is a statement by the aircraft or a service; the operator's record is the operator's statement. Neither is ever averaged with the other, and a rule never picks one without saying so.

| What | First | Then | Then |
| --- | --- | --- | --- |
| A flight's takeoff and landing times | the times the flight's `flight.report` observations state | the flight record's `takeoffAt`, `landingAt` | (none: the time is not on file) |
| A flight's flown height | the highest position whose height is above ground level (`ground_level`) | the flight record's `maxHeightFlownAboveGroundMeters` | a position height above the takeoff point (`takeoff_point`), then the plan |
| The time an airspace authorization must cover | the first to the last flown position | the flight record's takeoff to landing | the planned window |

Each time is chosen on its own: a report that states a takeoff and no landing gives the takeoff, and the flight record gives the landing; the result says which came from where. A height above the takeoff point ranks after the operator's figure because the operator records a height above the ground, which the limits are stated in; a height above the ellipsoid or mean sea level is never compared, as before.

**The sentence for each case.**

- Height read from positions: "Read the flown height above ground level: of N value(s) on record for this flight, the highest is X m at T, within the limit (…)." When the flight record also states a height: "The maximum height flown above ground level in the operator's flight record is Y m, within (or beyond) the limit; the reported value is read, not the recorded one."
- Height read from the record: "No flown height is reported for this flight; the result rests on the operator's own record of the flight. Read the maximum height flown above ground level in the operator's flight record: Y m, within the limit (…)." Details `basis: recorded`.
- Neither: "No flown height is reported for this flight; the result rests on the plan. No record of the flight as flown states a maximum height flown above ground level in the operator's flight record."
- Times (proposed § 108.40(a)(3)(i)): "On file for this flight, from the operator's flight record: takeoff T1, landing T2, a duration of N minutes." From reports: "…, from the flight's reports: …". Neither: "No takeoff or landing on file for this flight in the flight's reports or the operator's flight record."

**When a report and the record differ.** The reported value is read, and the result names the record's value beside it in the same sentence, with the words "which differs". Nothing becomes a conflict for that alone: an operator's log is commonly rounded to the minute, and a person reading the result sees both figures. Reports of one flight that disagree with each other, or flight records of one flight that disagree with each other, are a conflict, as before.

- Per-flight rules (`values.on-file@1`): "The landing in the operator's flight record is T, which differs; the one in the flight's reports is read." Details `differing` counts them.
- The aircraft's total time in service (`total.from-opening@1` with `recordedStartField`, `recordedEndField`): a flight record whose time overlaps a reported flight of the same aircraft is the same flight, counted once from the report. The result counts the flights read from records (`recordedAdditionCount`) and the records whose times differ from the report counted instead (`recordedDiffering`), and names those records.
- The exposure kinds (`exposure.flight-hours`, `exposure.flights`, `exposure.covered-flight-hours`): a flight's reported time is counted, else its flight record's; they report no difference, since an indicator states totals. The per-flight rule above is where a person reads a flight's two figures.

**Where it applies.** Part 107 § 107.51(b) height and § 107.41 airspace authorization; Part 108 proposed § 108.175(a) height, § 108.180(d)(1) airspace authorization, § 108.40(a)(1) total time in service and one rule for each of § 108.40(a)(3)(i), (ii), (iii), (v) and (vi); the waiver library's `condition.max-height`; the three flight exposure kinds. The items of § 108.40(a)(3) other than the times are read for a flight that has a flight record: a planned flight with no record of having been flown has none of them on file.

## 7. Wind, visibility and battery from the operator's own record

An operator with no aircraft or site reporting to Ledger keeps wind at launch, visibility and battery remaining at landing in its flight log. The `flight.record` operator record carries them, each with the import's unit handling (a unit in the heading or in the cell, kept as entered):

| Field | What it holds |
| --- | --- |
| `windAtTakeoffMetersPerSecond` | the wind the operator recorded at takeoff |
| `gustAtTakeoffMetersPerSecond` | the gust the operator recorded at takeoff |
| `visibilityAtTakeoffMeters` | the visibility the operator recorded at takeoff |
| `batteryAtLandingPercent` | the battery remaining the operator recorded at landing, in percent |

**The one rule for a flown value.** A rule reads what a source reported for the flight if a source reported it, and else the value in the operator's flight record; the sentence says which it read. The two are never averaged. When both are on record the reported value is read and the sentence names the recorded value beside it.

| What | First | Then |
| --- | --- | --- |
| A flight's takeoff and landing, which place the values | the flight's `flight.report` | the flight record's `takeoffAt`, `landingAt` |
| Wind and gust at takeoff | the measured `weather.wind` at the flight's site last reported at or before the reported takeoff | the flight record's `windAtTakeoffMetersPerSecond`, `gustAtTakeoffMetersPerSecond` |
| Wind for the whole flight | every measured `weather.wind` at the site from the reported takeoff to the landing | the flight record's wind at takeoff, the one value it holds |
| Battery at landing | the aircraft's `battery.state` last reported at or before the reported landing | the flight record's `batteryAtLandingPercent` |
| Battery for the whole flight | every `battery.state` of the aircraft from the reported takeoff to the landing | the flight record's battery at landing, the one value it holds |
| Visibility at takeoff | (no source reports visibility today) | the flight record's `visibilityAtTakeoffMeters`, then the latest preflight assessment's `visibilityMeters` |

`window.values-within-limit@1` does this for a value over a window. A rule gives it the operator's record as the optional `recorded` input, with the field that holds the value, the field that says when it applies (takeoff or landing), and the record's takeoff and landing fields. When the flight's reports state no window, the window is the record's. When no reported value falls in the window, the recorded value is compared with the limit at the time it applies, and a value outside the limit is one issue, named and timed like a reported run. Details `basis` (`reported` or `recorded`) and `recordedValue` say which was read.

**The sentences.**

- Read from the record: "No measured wind at the site is reported; the result rests on the operator's own record. Read the wind at takeoff in the operator's flight record: 13.38 m/s, outside the limit, at most 11 m/s."
- Read from a report, with the record beside it: "1 value(s) of Wind speed in the window from … are at most 11 m/s; the worst is 6 m/s at …. The wind at takeoff in the operator's flight record is 13 m/s; the reported value is read, not the recorded one." A rule's own wording ends with `{recordedNote}`, which is that last sentence, or nothing when no record states the value.
- Neither: "No value is reported for Wind speed in the window from …. The wind at takeoff in the operator's flight record is not on file either."
- No report and no record of the flight as flown: the rule does not apply yet ("Neither a report nor the operator's own record states when it happened, …").

A flight with no report and no record of having been flown is not yet flown: these rules do not apply to it. A rule that reads a report's activity (active or landed) applies when no report is on record at all (`whenAbsent: applies`), so a flight known only from the operator's record is read.

**Where it applies.** The waiver library's `weather.wind-at-takeoff`, `weather.gust-at-takeoff`, `weather.visibility-at-takeoff` and `condition.battery-at-landing`; the `ledger.example-weather` rules at takeoff and for the flight; the `ledger.example-operations` rules at landing and for the flight. A pack file names these obligation types, or writes a rule with the same kind and reads, and a wind limit or a battery reserve is checked from the operator's record alone.
