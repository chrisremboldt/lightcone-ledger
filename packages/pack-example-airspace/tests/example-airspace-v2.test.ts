import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, SubjectReference } from '../../contracts/src/index.js';
import { djiFaultScripts, planScriptedFlight } from '../../../apps/emulators/src/dji-fault-script.js';
import { translateDjiOsdPosition, type DjiOsdBinding } from '../../adapters/src/dji-osd-position.js';
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
  EXAMPLE_AIRSPACE_PACK_ID,
  OPERATING_AREA_PER_FLIGHT_LEAF_ID,
  exampleAirspaceVersionOne,
  exampleAirspaceVersionTwo,
  excursionsPerFlightHourV2,
} from '../src/index.js';

// The drift script with a second drift, translated by the shipped position adapter, evaluated as the generic
// evaluator would: the flight report states takeoff and landing, and the aircraft's positions are read within them.
const binding = { deviceId: 'ALPHA-AIRCRAFT-07', gatewayId: 'ALPHA-DOCK-07' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const area = { centerLatitude: 41.87995, centerLongitude: -87.6274, radiusMeters: 400, marginMeters: 50 };
const parameters = { [OPERATING_AREA_PER_FLIGHT_LEAF_ID]: area };
const drift = djiFaultScripts['drift-outside-area']!;
const start = Date.parse('2026-10-05T09:00:00.000Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const takeoffAt = at(10);
const landingAt = at(230);

const positions: CheckObservation[] = planScriptedFlight(
  {
    ...drift,
    name: 'drift-outside-area-twice',
    steps: [
      ...drift.steps,
      { atSeconds: 180, action: 'offset', eastMeters: 650, northMeters: 0 },
      { atSeconds: 200, action: 'offset', eastMeters: 0, northMeters: 0 },
    ],
  },
  { start: at(0), ...binding, runId: 'example-airspace-v2' },
).messages.map((message, index) => {
  const draft = translateDjiOsdPosition(
    { bytes: message.bytes, contentType: 'application/json', transport: { topic: message.topic }, capturedAt: '' },
    context,
  ).drafts[0]!;
  return {
    id: `position-${String(index).padStart(3, '0')}`,
    type: draft.type,
    version: 1,
    occurredAt: draft.occurredAt,
    observation: draft as unknown as Record<string, unknown>,
  };
});

function report(activity: 'active' | 'landed'): CheckObservation {
  return {
    id: `report-${activity}`,
    type: 'flight.report',
    version: 1,
    occurredAt: activity === 'active' ? takeoffAt : landingAt,
    observation: { values: { activity, takeoffAt, ...(activity === 'landed' ? { landingAt } : {}) } },
  };
}

const leaf = () => exampleAirspaceVersionTwo().leaves[0] as CheckedRuleLeaf;

/** Narrows every read in order as the evaluator does, then runs the rule at the given time. */
function evaluate(window: CheckObservation[], evaluatedAt: string) {
  const rule = leaf();
  const given: Record<string, CheckObservation[]> = { window, positions };
  const inputs: Record<string, readonly CheckObservation[]> = {};
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      [...given[read.name]!].filter((item) => item.occurredAt <= evaluatedAt).reverse(),
      inputs as CheckInputs,
    );
  return runCheckedRule(rule, checkParameters(rule, parameters), inputs, { mode: 'wall', evaluatedAt });
}

describe('example airspace pack, version 2', () => {
  it('registers version 2 beside the unchanged version 1, with a rule per flight about its aircraft', () => {
    expect(getRulePackVersion(EXAMPLE_AIRSPACE_PACK_ID, 1)!.digest).toBe(exampleAirspaceVersionOne().digest);
    expect(getRulePackVersion(EXAMPLE_AIRSPACE_PACK_ID, 2)!.digest).toBe(exampleAirspaceVersionTwo().digest);
    expect(checkedRuleProblem(leaf())).toBeUndefined();
    expect(leaf()).toMatchObject({
      target: { subjectKind: 'flight' },
      related: [{ name: 'aircraft', from: { read: 'window', field: 'secondarySubject' } }],
      check: { kind: 'position.in-area', version: 2 },
    });
    expect(adoptionParameterProblem(exampleAirspaceVersionTwo(), parameters)).toBeUndefined();
    expect(adoptionParameterProblem(exampleAirspaceVersionTwo(), undefined)).toMatch(/needs parameter/);
  });

  it('names each excursion between takeoff and landing, with the same result after landing as during the flight', () => {
    const during = evaluate([report('active')], at(220));
    const afterLanding = evaluate([report('active'), report('landed')], at(240));
    const muchLater = evaluate([report('active'), report('landed')], at(86_400));
    expect(during).toMatchObject({ outcome: 'attention', details: { excursionCount: 2, windowClosed: false } });
    expect(afterLanding).toMatchObject({ outcome: 'attention', details: { excursionCount: 2, windowClosed: true } });
    expect(afterLanding.issues).toEqual(during.issues);
    expect(muchLater).toEqual(afterLanding);
    expect(afterLanding.issueTimes!.map((time) => [time.start, time.end])).toEqual([
      [at(110), at(140)],
      [at(180), at(200)],
    ]);
    expect(afterLanding.summary).toMatch(/^2 excursion\(s\) outside the operating area and margin during the flight/);
    // Positions after the landing are not read.
    expect(afterLanding.details).toMatchObject({ windowEnd: landingAt, positionsChecked: 45 });
  });

  it('counts two excursions on one flight as two, per flight hour', () => {
    const definition = excursionsPerFlightHourV2();
    registerIndicatorDefinition(definition);
    expect(findIndicatorDefinition(definition.id, 2)!.digest).toBe(definition.digest);
    const flight: SubjectReference = { scope: 'source', kind: 'flight', id: 'survey-1', sourceId: 'telemetry' };
    const result = evaluate([report('landed')], at(240));
    const exposure: IndicatorObservation = {
      id: 'report-landed',
      type: 'flight.report',
      version: 1,
      occurredAt: landingAt,
      subjects: [flight],
      observation: { values: { activity: 'landed', takeoffAt: at(0), landingAt: at(1800) } },
    };
    expect(
      calculateIndicator(definition, {
        window: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
        recordedThrough: '2026-10-06T00:00:00.000Z',
        control: null,
        population: { subjects: [flight], complete: true, declaredBy: { kind: 'person', id: 'safety-lead' } },
        selection: { complete: true, exceeded: [] },
        events: issueEvents({ packId: EXAMPLE_AIRSPACE_PACK_ID, ruleId: OPERATING_AREA_PER_FLIGHT_LEAF_ID }, flight, [
          { ...result, recordedAt: at(240), clock: { mode: 'wall', evaluatedAt: at(240) } },
        ]),
        exposure: [exposure],
      }),
    ).toMatchObject({ status: 'supported', eventCount: 2, rate: { decimal: '4.000', label: 'per flight hour' } });
  });
});
