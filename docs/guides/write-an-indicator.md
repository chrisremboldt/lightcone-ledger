# Write an indicator

An **indicator** measures how often something happens, relative to how much the operation did: command-link losses per flight hour, low-battery landings per 100 flights. A safety program uses indicators to judge whether its controls are working. In Ledger, a person makes that judgement; the indicator gives them a number and states plainly when the records cannot support one.

An indicator is a definition: data, pinned by digest, with no code of its own. It belongs with the pack whose rules it counts. This guide walks through the two kinds Ledger ships: the command-link losses per flight hour indicator, and the battery reserve indicators of the example operations pack.

## Terms

- **Events**: what the indicator counts. Findings of a rule, issues a rule's check named, or accepted observations of a type.
- **Issue**: one distinct thing a check named inside a result, such as one stretch of battery reports below the reserve on a flight. One flight can have several.
- **Exposure**: what the count is divided by, such as flight hours or flights. It is measured from accepted observations by an **exposure kind**.
- **Window**: the half-open period `[start, end)` the indicator covers.
- **Population**: the subjects in scope, such as the flights declared for the window.

## The two shipped examples

| Indicator | Where | Counts | Divided by |
| --- | --- | --- | --- |
| `demo-procedures.command-link-losses-per-flight-hour` | `packages/domain/src/rules/demo-command-link-indicator-v1.ts` | Issues of the lost-link rule: each loss episode once | `exposure.covered-flight-hours`: flight hours covered by command-link reports |
| `example-operations.low-reserve-landings-per-100-flights` | `packages/pack-example-operations/src/indicators.ts` | Findings of the landing rule: each flight once | `exposure.flights` |
| `example-operations.reserve-exceedances-per-flight-hour` | the same file | Issues of the whole-flight rule: each stretch below the reserve | `exposure.flight-hours` |

Start from the battery reserve file if your indicator counts a pack's own rules. It is 55 lines.

## 1. Choose what to count

Count **findings** when one finding per subject is the event you mean. The landing rule opens at most one finding per flight, so each low-reserve landing counts once however many reports or evaluations show it:

```ts
    events: { kind: 'findings', packId: EXAMPLE_OPERATIONS_PACK_ID, ruleId: BATTERY_AT_LANDING_LEAF_ID },
    exposure: { kind: 'exposure.flights', version: 1, params: {} },
    unit: { per: 100, label: 'per 100 flights', fractionDigits: 2 },
```

Count **issues** when one subject can have several events. The rule's check kind names each one (for example `window.values-within-limit@1` names each run outside the limit), and each counts once however many evaluations name it. Two stretches on one flight count as two:

```ts
    events: { kind: 'issues', packId: EXAMPLE_OPERATIONS_PACK_ID, ruleId: BATTERY_FOR_FLIGHT_LEAF_ID },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 2 },
```

With `countEach: 'subject'`, an issues indicator counts subjects with at least one issue instead. Count **observations** to count accepted observations of a type directly, with an optional condition.

Issues are read only from evaluations under an active adoption; an evaluation recorded in shadow names no issue an indicator counts.

## 2. Choose an exposure kind

Exposure kinds are pure, versioned code in `packages/domain/src/indicator-exposure-kinds.ts`. Each declares its source of truth and whether it can see gaps:

| Exposure kind | Measures | Source of truth |
| --- | --- | --- |
| `exposure.flight-hours@1` | takeoff-to-landing hours inside the window | `flight.report` takeoff and landing times, else the `flight.record` operator record's |
| `exposure.flights@1` | flights that took off inside the window | `flight.report` takeoff times, else the `flight.record` operator record's |
| `exposure.covered-flight-hours@1` | flight hours during which a declared observation type kept arriving | `flight.report` (else `flight.record`) times and the declared type |
| `exposure.observation-count@1` | accepted observations of a declared type | that type |
| `exposure.duty-period-count@1`, `exposure.duty-hours@1` | duty periods, duty hours | duty period records |
| `exposure.time-in-service-hours@1` | aircraft time in service | time-in-service records |

An exposure kind never guesses. Each of a flight's takeoff and landing times is read from its reports where one states it, and from the operator's flight record otherwise; the two are never averaged. A flight on record as flown with no landing time is a gap, so its exposure is unknown, not zero. Reports that disagree, or flight records of one flight that disagree, are a conflict. A new exposure kind is registered with `registerExposureKind`, and like a check kind it names no rule, vendor or problem.

The command-link indicator shows a kind with parameters. It counts only flight time covered by command-link reports no more than a minute apart:

```ts
    exposure: {
      kind: 'exposure.covered-flight-hours',
      version: 1,
      params: {
        type: 'link.status',
        versions: [1],
        condition: { field: 'values.link', operator: 'equals', value: 'command_control' },
        maxSilenceMilliseconds: 60_000,
```

## 3. Say when a rate may be stated

Every definition bounds its window and states what completeness a rate needs. The battery reserve indicators share this:

```ts
const flightsInScope = {
  scope: { kind: 'subject_kind' as const, subjectKind: 'flight' as const },
  window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
  completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
};
```

A result is `supported`, `insufficient` or `conflicting`. It states a rate only when it is supported: the exposure exceeds the stated amount, the person who declared the population said it was complete, the exposure has no gaps, and no evaluation for the population is still due. Otherwise the result says why, in plain sentences, and states no rate.

## 4. Define and register it

`defineIndicator` from `@ledger/domain` pins the exposure kind's digest and the definition's own digest, and refuses a definition with a problem. The description is part of the definition, so write it for the person who will read the result: what counts once, where an event is placed in time, and what the rate does not establish.

```ts
export function lowReserveLandingsPer100FlightsV1(): IndicatorDefinition {
  return defineIndicator({
    id: LOW_RESERVE_LANDINGS_PER_100_FLIGHTS_ID,
    version: 1,
    title: 'Low-reserve landings per 100 flights',
```

Export your definitions beside your pack and register them with `registerIndicatorDefinition`. For a shipped pack, add them to `standardIndicators()` in `packages/standard-packs/src/index.ts`, which the API and workers call at startup. A published id and version never changes; a changed definition is a new version.

## 5. How results are recorded and reviewed

An indicator is calculated for an accepted control over a **control window**: the control, a period, the subjects in scope (with whether the list is declared complete), the observation types expected, and the indicators to calculate. A window is opened through `POST /v1/control-windows`, and its contents are fixed for its life; changes are revisions.

1. On the control's page, under **Indicator results**, each indicator of a window shows its current result, calculated from the window's revision and the records accepted so far.
2. **Record this result** keeps that result (`POST /v1/control-windows/{id}/indicator-results`). The record pins the window revision and definition the person saw; if either changed, the command conflicts.
3. A person with the authority reviews a recorded result with **Record review** (`POST /v1/control-indicator-reviews`), choosing a conclusion and writing a note. A supported, current result allows any conclusion. An insufficient or conflicting one allows only "inconclusive". A result whose inputs changed since it was recorded allows none; record a new one.

The review is the person's judgement, bound to the digest of the exact result they read. Ledger records it and never draws the conclusion itself.

The simulated operation exercises this end to end: `pnpm scenario:control:calculate` and `pnpm scenario:control:review`.

## Check your work

1. Copy `packages/pack-example-operations/tests/indicators.test.ts`. It checks that each definition has no problem (`indicatorDefinitionProblem`), that its digest recomputes, that it counts a rule of the pack, and which exposure kind and unit it uses.
2. For a calculation over fixed events and exposure, follow `tests/unit/command-link-losses-indicator.test.ts`, which calls `calculateIndicator` directly.
3. Run `pnpm verify`.
4. For the database path, copy `packages/adapters/tests/battery-reserve-indicator.integration.test.ts` and run it with `LEDGER_TEST_DATABASE=ledger_test_mine pnpm test:integration`.
5. In the running app, open an accepted control that has a window, and look under **Indicator results** for your indicator's title and its result.
