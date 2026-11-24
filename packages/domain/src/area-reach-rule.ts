import type { ControlApplicabilityMeasure, ControlApplicabilityOutcome } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { ApplicabilityPlan, ControlApplicabilityDeclaration } from './control-types.js';
import {
  calculationDefinition,
  calculationMeta,
  corridorBound,
  type CurveSegment,
  type DistanceBudget,
  geodesicDistance,
  missionSegments,
  validPosition,
} from './mission-avoidance-kernel.js';

/**
 * Whether an area control bears on a flight: whether the planned corridor comes within the control's declared reach
 * of the area's edge. It reuses the avoidance calculation's geometry and bounds with a wider threshold; anything it
 * cannot settle applies.
 */
export const areaReachDefinition = Object.freeze({
  id: 'ledger.control-applicability.area-reach',
  version: 1,
  title: 'Planned corridor within the declared reach of an area',
  geometryFrom: Object.freeze({
    id: calculationMeta.id,
    version: calculationMeta.version,
    digest: calculationMeta.digest,
  }),
  profile: calculationDefinition.profile,
  geometry: calculationDefinition.geometry,
  library: calculationDefinition.library,
  libraryVersion: calculationDefinition.libraryVersion,
  ellipsoid: calculationDefinition.ellipsoid,
  numericalMarginMeters: calculationDefinition.numericalMarginMeters,
  maxControlRadiusMeters: calculationDefinition.maxControlRadiusMeters,
  maxReachMeters: 50000,
  reachFrom: 'area_edge',
  distance: 'shortest_geodesic_distance_from_area_centre_to_planned_centreline',
  threshold: 'radiusMeters+appliesWithinMeters+lateralToleranceMeters',
  firstBound: 'distance_to_first_position-curveLengthBound-0.001',
  segmentBound: 'min_over_segments(min(distance_to_start,distance_to_end)-lengthBound/2-0.002)',
  sampleUpper: calculationDefinition.sampleUpper,
  intervalLower: calculationDefinition.intervalLower,
  maxRefinementDepth: calculationDefinition.maxRefinementDepth,
  applies: 'sample_upper_at_most_threshold',
  doesNotApply: 'first_bound_or_every_interval_lower_strictly_greater_than_threshold',
  distanceBudget: 4096,
  clearance:
    'floor(largest_of_first_bound_segment_bound_and_interval_bound_computed_within_budget-radiusMeters-lateralToleranceMeters)',
  uncertainty: 'applies',
});

const areaReachDigest = '4667a798dbaac5e9e22960c29b909906616a56b1ac1f12fdd7214633147d9f62';
if (canonicalDigest(areaReachDefinition) !== areaReachDigest)
  throw new Error('Area reach applicability rule version 1 changed without a new version');

export interface AreaReachParameters {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  appliesWithinMeters?: number;
}

/** Metres with a space between thousands and at most three decimals, as the sentences show them. */
export function meters(value: number): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
  const [whole, fraction] = text.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * The smallest over the segments of the nearer end's distance less half the segment's length bound: every point of a
 * segment lies within half its length of one of its ends. One distance per position after the first, which is already
 * known; -Infinity when they do not fit the remaining budget or one cannot be computed.
 */
function segmentLowerBound(
  center: AreaReachParameters['center'],
  segments: readonly CurveSegment[],
  first: number,
  budget: DistanceBudget,
): number {
  if (budget.used + segments.length > budget.maximum) return -Infinity;
  let lowest = Infinity;
  let previous = first;
  for (const segment of segments) {
    budget.used++;
    const next = geodesicDistance(center, segment.end[1], segment.end[0]);
    if (next === undefined) return -Infinity;
    const margin = areaReachDefinition.numericalMarginMeters;
    lowest = Math.min(lowest, Math.min(previous, next) - margin - (segment.lengthBound / 2 + margin));
    previous = next;
  }
  return lowest;
}

function undetermined(reasons: string[], summary?: string): ControlApplicabilityOutcome {
  return { applies: 'undetermined', reasons, ...(summary ? { summary } : {}) };
}

function evaluateAreaReach(parameters: AreaReachParameters, plan: ApplicabilityPlan): ControlApplicabilityOutcome {
  const { center, radiusMeters, appliesWithinMeters: reach } = parameters;
  if (reach === undefined)
    return undetermined(
      ['no_reach_declared'],
      'This control declares no reach, so it applies to every flight in its interval.',
    );
  const unsettled = 'The distance from this route to the area could not be settled, so the control applies.';
  if (
    !validPosition([center.longitude, center.latitude]) ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0 ||
    radiusMeters > areaReachDefinition.maxControlRadiusMeters ||
    !Number.isFinite(reach) ||
    reach < 0 ||
    reach > areaReachDefinition.maxReachMeters
  )
    return undetermined(['control_geometry_outside_profile'], unsettled);
  const route = missionSegments(plan.mission);
  if (route.segments === null) return undetermined(route.reasons, unsettled);

  const tolerance = plan.mission.lateralToleranceMeters;
  const threshold = radiusMeters + reach + tolerance;
  const declared: ControlApplicabilityMeasure[] = [
    { name: 'appliesWithinMeters', value: reach, unit: 'm' },
    { name: 'radiusMeters', value: radiusMeters, unit: 'm' },
  ];
  const segments = route.segments;
  const [longitude, latitude] = plan.mission.route.geometry.coordinates[0]!;
  const first = geodesicDistance(center, latitude, longitude);
  if (first === undefined) return undetermined(['distance_calculation_invalid'], unsettled);
  const budget: DistanceBudget = { maximum: areaReachDefinition.distanceBudget, used: 1 };
  // Whether it applies is settled first; the clearance recorded is then the largest sound lower bound computed within
  // the budget, so a far control does not read as only just clear.
  const doesNotApply = (lowerBound: number): ControlApplicabilityOutcome => {
    const largest = Math.max(lowerBound, segmentLowerBound(center, segments, first, budget));
    const clearance = Math.floor(largest - radiusMeters - tolerance);
    return {
      applies: false,
      measured: [{ name: 'clearanceAtLeastMeters', value: clearance, unit: 'm' }],
      declared,
      summary: `The planned corridor stays at least ${meters(clearance)} m from the area; the control applies within ${meters(reach)} m.`,
    };
  };

  const curveLengthBound = segments.reduce(
    (sum, segment) => sum + segment.lengthBound + areaReachDefinition.numericalMarginMeters,
    0,
  );
  const firstBound = first - curveLengthBound - areaReachDefinition.numericalMarginMeters;
  if (firstBound > threshold) return doesNotApply(firstBound);

  const bound = corridorBound(segments, center, threshold, budget);
  if (bound.bound === 'beyond') return doesNotApply(Math.max(firstBound, bound.lowerBoundMeters));
  if (bound.bound === 'within')
    return {
      applies: true,
      measured: [{ name: 'comesWithinMeters', value: reach, unit: 'm' }],
      declared,
      summary: `The planned corridor comes within ${meters(reach)} m of the area; the control applies within ${meters(reach)} m.`,
    };
  return undetermined(
    bound.reasons,
    bound.reasons.includes('distance_budget_exhausted')
      ? 'The distance from this route to the area could not be settled (distance budget used up), so the control applies.'
      : unsettled,
  );
}

export const areaReachApplicability: ControlApplicabilityDeclaration<AreaReachParameters> = Object.freeze({
  rule: Object.freeze({ id: areaReachDefinition.id, version: areaReachDefinition.version, digest: areaReachDigest }),
  definition: areaReachDefinition,
  evaluate: evaluateAreaReach,
});
