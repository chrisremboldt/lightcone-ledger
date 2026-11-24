import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, test } from 'vitest';
import {
  ControlApplicabilityRecordSchema,
  type ControlApplicabilityOutcome,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  controlTypeDigest,
  listControlTypes,
  registerControlType,
  registeredControlTypeDigest,
  type ApplicabilityPlan,
  type ControlType,
} from '../../packages/domain/src/control-types.js';
import {
  evaluateControlApplicability,
  type ControlApplicabilityInputs,
} from '../../packages/domain/src/control-applicability.js';
import {
  describedMeasureControlType,
  operatingLimitControlType,
} from '../../packages/domain/src/control-type-library.js';
import { repositoryRoot } from './generalisation-guard-scan.js';

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const validRecord = ajv.compile(structuredClone(ControlApplicabilityRecordSchema));

// A fictional pack's control type and rule, registered here as a pack registers its own: no core file names either.
const listedAircraftDefinition = Object.freeze({
  id: 'example.applicability.listed-aircraft',
  version: 1,
  reads: 'plan.mission.aircraftId',
  applies: 'aircraft_listed_or_no_list',
  uncertainty: 'applies',
});

interface AircraftLimitationParameters {
  measure: string;
  aircraftIds?: string[];
}

const aircraftLimitationType: ControlType<AircraftLimitationParameters> = {
  id: 'example.aircraft-limitation',
  version: 1,
  title: 'Example aircraft limitation',
  description: 'A fictional limitation that bears only on the listed aircraft.',
  appliesTo: ['aircraft'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['measure'],
    properties: {
      measure: { type: 'string', minLength: 1, maxLength: 200 },
      aircraftIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 20 },
    },
  },
  checkedAutomatically: false,
  describe: ({ measure }) => measure,
  applicability: {
    rule: {
      id: listedAircraftDefinition.id,
      version: 1,
      digest: canonicalDigest(listedAircraftDefinition),
    },
    definition: listedAircraftDefinition,
    evaluate({ aircraftIds }, plan) {
      if (!aircraftIds) return { applies: 'undetermined', reasons: ['no_aircraft_listed'] };
      const aircraft = plan.mission.aircraftId;
      return {
        applies: aircraftIds.includes(aircraft),
        measured: [{ name: 'aircraftId', value: aircraft }],
        declared: [{ name: 'aircraftIds', value: aircraftIds.join(', ') }],
        summary: `This flight's mission names aircraft ${aircraft}; the control applies to aircraft ${aircraftIds.join(' and ')}.`,
      };
    },
  },
};
registerControlType(aircraftLimitationType);

const pinned = () => ({
  id: aircraftLimitationType.id,
  version: 1,
  digest: registeredControlTypeDigest(aircraftLimitationType.id, 1)!,
});
const parameters = { measure: 'Fly the listed aircraft below 60 m.', aircraftIds: ['AC-03', 'AC-04'] };

const examplePlan: ApplicabilityPlan = {
  mission: {
    aircraftId: 'AC-17',
    sourceMissionId: 'example-mission-1',
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
};

const exampleInputs: ControlApplicabilityInputs = {
  mission: {
    missionId: 'example-mission',
    sourceRevision: 1,
    eventId: 'example-mission-event-1',
    contentDigest: canonicalDigest({ example: 'mission content' }),
    recordDigest: canonicalDigest({ example: 'mission record' }),
  },
  control: {
    controlId: 'example-control',
    versionNumber: 1,
    controlEventId: 'example-control-v1',
    bodyDigest: canonicalDigest({ example: 'control body' }),
  },
  reviewRequired: false,
};

/** Registers a variant of the example type whose rule returns or throws what the test gives it. */
function typeWithRule(id: string, evaluate: () => unknown) {
  const definition = Object.freeze({ id: `example.applicability.${id}`, version: 1 });
  const type: ControlType<{ measure: string }> = {
    ...aircraftLimitationType,
    id: `example.${id}`,
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['measure'],
      properties: { measure: { type: 'string', minLength: 1 } },
    },
    applicability: {
      rule: { id: definition.id, version: 1, digest: canonicalDigest(definition) },
      definition,
      evaluate: evaluate as () => ControlApplicabilityOutcome,
    },
  };
  registerControlType(type);
  return { id: type.id, version: 1, digest: registeredControlTypeDigest(type.id, 1)! };
}

describe('control applicability', () => {
  test('a type registered by a pack declares its own rule, and the evaluator applies it with no core change', () => {
    const { record, digest } = evaluateControlApplicability(pinned(), parameters, examplePlan, exampleInputs);
    expect(validRecord(record), JSON.stringify(validRecord.errors)).toBe(true);
    expect(record).toEqual({
      version: 'control.applicability.1',
      outcome: 'does_not_apply',
      basis: 'rule',
      rule: aircraftLimitationType.applicability!.rule,
      inputs: { mission: exampleInputs.mission, control: exampleInputs.control, controlType: pinned() },
      measured: [{ name: 'aircraftId', value: 'AC-17' }],
      declared: [{ name: 'aircraftIds', value: 'AC-03, AC-04' }],
      summary: "This flight's mission names aircraft AC-17; the control applies to aircraft AC-03 and AC-04.",
      reasons: [],
    });
    expect(digest).toBe(canonicalDigest(record));

    const listed = { ...examplePlan, mission: { ...examplePlan.mission, aircraftId: 'AC-04' } };
    expect(evaluateControlApplicability(pinned(), parameters, listed, exampleInputs).record).toMatchObject({
      outcome: 'applies',
      basis: 'rule',
    });
  });

  test('the same inputs give the same record digest, and any changed input another', () => {
    const first = evaluateControlApplicability(pinned(), parameters, examplePlan, exampleInputs);
    const again = evaluateControlApplicability(
      structuredClone(pinned()),
      structuredClone(parameters),
      structuredClone(examplePlan),
      structuredClone(exampleInputs),
    );
    expect(again.digest).toBe(first.digest);
    const otherMission = { ...exampleInputs, mission: { ...exampleInputs.mission!, sourceRevision: 2 } };
    expect(evaluateControlApplicability(pinned(), parameters, examplePlan, otherMission).digest).not.toBe(first.digest);
  });

  test('the rule sees frozen copies of the parameters and only the plan fields it may read', () => {
    let seen: { parameters: unknown; plan: ApplicabilityPlan } | undefined;
    const probe = typeWithRule('probe', function (this: unknown, ...args: unknown[]) {
      seen = { parameters: args[0], plan: args[1] as ApplicabilityPlan };
      return { applies: true, measured: [], declared: [], summary: 'Measured nothing.' };
    });
    const extra = { ...examplePlan, mission: { ...examplePlan.mission, id: 'not-a-plan-field' } } as ApplicabilityPlan;
    const input = { measure: 'Probe' };
    evaluateControlApplicability(probe, input, extra, exampleInputs);
    expect(seen!.parameters).toEqual(input);
    expect(seen!.parameters).not.toBe(input);
    expect(Object.isFrozen(seen!.parameters)).toBe(true);
    expect(Object.isFrozen(seen!.plan.mission.route.geometry.coordinates[0])).toBe(true);
    expect(Object.keys(seen!.plan.mission).sort()).toEqual([
      'aircraftId',
      'altitude',
      'lateralToleranceMeters',
      'operatingInterval',
      'route',
      'sourceMissionId',
    ]);
  });

  describe('fails towards applying', () => {
    const applies = (
      type: { id: string; version: number; digest: string },
      basis: string,
      reasons: string[],
      options: { parameters?: unknown; plan?: ApplicabilityPlan | null; inputs?: ControlApplicabilityInputs } = {},
    ) => {
      const { record } = evaluateControlApplicability(
        type,
        options.parameters ?? parameters,
        options.plan === undefined ? examplePlan : options.plan,
        options.inputs ?? exampleInputs,
      );
      expect(validRecord(record), JSON.stringify(validRecord.errors)).toBe(true);
      expect(record).toMatchObject({ outcome: 'applies', basis, reasons, measured: [], declared: [] });
      return record;
    };

    test('a pinned type not registered here, with another digest, or with invalid parameters', () => {
      expect(applies({ ...pinned(), version: 9 }, 'no_rule', ['control_type_unavailable']).rule).toBeNull();
      applies({ ...pinned(), digest: 'a'.repeat(64) }, 'no_rule', ['control_type_unavailable']);
      applies(pinned(), 'no_rule', ['control_parameters_invalid'], { parameters: { measure: '' } });
    });

    test('a type that declares no rule', () => {
      const described = {
        id: describedMeasureControlType.id,
        version: 1,
        digest: registeredControlTypeDigest(describedMeasureControlType.id, 1)!,
      };
      const record = applies(described, 'no_rule', [], { parameters: { measure: 'Brief the crew' } });
      expect(record.rule).toBeNull();
      expect(record.summary).toBe(
        "This control's type declares no applicability rule, so it applies to every flight in its interval.",
      );
    });

    test('a control whose hazard assessment changed since acceptance, without consulting the rule', () => {
      let consulted = false;
      const watched = typeWithRule('watched', () => {
        consulted = true;
        return { applies: false, measured: [], declared: [], summary: 'Measured nothing.' };
      });
      const record = applies(watched, 'under_review', ['review_required'], {
        parameters: { measure: 'Watched' },
        inputs: { ...exampleInputs, reviewRequired: true },
      });
      expect(consulted).toBe(false);
      expect(record.rule).toMatchObject({ id: 'example.applicability.watched', version: 1 });
      expect(record.summary).toBe(
        'The hazard assessment has changed since this control was accepted, so it applies until a person signs again.',
      );
    });

    test('no mission revision to read', () => {
      applies(pinned(), 'inputs_incomplete', ['mission_unavailable'], { plan: null });
      const record = applies(pinned(), 'inputs_incomplete', ['mission_unavailable'], {
        inputs: { ...exampleInputs, mission: null },
      });
      expect(record.inputs.mission).toBeNull();
    });

    test('a rule that throws or returns a shape outside the schema', () => {
      const throwing = typeWithRule('throwing', () => {
        throw new Error('fictional failure');
      });
      applies(throwing, 'error', ['rule_failed'], { parameters: { measure: 'Throws' } });
      for (const [id, result] of [
        ['shapeless', { applies: 'maybe' }],
        ['unbounded', { applies: false, measured: [{ name: 'x', value: Infinity }], declared: [], summary: 'x' }],
        ['wordless', { applies: false, measured: [], declared: [], summary: ' ' }],
        ['nothing', undefined],
      ] as const)
        applies(
          typeWithRule(id, () => result),
          'error',
          ['rule_result_invalid'],
          { parameters: { measure: id } },
        );
    });

    test('a rule that cannot settle the case', () => {
      const record = applies(pinned(), 'undetermined', ['no_aircraft_listed'], {
        parameters: { measure: 'No list' },
      });
      expect(record.summary).toBe(
        'The applicability rule could not settle whether this control bears on the flight, so it applies.',
      );
    });
  });

  describe('pinning the rule', () => {
    test("the rule's identity enters the type's digest only when a type declares one", () => {
      const { applicability: _rule, ...withoutRule } = aircraftLimitationType;
      expect(controlTypeDigest(withoutRule)).not.toBe(controlTypeDigest(aircraftLimitationType));
      expect(listControlTypes().find((type) => type.id === aircraftLimitationType.id)).toMatchObject({
        applicability: aircraftLimitationType.applicability!.rule,
        digest: pinned().digest,
      });
      // Types without a rule keep the digests they had before the hook existed.
      expect(registeredControlTypeDigest(describedMeasureControlType.id, 1)).toBe(
        'ef7b1e15b424ff6d28ebc61768f6e4305771d32f6ce08543c6a289e4597449bc',
      );
      expect(registeredControlTypeDigest(operatingLimitControlType.id, 1)).toBe(
        '67ca077684fb30db774dcfe91f7e21e04ba88e03eea8ca4abf61d94136e8c544',
      );
      expect(listControlTypes().find((type) => type.id === describedMeasureControlType.id)).not.toHaveProperty(
        'applicability',
      );
    });

    test('registration refuses a rule whose definition does not match its pinned identity', () => {
      const declared = aircraftLimitationType.applicability!;
      expect(() =>
        registerControlType({
          ...aircraftLimitationType,
          id: 'example.drifted-rule',
          applicability: { ...declared, definition: { ...listedAircraftDefinition, applies: 'changed' } },
        }),
      ).toThrow(/does not match its digest/);
      expect(() =>
        registerControlType({
          ...aircraftLimitationType,
          id: 'example.renamed-rule',
          applicability: { ...declared, rule: { ...declared.rule, version: 2 } },
        }),
      ).toThrow(/names another definition/);
    });

    test('no core module names a control type, an applicability rule or a vendor', () => {
      const source = readFileSync(join(repositoryRoot, 'packages/domain/src/control-applicability.ts'), 'utf8');
      for (const named of [...listControlTypes().map((type) => type.id), 'area-reach', 'radius'])
        expect(source, named).not.toContain(named);
    });
  });
});
