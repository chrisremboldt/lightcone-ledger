import { describe, expect, it } from 'vitest';
import type { SubjectReference } from '@ledger/contracts';
import { libraryExposureKinds, type IndicatorObservation } from '../src/indicator-exposure-kinds.js';
import { indicatorResultWording, populationWording } from '../src/indicator-wording.js';
import {
  calculateIndicator,
  defineIndicator,
  indicatorReasonSentences,
  registerIndicatorDefinition,
  type IndicatorCalculationInput,
} from '../src/indicators.js';

// A made-up definition: made-up readings per 100 reported flight hours, over two made-up aircraft.
const tails = ['tail-1', 'tail-2'].map((id): SubjectReference => ({
  scope: 'source',
  kind: 'aircraft',
  id,
  sourceId: 'made-up-log',
}));
const definition = defineIndicator({
  id: 'made-up.wording-readings-per-flight-hour',
  version: 1,
  title: 'Made-up readings per 100 flight hours',
  description: 'Made-up readings, per 100 reported flight hours.',
  scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
  events: { kind: 'observations', type: 'made-up.reading', versions: [1] },
  exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
  window: { maxMilliseconds: 31 * 24 * 60 * 60 * 1000 },
  completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
  unit: { per: 100, label: 'per 100 flight hours', fractionDigits: 3 },
});
registerIndicatorDefinition(definition);

function flight(id: string, takeoffAt: string, landingAt?: string): IndicatorObservation {
  const subjects: SubjectReference[] = [
    { scope: 'source', kind: 'flight', id: `flight-${id}`, sourceId: 'made-up-log' },
    tails[0]!,
  ];
  const values = { takeoffAt, ...(landingAt ? { landingAt } : {}) };
  return { id, type: 'flight.report', version: 1, occurredAt: takeoffAt, subjects, observation: { values } };
}

function input(exposure: IndicatorObservation[], complete = true): IndicatorCalculationInput {
  return {
    window: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-08T00:00:00.000Z' },
    recordedThrough: '2026-11-09T00:00:00.000Z',
    control: null,
    population: { subjects: tails, complete, declaredBy: { kind: 'person', id: 'made-up-lead' } },
    selection: { complete: true, exceeded: [] },
    events: [],
    exposure,
  };
}

const names = new Map([['person:made-up-lead', 'Avery Example']]);

describe('indicator result wording', () => {
  it('words a stated rate with the definition title, plain decimals and the declarer by name', () => {
    const result = calculateIndicator(
      definition,
      input([flight('f1', '2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z')]),
    );
    expect(result.status).toBe('supported');
    expect(indicatorResultWording(result, { names })).toEqual({
      title: 'Made-up readings per 100 flight hours',
      description: 'Made-up readings, per 100 reported flight hours.',
      rate: '0 per 100 flight hours',
      events: '0 matching reports',
      exposure: '1 flight hour',
      population: '2 aircraft, declared complete by Avery Example',
      reasons: [],
      limitations: [],
      gaps: [],
      conflicts: [],
    });
  });

  it('words each reason, and each gap once with how many flights it concerns', () => {
    const result = calculateIndicator(
      definition,
      input([flight('f1', '2026-11-03T08:00:00.000Z'), flight('f2', '2026-11-04T08:00:00.000Z')], false),
    );
    const wording = indicatorResultWording(result, { names });
    expect(wording.rate).toBeNull();
    expect(wording.exposure).toBe('0 flight hours');
    expect(wording.population).toBe('2 aircraft listed by Avery Example, not declared complete');
    expect(wording.gaps).toEqual([
      {
        code: 'landing_unreported',
        count: 2,
        sentence: '2 flights have a takeoff time and no landing time on record, so their airborne time is unknown.',
      },
    ]);
    expect(wording.reasons.map((reason) => reason.code)).toEqual(result.reasons);
    for (const reason of wording.reasons) expect(reason.sentence).toBe(indicatorReasonSentences[reason.code]);
  });

  it('keeps a code no current definition words, and an unknown declarer, readable without inventing words', () => {
    const result = calculateIndicator(definition, input([flight('f1', '2026-11-03T08:00:00.000Z')]));
    const older = {
      ...result,
      reasons: ['a_retired_reason'],
      exposure: { ...result.exposure, gaps: [{ code: 'a_retired_gap', observationIds: [] }] },
    };
    const wording = indicatorResultWording(older, { names: new Map() });
    expect(wording.reasons).toEqual([{ code: 'a_retired_reason', sentence: null }]);
    expect(wording.gaps).toEqual([{ code: 'a_retired_gap', count: 1, sentence: null }]);
    expect(wording.population).toBe('2 aircraft, declared complete by a person');
    const unknown = { ...result, definition: { ...result.definition, id: 'made-up.not-registered' } };
    expect(indicatorResultWording(unknown, { names }).title).toBeNull();
  });

  it('words one subject in the singular and a source or definition as the declarer', () => {
    expect(
      populationWording('flight', { count: 1, complete: true, declaredBy: { kind: 'definition', id: 'x' } }, names),
    ).toBe('1 flight, declared complete by the indicator definition');
    expect(
      populationWording('person', { count: 3, complete: true, declaredBy: { kind: 'source', id: 'roster' } }, names),
    ).toBe('3 people, declared complete by a reporting source');
  });

  it('is supplied by every library exposure kind for its unit', () => {
    for (const kind of libraryExposureKinds) expect(kind.wording?.unit.one, kind.id).toBeTruthy();
  });
});
