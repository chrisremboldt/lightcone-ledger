import { describe, expect, test } from 'vitest';
import { canonicalDigest } from '../../../packages/integrity/src/index.js';
import {
  controlParameterProblem,
  controlTypeDigest,
  describeControl,
  registerControlType,
  registeredControlTypeDigest,
  type ApplicabilityPlan,
  type ControlType,
} from '../../../packages/domain/src/control-types.js';
import { evaluateControlApplicability } from '../../../packages/domain/src/control-applicability.js';

// The worked example of docs/guides/write-a-control-type.md. If this test changes, change the guide with it.

interface HeightCeilingParameters {
  maxHeightMeters: number;
  aircraftIds?: string[];
}

/** The frozen description the rule's digest covers. A changed rule is a new version of it and of the type. */
const listedAircraftRule = Object.freeze({
  id: 'example.applicability.guide-listed-aircraft',
  version: 1,
  reads: 'plan.mission.aircraftId',
  applies: 'aircraft_listed',
  uncertainty: 'applies',
});

const heightCeilingControlType: ControlType<HeightCeilingParameters> = {
  id: 'example.guide-height-ceiling',
  version: 1,
  title: 'Example height ceiling',
  description: 'A fictional lower height ceiling for the listed aircraft, such as while a sensor is being trialled.',
  appliesTo: ['aircraft'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['maxHeightMeters'],
    properties: {
      maxHeightMeters: {
        type: 'number',
        title: 'Highest height above ground (metres)',
        exclusiveMinimum: 0,
        maximum: 120,
      },
      aircraftIds: {
        type: 'array',
        title: 'Aircraft',
        description: 'The aircraft it bears on. Leave empty for every aircraft.',
        items: { type: 'string', minLength: 1, maxLength: 200 },
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      },
    },
  },
  checkedAutomatically: false,
  describe: ({ maxHeightMeters, aircraftIds }) =>
    `Fly no higher than ${maxHeightMeters} m above ground` +
    (aircraftIds ? ` with aircraft ${aircraftIds.join(', ')}.` : ' with every aircraft.'),
  applicability: {
    rule: { id: listedAircraftRule.id, version: 1, digest: canonicalDigest(listedAircraftRule) },
    definition: listedAircraftRule,
    evaluate({ aircraftIds }, plan) {
      if (!aircraftIds) return { applies: 'undetermined', reasons: ['no_aircraft_listed'] };
      const aircraft = plan.mission.aircraftId;
      return {
        applies: aircraftIds.includes(aircraft),
        measured: [{ name: 'aircraftId', value: aircraft }],
        declared: [{ name: 'aircraftIds', value: aircraftIds.join(', ') }],
        summary: `This flight's mission names aircraft ${aircraft}; the control bears on aircraft ${aircraftIds.join(', ')}.`,
      };
    },
  },
};

const TYPE_DIGEST = 'f0926f0f6fbffe05d65086d01c0a348d15ba44c2d5ade042a9457eee01588253';

const plan = (aircraftId: string): ApplicabilityPlan => ({
  mission: {
    aircraftId,
    sourceMissionId: 'guide-mission-1',
    route: {
      coordinateReference: 'WGS84',
      coordinateOrder: 'longitude_latitude',
      segmentInterpolation: 'linear_longitude_latitude',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-105.01, 40.01],
          [-104.99, 40.01],
        ],
      },
    },
    lateralToleranceMeters: 20,
    altitude: { minimum: 0, maximum: 100, unit: 'm', reference: 'AGL' },
    operatingInterval: { start: '2026-11-20T14:00:00Z', end: '2026-11-20T15:00:00Z' },
  },
});

const inputs = {
  mission: {
    missionId: 'guide-mission',
    sourceRevision: 1,
    eventId: 'guide-mission-event-1',
    contentDigest: canonicalDigest({ guide: 'mission content' }),
    recordDigest: canonicalDigest({ guide: 'mission record' }),
  },
  control: {
    controlId: 'guide-control',
    versionNumber: 1,
    controlEventId: 'guide-control-v1',
    bodyDigest: canonicalDigest({ guide: 'control body' }),
  },
  reviewRequired: false,
};

describe('the control type guide example', () => {
  test('registers with its pinned digest, which covers the rule but not the wording', () => {
    registerControlType(heightCeilingControlType);
    expect(registeredControlTypeDigest(heightCeilingControlType.id, 1)).toBe(TYPE_DIGEST);
    const reworded = { ...heightCeilingControlType, describe: () => 'Other words.' };
    expect(controlTypeDigest(reworded)).toBe(TYPE_DIGEST);
    const otherRule = { ...listedAircraftRule, uncertainty: 'does_not_apply' };
    const changedRule = {
      ...heightCeilingControlType,
      applicability: {
        ...heightCeilingControlType.applicability!,
        rule: { id: otherRule.id, version: 1, digest: canonicalDigest(otherRule) },
        definition: otherRule,
      },
    };
    expect(controlTypeDigest(changedRule)).not.toBe(TYPE_DIGEST);
  });

  test('checks parameters against its schema and words a control from them', () => {
    const pinned = { id: heightCeilingControlType.id, version: 1, digest: TYPE_DIGEST };
    const parameters = { maxHeightMeters: 60, aircraftIds: ['AC-03', 'AC-04'] };
    expect(controlParameterProblem(pinned, parameters)).toBeUndefined();
    expect(controlParameterProblem(pinned, { maxHeightMeters: 400 })).toMatch(/maxHeightMeters/);
    expect(describeControl(pinned, parameters)).toBe(
      'Fly no higher than 60 m above ground with aircraft AC-03, AC-04.',
    );
  });

  test('applies only to flights whose mission names a listed aircraft', () => {
    const pinned = { id: heightCeilingControlType.id, version: 1, digest: TYPE_DIGEST };
    const parameters = { maxHeightMeters: 60, aircraftIds: ['AC-03', 'AC-04'] };
    const other = evaluateControlApplicability(pinned, parameters, plan('AC-17'), inputs);
    expect(other.record).toMatchObject({
      outcome: 'does_not_apply',
      basis: 'rule',
      rule: heightCeilingControlType.applicability!.rule,
      summary: "This flight's mission names aircraft AC-17; the control bears on aircraft AC-03, AC-04.",
    });
    expect(other.digest).toBe(canonicalDigest(other.record));
    expect(evaluateControlApplicability(pinned, parameters, plan('AC-04'), inputs).record).toMatchObject({
      outcome: 'applies',
      basis: 'rule',
    });
    // Anything the rule cannot settle applies.
    expect(evaluateControlApplicability(pinned, { maxHeightMeters: 60 }, plan('AC-17'), inputs).record).toMatchObject({
      outcome: 'applies',
      basis: 'undetermined',
      reasons: ['no_aircraft_listed'],
    });
  });
});
