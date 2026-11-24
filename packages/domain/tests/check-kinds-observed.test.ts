import { describe, expect, it } from 'vitest';
import { checkParameterProblem, type CheckInputs, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import {
  authorizationCoversFlightV1,
  valueFlownOrPlannedV1,
  type AuthorizationCoversFlightParams,
  type FlownOrPlannedParams,
} from '../src/check-kind-library-observed.js';

// Made-up plans, positions and authorizations. The kinds read only the fields their parameters and the vocabulary name.

const t0 = Date.parse('2026-11-02T10:00:00.000Z');
const at = (minute: number) => new Date(t0 + minute * 60_000).toISOString();
const clock = { mode: 'wall' as const, evaluatedAt: at(240) };

let sequence = 0;
const id = (prefix: string) => `${prefix}-${String(++sequence).padStart(4, '0')}`;

function plan(record: Record<string, unknown> = {}): CheckObservation {
  const values = { recordType: 'flight.plan', recordVersion: 1, record: { start: at(0), end: at(60), ...record } };
  return {
    id: id('plan'),
    type: 'operator.record',
    version: 1,
    occurredAt: at(-60),
    observation: { type: 'operator.record', version: 1, occurredAt: at(-60), values },
  };
}

function position(
  minute: number,
  altitude?: { meters: number; datum: string },
  values: Record<string, unknown> = {},
  point = { latitudeDegrees: 41.88, longitudeDegrees: -87.63 },
): CheckObservation {
  return {
    id: id('position'),
    type: 'position.fix',
    version: 1,
    occurredAt: at(minute),
    observation: {
      type: 'position.fix',
      version: 1,
      occurredAt: at(minute),
      position: { ...point, ...(altitude ? { altitude } : {}) },
      values: { fix: 'unknown', ...values },
    },
  };
}

const newestFirst = (items: CheckObservation[]) =>
  [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || (a.id < b.id ? 1 : -1));

describe('value.flown-or-planned@1', () => {
  const height: FlownOrPlannedParams = {
    plannedField: 'values.record.plannedHeightMeters',
    plannedDescribes: 'planned maximum height above ground level',
    flownField: 'position.altitude.meters',
    flownDescribes: 'height',
    measures: [
      {
        where: [{ field: 'position.altitude.datum', oneOf: ['ground_level'] }],
        describes: 'flown height above ground level',
        compared: true,
      },
      {
        where: [{ field: 'position.altitude.datum', oneOf: ['takeoff_point'] }],
        describes: 'flown height above the takeoff point',
        compared: true,
      },
      {
        where: [{ field: 'position.altitude.datum', oneOf: ['wgs84_ellipsoid'] }],
        describes: 'height above the WGS84 ellipsoid',
        compared: false,
      },
    ],
    unusable: [{ field: 'values.fix', oneOf: ['none'] }],
    comparison: 'at_most',
    limit: 120,
    limitDescribes: 'at most 400 feet, 121.92 m',
    unit: 'm',
  };
  const run = (inputs: CheckInputs, params: FlownOrPlannedParams = height) =>
    valueFlownOrPlannedV1.evaluate(params, inputs, clock);

  it('accepts its parameters and refuses measures without a flown field', () => {
    expect(checkParameterProblem('value.flown-or-planned', 1, height)).toBeUndefined();
    const { flownField: _field, flownDescribes: _describes, ...planOnly } = height;
    expect(checkParameterProblem('value.flown-or-planned', 1, planOnly)).toMatch(/flownField/);
  });

  it('rests on the plan when no flown value is on record, and says so', () => {
    const result = run({ plan: [plan({ plannedHeightMeters: 100 })], flown: [] });
    expect(result).toMatchObject({
      outcome: 'pass',
      evidenceState: 'supported',
      reasonCode: 'planned_within_limit',
      details: { basis: 'planned', measured: 'planned maximum height above ground level', value: 100, valueAt: null },
    });
    expect(result.summary).toBe(
      'No flown height is reported for this flight; the result rests on the plan. The planned maximum height above ground level is 100 m, within the limit (at most 400 feet, 121.92 m).',
    );
    expect(run({ plan: [plan({ plannedHeightMeters: 130 })], flown: [] })).toMatchObject({
      outcome: 'attention',
      reasonCode: 'planned_beyond_limit',
      details: { basis: 'planned', margin: -10 },
    });
  });

  it('reads the flown value once it is on record, within the limit', () => {
    const flown = newestFirst(
      [0, 10, 20].map((minute) => position(minute, { meters: 80 + minute, datum: 'takeoff_point' })),
    );
    const result = run({ plan: [plan({ plannedHeightMeters: 100 })], flown });
    expect(result).toMatchObject({
      outcome: 'pass',
      reasonCode: 'flown_within_limit',
      details: {
        basis: 'flown',
        measured: 'flown height above the takeoff point',
        value: 100,
        valueAt: at(20),
        plannedValue: 100,
        flownValues: 3,
      },
    });
    expect(result.summary).toBe(
      `Read the flown height above the takeoff point: of 3 value(s) on record for this flight, the highest is 100 m at ${at(20)}, within the limit (at most 400 feet, 121.92 m). The planned maximum height above ground level is 100 m, within the limit.`,
    );
    expect(result.evidence).toContain(flown[0]!.id);
  });

  it('needs attention when the flown value is beyond the limit after a plan within it', () => {
    const flown = newestFirst([
      position(5, { meters: 90, datum: 'ground_level' }),
      position(6, { meters: 131.5, datum: 'ground_level' }),
      position(7, { meters: 140, datum: 'ground_level' }, { fix: 'none' }),
    ]);
    const result = run({ plan: [plan({ plannedHeightMeters: 100 })], flown });
    expect(result).toMatchObject({
      outcome: 'attention',
      evidenceState: 'supported',
      reasonCode: 'flown_beyond_limit',
      details: { basis: 'flown', measured: 'flown height above ground level', value: 131.5, margin: -11.5 },
    });
    expect(result.summary).toMatch(/^Read the flown height above ground level: .* is 131\.5 m at .*, beyond the limit/);
    expect(result.summary).toMatch(/The planned maximum height above ground level is 100 m, within the limit\.$/);
  });

  it('never compares a height in another datum with the limit: it names it and rests on the plan', () => {
    const flown = newestFirst([position(1, { meters: 300, datum: 'wgs84_ellipsoid' }), position(2, undefined)]);
    const result = run({ plan: [plan({ plannedHeightMeters: 100 })], flown });
    expect(result).toMatchObject({
      outcome: 'pass',
      reasonCode: 'planned_within_limit',
      details: { basis: 'planned', flownValues: 0, flownNotCompared: 1 },
    });
    expect(result.summary).toMatch(
      /^1 flown value\(s\) are reported for this flight, but they state height above the WGS84 ellipsoid, which this rule does not compare with its limit; the result rests on the plan\./,
    );
  });

  it('is pending with neither a flown nor a planned value, and says a rule reading no flown value rests on the plan', () => {
    expect(run({ plan: [plan()], flown: [] })).toMatchObject({
      outcome: 'pending',
      evidenceState: 'insufficient',
      reasonCode: 'planned_value_missing',
    });
    const { flownField: _f, flownDescribes: _d, measures: _m, unusable: _u, ...planOnly } = height;
    expect(run({ plan: [plan({ plannedHeightMeters: 50 })] }, planOnly).summary).toMatch(
      /^This rule reads no flown value; the result rests on the plan\./,
    );
  });

  describe('with the operator’s own record of the flight', () => {
    const recordedHeight: FlownOrPlannedParams = {
      ...height,
      recordedField: 'values.record.maxHeightFlownAboveGroundMeters',
      recordedDescribes: 'maximum height flown above ground level in the operator’s flight record',
      measures: height.measures!.map((measure) =>
        measure.describes === 'flown height above the takeoff point' ? { ...measure, afterRecorded: true } : measure,
      ),
    };
    function flightRecord(meters?: number): CheckObservation {
      const values = {
        recordType: 'flight.record',
        recordVersion: 1,
        record: {
          takeoffAt: at(5),
          landingAt: at(40),
          ...(meters === undefined ? {} : { maxHeightFlownAboveGroundMeters: meters }),
        },
      };
      return {
        id: id('record'),
        type: 'operator.record',
        version: 1,
        occurredAt: at(90),
        interval: { start: at(5), end: at(40) },
        observation: { type: 'operator.record', version: 1, occurredAt: at(90), values },
      };
    }
    const runRecorded = (inputs: CheckInputs) => valueFlownOrPlannedV1.evaluate(recordedHeight, inputs, clock);

    it('accepts the recorded field only with its words', () => {
      expect(checkParameterProblem('value.flown-or-planned', 1, recordedHeight)).toBeUndefined();
      const { recordedDescribes: _words, ...unnamed } = recordedHeight;
      expect(checkParameterProblem('value.flown-or-planned', 1, unnamed)).toMatch(/recordedDescribes/);
    });

    it('reads positions above ground level first, and states the recorded value beside them', () => {
      const flown = newestFirst([position(10, { meters: 95, datum: 'ground_level' })]);
      const record = flightRecord(104.5);
      const result = runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [record], flown });
      expect(result).toMatchObject({
        outcome: 'pass',
        reasonCode: 'flown_within_limit',
        details: { basis: 'flown', measured: 'flown height above ground level', value: 95, recordedValue: 104.5 },
      });
      expect(result.summary).toBe(
        `Read the flown height above ground level: of 1 value(s) on record for this flight, the highest is 95 m at ${at(10)}, within the limit (at most 400 feet, 121.92 m). The maximum height flown above ground level in the operator’s flight record is 104.5 m, within the limit; the reported value is read, not the recorded one. The planned maximum height above ground level is 100 m, within the limit.`,
      );
      expect(result.evidence).toEqual([flown[0]!.id, record.id, expect.any(String)]);
    });

    it('reads the recorded value when no position states a height above ground level, and says so', () => {
      const flown = newestFirst([
        position(10, { meters: 300, datum: 'wgs84_ellipsoid' }),
        position(12, { meters: 90, datum: 'takeoff_point' }),
      ]);
      const record = flightRecord(130);
      const result = runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [record], flown });
      expect(result).toMatchObject({
        outcome: 'attention',
        evidenceState: 'supported',
        reasonCode: 'recorded_beyond_limit',
        details: {
          basis: 'recorded',
          measured: 'maximum height flown above ground level in the operator’s flight record',
          value: 130,
          valueAt: null,
          margin: -10,
          flownValues: 0,
          flownNotCompared: 2,
        },
      });
      expect(result.summary).toBe(
        '1 flown value(s) are reported for this flight, but they state height above the WGS84 ellipsoid, which this rule does not compare with its limit; the result rests on the operator’s own record of the flight. Read the maximum height flown above ground level in the operator’s flight record: 130 m, beyond the limit (at most 400 feet, 121.92 m). The planned maximum height above ground level is 100 m, within the limit. 2 other flown value(s) state height above the WGS84 ellipsoid and flown height above the takeoff point and are not compared.',
      );
      expect(result.evidence).toContain(record.id);
      expect(
        runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [flightRecord(110)], flown: [] }).summary,
      ).toBe(
        'No flown height is reported for this flight; the result rests on the operator’s own record of the flight. Read the maximum height flown above ground level in the operator’s flight record: 110 m, within the limit (at most 400 feet, 121.92 m). The planned maximum height above ground level is 100 m, within the limit.',
      );
    });

    it('rests on the plan with neither, naming what was missing', () => {
      const result = runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [flightRecord()], flown: [] });
      expect(result).toMatchObject({
        outcome: 'pass',
        reasonCode: 'planned_within_limit',
        details: { basis: 'planned', recordedValue: null },
      });
      expect(result.summary).toBe(
        'No flown height is reported for this flight; the result rests on the plan. No record of the flight as flown states a maximum height flown above ground level in the operator’s flight record. The planned maximum height above ground level is 100 m, within the limit (at most 400 feet, 121.92 m).',
      );
      // Without a recorded value a takeoff-point height is compared as before.
      const flown = newestFirst([position(12, { meters: 90, datum: 'takeoff_point' })]);
      expect(runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [], flown })).toMatchObject({
        details: { basis: 'flown', measured: 'flown height above the takeoff point', value: 90 },
      });
    });

    it('conflicts when records made at the same time state different values', () => {
      const [one, two] = [flightRecord(100), flightRecord(110)];
      expect(
        runRecorded({ plan: [plan({ plannedHeightMeters: 100 })], recorded: [one!, two!], flown: [] }),
      ).toMatchObject({
        evidenceState: 'conflicting',
        reasonCode: 'recorded_values_disagree',
      });
    });
  });

  it('compares the lowest flown value for an at-least limit', () => {
    const speed: FlownOrPlannedParams = {
      plannedField: 'values.record.minimum',
      plannedDescribes: 'planned minimum',
      flownField: 'values.groundSpeedMetersPerSecond',
      flownDescribes: 'ground speed',
      comparison: 'at_least',
      limit: 5,
    };
    const flown = newestFirst([
      position(1, undefined, { groundSpeedMetersPerSecond: 7 }),
      position(2, undefined, { groundSpeedMetersPerSecond: 4 }),
    ]);
    expect(run({ plan: [plan({ minimum: 6 })], flown }, speed)).toMatchObject({
      outcome: 'attention',
      details: { basis: 'flown', measured: 'ground speed', value: 4 },
    });
  });
});

describe('authorization.covers-flight@1', () => {
  const params: AuthorizationCoversFlightParams = {
    plannedStartField: 'values.record.start',
    plannedEndField: 'values.record.end',
    plannedHeightField: 'values.record.plannedHeightMeters',
    plannedHeightDescribes: 'planned maximum height above ground level',
    heightField: 'position.altitude.meters',
    measures: [
      {
        where: [{ field: 'position.altitude.datum', oneOf: ['takeoff_point'] }],
        describes: 'flown height above the takeoff point',
        compared: true,
      },
    ],
    unusable: [{ field: 'values.fix', oneOf: ['none'] }],
    inForce: ['approved'],
    awaiting: ['requested', 'unknown'],
    ceilingDatums: ['ground_level'],
  };
  const square = [
    { latitudeDegrees: 41.87, longitudeDegrees: -87.64 },
    { latitudeDegrees: 41.89, longitudeDegrees: -87.64 },
    { latitudeDegrees: 41.89, longitudeDegrees: -87.62 },
    { latitudeDegrees: 41.87, longitudeDegrees: -87.62 },
  ];
  function authorization(
    values: Record<string, unknown> = {},
    interval: { start: string; end?: string } = { start: at(-10), end: at(90) },
    reportedAt = at(-30),
  ): CheckObservation {
    const body = {
      authorizationId: 'AUTH-1',
      reportedStatus: 'approved',
      ceiling: { meters: 121.92, datum: 'ground_level' },
      area: { boundary: square },
      ...values,
    };
    return {
      id: id('authorization'),
      type: 'airspace.authorization',
      version: 1,
      occurredAt: reportedAt,
      interval,
      observation: { type: 'airspace.authorization', version: 1, occurredAt: reportedAt, interval, values: body },
    };
  }
  const run = (inputs: CheckInputs) => authorizationCoversFlightV1.evaluate(params, inputs, clock);
  const planned = () => plan({ plannedHeightMeters: 100 });

  it('accepts its parameters', () => {
    expect(checkParameterProblem('authorization.covers-flight', 1, params)).toBeUndefined();
  });

  it('reads the flight record’s takeoff, landing and height where no position is on record', () => {
    const recordedParams: AuthorizationCoversFlightParams = {
      ...params,
      recordedStartField: 'values.record.takeoffAt',
      recordedEndField: 'values.record.landingAt',
      recordedHeightField: 'values.record.maxHeightFlownAboveGroundMeters',
      recordedHeightDescribes: 'maximum height flown above ground level in the operator’s flight record',
    };
    expect(checkParameterProblem('authorization.covers-flight', 1, recordedParams)).toBeUndefined();
    const logged = (takeoff: number, landing: number, meters: number): CheckObservation => {
      const values = {
        recordType: 'flight.record',
        recordVersion: 1,
        record: { takeoffAt: at(takeoff), landingAt: at(landing), maxHeightFlownAboveGroundMeters: meters },
      };
      const interval = { start: at(takeoff), end: at(landing) };
      return {
        id: id('record'),
        type: 'operator.record',
        version: 1,
        occurredAt: at(120),
        interval,
        observation: { type: 'operator.record', version: 1, occurredAt: at(120), interval, values },
      };
    };
    const runRecorded = (inputs: CheckInputs) => authorizationCoversFlightV1.evaluate(recordedParams, inputs, clock);
    const covered = runRecorded({
      authorizations: [authorization()],
      plan: [planned()],
      recorded: [logged(5, 50, 110)],
      flown: [],
    });
    expect(covered).toMatchObject({
      outcome: 'pass',
      details: {
        basis: 'recorded',
        flightStart: at(5),
        flightEnd: at(50),
        heightRead: 110,
        heightMeasured: 'maximum height flown above ground level in the operator’s flight record',
      },
    });
    expect(covered.summary).toMatch(/covers the flight’s recorded takeoff to landing, with a ceiling of 121\.92 m/);
    expect(covered.summary).toMatch(/The flight record states no position/);
    // A landing after the authorization ends, and a recorded height above its ceiling, are each named.
    const beyond = runRecorded({
      authorizations: [authorization()],
      plan: [planned()],
      recorded: [logged(60, 100, 130)],
      flown: [],
    });
    expect(beyond).toMatchObject({ outcome: 'attention', details: { basis: 'recorded', problem: 'expired' } });
    expect(beyond.summary).toMatch(/its ceiling, 121\.92 m above ground level, is below the maximum height flown/);
  });

  it('is supported by one covering the planned window with a high enough ceiling, and names it', () => {
    const result = run({ authorizations: [authorization()], plan: [planned()], flown: [] });
    expect(result).toMatchObject({
      outcome: 'pass',
      evidenceState: 'supported',
      reasonCode: 'authorization_covers',
      details: {
        basis: 'planned',
        authorizationId: 'AUTH-1',
        authorizationStatus: 'approved',
        ceilingMeters: 121.92,
        heightRead: 100,
        heightMeasured: 'planned maximum height above ground level',
        problem: null,
      },
    });
    expect(result.summary).toMatch(
      /^Authorization AUTH-1, reported approved at .*, covers the flight’s planned window/,
    );
    expect(result.summary).toMatch(
      /The plan states no place, so whether its area covers the flight is not compared\.$/,
    );
  });

  it('is supported by flown positions inside its area, below its ceiling', () => {
    const flown = newestFirst([5, 30].map((minute) => position(minute, { meters: 110, datum: 'takeoff_point' })));
    expect(run({ authorizations: [authorization()], plan: [planned()], flown })).toMatchObject({
      outcome: 'pass',
      details: { basis: 'flown', flightStart: at(5), flightEnd: at(30), heightRead: 110, positionsOutside: 0 },
    });
  });

  it('is insufficient with none on record, never a finding', () => {
    expect(run({ authorizations: [], plan: [planned()], flown: [] })).toMatchObject({
      outcome: 'pending',
      evidenceState: 'insufficient',
      reasonCode: 'authorization_missing',
    });
  });

  it('needs attention for one that had expired before the flight ended', () => {
    const result = run({
      authorizations: [authorization({}, { start: at(-10), end: at(30) })],
      plan: [planned()],
      flown: [],
    });
    expect(result).toMatchObject({
      outcome: 'attention',
      reasonCode: 'authorization_not_covering',
      details: { authorizationId: 'AUTH-1', problem: 'expired' },
    });
    expect(result.summary).toContain(`AUTH-1: ended at ${at(30)}, before the flight’s ${at(60)}.`);
    const reported = run({
      authorizations: [authorization({ reportedStatus: 'expired' })],
      plan: [planned()],
      flown: [],
    });
    expect(reported).toMatchObject({ outcome: 'attention', details: { problem: 'status' } });
  });

  it('needs attention for one covering another place', () => {
    const elsewhere = { latitudeDegrees: 41.95, longitudeDegrees: -87.63 };
    const flown = newestFirst([position(5, undefined, {}), position(6, undefined, {}, elsewhere)]);
    const result = run({ authorizations: [authorization()], plan: [planned()], flown });
    expect(result).toMatchObject({
      outcome: 'attention',
      details: { basis: 'flown', problem: 'other_place', positionsOutside: 1 },
    });
    expect(result.summary).toMatch(/AUTH-1: 1 of 2 flown positions are outside its area, up to \d+(\.\d+)? m\./);
  });

  it('needs attention for one whose ceiling is below the height read', () => {
    const result = run({
      authorizations: [authorization({ ceiling: { meters: 60.96, datum: 'ground_level' } })],
      plan: [planned()],
      flown: [],
    });
    expect(result).toMatchObject({ outcome: 'attention', details: { problem: 'ceiling_below', ceilingMeters: 60.96 } });
    expect(result.summary).toContain(
      'AUTH-1: its ceiling, 60.96 m above ground level, is below the planned maximum height above ground level, 100 m.',
    );
  });

  it('reads the status reported by the flight’s end: a later close does not undo it, a requested one is awaited', () => {
    const closedLater = authorization({ reportedStatus: 'cancelled' }, undefined, at(120));
    expect(run({ authorizations: [closedLater, authorization()], plan: [planned()], flown: [] })).toMatchObject({
      outcome: 'pass',
      details: { authorizationStatus: 'approved' },
    });
    expect(
      run({ authorizations: [authorization({ reportedStatus: 'requested' })], plan: [planned()], flown: [] }),
    ).toMatchObject({ outcome: 'pending', reasonCode: 'authorization_awaited' });
  });

  it('passes when any one supports it, naming that one', () => {
    const low = authorization({ authorizationId: 'AUTH-0', ceiling: { meters: 30, datum: 'ground_level' } });
    expect(run({ authorizations: [low, authorization()], plan: [planned()], flown: [] })).toMatchObject({
      outcome: 'pass',
      details: { authorizationId: 'AUTH-1' },
    });
  });
});
