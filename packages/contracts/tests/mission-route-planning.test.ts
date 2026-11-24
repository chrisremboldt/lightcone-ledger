import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { MissionSourceSchema, MissionRouteSuggestionRequestSchema, missionRoutePlanningReasons } from '../src/index.js';
import { missionSource } from '../fixtures/demo/v1/missions.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const coordinates = missionSource.route.geometry.coordinates;
const planning = {
  version: 'mission.route-planning.1',
  requiredLocations: [
    { role: 'launch', position: coordinates[0] },
    { role: 'service', position: coordinates[1] },
    { role: 'return', position: coordinates.at(-1) },
  ],
  cruiseMetersPerSecond: 15,
  ascentMs: 20_000,
  serviceMs: 20_000,
  descentMs: 20_000,
  holdAllowanceMs: 0,
  handoffAllowanceMs: 30_000,
  marginMs: 10_000,
  customerInterval: missionSource.operatingInterval,
  resourceInterval: missionSource.operatingInterval,
};

describe('source planning context contract', () => {
  it('retains an optional bounded source context while old mission sources remain valid', () => {
    const validate = ajv.compile(MissionSourceSchema);
    expect(validate(missionSource)).toBe(true);
    expect(validate({ ...missionSource, routePlanning: planning }), JSON.stringify(validate.errors)).toBe(true);
    expect(missionRoutePlanningReasons(planning, coordinates, missionSource.operatingInterval)).toEqual([]);
    for (const invalid of [
      { ...planning, cruiseMetersPerSecond: 0 },
      { ...planning, holdAllowanceMs: -1 },
      { ...planning, marginMs: 0 },
      { ...planning, vendorAuthorization: true },
    ])
      expect(validate({ ...missionSource, routePlanning: invalid })).toBe(false);
    expect(
      missionRoutePlanningReasons(
        { ...planning, requiredLocations: [...planning.requiredLocations].reverse() },
        coordinates,
        missionSource.operatingInterval,
      ),
    ).toContain('route_planning_locations_invalid');
    expect(
      missionRoutePlanningReasons(
        {
          ...planning,
          resourceInterval: { ...missionSource.operatingInterval, start: missionSource.operatingInterval.end },
        },
        coordinates,
        missionSource.operatingInterval,
      ),
    ).toContain('route_planning_context_invalid');
  });

  it('requires exact mission/context references and a finite authored clearance for a read-only suggestion', () => {
    const validate = ajv.compile(MissionRouteSuggestionRequestSchema);
    const request = {
      expectedMission: {
        missionId: 'mission',
        sourceRevision: 1,
        eventId: 'event',
        contentDigest: 'a'.repeat(64),
        recordDigest: 'b'.repeat(64),
      },
      expectedContextDigest: 'c'.repeat(64),
      clearanceMeters: 25,
    };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, clearanceMeters: 0 })).toBe(false);
    expect(validate({ ...request, circles: [] })).toBe(false);
  });
});
