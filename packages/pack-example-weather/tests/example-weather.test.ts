import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, SubjectReference } from '../../contracts/src/index.js';
import { djiDockWindScripts, planDockWind } from '../../../apps/emulators/src/dji-dock-wind-script.js';
import { translateDjiDockWind, type DjiDockBinding } from '../../adapters/src/dji-dock-wind.js';
import type { TranslationContext } from '../../adapters/src/adapter-contract.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import type { IndicatorObservation } from '../../domain/src/indicator-exposure-kinds.js';
import {
  adoptionParameterProblem,
  checkedRuleProblem,
  checkParameters,
  runCheckedRule,
} from '../../domain/src/checked-rules.js';
import {
  calculateIndicator,
  findIndicatorDefinition,
  registerIndicatorDefinition,
} from '../../domain/src/indicators.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  EXAMPLE_WEATHER_PACK_ID,
  WIND_AT_DEPARTURE_LEAF_ID,
  WIND_IN_FLIGHT_LEAF_ID,
  exampleWeatherVersionOne,
  flightsWithWindAboveLimitInFlightV1,
} from '../src/index.js';

// The dock wind script's messages, translated by the shipped dock wind adapter, are evaluated one by one as the
// generic evaluator would after each arrives, with the flight report the crew gives at takeoff and at landing.
const binding: DjiDockBinding = { dockId: 'ALPHA-DOCK-07', siteId: 'ALPHA-SITE-07', dockModel: 'dock3' };
const context: TranslationContext<DjiDockBinding> = { subjects: { scope: 'source' }, binding };
const limit = 10;
const parameters = { [WIND_AT_DEPARTURE_LEAF_ID]: { limit }, [WIND_IN_FLIGHT_LEAF_ID]: { limit } };
const plan = planDockWind(djiDockWindScripts['dock-wind-rises-in-flight']!, {
  start: '2026-10-05T09:00:00.000Z',
  dockId: binding.dockId,
  runId: 'example-weather',
});
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-05T10:00:00.000Z' };

const winds: CheckObservation[] = plan.messages.map((message, index) => {
  const translated = translateDjiDockWind(
    { bytes: message.bytes, contentType: 'application/json', transport: { topic: message.topic }, capturedAt: '' },
    context,
  );
  const draft = translated.drafts[0];
  if (!draft) throw new Error(`Expected a wind: ${JSON.stringify(translated.rejections)}`);
  return {
    id: `wind-${String(index).padStart(3, '0')}`,
    type: draft.type,
    version: 1,
    occurredAt: draft.occurredAt,
    observation: draft as unknown as Record<string, unknown>,
  };
});

function report(activity: 'active' | 'landed'): CheckObservation {
  const values = {
    activity,
    takeoffAt: plan.takeoffAt,
    ...(activity === 'landed' ? { landingAt: plan.landingAt } : {}),
  };
  return {
    id: `report-${activity}`,
    type: 'flight.report',
    version: 1,
    occurredAt: activity === 'active' ? plan.takeoffAt : plan.landingAt,
    observation: { type: 'flight.report', version: 1, values },
  };
}

const leaf = (id: string) => exampleWeatherVersionOne().leaves.find((item) => item.id === id) as CheckedRuleLeaf;
const newestFirst = (items: CheckObservation[]) => [...items].reverse();
const evaluate = (id: string, inputs: Record<string, CheckObservation[]>) =>
  runCheckedRule(leaf(id), checkParameters(leaf(id), parameters), inputs, clock);

describe('example weather pack', () => {
  it('ships two rules per flight about the wind at the site its flight plan names', () => {
    const pack = getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 1)!;
    expect(pack.digest).toBe(exampleWeatherVersionOne().digest);
    expect(pack.leaves.map((item) => item.id)).toEqual([WIND_AT_DEPARTURE_LEAF_ID, WIND_IN_FLIGHT_LEAF_ID]);
    for (const id of [WIND_AT_DEPARTURE_LEAF_ID, WIND_IN_FLIGHT_LEAF_ID]) {
      expect(checkedRuleProblem(leaf(id))).toBeUndefined();
      expect(leaf(id)).toMatchObject({
        target: { subjectKind: 'flight' },
        related: [{ name: 'site', subjectKind: 'site', from: { read: 'plan', field: 'values.record.siteId' } }],
        check: { kind: 'value.within-limit', version: 1, params: { field: 'values.speedMetersPerSecond' } },
      });
    }
    expect(leaf(WIND_AT_DEPARTURE_LEAF_ID).reads[2]).toMatchObject({
      type: 'weather.wind',
      about: { related: 'site' },
      select: { latestAtOrBefore: { read: 'report', field: 'values.takeoffAt' } },
      where: [{ field: 'values.method', oneOf: ['measured'] }],
    });
  });

  it('is adopted only with a wind limit within range for each rule', () => {
    const pack = exampleWeatherVersionOne();
    expect(adoptionParameterProblem(pack, parameters)).toBeUndefined();
    expect(adoptionParameterProblem(pack, undefined)).toMatch(/needs parameter limit/);
    expect(adoptionParameterProblem(pack, { ...parameters, [WIND_IN_FLIGHT_LEAF_ID]: { limit: 0 } })).toBeDefined();
    expect(adoptionParameterProblem(pack, { ...parameters, [WIND_AT_DEPARTURE_LEAF_ID]: { limit: 80 } })).toBeDefined();
  });

  it('checks the latest measured wind at or before the takeoff', () => {
    const takeoff = Date.parse(plan.takeoffAt);
    const atDeparture = winds.filter((wind) => Date.parse(wind.occurredAt) <= takeoff).at(-1)!;
    const passed = evaluate(WIND_AT_DEPARTURE_LEAF_ID, { report: [report('active')], subject: [atDeparture] });
    expect(passed).toMatchObject({ outcome: 'pass', evidence: [atDeparture.id] });
    expect(passed.summary).toBe(
      `The latest reported value for the wind reading’s Wind speed (m/s) is 4.5; the limit is at most ${limit}.`,
    );
    const gust = winds.find(
      (wind) => (wind.observation.values as { speedMetersPerSecond: number }).speedMetersPerSecond > limit,
    )!;
    expect(evaluate(WIND_AT_DEPARTURE_LEAF_ID, { report: [report('active')], subject: [gust] }).outcome).toBe(
      'attention',
    );
    expect(evaluate(WIND_AT_DEPARTURE_LEAF_ID, { report: [], subject: [atDeparture] }).outcome).toBe('not_applicable');
  });

  it('passes in flight, needs attention while the wind is above the limit and stops applying once landed', () => {
    const takeoff = Date.parse(plan.takeoffAt);
    const landing = Date.parse(plan.landingAt);
    const inFlight = winds.filter((wind) => {
      const at = Date.parse(wind.occurredAt);
      return at >= takeoff && at <= landing;
    });
    const results = inFlight.map((wind) =>
      evaluate(WIND_IN_FLIGHT_LEAF_ID, {
        report: [report('active')],
        subject: newestFirst(winds.slice(0, winds.indexOf(wind) + 1)),
      }),
    );
    const outcomes = results.map((result) => result.outcome);
    const first = outcomes.indexOf('attention');
    expect(first).toBeGreaterThan(0);
    expect(outcomes).toEqual([
      ...Array(first).fill('pass'),
      ...Array(5).fill('attention'),
      ...Array(outcomes.length - first - 5).fill('pass'),
    ]);
    expect(results[first]!.evidence).toEqual([inFlight[first]!.id]);
    expect(inFlight[first]!.occurredAt).toBe('2026-10-05T09:04:30.000Z');
    const landed = evaluate(WIND_IN_FLIGHT_LEAF_ID, { report: [report('landed')], subject: newestFirst(winds) });
    expect(landed).toMatchObject({ outcome: 'not_applicable', reasonCode: 'condition_not_met' });
  });

  it('counts flights with an in-flight wind finding per 100 reported flights', () => {
    const definition = flightsWithWindAboveLimitInFlightV1();
    registerIndicatorDefinition(definition);
    expect(findIndicatorDefinition(definition.id, 1)!.digest).toBe(definition.digest);
    const flight = (id: string): SubjectReference => ({ scope: 'source', kind: 'flight', id, sourceId: 'dock' });
    const flown = (id: string, takeoffAt: string, landingAt: string): IndicatorObservation => ({
      id: `${id}-report`,
      type: 'flight.report',
      version: 1,
      occurredAt: landingAt,
      subjects: [flight(id)],
      observation: { values: { activity: 'landed', takeoffAt, landingAt } },
    });
    const result = calculateIndicator(definition, {
      window: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
      recordedThrough: '2026-10-06T00:00:00.000Z',
      control: null,
      population: {
        subjects: [flight('gusty'), flight('calm')],
        complete: true,
        declaredBy: { kind: 'person', id: 'safety-lead' },
      },
      selection: { complete: true, exceeded: [] },
      events: [
        {
          kind: 'finding',
          id: 'finding-1',
          subject: flight('gusty'),
          packId: EXAMPLE_WEATHER_PACK_ID,
          ruleId: WIND_IN_FLIGHT_LEAF_ID,
          openedAt: '2026-10-05T09:04:31.000Z',
        },
      ],
      exposure: [
        flown('gusty', '2026-10-05T09:02:00.000Z', '2026-10-05T09:08:00.000Z'),
        flown('calm', '2026-10-05T11:00:00.000Z', '2026-10-05T11:20:00.000Z'),
      ],
    });
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 1,
      exposure: { value: { numerator: '2', denominator: '1' }, unit: 'flight' },
      rate: { value: { numerator: '50', denominator: '1' }, decimal: '50.00', label: 'per 100 flights' },
    });
  });
});
