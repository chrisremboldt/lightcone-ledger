import { describe, expect, it } from 'vitest';
import {
  calculationDefinition,
  calculationMeta,
  evaluateMissionAvoidanceGeometry,
  type MissionAvoidanceGeometryInput,
} from '../../packages/domain/src/mission-avoidance-kernel.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';

function mission(
  coordinates: MissionAvoidanceGeometryInput['mission']['route']['geometry']['coordinates'],
  lateralToleranceMeters = 0,
): MissionAvoidanceGeometryInput['mission'] {
  return {
    route: {
      coordinateReference: 'WGS84',
      coordinateOrder: 'longitude_latitude',
      segmentInterpolation: 'linear_longitude_latitude',
      geometry: { type: 'LineString', coordinates },
    },
    lateralToleranceMeters,
  };
}

describe('conservative mission avoidance geometry', () => {
  it('finds an interior crossing even when both supplied vertices are outside', () => {
    const result = evaluateMissionAvoidanceGeometry({
      mission: mission([
        [-0.015, 0],
        [0.005, 0],
      ]),
      circles: [{ center: { latitude: 0, longitude: 0 }, radiusMeters: 10 }],
    });
    expect(result.results).toEqual([{ verdict: 'intersects', reasons: [] }]);
    expect(result.distanceCalculations).toBeGreaterThan(1);
  });

  it('includes the lateral corridor and rounded endpoint caps', () => {
    const coordinates: MissionAvoidanceGeometryInput['mission']['route']['geometry']['coordinates'] = [
      [0, 0],
      [0.001, 0],
    ];
    const circles = [
      { center: { latitude: 0.00015, longitude: 0.0005 }, radiusMeters: 5 },
      { center: { latitude: 0, longitude: -0.00015 }, radiusMeters: 5 },
    ];
    expect(
      evaluateMissionAvoidanceGeometry({ mission: mission(coordinates, 20), circles }).results.map(
        (result) => result.verdict,
      ),
    ).toEqual(['intersects', 'intersects']);
    expect(
      evaluateMissionAvoidanceGeometry({ mission: mission(coordinates), circles }).results.map(
        (result) => result.verdict,
      ),
    ).toEqual(['outside', 'outside']);
  });

  it('certifies outside only from continuous bounds under the pinned calculation', () => {
    const result = evaluateMissionAvoidanceGeometry({
      mission: mission(
        [
          [0, 0],
          [0.001, 0],
        ],
        10,
      ),
      circles: [{ center: { latitude: 0.01, longitude: 0.0005 }, radiusMeters: 50 }],
    });
    expect(result.results).toEqual([{ verdict: 'outside', reasons: [] }]);
    expect(result.reasons).toEqual([]);
    expect(canonicalDigest(calculationDefinition)).toBe(calculationMeta.digest);
    expect(Object.isFrozen(calculationDefinition)).toBe(true);
    expect(Object.isFrozen(calculationMeta)).toBe(true);
  });

  it('fails closed for unsupported empty-candidate missions and shares one distance budget', () => {
    const unsupported = evaluateMissionAvoidanceGeometry({
      mission: mission([
        [0, 81],
        [0.001, 81],
      ]),
      circles: [],
    });
    expect(unsupported.reasons).toEqual(['mission_geometry_outside_profile']);
    expect(unsupported.distanceCalculations).toBe(0);

    const bounded = evaluateMissionAvoidanceGeometry({
      mission: mission([
        [0, 0],
        [0.001, 0],
      ]),
      circles: [
        { center: { latitude: 0.01, longitude: 0.0005 }, radiusMeters: 50 },
        { center: { latitude: 0, longitude: 0.0005 }, radiusMeters: 10 },
      ],
      distanceBudget: 1,
    });
    expect(bounded.results).toEqual([
      { verdict: 'outside', reasons: [] },
      { verdict: 'insufficient', reasons: ['distance_budget_exhausted'] },
    ]);
    expect(bounded.distanceCalculations).toBe(1);
    expect(bounded.remainingDistanceBudget).toBe(0);
  });

  it('retains numerical uncertainty instead of declaring a submillimetre circle outside', () => {
    const result = evaluateMissionAvoidanceGeometry({
      mission: mission([
        [0, 0],
        [0, 0],
      ]),
      circles: [{ center: { latitude: 0, longitude: 0 }, radiusMeters: 0.0001 }],
    });
    expect(result.results).toEqual([{ verdict: 'insufficient', reasons: ['geometry_refinement_uncertain'] }]);
    expect(result.distanceCalculations).toBe(1);
  });
});
