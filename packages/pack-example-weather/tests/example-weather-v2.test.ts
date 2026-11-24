import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, SubjectReference } from '../../contracts/src/index.js';
import {
  djiDockWindScripts,
  planDockWind,
  type DjiDockWindScript,
} from '../../../apps/emulators/src/dji-dock-wind-script.js';
import { translateDjiDockWind, type DjiDockBinding } from '../../adapters/src/dji-dock-wind.js';
import type { TranslationContext } from '../../adapters/src/adapter-contract.js';
import type { CheckInputs, CheckObservation } from '../../domain/src/check-kinds.js';
import type { IndicatorObservation } from '../../domain/src/indicator-exposure-kinds.js';
import {
  adoptionParameterProblem,
  checkedRuleProblem,
  checkParameters,
  narrowRead,
  runCheckedRule,
} from '../../domain/src/checked-rules.js';
import {
  calculateIndicator,
  findIndicatorDefinition,
  issueEvents,
  registerIndicatorDefinition,
} from '../../domain/src/indicators.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  EXAMPLE_WEATHER_PACK_ID,
  WIND_AT_TAKEOFF_LEAF_ID,
  WIND_FOR_FLIGHT_LEAF_ID,
  exampleWeatherVersionOne,
  exampleWeatherVersionTwo,
  flightsWithWindAboveLimitV1,
  windExceedancesPer100FlightsV1,
} from '../src/index.js';

// The dock wind scripts' messages, translated by the shipped dock wind adapter, evaluated as the generic evaluator
// would: each read narrowed in order, then the rule run, with the crew's flight report at takeoff and at landing.
const binding: DjiDockBinding = { dockId: 'ALPHA-DOCK-07', siteId: 'ALPHA-SITE-07', dockModel: 'dock3' };
const context: TranslationContext<DjiDockBinding> = { subjects: { scope: 'source' }, binding };
const limit = 10;
const parameters = { [WIND_AT_TAKEOFF_LEAF_ID]: { limit }, [WIND_FOR_FLIGHT_LEAF_ID]: { limit } };
const rises = djiDockWindScripts['dock-wind-rises-in-flight']!;
/** The same flight, taking off just after a reading above the limit, then gusting above it twice in the air. */
const gusty: DjiDockWindScript = {
  ...rises,
  name: 'dock-wind-gusts-twice',
  flight: { takeoffSeconds: 125, landingSeconds: 480 },
  wind: { speedMetersPerSecond: 11.5, direction: 6 },
  steps: [
    { atSeconds: 130, action: 'wind', speedMetersPerSecond: 4.5 },
    ...rises.steps,
    { atSeconds: 420, action: 'wind', speedMetersPerSecond: 12.6 },
    { atSeconds: 450, action: 'wind', speedMetersPerSecond: 6.2 },
  ],
};

function flown(script: DjiDockWindScript, start: string) {
  const plan = planDockWind(script, { start, dockId: binding.dockId, runId: script.name });
  const winds: CheckObservation[] = plan.messages.map((message, index) => {
    const draft = translateDjiDockWind(
      { bytes: message.bytes, contentType: 'application/json', transport: { topic: message.topic }, capturedAt: '' },
      context,
    ).drafts[0]!;
    return {
      id: `${script.name}-wind-${String(index).padStart(3, '0')}`,
      type: draft.type,
      version: 1,
      occurredAt: draft.occurredAt,
      observation: draft as unknown as Record<string, unknown>,
    };
  });
  const report = (activity: 'active' | 'landed'): CheckObservation => ({
    id: `${script.name}-report-${activity}`,
    type: 'flight.report',
    version: 1,
    occurredAt: activity === 'active' ? plan.takeoffAt : plan.landingAt,
    observation: {
      type: 'flight.report',
      version: 1,
      values: { activity, takeoffAt: plan.takeoffAt, ...(activity === 'landed' ? { landingAt: plan.landingAt } : {}) },
    },
  });
  return { plan, winds, report };
}

const leaf = (id: string) => exampleWeatherVersionTwo().leaves.find((item) => item.id === id) as CheckedRuleLeaf;
const newestFirst = (items: CheckObservation[]) => [...items].reverse();

/** Narrows every read in order as the evaluator does, then runs the rule at the given time. */
function evaluate(id: string, given: { window: CheckObservation[]; values: CheckObservation[] }, evaluatedAt: string) {
  const rule = leaf(id);
  const inputs: Record<string, readonly CheckObservation[]> = {};
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      newestFirst((given[read.name as 'window' | 'values'] ?? []).filter((item) => item.occurredAt <= evaluatedAt)),
      inputs as CheckInputs,
    );
  return runCheckedRule(rule, checkParameters(rule, parameters), inputs, { mode: 'wall', evaluatedAt });
}

describe('example weather pack, version 2', () => {
  it('registers version 2 beside the unchanged version 1, with rules that read the wind in a window', () => {
    expect(getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 1)!.digest).toBe(exampleWeatherVersionOne().digest);
    expect(getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 2)!.digest).toBe(exampleWeatherVersionTwo().digest);
    expect(exampleWeatherVersionTwo().leaves.map((item) => item.id)).toEqual([
      WIND_AT_TAKEOFF_LEAF_ID,
      WIND_FOR_FLIGHT_LEAF_ID,
    ]);
    for (const id of [WIND_AT_TAKEOFF_LEAF_ID, WIND_FOR_FLIGHT_LEAF_ID]) {
      expect(checkedRuleProblem(leaf(id))).toBeUndefined();
      expect(leaf(id).check).toMatchObject({ kind: 'window.values-within-limit', version: 1 });
    }
    expect(leaf(WIND_FOR_FLIGHT_LEAF_ID).reads[2]).toMatchObject({
      about: { related: 'site' },
      select: { within: { read: 'window', startField: 'values.takeoffAt', endField: 'values.landingAt' } },
    });
    expect(adoptionParameterProblem(exampleWeatherVersionTwo(), parameters)).toBeUndefined();
    expect(adoptionParameterProblem(exampleWeatherVersionTwo(), undefined)).toMatch(/needs parameter limit/);
  });

  it('checks the wind in effect at takeoff', () => {
    const calm = flown(rises, '2026-10-05T09:00:00.000Z');
    expect(
      evaluate(WIND_AT_TAKEOFF_LEAF_ID, { window: [calm.report('active')], values: calm.winds }, calm.plan.takeoffAt),
    ).toMatchObject({ outcome: 'pass', details: { worstValue: 4.5, valuesChecked: 1 } });
    const gust = flown(gusty, '2026-10-05T10:00:00.000Z');
    const atTakeoff = evaluate(
      WIND_AT_TAKEOFF_LEAF_ID,
      { window: [gust.report('active')], values: gust.winds },
      gust.plan.takeoffAt,
    );
    expect(atTakeoff).toMatchObject({
      outcome: 'attention',
      issues: [`outside-from:${gust.plan.takeoffAt}`],
      details: { worstValueAt: gust.plan.takeoffAt },
      summary: `At takeoff the measured wind was 11.5 m/s, above the ${limit} m/s limit.`,
    });
  });

  it('gives the same result for the whole flight after landing as during it, and names each stretch', () => {
    const gust = flown(gusty, '2026-10-05T10:00:00.000Z');
    const during = gust.winds
      .filter((wind) => wind.occurredAt >= gust.plan.takeoffAt && wind.occurredAt < gust.plan.landingAt)
      .map((wind) =>
        evaluate(WIND_FOR_FLIGHT_LEAF_ID, { window: [gust.report('active')], values: gust.winds }, wind.occurredAt),
      );
    const landed = { window: [gust.report('active'), gust.report('landed')], values: gust.winds };
    const atLanding = evaluate(WIND_FOR_FLIGHT_LEAF_ID, landed, gust.plan.landingAt);
    const muchLater = evaluate(WIND_FOR_FLIGHT_LEAF_ID, landed, '2026-10-06T10:00:00.000Z');
    const lastDuring = during.at(-1)!;
    expect(lastDuring).toMatchObject({ outcome: 'attention', details: { windowClosed: false, runCount: 2 } });
    for (const after of [atLanding, muchLater]) {
      expect(after).toMatchObject({
        outcome: 'attention',
        evidenceState: 'supported',
        details: { windowClosed: true },
      });
      expect(after.issues).toEqual(lastDuring.issues);
      expect(after.details).toMatchObject({ runCount: 2, worstValue: 14.2 });
    }
    expect(muchLater).toEqual(atLanding);
    // Each issue named once its stretch is under way keeps its name as the flight goes on.
    const first = during.findIndex((result) => result.issues?.length);
    expect(during[first]!.issues).toEqual([atLanding.issues![0]]);
    expect(atLanding.issueTimes).toEqual([
      { issue: atLanding.issues![0], start: '2026-10-05T10:04:30.000Z', end: '2026-10-05T10:05:45.000Z' },
      { issue: atLanding.issues![1], start: '2026-10-05T10:07:00.000Z', end: '2026-10-05T10:07:30.000Z' },
    ]);
    expect(atLanding.summary).toBe(
      `2 stretch(es) of measured wind above the ${limit} m/s limit from 2026-10-05T10:04:30.000Z, 105 s in all; the highest was 14.2 m/s at 2026-10-05T10:05:00.000Z.`,
    );
  });

  it('passes a calm flight and reports the flight unflown as not applicable', () => {
    const calm = flown({ ...rises, name: 'dock-wind-steady', steps: [] }, '2026-10-05T11:00:00.000Z');
    const landed = { window: [calm.report('landed')], values: calm.winds };
    expect(evaluate(WIND_FOR_FLIGHT_LEAF_ID, landed, calm.plan.landingAt)).toMatchObject({
      outcome: 'pass',
      issues: [],
      details: { gapCount: 0, valuesChecked: 25 },
    });
    expect(evaluate(WIND_FOR_FLIGHT_LEAF_ID, { window: [], values: calm.winds }, calm.plan.landingAt)).toMatchObject({
      outcome: 'not_applicable',
    });
  });

  it('counts two stretches on one flight as two exceedances, and a flight with exceedances under both rules once', () => {
    const exceedances = windExceedancesPer100FlightsV1();
    const flights = flightsWithWindAboveLimitV1();
    for (const definition of [exceedances, flights]) {
      registerIndicatorDefinition(definition);
      expect(findIndicatorDefinition(definition.id, 1)!.digest).toBe(definition.digest);
    }
    const flight = (id: string): SubjectReference => ({ scope: 'source', kind: 'flight', id, sourceId: 'dock' });
    const gust = flown(gusty, '2026-10-05T10:00:00.000Z');
    const calm = flown(rises, '2026-10-05T12:00:00.000Z');
    const record = (result: ReturnType<typeof evaluate>, at: string) => ({
      ...result,
      recordedAt: at,
      clock: { mode: 'wall' as const, evaluatedAt: at },
    });
    const events = [gust, calm].flatMap((item, index) => {
      const subject = flight(index ? 'calm' : 'gusty');
      const landed = { window: [item.report('landed')], values: item.winds };
      return [WIND_AT_TAKEOFF_LEAF_ID, WIND_FOR_FLIGHT_LEAF_ID].flatMap((ruleId) =>
        issueEvents({ packId: EXAMPLE_WEATHER_PACK_ID, ruleId }, subject, [
          record(evaluate(ruleId, landed, item.plan.landingAt), item.plan.landingAt),
        ]),
      );
    });
    const report = (id: string, item: ReturnType<typeof flown>): IndicatorObservation => ({
      id: `${id}-report`,
      type: 'flight.report',
      version: 1,
      occurredAt: item.plan.landingAt,
      subjects: [flight(id)],
      observation: { values: { activity: 'landed', takeoffAt: item.plan.takeoffAt, landingAt: item.plan.landingAt } },
    });
    const input = {
      window: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
      recordedThrough: '2026-10-06T00:00:00.000Z',
      control: null,
      population: {
        subjects: [flight('gusty'), flight('calm')],
        complete: true,
        declaredBy: { kind: 'person' as const, id: 'safety-lead' },
      },
      selection: { complete: true, exceeded: [] },
      events,
      exposure: [report('gusty', gust), report('calm', calm)],
    };
    // The calm flight still has the single stretch of the original script.
    expect(calculateIndicator(exceedances, input)).toMatchObject({
      status: 'supported',
      eventCount: 4,
      rate: { decimal: '200.00', label: 'per 100 flights' },
    });
    expect(calculateIndicator(flights, input)).toMatchObject({
      status: 'supported',
      eventCount: 2,
      rate: { decimal: '100.00' },
    });
    const gustyOnly = { ...input, events: events.filter((event) => event.subject.id === 'gusty') };
    expect(calculateIndicator(exceedances, gustyOnly).eventCount).toBe(3);
    expect(calculateIndicator(flights, gustyOnly).eventCount).toBe(1);
  });
});
