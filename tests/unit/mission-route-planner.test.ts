import { describe, expect, it } from 'vitest';
import type { MissionRevisionRecord, MissionRoutePlanning } from '../../packages/contracts/src/index.js';
import { missionRecord } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { evaluateMissionAvoidanceGeometry } from '../../packages/domain/src/mission-avoidance-kernel.js';
import { modeledMissionTimeFit, suggestMissionRoute } from '../../packages/domain/src/mission-route-planner.js';

const evaluatedAt = '2026-10-18T12:00:00.000Z';
const interval = { start: evaluatedAt, end: '2026-10-18T12:15:00.000Z' };
const planning: MissionRoutePlanning = {
  version: 'mission.route-planning.1',
  requiredLocations: [
    { role: 'launch', position: [0, 0] },
    { role: 'service', position: [0.02, 0] },
    { role: 'return', position: [0, 0] },
  ],
  cruiseMetersPerSecond: 15,
  ascentMs: 20_000,
  serviceMs: 20_000,
  descentMs: 20_000,
  holdAllowanceMs: 30_000,
  handoffAllowanceMs: 30_000,
  marginMs: 10_000,
  customerInterval: interval,
  resourceInterval: interval,
};
function mission(): MissionRevisionRecord {
  return {
    ...structuredClone(missionRecord),
    route: {
      ...missionRecord.route,
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.02, 0],
          [0, 0],
        ],
      },
    },
    lateralToleranceMeters: 30,
    operatingInterval: { ...interval },
    routePlanning: structuredClone(planning),
  };
}

describe('bounded mission detours', () => {
  it('deterministically clears multiple accepted circles including the whole corridor and authored clearance while retaining stops', () => {
    const original = mission();
    const circles = [
      { center: { longitude: 0.007, latitude: 0 }, radiusMeters: 180 },
      { center: { longitude: 0.014, latitude: 0 }, radiusMeters: 200 },
    ];
    const result = suggestMissionRoute(original, circles, 25, evaluatedAt);
    expect(result.status).toBe('suggested');
    expect(result).toEqual(suggestMissionRoute(original, circles, 25, evaluatedAt));
    expect(result.distance!.changeMeters).toBeGreaterThan(0);
    expect(result.timeFit.status).toBe('fits');
    const coordinates = result.proposedRoute!.geometry.coordinates;
    expect(coordinates[0]).toEqual([0, 0]);
    expect(coordinates).toContainEqual([0.02, 0]);
    expect(coordinates.at(-1)).toEqual([0, 0]);
    expect(original).toEqual(mission());
    const proof = evaluateMissionAvoidanceGeometry({
      mission: { route: result.proposedRoute!, lateralToleranceMeters: original.lateralToleranceMeters },
      circles: circles.map((circle) => ({ ...circle, radiusMeters: circle.radiusMeters + 25 })),
    });
    expect(proof.results.map((entry) => entry.verdict)).toEqual(['outside', 'outside']);
  });

  it('detours when only the corridor intersects and never moves an infeasible service destination', () => {
    const original = mission();
    original.lateralToleranceMeters = 50;
    expect(
      suggestMissionRoute(
        original,
        [{ center: { longitude: 0.01, latitude: 0.0004 }, radiusMeters: 10 }],
        10,
        evaluatedAt,
      ).status,
    ).toBe('suggested');
    const blocked = suggestMissionRoute(
      original,
      [{ center: { longitude: 0.02, latitude: 0 }, radiusMeters: 20 }],
      10,
      evaluatedAt,
    );
    expect(blocked.status).toBe('infeasible');
    expect(blocked.proposedRoute).toBeNull();
    expect(blocked.reasons).toContain('required_location_inside_avoidance_corridor');
  });

  it('keeps unsupported planning and elapsed customer/resource time explicit without relaxing constraints', () => {
    const original = mission();
    delete original.routePlanning;
    expect(suggestMissionRoute(original, [], 20, evaluatedAt)).toMatchObject({
      status: 'unsupported',
      proposedRoute: null,
      timeFit: { status: 'unsupported' },
      reasons: ['route_planning_context_missing'],
    });
    const expired = suggestMissionRoute(mission(), [], 20, '2026-10-18T12:14:00.000Z');
    expect(expired.status).toBe('infeasible');
    expect(expired.proposedRoute).toEqual(mission().route);
    expect(expired.timeFit).toMatchObject({ status: 'insufficient', reasons: ['mission_interval_insufficient'] });
    expect(expired.timeFit.slackMs).toBeLessThan(0);
  });

  it('fails closed outside the kernel profile and retains exact phase/time allowances', () => {
    const original = mission();
    const fit = modeledMissionTimeFit(original, original.route, evaluatedAt);
    expect(fit.nominalDurationMs).toBe(fit.travelMs! + 60_000);
    expect(Date.parse(fit.requiredCompletionAt!) - Date.parse(fit.departureAt!)).toBe(
      fit.nominalDurationMs! + 30_000 + 10_000,
    );
    expect(fit.departureAt).toBe('2026-10-18T12:00:30.000Z');
    const beyondProofProfile = mission();
    beyondProofProfile.lateralToleranceMeters = 1000;
    expect(
      suggestMissionRoute(
        beyondProofProfile,
        [{ center: { longitude: 0.01, latitude: 0 }, radiusMeters: 10_000 }],
        20,
        evaluatedAt,
      ),
    ).toMatchObject({ status: 'unsupported', proposedRoute: null });
    original.routePlanning!.requiredLocations[1]!.position = [0.03, 0];
    expect(suggestMissionRoute(original, [], 20, evaluatedAt).reasons).toContain(
      'route_planning_required_location_missing',
    );
  });
});
