import type { MissionAvoidanceCalculation } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

export const calculationDefinition = Object.freeze({
  id: 'ledger.demo.mission-site-avoidance',
  version: 1,
  title: 'Recorded mission site avoidance',
  status: 'draft',
  review: 'ai_drafted',
  adopted: false,
  profile: 'ledger.local-mission-avoidance.1',
  geometry: 'ledger.wgs84-conservative-bounds.1',
  library: 'geographiclib-geodesic',
  libraryVersion: '2.2.0',
  ellipsoid: 'WGS84',
  numericalMarginMeters: 0.001,
  metricRadiusUpperBoundMeters: 6400000,
  distanceBudget: 100000,
  maxPositions: 256,
  maxAbsLatitudeDegrees: 80,
  maxAbsLongitudeDegrees: 180,
  maxLongitudeDeltaDegrees: 180,
  maxCurveLengthMeters: 50000,
  maxControlRadiusMeters: 10000,
  maxLateralToleranceMeters: 1000,
  maxRefinementDepth: 48,
  minimumIntervalCurveBoundMeters: 0.002,
  centerline: 'linear_longitude_latitude_without_wrapping',
  corridor: 'closed_geodesic_corridor_including_endpoint_caps',
  control: 'closed_geodesic_circle_at_all_altitudes',
  curveLengthBound: '6400000*hypot(deltaLatitudeRadians,deltaLongitudeRadians)+0.001',
  sampleUpper: 'distance+0.001',
  intervalLower: 'max(0,distance-0.001-halfCurveLengthBound)',
  intersection: 'sample_upper_at_most_radius_plus_tolerance',
  outside: 'every_interval_lower_strictly_greater_than_radius_plus_tolerance',
  uncertainty: 'insufficient',
  instruction:
    'Compare the recorded continuous planned corridor with each supplied manual site-avoidance circle using conservative WGS84 distance bounds. This draft calculation records geometry consistency only; it does not establish control implementation, enforcement or mission release.',
} as const);

const calculationDigest = '7ef485fc10cbdaedab3195b727bc6ef45aebb74e9090132910376fa2bd998308';
if (canonicalDigest(calculationDefinition) !== calculationDigest)
  throw new Error('Mission avoidance calculation version 1 changed without a new version');

export const calculationMeta: Readonly<MissionAvoidanceCalculation> = Object.freeze({
  id: calculationDefinition.id,
  version: calculationDefinition.version,
  digest: calculationDigest,
  profile: calculationDefinition.profile,
  geometry: calculationDefinition.geometry,
  distanceBudget: calculationDefinition.distanceBudget,
});
