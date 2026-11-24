import GeographicLib from 'geographiclib-geodesic';
import { OPERATING_AREA_SIZE_LIMIT_METERS } from '@ledger/contracts';
import { describe, expect, it } from 'vitest';
import { checkKindDigest, checkParameterProblem, findCheckKind, type CheckObservation } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import { checkSummaryWording } from '../src/checked-rules.js';
import { geometryCheckKinds, positionInAreaV1, type PositionInAreaParams } from '../src/check-kind-library-geometry.js';

// Minimal made-up positions and areas. The observation types and field names are invented; the kind reads only the
// observation's position and the fields the parameters name.

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-02T11:00:00.000Z' };
const center = { latitude: 41.88, longitude: -87.63 };
const geodesic = GeographicLib.Geodesic.WGS84;

/** The point at a distance and bearing (degrees from north) from a start point. */
function moved(from: { latitude: number; longitude: number }, meters: number, bearing = 90) {
  const line = geodesic.Direct(from.latitude, from.longitude, bearing, meters);
  return { latitude: line.lat2!, longitude: line.lon2! };
}

let sequence = 0;
function fix(
  point: { latitude: number; longitude: number },
  second: number,
  values: Record<string, unknown> = { quality: 'good' },
  altitude?: { meters: number; datum: string },
): CheckObservation {
  const occurredAt = new Date(Date.parse('2026-11-02T10:00:00.000Z') + second * 1000).toISOString();
  sequence += 1;
  return {
    id: `fix-${String(sequence).padStart(4, '0')}`,
    type: 'made-up.fix',
    version: 1,
    occurredAt,
    observation: {
      type: 'made-up.fix',
      version: 1,
      occurredAt,
      position: {
        latitudeDegrees: point.latitude,
        longitudeDegrees: point.longitude,
        ...(altitude ? { altitude } : {}),
      },
      values,
    },
  };
}

/** Inputs arrive newest first. */
const newestFirst = (positions: CheckObservation[]) => [...positions].reverse();

const circle = { centerLatitude: center.latitude, centerLongitude: center.longitude, radiusMeters: 500 };
const base: PositionInAreaParams = { expect: 'inside', scope: 'latest', ...circle };

function run(params: Partial<PositionInAreaParams>, positions: CheckObservation[], area?: CheckObservation[]) {
  const merged = Object.fromEntries(
    Object.entries({ ...base, ...params }).filter(([, value]) => value !== undefined),
  ) as unknown as PositionInAreaParams;
  expect(checkParameterProblem(positionInAreaV1.id, 1, merged)).toBeUndefined();
  return positionInAreaV1.evaluate(merged, { positions: newestFirst(positions), ...(area ? { area } : {}) }, clock);
}

describe('geometry check kinds', () => {
  it('are registered under new ids, compared by digest', () => {
    expect(geometryCheckKinds.map((kind) => `${kind.id}@${kind.version}`)).toEqual([
      'position.in-area@1',
      'position.in-area@2',
    ]);
    for (const kind of geometryCheckKinds)
      expect(checkKindDigest(findCheckKind(kind.id, kind.version)!)).toBe(checkKindDigest(kind));
  });

  it('name no rule, vendor or regulation and use no verdict wording', () => {
    const text = JSON.stringify(geometryCheckKinds.map((kind) => [kind.title, kind.description, kind.details]));
    expect(text).not.toMatch(
      /\b(compliant|compliance|authori[sz]ed|no-go|go|part \d|section|§|nprm|dji|osd|faa|geofence)\b/i,
    );
  });

  it('takes exactly one area, and a height limit only with its datum when keeping inside', () => {
    const problem = (params: Record<string, unknown>) => checkParameterProblem('position.in-area', 1, params);
    expect(problem({ expect: 'inside', scope: 'latest' })).toBeDefined();
    expect(problem({ ...base, areaField: 'values.area' })).toBeDefined();
    expect(problem({ expect: 'inside', scope: 'latest', centerLatitude: 1, centerLongitude: 2 })).toBeDefined();
    expect(problem({ ...base, maxHeightMeters: 120 })).toBeDefined();
    expect(problem({ ...base, maxHeightMeters: 120, heightDatum: 'wgs84_ellipsoid' })).toBeUndefined();
    expect(problem({ ...base, expect: 'outside', maxHeightMeters: 120, heightDatum: 'wgs84_ellipsoid' })).toBeDefined();
    expect(problem({ ...base, accuracyField: 'values.accuracyMeters' })).toBeDefined();
    expect(
      problem({
        expect: 'inside',
        scope: 'any',
        area: { center: { latitude: 41.88, longitude: -87.63 }, radiusMeters: 20_000 },
      }),
    ).toBeDefined();
  });
});

describe('position.in-area with a circle', () => {
  it('passes for a position inside', () => {
    const outcome = run({}, [fix(moved(center, 200), 0)]);
    expect(outcome).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'positions_inside' });
    expect(outcome.details).toMatchObject({ areaShape: 'circle', positionsChecked: 1, unusablePositions: 0 });
    expect(outcome.details!.latestDistanceOutsideMeters).toBeCloseTo(-300, 1);
  });

  it('needs attention for a position outside, stating the distance and the time', () => {
    const outside = fix(moved(center, 650), 10);
    const outcome = run({}, [fix(moved(center, 200), 0), outside]);
    expect(outcome).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'excursion',
      evidence: [outside.id],
    });
    expect(outcome.details).toMatchObject({
      excursionStartedAt: outside.occurredAt,
      excursionLastAt: outside.occurredAt,
      excursionSeconds: 0,
      excursionPositions: 1,
      maxDistanceOutsideMeters: 150,
    });
    expect(outcome.summary).toContain('up to 150 m');
    expect(checkSummaryWording(positionInAreaV1, outcome.summary, outcome.details)).toMatch(
      /^1 position\(s\) from \{excursionStartedAt\} to \{excursion(Started|Last)At\} were outside /,
    );
  });

  it('counts a position on the boundary as inside, and as inside a keep-out area too', () => {
    const onEdge = fix(moved(center, 500, 33), 0);
    expect(run({}, [onEdge])).toMatchObject({ outcome: 'pass', reasonCode: 'positions_inside' });
    expect(run({ expect: 'outside' }, [onEdge])).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    expect(run({}, [fix(moved(center, 500.01, 33), 0)])).toMatchObject({ outcome: 'attention' });
  });

  it('grows the area by the margin, or shrinks it when the margin is negative', () => {
    const position = fix(moved(center, 540), 0);
    expect(run({}, [position])).toMatchObject({ outcome: 'attention' });
    expect(run({ marginMeters: 50 }, [position])).toMatchObject({ outcome: 'pass' });
    const near = fix(moved(center, 480), 1);
    expect(run({ marginMeters: -50 }, [near])).toMatchObject({ outcome: 'attention' });
    expect(run({ marginMeters: -50 }, [near]).details!.maxDistanceOutsideMeters).toBeCloseTo(30, 1);
  });

  it('keeps out of an area: a position inside needs attention', () => {
    const outcome = run({ expect: 'outside' }, [fix(moved(center, 900), 0), fix(moved(center, 100), 5)]);
    expect(outcome).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    expect(outcome.details!.maxDistanceOutsideMeters).toBeCloseTo(400, 1);
    expect(run({ expect: 'outside' }, [fix(moved(center, 900), 0)])).toMatchObject({
      outcome: 'pass',
      reasonCode: 'positions_outside',
    });
  });

  it('compares a height only where the position states one in the stated datum', () => {
    const params = { maxHeightMeters: 120, heightDatum: 'wgs84_ellipsoid' };
    const high = fix(moved(center, 100), 0, { quality: 'good' }, { meters: 150, datum: 'wgs84_ellipsoid' });
    const otherDatum = fix(moved(center, 100), 1, { quality: 'good' }, { meters: 150, datum: 'above_takeoff' });
    expect(run(params, [high])).toMatchObject({ outcome: 'attention' });
    expect(run(params, [high]).details).toMatchObject({ maxHeightAboveLimitMeters: 30, heightsUnchecked: 0 });
    const unchecked = run(params, [otherDatum]);
    expect(unchecked).toMatchObject({ outcome: 'pass' });
    expect(unchecked.details).toMatchObject({ heightsUnchecked: 1 });
  });

  it('counts an excursion only after enough consecutive positions, or long enough', () => {
    const inside = fix(moved(center, 100), 0);
    const first = fix(moved(center, 600), 2);
    const second = fix(moved(center, 700), 4);
    const third = fix(moved(center, 650), 6);
    expect(run({ minPositions: 2 }, [inside, first])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'excursion_unconfirmed',
      evidence: [first.id],
    });
    const counted = run({ minPositions: 2 }, [inside, first, second]);
    expect(counted).toMatchObject({ outcome: 'attention', evidence: [first.id, second.id] });
    expect(counted.details).toMatchObject({ excursionStartedAt: first.occurredAt, excursionPositions: 2 });
    expect(run({ minSeconds: 4 }, [inside, first, second])).toMatchObject({ outcome: 'pending' });
    expect(run({ minSeconds: 4 }, [inside, first, second, third])).toMatchObject({ outcome: 'attention' });
    expect(run({ minSeconds: 4 }, [inside, first, second, third]).details).toMatchObject({ excursionSeconds: 4 });
  });

  it('with scope latest passes again once back inside; with scope any keeps the earlier excursion', () => {
    const positions = [
      fix(moved(center, 100), 0),
      fix(moved(center, 600), 2),
      fix(moved(center, 700), 4),
      fix(moved(center, 120), 6),
    ];
    expect(run({ minPositions: 2 }, positions)).toMatchObject({ outcome: 'pass' });
    const any = run({ minPositions: 2, scope: 'any' }, positions);
    expect(any).toMatchObject({ outcome: 'attention', evidence: [positions[1]!.id, positions[2]!.id] });
    expect(any.details!.maxDistanceOutsideMeters).toBeCloseTo(200, 1);
    // A single stray fix is not an excursion.
    const stray = [fix(moved(center, 100), 0), fix(moved(center, 900), 2), fix(moved(center, 100), 4)];
    expect(run({ minPositions: 2, scope: 'any' }, stray)).toMatchObject({ outcome: 'pass' });
  });

  it('leaves out unusable positions, reports them, and is insufficient when none is usable', () => {
    const unusable = [{ field: 'values.quality', oneOf: ['none'] }];
    const bad = fix(moved(center, 900), 2, { quality: 'none' });
    const vague = fix(moved(center, 900), 3, { quality: 'good', accuracyMeters: 80 });
    const outcome = run({ unusable, accuracyField: 'values.accuracyMeters', maxAccuracyMeters: 25 }, [
      fix(moved(center, 100), 0),
      bad,
      vague,
    ]);
    expect(outcome).toMatchObject({ outcome: 'pass', details: { unusablePositions: 2, positionsChecked: 1 } });
    expect(outcome.summary).toContain(`${bad.id} (the quality none)`);
    expect(outcome.summary).toContain(`${vague.id} (the accuracy meters 80)`);
    expect(run({ unusable }, [bad])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'positions_unusable',
      evidence: [bad.id],
    });
    expect(run({}, [])).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'positions_missing' });
  });

  it('an unusable fix neither ends nor extends an excursion', () => {
    const unusable = [{ field: 'values.quality', oneOf: ['none'] }];
    const first = fix(moved(center, 600), 0);
    const second = fix(moved(center, 650), 4);
    const outcome = run({ unusable, minPositions: 2 }, [first, fix(center, 2, { quality: 'none' }), second]);
    expect(outcome).toMatchObject({ outcome: 'attention', evidence: [first.id, second.id] });
  });
});

describe('position.in-area with a polygon', () => {
  // A square about 1 km a side around the centre, with a 200 m square hole in its middle.
  const corner = (north: number, east: number) => moved(moved(center, north, 0), east, 90);
  const ring = (half: number) => {
    const points = [corner(-half, -half), corner(-half, half), corner(half, half), corner(half, -half)];
    return [...points, points[0]!].map((point) => [point.longitude, point.latitude] as [number, number]);
  };
  const square = { type: 'Polygon' as const, coordinates: [ring(500)] };
  const holed = { type: 'Polygon' as const, coordinates: [ring(500), ring(100)] };

  it('places positions inside, outside, on an edge and in a hole', () => {
    expect(run({ area: square, ...noCircle }, [fix(corner(300, 200), 0)])).toMatchObject({ outcome: 'pass' });
    const outside = run({ area: square, ...noCircle }, [fix(corner(0, 560), 0)]);
    expect(outside).toMatchObject({ outcome: 'attention', details: { areaShape: 'polygon' } });
    expect(outside.details!.maxDistanceOutsideMeters).toBeCloseTo(60, 0);
    expect(run({ area: square, ...noCircle }, [fix(corner(0, 500), 0)])).toMatchObject({ outcome: 'pass' });
    expect(run({ area: holed, ...noCircle }, [fix(center, 0)])).toMatchObject({ outcome: 'attention' });
    expect(run({ area: holed, ...noCircle }, [fix(corner(0, 300), 0)])).toMatchObject({ outcome: 'pass' });
  });

  it('measures the distance to the nearest corner as a geodesic distance', () => {
    const beyond = moved(corner(500, 500), 100, 45);
    const outcome = run({ area: square, ...noCircle }, [fix(beyond, 0)]);
    expect(outcome.details!.maxDistanceOutsideMeters).toBeCloseTo(100, 0);
  });

  it('is insufficient for an unclosed ring', () => {
    const open = {
      type: 'Polygon' as const,
      coordinates: [
        ring(500)
          .slice(0, 4)
          .concat([ring(500)[1]!]),
      ],
    };
    expect(run({ area: open, ...noCircle }, [fix(center, 0)])).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'area_invalid',
    });
  });
});

const noCircle = { centerLatitude: undefined, centerLongitude: undefined, radiusMeters: undefined };

describe('position.in-area with an area from another input', () => {
  const recorded = (id: string, area: unknown, at = '2026-11-02T09:00:00.000Z'): CheckObservation => ({
    id,
    type: 'made-up.area',
    version: 1,
    occurredAt: at,
    observation: { type: 'made-up.area', version: 1, occurredAt: at, values: { area } },
  });
  const params = { areaField: 'values.area', ...noCircle };
  const circleShape = { center, radiusMeters: 500 };

  it('reads a circle in the shape area controls state, citing the area record', () => {
    const area = recorded('area-1', circleShape);
    const outside = fix(moved(center, 700), 0);
    expect(run(params, [outside], [area])).toMatchObject({ outcome: 'attention', evidence: ['area-1', outside.id] });
  });

  it('is insufficient without an area, and conflicting when simultaneous areas disagree', () => {
    expect(run(params, [fix(center, 0)], [])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'area_missing',
    });
    expect(run(params, [fix(center, 0)], [recorded('area-1', { center, radiusMeters: -3 })])).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'area_invalid',
    });
    expect(
      run(
        params,
        [fix(center, 0)],
        [recorded('area-1', circleShape), recorded('area-2', { ...circleShape, radiusMeters: 800 })],
      ),
    ).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'areas_disagree' });
  });

  it('reads only the latest area', () => {
    const areas = [
      recorded('area-new', { ...circleShape, radiusMeters: 800 }, '2026-11-02T09:30:00.000Z'),
      recorded('area-old', circleShape),
    ];
    expect(run(params, [fix(moved(center, 700), 0)], areas)).toMatchObject({ outcome: 'pass' });
  });
});

describe('position.in-area@2 with area records', () => {
  const fields = {
    idField: 'values.record.areaId',
    shapeField: 'values.record.shape',
    centerField: 'values.record.center',
    radiusField: 'values.record.radiusMeters',
    pointsField: 'values.record.corridorPoints',
    halfWidthField: 'values.record.corridorHalfWidthMeters',
  };
  const params = { expect: 'inside', scope: 'any', minPositions: 1, areaRecords: fields } as const;
  const written = (point: { latitude: number; longitude: number }) =>
    `${point.latitude.toFixed(7)}, ${point.longitude.toFixed(7)}`;
  function area(record: Record<string, unknown>, from = '2026-11-01T00:00:00.000Z', until?: string): CheckObservation {
    sequence += 1;
    const interval = { start: from, ...(until ? { end: until } : {}) };
    return {
      id: `area-${sequence}`,
      type: 'made-up.record',
      version: 1,
      occurredAt: from,
      interval,
      observation: { occurredAt: from, interval, values: { record } },
    };
  }
  const circleArea = (areaId: string, radiusMeters: number, at = center) =>
    area({ areaId, shape: 'circle', center: written(at), radiusMeters });
  // A corridor 100 m either side of a 60 km line due east, from the centre: much longer than any one piece measured.
  const end = moved(center, 60_000, 90);
  const corridor = area({
    areaId: 'LINE-1',
    shape: 'corridor',
    corridorPoints: `${written(center)}; ${written(end)}`,
    corridorHalfWidthMeters: 100,
  });
  const evaluate = (positions: CheckObservation[], areas: CheckObservation[], extra: Record<string, unknown> = {}) => {
    const merged = { ...params, ...extra };
    expect(checkParameterProblem('position.in-area', 2, merged)).toBeUndefined();
    return findCheckKind('position.in-area', 2)!.evaluate(
      merged,
      { positions: newestFirst(positions), area: areas },
      clock,
    );
  };
  /** A point beside the line, at a distance along it, on its north side. */
  const beside = (along: number, off: number) => moved(moved(center, along, 90), off, 0);

  it('is inside a corridor near the middle of a long leg, and outside it beyond its half-width', () => {
    const inside = evaluate([fix(beside(30_000, 90), 0)], [corridor]);
    expect(inside).toMatchObject({ outcome: 'pass', reasonCode: 'positions_inside' });
    expect(inside.summary).toContain('every operating area in force (operating area LINE-1)');
    const outside = evaluate([fix(beside(30_000, 130), 0)], [corridor]);
    expect(outside).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    // A leg 60 km long is measured along its geodesic: the distance beyond the half-width is about 30 m.
    expect(Number(outside.details!.maxDistanceOutsideMeters)).toBeGreaterThan(29);
    expect(Number(outside.details!.maxDistanceOutsideMeters)).toBeLessThan(31);
    // Past the end of the line the corridor ends too.
    expect(evaluate([fix(beside(60_500, 0), 0)], [corridor])).toMatchObject({ outcome: 'attention' });
  });

  it('places a position inside when it is inside any area in force, and names every area', () => {
    const far = moved(center, 20_000, 0);
    const areas = [circleArea('RIDGE-AREA-1', 1_000), circleArea('RIDGE-AREA-2', 1_000, far), corridor];
    const result = evaluate([fix(center, 0), fix(far, 10), fix(beside(45_000, 50), 20)], areas);
    expect(result).toMatchObject({ outcome: 'pass' });
    expect(result.summary).toContain('the 3 operating areas LINE-1, RIDGE-AREA-1, RIDGE-AREA-2');
    expect(evaluate([fix(moved(center, 5_000, 180), 0)], areas)).toMatchObject({ outcome: 'attention' });
  });

  it('reads an area only while it is in force, and says when none was', () => {
    const ended = area(
      { areaId: 'OLD-1', shape: 'circle', center: written(center), radiusMeters: 1_000 },
      '2026-01-01T00:00:00.000Z',
      '2026-11-02T10:00:05.000Z',
    );
    const result = evaluate([fix(center, 0), fix(center, 10)], [ended]);
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    expect(result.summary).toContain('1 of them when no operating area was in force');
    expect(result.details!.maxDistanceOutsideMeters).toBeNull();
  });

  it('holds a radius or half-width of exactly 50,000 m, the bound the record type states, and leaves out more', () => {
    expect(OPERATING_AREA_SIZE_LIMIT_METERS).toBe(50_000);
    const atBound = circleArea('WIDE-1', OPERATING_AREA_SIZE_LIMIT_METERS);
    expect(evaluate([fix(moved(center, 49_999, 0), 0)], [atBound])).toMatchObject({ outcome: 'pass' });
    const beyond = circleArea('WIDE-2', OPERATING_AREA_SIZE_LIMIT_METERS + 1);
    const refused = evaluate([fix(center, 0)], [beyond]);
    expect(refused).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'area_invalid' });
    expect(refused.summary).toBe(
      'No operating area on file states a shape a position can be placed against: WIDE-2 states a radius of 50001 m, more than the 50000 m an area may reach.',
    );
    const wideCorridor = area({
      areaId: 'WIDE-3',
      shape: 'corridor',
      corridorPoints: `${written(center)}; ${written(end)}`,
      corridorHalfWidthMeters: OPERATING_AREA_SIZE_LIMIT_METERS,
    });
    expect(evaluate([fix(beside(10_000, 49_999), 0)], [wideCorridor])).toMatchObject({ outcome: 'pass' });
  });

  it('names an area whose shape cannot be read, leaves it out, and places positions against the others', () => {
    const unreadable = area({
      areaId: 'BAD-1',
      shape: 'corridor',
      corridorPoints: '41.88 -87.63',
      corridorHalfWidthMeters: 50,
    });
    const noRadius = area({ areaId: 'BAD-2', shape: 'circle', center: written(center) });
    const result = evaluate([fix(center, 0)], [unreadable, noRadius, circleArea('GOOD-1', 500)]);
    expect(result).toMatchObject({ outcome: 'pass' });
    expect(result.summary).toContain(
      'Left out, as no position can be placed against them: BAD-1 has points that cannot be read: a corridor needs at least two points, separated by semicolons; BAD-2 states no radius.',
    );
    expect(evaluate([fix(center, 0)], [])).toMatchObject({
      reasonCode: 'area_missing',
      summary: 'No operating area is on file.',
    });
  });
});
