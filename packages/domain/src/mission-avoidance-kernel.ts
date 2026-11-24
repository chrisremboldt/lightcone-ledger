import type { MissionRoute } from '@ledger/contracts';
import GeographicLib from 'geographiclib-geodesic';
import { calculationDefinition } from './mission-avoidance-definition.js';
export { calculationDefinition, calculationMeta } from './mission-avoidance-definition.js';

export interface MissionAvoidanceCircle {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
}

export interface MissionAvoidanceGeometryInput {
  mission: { route: MissionRoute; lateralToleranceMeters: number };
  circles: readonly MissionAvoidanceCircle[];
  distanceBudget?: number;
}

export interface MissionAvoidanceGeometryResult {
  verdict: 'outside' | 'intersects' | 'insufficient';
  reasons: string[];
}

export interface MissionAvoidanceKernelResult {
  results: MissionAvoidanceGeometryResult[];
  reasons: string[];
  distanceCalculations: number;
  remainingDistanceBudget: number;
}

type Position = readonly [longitude: number, latitude: number];

export interface CurveSegment {
  start: Position;
  end: Position;
  lengthBound: number;
}

export interface DistanceBudget {
  maximum: number;
  used: number;
}

interface CurveInterval {
  start: number;
  end: number;
  depth: number;
}

const radiansPerDegree = Math.PI / 180;
const margin = calculationDefinition.numericalMarginMeters;

export function validPosition(position: Position): boolean {
  return (
    Array.isArray(position) &&
    position.length === 2 &&
    Number.isFinite(position[0]) &&
    Number.isFinite(position[1]) &&
    Math.abs(position[0]) <= calculationDefinition.maxAbsLongitudeDegrees &&
    Math.abs(position[1]) <= calculationDefinition.maxAbsLatitudeDegrees
  );
}

/** The planned centreline as curve segments with their length bounds, or why it is outside the profile. */
export function missionSegments(
  mission: MissionAvoidanceGeometryInput['mission'],
): { segments: CurveSegment[]; reasons: [] } | { segments: null; reasons: string[] } {
  const route = mission.route;
  if (
    !route ||
    route.coordinateReference !== 'WGS84' ||
    route.coordinateOrder !== 'longitude_latitude' ||
    route.segmentInterpolation !== 'linear_longitude_latitude' ||
    route.geometry?.type !== 'LineString' ||
    !Array.isArray(route.geometry.coordinates) ||
    route.geometry.coordinates.length < 2 ||
    route.geometry.coordinates.length > calculationDefinition.maxPositions ||
    !route.geometry.coordinates.every(validPosition)
  )
    return { segments: null, reasons: ['mission_geometry_outside_profile'] };
  if (
    !Number.isFinite(mission.lateralToleranceMeters) ||
    mission.lateralToleranceMeters < 0 ||
    mission.lateralToleranceMeters > calculationDefinition.maxLateralToleranceMeters
  )
    return { segments: null, reasons: ['mission_tolerance_outside_profile'] };

  const segments: CurveSegment[] = [];
  let totalLengthBound = 0;
  for (let index = 1; index < route.geometry.coordinates.length; index++) {
    const start = route.geometry.coordinates[index - 1];
    const end = route.geometry.coordinates[index];
    const longitudeDelta = end[0] - start[0];
    if (Math.abs(longitudeDelta) > calculationDefinition.maxLongitudeDeltaDegrees)
      return { segments: null, reasons: ['mission_antimeridian_segment_unsupported'] };
    const latitudeDelta = end[1] - start[1];
    const lengthBound =
      calculationDefinition.metricRadiusUpperBoundMeters *
      Math.hypot(latitudeDelta * radiansPerDegree, longitudeDelta * radiansPerDegree);
    totalLengthBound += lengthBound + margin;
    segments.push({ start, end, lengthBound });
  }
  if (totalLengthBound > calculationDefinition.maxCurveLengthMeters)
    return { segments: null, reasons: ['mission_curve_length_outside_profile'] };
  return { segments, reasons: [] };
}

function insufficient(reasons: string[]): MissionAvoidanceGeometryResult {
  return { verdict: 'insufficient', reasons };
}

function evaluateCircle(
  segments: readonly CurveSegment[],
  circle: MissionAvoidanceCircle,
  tolerance: number,
  budget: DistanceBudget,
): MissionAvoidanceGeometryResult {
  if (
    !circle.center ||
    !validPosition([circle.center.longitude, circle.center.latitude]) ||
    !Number.isFinite(circle.radiusMeters) ||
    circle.radiusMeters <= 0 ||
    circle.radiusMeters > calculationDefinition.maxControlRadiusMeters
  )
    return insufficient(['control_geometry_outside_profile']);

  const bound = corridorBound(segments, circle.center, circle.radiusMeters + tolerance, budget);
  if (bound.bound === 'within') return { verdict: 'intersects', reasons: [] };
  if (bound.bound === 'beyond') return { verdict: 'outside', reasons: [] };
  return insufficient(bound.reasons);
}

export type CorridorBound =
  | { bound: 'within'; reasons: [] }
  | { bound: 'beyond'; lowerBoundMeters: number; reasons: [] }
  | { bound: 'uncertain'; reasons: string[] };

/**
 * Whether the centreline comes within threshold of a point, by the calculation's conservative bounds: one sample whose
 * upper bound is at most threshold makes it within; every interval's lower bound strictly greater than threshold makes
 * it beyond, and the smallest of those bounds is returned. Every distance computed counts against the budget.
 */
export function corridorBound(
  segments: readonly CurveSegment[],
  center: { latitude: number; longitude: number },
  threshold: number,
  budget: DistanceBudget,
): CorridorBound {
  const unresolved = new Set<string>();
  let lowest = Infinity;
  for (const segment of segments) {
    const intervals: CurveInterval[] = [{ start: 0, end: 1, depth: 0 }];
    while (intervals.length > 0) {
      if (budget.used >= budget.maximum)
        return { bound: 'uncertain', reasons: [...unresolved, 'distance_budget_exhausted'] };
      const interval = intervals.pop()!;
      const midpoint = (interval.start + interval.end) / 2;
      const longitude = segment.start[0] + (segment.end[0] - segment.start[0]) * midpoint;
      const latitude = segment.start[1] + (segment.end[1] - segment.start[1]) * midpoint;
      budget.used++;
      const distance = geodesicDistance(center, latitude, longitude);
      if (distance === undefined) return { bound: 'uncertain', reasons: ['distance_calculation_invalid'] };

      const intervalLength = segment.lengthBound * (interval.end - interval.start);
      const halfCurveLengthBound = intervalLength / 2 + margin;
      const upper = distance + margin;
      const lower = Math.max(0, distance - margin - halfCurveLengthBound);
      if (upper <= threshold) return { bound: 'within', reasons: [] };
      if (lower > threshold) {
        lowest = Math.min(lowest, lower);
        continue;
      }
      if (
        intervalLength + margin <= calculationDefinition.minimumIntervalCurveBoundMeters ||
        interval.depth >= calculationDefinition.maxRefinementDepth ||
        midpoint === interval.start ||
        midpoint === interval.end
      ) {
        unresolved.add('geometry_refinement_uncertain');
        continue;
      }
      intervals.push(
        { start: midpoint, end: interval.end, depth: interval.depth + 1 },
        { start: interval.start, end: midpoint, depth: interval.depth + 1 },
      );
    }
  }
  return unresolved.size > 0
    ? { bound: 'uncertain', reasons: [...unresolved] }
    : { bound: 'beyond', lowerBoundMeters: lowest, reasons: [] };
}

/** The shortest WGS84 geodesic distance in metres, or undefined when the library gives no usable value. */
export function geodesicDistance(
  center: { latitude: number; longitude: number },
  latitude: number,
  longitude: number,
): number | undefined {
  let distance: number | undefined;
  try {
    distance = GeographicLib.Geodesic.WGS84.Inverse(
      center.latitude,
      center.longitude,
      latitude,
      longitude,
      GeographicLib.Geodesic.DISTANCE,
    ).s12;
  } catch {
    return undefined;
  }
  return distance === undefined || !Number.isFinite(distance) || distance < 0 ? undefined : distance;
}

export function evaluateMissionAvoidanceGeometry(input: MissionAvoidanceGeometryInput): MissionAvoidanceKernelResult {
  const maximum = input.distanceBudget ?? calculationDefinition.distanceBudget;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > calculationDefinition.distanceBudget) {
    const reasons = ['distance_budget_invalid'];
    return {
      results: input.circles.map(() => insufficient([...reasons])),
      reasons,
      distanceCalculations: 0,
      remainingDistanceBudget: 0,
    };
  }
  const mission = missionSegments(input.mission);
  if (mission.segments === null)
    return {
      results: input.circles.map(() => insufficient([...mission.reasons])),
      reasons: mission.reasons,
      distanceCalculations: 0,
      remainingDistanceBudget: maximum,
    };

  const segments = mission.segments;
  const budget: DistanceBudget = { maximum, used: 0 };
  const results = input.circles.map((circle) =>
    evaluateCircle(segments, circle, input.mission.lateralToleranceMeters, budget),
  );
  return {
    results,
    reasons: [],
    distanceCalculations: budget.used,
    remainingDistanceBudget: budget.maximum - budget.used,
  };
}
