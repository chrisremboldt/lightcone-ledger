import { describe, expect, it } from 'vitest';
import type { SubjectReference } from '@ledger/contracts';
import { add, decimalOfNumber, divide, formatDecimal, parseDecimal, rational } from '../src/indicator-arithmetic.js';
import {
  dutyHoursV1,
  dutyPeriodCountV1,
  exposureKindDigest,
  findExposureKind,
  coveredFlightHoursV1,
  flightHoursV1,
  flightsV1,
  observationCountV1,
  registerExposureKind,
  timeInServiceHoursV1,
  type IndicatorObservation,
} from '../src/indicator-exposure-kinds.js';

const window = { start: Date.parse('2026-11-01T00:00:00.000Z'), end: Date.parse('2026-11-02T00:00:00.000Z') };
const aircraft = (id: string): SubjectReference => ({ scope: 'source', kind: 'aircraft', id, sourceId: 'made-up-log' });
const flight = (id: string): SubjectReference => ({ scope: 'source', kind: 'flight', id, sourceId: 'made-up-log' });
const person = (id: string): SubjectReference => ({ scope: 'ledger', kind: 'person', id });

function observation(
  id: string,
  type: string,
  subjects: SubjectReference[],
  occurredAt: string,
  values: Record<string, unknown>,
  interval?: { start: string; end?: string },
): IndicatorObservation {
  return {
    id,
    type,
    version: 1,
    occurredAt,
    ...(interval ? { interval } : {}),
    subjects,
    observation: { type, version: 1, occurredAt, ...(interval ? { interval } : {}), values },
  };
}

function report(
  id: string,
  flightId: string,
  values: Record<string, unknown>,
  occurredAt = '2026-11-01T12:00:00.000Z',
) {
  return observation(id, 'flight.report', [flight(flightId), aircraft('tail-1')], occurredAt, values);
}

function timeInService(
  id: string,
  tail: string,
  coveredThroughAt: string,
  totalTimeHours: number,
  coverage = 'complete',
) {
  return observation(id, 'operator.record', [aircraft(tail)], coveredThroughAt, {
    recordType: 'aircraft.time-in-service',
    recordVersion: 1,
    record: { entryKind: 'running_total', totalTimeHours, coveredThroughAt, coverage },
  });
}

describe('exact arithmetic', () => {
  it('keeps decimals exact and rounds half up only when formatting', () => {
    expect(add(decimalOfNumber(0.1)!, decimalOfNumber(0.2)!)).toEqual(rational(3n, 10n));
    expect(decimalOfNumber(1e-7)).toEqual(rational(1n, 10_000_000n));
    expect(decimalOfNumber(1.5e21)).toEqual(rational(1_500_000_000_000_000_000_000n));
    expect(parseDecimal('2.50')).toEqual(rational(5n, 2n));
    expect(formatDecimal(divide(rational(1n), rational(3n)), 3)).toBe('0.333');
    expect(formatDecimal(rational(2n, 3n), 3)).toBe('0.667');
    expect(formatDecimal(rational(5n, 2n), 0)).toBe('3');
    expect(formatDecimal(rational(7n), 2)).toBe('7.00');
  });
});

describe('flight hours from flight reports', () => {
  it('sums the part of each reported flight inside the window, exactly', () => {
    const measure = flightHoursV1.measure(
      {},
      [
        report('r1', 'f1', { activity: 'active', takeoffAt: '2026-11-01T10:00:00.000Z' }),
        report('r2', 'f1', {
          activity: 'landed',
          takeoffAt: '2026-11-01T10:00:00.000Z',
          landingAt: '2026-11-01T10:20:00.000Z',
        }),
        // Took off before the window: only the part inside counts.
        report('r3', 'f2', { takeoffAt: '2026-10-31T23:30:00.000Z', landingAt: '2026-11-01T00:30:00.000Z' }),
        report('r4', 'f3', { activity: 'cancelled' }),
      ],
      window,
      [aircraft('tail-1')],
    );
    expect(measure.quantity).toEqual(rational(5n, 6n));
    expect(measure.counted).toEqual(['r1', 'r2', 'r3']);
    expect(measure.gaps).toEqual([]);
    expect(measure.conflicts).toEqual([]);
  });

  it('reports a flight with no landing as a gap, not as zero or open-ended exposure', () => {
    const measure = flightHoursV1.measure(
      {},
      [report('r1', 'f1', { activity: 'active', takeoffAt: '2026-11-01T10:00:00.000Z' })],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(0n));
    expect(measure.gaps).toEqual([
      { code: 'landing_unreported', subjectKey: 'source/made-up-log/flight/f1', observationIds: ['r1'] },
    ]);
  });

  it('reports disagreeing takeoff or landing times as a conflict and counts neither', () => {
    const measure = flightHoursV1.measure(
      {},
      [
        report('r1', 'f1', { takeoffAt: '2026-11-01T10:00:00.000Z', landingAt: '2026-11-01T10:20:00.000Z' }),
        report('r2', 'f1', { landingAt: '2026-11-01T10:40:00.000Z' }),
        report('r3', 'f2', { takeoffAt: '2026-11-01T11:00:00.000Z', landingAt: '2026-11-01T10:00:00.000Z' }),
      ],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(0n));
    expect(measure.conflicts.map((note) => note.code)).toEqual([
      'landing_reports_disagree',
      'landing_not_after_takeoff',
    ]);
  });
});

function flightRecord(id: string, flightId: string, takeoffAt: string, landingAt: string) {
  return observation(
    id,
    'operator.record',
    [flight(flightId), aircraft('tail-1')],
    '2026-11-05T09:00:00.000Z',
    { recordType: 'flight.record', recordVersion: 1, record: { takeoffAt, landingAt, takeoffLocation: 'Pad A' } },
    { start: takeoffAt, end: landingAt },
  );
}

describe('flight hours and flights from the operator’s flight records', () => {
  const records = [
    // Logged only: its times come from the flight record.
    flightRecord('log-1', 'f1', '2026-11-01T08:00:00.000Z', '2026-11-01T08:45:00.000Z'),
    // Reported and logged a minute apart: the reported times are counted, the logged ones are not added.
    flightRecord('log-2', 'f2', '2026-11-01T10:01:00.000Z', '2026-11-01T10:30:00.000Z'),
    report('r2', 'f2', { takeoffAt: '2026-11-01T10:00:00.000Z', landingAt: '2026-11-01T10:30:00.000Z' }),
    // A report with a takeoff and no landing: the landing comes from the flight record.
    report('r3', 'f3', { activity: 'active', takeoffAt: '2026-11-01T12:00:00.000Z' }),
    flightRecord('log-3', 'f3', '2026-11-01T12:00:00.000Z', '2026-11-01T12:15:00.000Z'),
    // An unrelated operator record is not read.
    timeInService('tis', 'tail-1', '2026-11-01T00:00:00.000Z', 10),
  ];

  it('reads a reported time where a report states one, and the flight record’s otherwise', () => {
    const hours = flightHoursV1.measure({}, records, window, [aircraft('tail-1')]);
    expect(hours.quantity).toEqual(rational(3n, 2n));
    expect(hours.counted).toEqual(['log-1', 'log-2', 'log-3', 'r2', 'r3']);
    expect(hours.gaps).toEqual([]);
    expect(hours.conflicts).toEqual([]);
    const flights = flightsV1.measure({}, records, window, [aircraft('tail-1')]);
    expect(flights.quantity).toEqual(rational(3n));
    expect(flightHoursV1.reads({})).toEqual([
      { type: 'flight.report', versions: [1] },
      { type: 'operator.record', versions: [1], alternative: true },
    ]);
  });

  it('reports flight records of one flight that disagree as a conflict', () => {
    const measure = flightHoursV1.measure(
      {},
      [
        flightRecord('log-1', 'f1', '2026-11-01T08:00:00.000Z', '2026-11-01T08:45:00.000Z'),
        flightRecord('log-1b', 'f1', '2026-11-01T08:05:00.000Z', '2026-11-01T08:45:00.000Z'),
      ],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(0n));
    expect(measure.conflicts).toEqual([
      {
        code: 'takeoff_records_disagree',
        subjectKey: 'source/made-up-log/flight/f1',
        observationIds: ['log-1', 'log-1b'],
      },
    ]);
  });
});

describe('flights from flight reports', () => {
  it('counts flights whose takeoff falls inside the window', () => {
    const measure = flightsV1.measure(
      {},
      [
        report('r1', 'f1', { takeoffAt: '2026-11-01T10:00:00.000Z' }),
        report('r2', 'f2', { takeoffAt: '2026-10-31T23:00:00.000Z', landingAt: '2026-11-01T00:10:00.000Z' }),
        report('r3', 'f3', { activity: 'landed', landingAt: '2026-11-01T09:00:00.000Z' }),
        report('r4', 'f4', { takeoffAt: '2026-11-01T11:00:00.000Z' }),
        report('r5', 'f4', { takeoffAt: '2026-11-01T11:05:00.000Z' }),
      ],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(1n));
    expect(measure.counted).toEqual(['r1']);
    expect(measure.gaps.map((note) => note.code)).toEqual(['takeoff_unreported']);
    expect(measure.conflicts.map((note) => note.code)).toEqual(['takeoff_reports_disagree']);
  });
});

describe('observations of a declared type', () => {
  it('counts matching observations inside the window and cannot check coverage', () => {
    const delivery = (id: string, at: string, outcome: string) =>
      observation(id, 'made-up.delivery', [aircraft('tail-1')], at, { outcome });
    const measure = observationCountV1.measure(
      {
        type: 'made-up.delivery',
        versions: [1],
        condition: { field: 'values.outcome', operator: 'equals', value: 'done' },
      },
      [
        delivery('d1', '2026-11-01T01:00:00.000Z', 'done'),
        delivery('d2', '2026-11-01T02:00:00.000Z', 'abandoned'),
        delivery('d3', '2026-11-02T00:00:00.000Z', 'done'),
        observation('x1', 'made-up.other', [aircraft('tail-1')], '2026-11-01T03:00:00.000Z', { outcome: 'done' }),
      ],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(1n));
    expect(measure.counted).toEqual(['d1']);
    expect(observationCountV1.coverage).toBe('not_determinable');
  });
});

describe('duty periods', () => {
  const period = (id: string, who: string, kind: string, start: string, end?: string) =>
    observation(
      id,
      'crew.duty-period',
      [person(who)],
      end ?? start,
      { period: kind },
      { start, ...(end ? { end } : {}) },
    );
  const periods = [
    period('p1', 'pilot-1', 'duty', '2026-11-01T06:00:00.000Z', '2026-11-01T14:00:00.000Z'),
    period('p2', 'pilot-1', 'flight_duty', '2026-11-01T08:00:00.000Z', '2026-11-01T16:00:00.000Z'),
    period('p3', 'pilot-2', 'duty', '2026-10-31T22:00:00.000Z', '2026-11-01T02:00:00.000Z'),
    period('p4', 'pilot-2', 'rest', '2026-11-01T02:00:00.000Z', '2026-11-01T12:00:00.000Z'),
    period('p5', 'pilot-3', 'duty', '2026-11-01T20:00:00.000Z'),
  ];

  it('counts periods of the declared kinds that start inside the window', () => {
    const measure = dutyPeriodCountV1.measure({ periods: ['duty', 'flight_duty'] }, periods, window, []);
    expect(measure.quantity).toEqual(rational(3n));
    expect(measure.counted).toEqual(['p1', 'p2', 'p5']);
  });

  it('sums hours inside the window, counts overlap once per person, and reports a period with no end as a gap', () => {
    const measure = dutyHoursV1.measure({ periods: ['duty', 'flight_duty'] }, periods, window, []);
    // pilot-1: 06:00 to 16:00 is 10 hours; pilot-2: 00:00 to 02:00 inside the window is 2 hours.
    expect(measure.quantity).toEqual(rational(12n));
    expect(measure.counted).toEqual(['p1', 'p2', 'p3']);
    expect(measure.gaps).toEqual([
      { code: 'duty_period_end_unrecorded', subjectKey: 'ledger/person/pilot-3', observationIds: ['p5'] },
    ]);
  });
});

describe('time in service', () => {
  const start = '2026-11-01T00:00:00.000Z',
    end = '2026-11-02T00:00:00.000Z';

  it('takes the difference of the recorded totals at the window bounds, in exact decimal hours', () => {
    const measure = timeInServiceHoursV1.measure(
      {},
      [
        timeInService('t1', 'tail-1', start, 1234.5),
        timeInService('t2', 'tail-1', end, 1240.2),
        timeInService('t3', 'tail-2', start, 10.1),
        timeInService('t4', 'tail-2', end, 10.3),
      ],
      window,
      [aircraft('tail-1'), aircraft('tail-2')],
    );
    expect(measure.quantity).toEqual(rational(59n, 10n));
    expect(measure.counted).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('reports missing or partial totals as gaps and disagreeing or decreasing totals as conflicts', () => {
    const measure = timeInServiceHoursV1.measure(
      {},
      [
        timeInService('a1', 'tail-1', start, 100),
        timeInService('b1', 'tail-2', start, 100),
        timeInService('b2', 'tail-2', end, 101, 'partial'),
        timeInService('c1', 'tail-3', start, 100),
        timeInService('c2', 'tail-3', start, 100.5),
        timeInService('c3', 'tail-3', end, 101),
        timeInService('d1', 'tail-4', start, 100),
        timeInService('d2', 'tail-4', end, 99),
      ],
      window,
      ['tail-1', 'tail-2', 'tail-3', 'tail-4', 'tail-5'].map(aircraft),
    );
    expect(measure.quantity).toEqual(rational(0n));
    expect(measure.gaps.map((note) => [note.subjectKey, note.code])).toEqual([
      ['source/made-up-log/aircraft/tail-1', 'time_in_service_unrecorded_at_end'],
      ['source/made-up-log/aircraft/tail-2', 'time_in_service_coverage_partial'],
      ['source/made-up-log/aircraft/tail-5', 'time_in_service_unrecorded_at_start'],
      ['source/made-up-log/aircraft/tail-5', 'time_in_service_unrecorded_at_end'],
    ]);
    expect(measure.conflicts.map((note) => [note.subjectKey, note.code])).toEqual([
      ['source/made-up-log/aircraft/tail-3', 'time_in_service_totals_disagree'],
      ['source/made-up-log/aircraft/tail-4', 'time_in_service_decreased'],
    ]);
  });
});

describe('exposure kind registry', () => {
  it('holds the library kinds and refuses a changed definition under a published version', () => {
    // The registry keeps the first copy registered (source or build), so compare definitions, not identity.
    expect(exposureKindDigest(findExposureKind('exposure.flight-hours', 1)!)).toBe(exposureKindDigest(flightHoursV1));
    registerExposureKind(flightHoursV1);
    expect(() => registerExposureKind({ ...flightHoursV1, description: 'Changed.' })).toThrow(/another definition/);
    expect(() => registerExposureKind({ ...flightHoursV1, id: 'Flight Hours' })).toThrow(/domain.noun/);
    expect(
      exposureKindDigest({
        ...flightHoursV1,
        measure: () => ({ quantity: rational(0n), counted: [], gaps: [], conflicts: [] }),
      }),
    ).toBe(exposureKindDigest(flightHoursV1));
  });
});

describe('flight hours with coverage', () => {
  const params = { type: 'made-up.heartbeat', versions: [1], maxSilenceMilliseconds: 60_000 };
  const beat = (id: string, flightId: string, occurredAt: string) =>
    observation(id, 'made-up.heartbeat', [flight(flightId)], occurredAt, {});

  it('counts airborne time while observations of the declared type were being received', () => {
    const beats = ['10:00:00', '10:01:00', '10:02:00', '10:05:00', '10:06:00'].map((time, index) =>
      beat(`b${index}`, 'f1', `2026-11-01T${time}.000Z`),
    );
    const measure = coveredFlightHoursV1.measure(
      params,
      [report('r1', 'f1', { takeoffAt: '2026-11-01T10:00:00.000Z', landingAt: '2026-11-01T10:06:00.000Z' }), ...beats],
      window,
      [],
    );
    // Received from 10:00 to 10:02 and from 10:05 to 10:06: three of the six airborne minutes.
    expect(measure.quantity).toEqual(rational(1n, 20n));
    expect(measure.counted).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'r1']);
    expect(measure.gaps).toEqual([
      { code: 'coverage_not_received', subjectKey: 'source/made-up-log/flight/f1', observationIds: ['r1'] },
    ]);
    expect(coveredFlightHoursV1.reads(params)).toEqual([
      { type: 'flight.report', versions: [1] },
      { type: 'operator.record', versions: [1], alternative: true },
      { type: 'made-up.heartbeat', versions: [1] },
    ]);
  });

  it('reports airborne time with nothing received, and unreported landings, as gaps', () => {
    const measure = coveredFlightHoursV1.measure(
      params,
      [
        report('r1', 'f1', { takeoffAt: '2026-11-01T10:00:00.000Z', landingAt: '2026-11-01T10:06:00.000Z' }),
        report('r2', 'f2', { activity: 'active', takeoffAt: '2026-11-01T11:00:00.000Z' }),
        beat('b1', 'f2', '2026-11-01T11:00:00.000Z'),
        beat('b2', 'f2', '2026-11-01T11:01:00.000Z'),
      ],
      window,
      [],
    );
    expect(measure.quantity).toEqual(rational(0n));
    expect(measure.gaps.map((gap) => gap.code)).toEqual(['coverage_not_received', 'landing_unreported']);
  });

  it('needs the state established at the window start for a flight then airborne, when the definition asks', () => {
    const withState = {
      ...params,
      stateAtWindowStart: [[{ field: 'values.state', operator: 'equals' as const, value: 'known' }]],
    };
    const measure = (state: string) =>
      coveredFlightHoursV1.measure(
        withState,
        [
          report('r1', 'f1', { takeoffAt: '2026-10-31T23:58:00.000Z', landingAt: '2026-11-01T00:02:00.000Z' }),
          observation('b1', 'made-up.heartbeat', [flight('f1')], '2026-10-31T23:59:30.000Z', {}),
          observation('b2', 'made-up.heartbeat', [flight('f1')], '2026-11-01T00:00:00.000Z', { state }),
          observation('b3', 'made-up.heartbeat', [flight('f1')], '2026-11-01T00:01:00.000Z', {}),
          observation('b4', 'made-up.heartbeat', [flight('f1')], '2026-11-01T00:02:00.000Z', {}),
        ],
        window,
        [],
      );
    expect(measure('known').gaps).toEqual([]);
    expect(measure('known').quantity).toEqual(rational(1n, 30n));
    expect(measure('unclear').gaps).toEqual([
      {
        code: 'state_not_established_at_window_start',
        subjectKey: 'source/made-up-log/flight/f1',
        observationIds: ['r1'],
      },
    ]);
  });
});
