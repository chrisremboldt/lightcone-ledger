import { describe, expect, it } from 'vitest';
import type { CheckedRuleLeaf, SubjectReference } from '../../contracts/src/index.js';
import { djiFaultScripts, planScriptedFlight } from '../../../apps/emulators/src/dji-fault-script.js';
import { translateDjiOsdPosition, type DjiOsdBinding } from '../../adapters/src/dji-osd-position.js';
import type { TranslationContext } from '../../adapters/src/adapter-contract.js';
import { findCheckKind, type CheckObservation } from '../../domain/src/check-kinds.js';
import type { IndicatorObservation } from '../../domain/src/indicator-exposure-kinds.js';
import { adoptionParameterProblem, checkParameters, runCheckedRule } from '../../domain/src/checked-rules.js';
import {
  calculateIndicator,
  findIndicatorDefinition,
  registerIndicatorDefinition,
} from '../../domain/src/indicators.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  EXAMPLE_AIRSPACE_PACK_ID,
  OPERATING_AREA_LEAF_ID,
  excursionsPerFlightHourV1,
  exampleAirspaceVersionOne,
} from '../src/index.js';

// The drift script's positions, translated by the shipped position adapter, are evaluated one by one as the generic
// evaluator would after each arrives. The area is the circle the organization adopts around the middle of the leg.
const binding = { deviceId: 'ALPHA-AIRCRAFT-07', gatewayId: 'ALPHA-DOCK-07' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const area = { centerLatitude: 41.87995, centerLongitude: -87.6274, radiusMeters: 400, marginMeters: 50 };
const parameters = { [OPERATING_AREA_LEAF_ID]: area };

function positions(): CheckObservation[] {
  const plan = planScriptedFlight(djiFaultScripts['drift-outside-area']!, {
    start: '2026-10-05T09:00:00.000Z',
    ...binding,
    runId: 'example-airspace',
  });
  return plan.messages.map((message, index) => {
    const translated = translateDjiOsdPosition(
      {
        bytes: message.bytes,
        contentType: 'application/json',
        transport: { topic: message.topic },
        capturedAt: message.occurredAt,
      },
      context,
    );
    const draft = translated.drafts[0];
    if (!draft) throw new Error(`Expected a position: ${JSON.stringify(translated.rejections)}`);
    return {
      id: `position-${String(index).padStart(3, '0')}`,
      type: draft.type,
      version: 1,
      occurredAt: draft.occurredAt,
      observation: draft as unknown as Record<string, unknown>,
    };
  });
}

function leaf(): CheckedRuleLeaf {
  return exampleAirspaceVersionOne().leaves[0] as CheckedRuleLeaf;
}

/** One evaluation per arriving position, reading every position so far, newest first. */
function evaluations() {
  const rule = leaf();
  const all = positions();
  return all.map((position, index) => ({
    position,
    outcome: runCheckedRule(
      rule,
      checkParameters(rule, parameters),
      { positions: all.slice(0, index + 1).reverse() },
      { mode: 'wall', evaluatedAt: '2026-10-05T10:00:00.000Z' },
    ),
  }));
}

describe('example airspace pack', () => {
  it('ships one rule over position fixes, registered with the standard packs', () => {
    const pack = getRulePackVersion(EXAMPLE_AIRSPACE_PACK_ID, 1)!;
    expect(pack.digest).toBe(exampleAirspaceVersionOne().digest);
    expect(pack.leaves.map((item) => item.id)).toEqual([OPERATING_AREA_LEAF_ID]);
    expect(leaf()).toMatchObject({
      target: { subjectKind: 'aircraft' },
      reads: [{ name: 'positions', type: 'position.fix', about: 'target', select: 'all' }],
      check: { kind: 'position.in-area', version: 1 },
    });
    expect(findCheckKind('position.in-area', 1)).toBeDefined();
  });

  it('is adopted only with an area and a margin within range', () => {
    const pack = exampleAirspaceVersionOne();
    expect(adoptionParameterProblem(pack, parameters)).toBeUndefined();
    expect(adoptionParameterProblem(pack, undefined)).toMatch(/needs parameter centerLatitude/);
    expect(
      adoptionParameterProblem(pack, { [OPERATING_AREA_LEAF_ID]: { ...area, radiusMeters: 20_000 } }),
    ).toBeDefined();
    expect(adoptionParameterProblem(pack, { [OPERATING_AREA_LEAF_ID]: { ...area, marginMeters: -10 } })).toBeDefined();
  });

  it('passes inside, waits on one position outside, needs attention on the second and passes again once back', () => {
    const results = evaluations();
    const outcomes = results.map((item) => item.outcome.outcome);
    const firstAway = outcomes.indexOf('pending');
    expect(firstAway).toBeGreaterThan(0);
    expect(outcomes.slice(0, firstAway).every((outcome) => outcome === 'pass')).toBe(true);
    expect(outcomes[firstAway + 1]).toBe('attention');
    const lastAttention = outcomes.lastIndexOf('attention');
    expect(outcomes.slice(firstAway + 1, lastAttention + 1).every((outcome) => outcome === 'attention')).toBe(true);
    expect(outcomes.slice(lastAttention + 1).every((outcome) => outcome === 'pass')).toBe(true);
    expect(outcomes.at(-1)).toBe('pass');

    const first = results[firstAway + 1]!.outcome;
    const firstOutside = results[firstAway]!.position;
    expect(first).toMatchObject({ evidenceState: 'supported', reasonCode: 'excursion' });
    expect(first.evidence[0]).toBe(firstOutside.id);
    expect(first.details).toMatchObject({ excursionStartedAt: firstOutside.occurredAt, excursionPositions: 2 });
    expect(first.summary).toBe(
      `Outside the operating area and margin from ${firstOutside.occurredAt} to ${results[firstAway + 1]!.position.occurredAt} (2 positions), up to ${first.details!.maxDistanceOutsideMeters} m beyond.`,
    );
    const worst = results[lastAttention]!.outcome.details!;
    expect(Number(worst.maxDistanceOutsideMeters)).toBeGreaterThan(200);
    expect(worst.unusablePositions).toBe(0);
  });

  it('defines excursions per flight hour over the rule’s findings and reported flight hours', () => {
    const definition = excursionsPerFlightHourV1();
    registerIndicatorDefinition(definition);
    expect(findIndicatorDefinition(definition.id, 1)!.digest).toBe(definition.digest);
    const tail = (id: string): SubjectReference => ({ scope: 'source', kind: 'aircraft', id, sourceId: 'telemetry' });
    const report = (id: string, aircraft: string, takeoffAt: string, landingAt: string): IndicatorObservation => ({
      id,
      type: 'flight.report',
      version: 1,
      occurredAt: landingAt,
      subjects: [{ scope: 'source', kind: 'flight', id: `${id}-flight`, sourceId: 'telemetry' }, tail(aircraft)],
      observation: { values: { activity: 'landed', takeoffAt, landingAt } },
    });
    const result = calculateIndicator(definition, {
      window: { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z' },
      recordedThrough: '2026-10-06T00:00:00.000Z',
      control: null,
      population: {
        subjects: [tail('alpha-7'), tail('alpha-8')],
        complete: true,
        declaredBy: { kind: 'person', id: 'safety-lead' },
      },
      selection: { complete: true, exceeded: [] },
      events: [
        {
          kind: 'finding',
          id: 'finding-1',
          subject: tail('alpha-7'),
          packId: EXAMPLE_AIRSPACE_PACK_ID,
          ruleId: OPERATING_AREA_LEAF_ID,
          openedAt: '2026-10-05T09:02:00.000Z',
        },
      ],
      exposure: [
        report('report-1', 'alpha-7', '2026-10-05T09:00:00.000Z', '2026-10-05T09:30:00.000Z'),
        report('report-2', 'alpha-8', '2026-10-05T10:00:00.000Z', '2026-10-05T11:30:00.000Z'),
      ],
    });
    expect(result).toMatchObject({
      status: 'supported',
      eventCount: 1,
      exposure: { value: { numerator: '2', denominator: '1' }, unit: 'flight_hour' },
      rate: { value: { numerator: '1', denominator: '2' }, decimal: '0.500', label: 'per flight hour' },
    });
  });
});
