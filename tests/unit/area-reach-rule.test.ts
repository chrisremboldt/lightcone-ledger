import { describe, expect, test } from 'vitest';
import type { MissionRoute } from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { registeredControlTypeDigest, type ApplicabilityPlan } from '../../packages/domain/src/control-types.js';
import { avoidanceAreaControlType } from '../../packages/domain/src/control-type-library.js';
import {
  evaluateControlApplicability,
  type ControlApplicabilityInputs,
} from '../../packages/domain/src/control-applicability.js';
import { areaReachApplicability, areaReachDefinition } from '../../packages/domain/src/area-reach-rule.js';
import { calculationMeta, geodesicDistance } from '../../packages/domain/src/mission-avoidance-kernel.js';

const pinned = () => ({
  id: avoidanceAreaControlType.id,
  version: 1,
  digest: registeredControlTypeDigest(avoidanceAreaControlType.id, 1)!,
});
const center = { latitude: 40, longitude: -105 };
const area = { center, radiusMeters: 250, site: 'Example yard' };
/** About one metre of latitude in degrees near the area, for placing fictional routes. */
const metre = 1 / 111034;

function plan(coordinates: MissionRoute['geometry']['coordinates'], lateralToleranceMeters = 0): ApplicabilityPlan {
  return {
    mission: {
      aircraftId: 'AC-17',
      sourceMissionId: 'example-mission-1',
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: { type: 'LineString', coordinates },
      },
      lateralToleranceMeters,
      altitude: { minimum: 0, maximum: 100, unit: 'm', reference: 'AGL' },
      operatingInterval: { start: '2026-11-20T14:00:00Z', end: '2026-11-20T15:00:00Z' },
    },
  };
}

const inputs: ControlApplicabilityInputs = {
  mission: {
    missionId: 'example-mission',
    sourceRevision: 1,
    eventId: 'example-mission-event-1',
    contentDigest: canonicalDigest({ example: 'mission content' }),
    recordDigest: canonicalDigest({ example: 'mission record' }),
  },
  control: {
    controlId: 'example-area-control',
    versionNumber: 1,
    controlEventId: 'example-area-control-v1',
    bodyDigest: canonicalDigest({ example: 'area control body' }),
  },
  reviewRequired: false,
};

const evaluate = (parameters: Record<string, unknown>, routePlan: ApplicabilityPlan, review = false) =>
  evaluateControlApplicability(pinned(), parameters, routePlan, { ...inputs, reviewRequired: review });

const eastward = (northMeters: number, from = -105.01, to = -104.99) => [
  [from, 40 + northMeters * metre],
  [to, 40 + northMeters * metre],
];

describe('area reach applicability rule, version 1', () => {
  test('is pinned by its frozen definition, which enters the area type definition', () => {
    expect(Object.isFrozen(areaReachDefinition)).toBe(true);
    expect(areaReachApplicability.rule).toEqual({
      id: 'ledger.control-applicability.area-reach',
      version: 1,
      digest: canonicalDigest(areaReachDefinition),
    });
    expect(areaReachApplicability.rule.digest).toBe('4667a798dbaac5e9e22960c29b909906616a56b1ac1f12fdd7214633147d9f62');
    expect(areaReachDefinition.geometryFrom).toEqual({
      id: calculationMeta.id,
      version: calculationMeta.version,
      digest: calculationMeta.digest,
    });
    // The area type stays version 1; its digest moved when it gained the reach and the rule.
    expect(pinned().digest).toBe('2395def95d291518f6f44e8cccfbdcf9415c56a6ae6fa67f97fd8044031af6d3');
  });

  test('golden vectors', () => {
    const point = [-105, 40 + 900 * metre];
    const clearance = geodesicDistance(center, point[1]!, point[0]!)! - area.radiusMeters;
    const reach = 500;
    const square = (() => {
      const north = 350.01 * metre;
      const east = 350.01 / 85390;
      return [
        [-105 - east, 40 + north],
        [-105 + east, 40 + north],
        [-105 + east, 40 - north],
        [-105 - east, 40 - north],
        [-105 - east, 40 + north],
      ];
    })();
    const vectors = {
      far: evaluate({ ...area, appliesWithinMeters: reach }, plan(eastward(20000), 20)),
      farByBisection: evaluate({ ...area, appliesWithinMeters: reach }, plan(eastward(1200, -105.05, -104.95), 20)),
      near: evaluate({ ...area, appliesWithinMeters: reach }, plan(eastward(550), 20)),
      inside: evaluate({ ...area, appliesWithinMeters: reach }, plan(eastward(0), 20)),
      reachPlus: evaluate({ ...area, appliesWithinMeters: clearance + 0.002 }, plan([point, point])),
      reachMinus: evaluate({ ...area, appliesWithinMeters: clearance - 0.002 }, plan([point, point])),
      reachMinusMore: evaluate({ ...area, appliesWithinMeters: clearance - 0.003 }, plan([point, point])),
      outsideProfile: evaluate(
        { ...area, appliesWithinMeters: reach },
        plan([
          [-105, 81],
          [-104.9, 81],
        ]),
      ),
      budgetUsedUp: evaluate({ ...area, appliesWithinMeters: 100 }, plan(square)),
      noReach: evaluate(area, plan(eastward(20000), 20)),
      underReview: evaluate({ ...area, appliesWithinMeters: reach }, plan(eastward(20000), 20), true),
    };
    const shown = Object.fromEntries(
      Object.entries(vectors).map(([name, { record, digest }]) => [
        name,
        { outcome: record.outcome, basis: record.basis, measured: record.measured, summary: record.summary, digest },
      ]),
    );
    expect(shown).toMatchInlineSnapshot(`
      {
        "budgetUsedUp": {
          "basis": "undetermined",
          "digest": "baa09919a289da46fd032e3a918afee40d96f77a489138e3176a3b60b9dbd7bd",
          "measured": [],
          "outcome": "applies",
          "summary": "The distance from this route to the area could not be settled (distance budget used up), so the control applies.",
        },
        "far": {
          "basis": "rule",
          "digest": "8df96075238f2106b20177cba1a4535e20c9e3bf5778676228af00d2a5965f68",
          "measured": [
            {
              "name": "clearanceAtLeastMeters",
              "unit": "m",
              "value": 18631,
            },
          ],
          "outcome": "does_not_apply",
          "summary": "The planned corridor stays at least 18 631 m from the area; the control applies within 500 m.",
        },
        "farByBisection": {
          "basis": "rule",
          "digest": "4745c6a1101d45b8ff1d49cf258f54dbe66e2b81563bf0d97733798be587a1dd",
          "measured": [
            {
              "name": "clearanceAtLeastMeters",
              "unit": "m",
              "value": 610,
            },
          ],
          "outcome": "does_not_apply",
          "summary": "The planned corridor stays at least 610 m from the area; the control applies within 500 m.",
        },
        "inside": {
          "basis": "rule",
          "digest": "b582482d6ceb5ed7c905015e3941cddf59a724269e998cf25faf8913be19fe54",
          "measured": [
            {
              "name": "comesWithinMeters",
              "unit": "m",
              "value": 500,
            },
          ],
          "outcome": "applies",
          "summary": "The planned corridor comes within 500 m of the area; the control applies within 500 m.",
        },
        "near": {
          "basis": "rule",
          "digest": "b582482d6ceb5ed7c905015e3941cddf59a724269e998cf25faf8913be19fe54",
          "measured": [
            {
              "name": "comesWithinMeters",
              "unit": "m",
              "value": 500,
            },
          ],
          "outcome": "applies",
          "summary": "The planned corridor comes within 500 m of the area; the control applies within 500 m.",
        },
        "noReach": {
          "basis": "undetermined",
          "digest": "29a58d07ea931055f2fa1d7fea181bdefcea1987a4a48d62a748c79da241d971",
          "measured": [],
          "outcome": "applies",
          "summary": "This control declares no reach, so it applies to every flight in its interval.",
        },
        "outsideProfile": {
          "basis": "undetermined",
          "digest": "adb0942d2530ed416a21a37015d3d64ae0a2daa6d87b26a8ab117152a7c1a329",
          "measured": [],
          "outcome": "applies",
          "summary": "The distance from this route to the area could not be settled, so the control applies.",
        },
        "reachMinus": {
          "basis": "undetermined",
          "digest": "468215a1d4fecafe5e5bf1f2248a000c313560f71718cc71b68d3641ad56209e",
          "measured": [],
          "outcome": "applies",
          "summary": "The distance from this route to the area could not be settled, so the control applies.",
        },
        "reachMinusMore": {
          "basis": "rule",
          "digest": "a831017620a1001f28503c2bfc547e569c3835059b9fbed1dca79adaa2ecbd14",
          "measured": [
            {
              "name": "clearanceAtLeastMeters",
              "unit": "m",
              "value": 650,
            },
          ],
          "outcome": "does_not_apply",
          "summary": "The planned corridor stays at least 650 m from the area; the control applies within 650.003 m.",
        },
        "reachPlus": {
          "basis": "rule",
          "digest": "3603735fc0a821e71e2f5de109d72b791f9784531acbeaeb2e934e66da905aa1",
          "measured": [
            {
              "name": "comesWithinMeters",
              "unit": "m",
              "value": 650.0077587403171,
            },
          ],
          "outcome": "applies",
          "summary": "The planned corridor comes within 650.008 m of the area; the control applies within 650.008 m.",
        },
        "underReview": {
          "basis": "under_review",
          "digest": "757f087856a218bd5800b04fd70392d7d99a29e8d172e1ce50fd573e29801493",
          "measured": [],
          "outcome": "applies",
          "summary": "The hazard assessment has changed since this control was accepted, so it applies until a person signs again.",
        },
      }
    `);
  });

  test('the corridor tolerance widens the threshold, and the reach is measured from the edge', () => {
    // 600 m from the centre: 350 m from the edge. A 340 m reach misses it unless the corridor is 20 m wide.
    expect(evaluate({ ...area, appliesWithinMeters: 340 }, plan(eastward(600))).record.outcome).toBe('does_not_apply');
    expect(evaluate({ ...area, appliesWithinMeters: 340 }, plan(eastward(600), 20)).record.outcome).toBe('applies');
    expect(evaluate({ ...area, appliesWithinMeters: 360 }, plan(eastward(600))).record.outcome).toBe('applies');
  });

  test('records as clearance the largest sound lower bound it computed', () => {
    // A long route of several legs, far north of the area: the first bound alone would be the route's length short.
    const legs = [-105.2, -105.1, -105, -104.9, -104.8].map((longitude, index) => [
      longitude,
      40 + (20000 + index * 50) * metre,
    ]);
    const { record } = evaluate({ ...area, appliesWithinMeters: 500 }, plan(legs, 20));
    expect(record.outcome).toBe('does_not_apply');
    const clearance = record.measured[0]!.value as number;
    let nearest = Infinity;
    for (let leg = 1; leg < legs.length; leg++)
      for (let step = 0; step <= 1000; step++) {
        const [fromLongitude, fromLatitude] = legs[leg - 1]!;
        const [toLongitude, toLatitude] = legs[leg]!;
        const at = step / 1000;
        nearest = Math.min(
          nearest,
          geodesicDistance(
            center,
            fromLatitude! + (toLatitude! - fromLatitude!) * at,
            fromLongitude! + (toLongitude! - fromLongitude!) * at,
          )!,
        );
      }
    const corridor = nearest - area.radiusMeters - 20;
    const curveLengthBound = 4 * 6.4e6 * 0.1 * (Math.PI / 180);
    expect(clearance).toBeLessThanOrEqual(corridor);
    expect(clearance).toBeGreaterThan(corridor - curveLengthBound / 4);
  });
});
