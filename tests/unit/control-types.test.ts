import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  areaControlTypes,
  controlArea,
  controlParameterProblem,
  controlTypeDigest,
  describeControl,
  findControlType,
  listControlTypes,
  registerControlType,
  registeredControlTypeDigest,
  type ControlType,
} from '../../packages/domain/src/control-types.js';
import {
  avoidanceAreaControlType,
  describedMeasureControlType,
  operatingLimitControlType,
  operatingLimitSubjectIds,
} from '../../packages/domain/src/control-type-library.js';
import { valueWithinLimitV1 } from '../../packages/domain/src/check-kind-library.js';
import { repositoryRoot } from './generalisation-guard-scan.js';

const crewPairing: ControlType<{ minimumCrew: number }> = {
  id: 'toy.crew-pairing',
  version: 1,
  title: 'Toy crew pairing',
  description: 'A minimum number of fictional crew on site.',
  appliesTo: ['person_or_role', 'operation_kind'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['minimumCrew'],
    properties: { minimumCrew: { type: 'integer', minimum: 2, maximum: 6 } },
  },
  checkedAutomatically: false,
  describe: ({ minimumCrew }) => `At least ${minimumCrew} crew on site`,
};

describe('control type registry', () => {
  test('registers a type once by its declared definition and describes valid parameters', () => {
    registerControlType(crewPairing);
    // Same id, version and definition again is accepted; a different definition is refused.
    registerControlType({ ...crewPairing, describe: () => 'Another wording is not part of the definition' });
    expect(() => registerControlType({ ...crewPairing, title: 'Changed title' })).toThrow(/another definition/);
    const digest = registeredControlTypeDigest(crewPairing.id, 1)!;
    expect(digest).toBe(controlTypeDigest(crewPairing));
    expect(controlTypeDigest(findControlType(crewPairing.id, 1)!)).toBe(digest);
    expect(listControlTypes().find((type) => type.id === crewPairing.id)).toMatchObject({
      appliesTo: ['person_or_role', 'operation_kind'],
      checkedAutomatically: false,
      digest,
    });
    const pinned = { id: crewPairing.id, version: 1, digest };
    expect(controlParameterProblem(pinned, { minimumCrew: 2 })).toBeUndefined();
    expect(controlParameterProblem(pinned, { minimumCrew: 1 })).toMatch(/minimumCrew/);
    expect(controlParameterProblem({ ...pinned, digest: 'a'.repeat(64) }, { minimumCrew: 2 })).toMatch(
      /another definition/,
    );
    expect(controlParameterProblem({ ...pinned, version: 2 }, { minimumCrew: 2 })).toMatch(/not registered/);
    expect(describeControl(pinned, { minimumCrew: 3 })).toBe('At least 3 crew on site');
    expect(describeControl(pinned, { minimumCrew: 9 })).toBeUndefined();
  });

  test('refuses a type that does not declare what it applies to or has a malformed id', () => {
    expect(() => registerControlType({ ...crewPairing, id: 'toy.no-scope', appliesTo: [] })).toThrow(/appliesTo/);
    expect(() => registerControlType({ ...crewPairing, id: 'Not An Id' })).toThrow(/id/);
  });

  test('ships one generic described measure that a person checks', () => {
    const digest = registeredControlTypeDigest(describedMeasureControlType.id, 1)!;
    expect(digest).toBe(controlTypeDigest(describedMeasureControlType));
    const pinned = { id: describedMeasureControlType.id, version: 1, digest };
    expect(describeControl(pinned, { measure: 'Brief the crew', operationKind: 'line inspection' })).toBe(
      'Brief the crew (for line inspection)',
    );
    expect(controlParameterProblem(pinned, { measure: ' ' })).toBeDefined();
  });

  describe('operating limit', () => {
    const pinned = () => ({
      id: operatingLimitControlType.id,
      version: 1,
      digest: registeredControlTypeDigest(operatingLimitControlType.id, 1)!,
    });
    const reserve = {
      observationType: 'battery.state',
      observationVersion: 1,
      field: 'values.totalRemainingPercent',
      comparison: 'at_least',
      limit: 30,
      unit: 'percent',
      scope: 'subject_kind',
      subjectKind: 'aircraft',
    };

    test('is registered by its digest, checked automatically, and states the limit in plain words', () => {
      expect(pinned().digest).toBe(controlTypeDigest(operatingLimitControlType));
      expect(listControlTypes().find((type) => type.id === operatingLimitControlType.id)).toMatchObject({
        checkedAutomatically: true,
        digest: pinned().digest,
      });
      expect(controlParameterProblem(pinned(), reserve)).toBeUndefined();
      expect(describeControl(pinned(), reserve)).toBe(
        'Keep the reported values.totalRemainingPercent of battery.state version 1 at least 30 percent, for every aircraft.',
      );
      const listed = { ...reserve, scope: 'listed_subjects', subjectIds: ' tail-1, tail-2 ' };
      expect(controlParameterProblem(pinned(), listed)).toBeUndefined();
      expect(operatingLimitSubjectIds(listed)).toEqual(['tail-1', 'tail-2']);
      expect(describeControl(pinned(), listed)).toMatch(/at least 30 percent, for aircraft tail-1, tail-2\.$/);
      const whole = { ...reserve, scope: 'organization', comparison: 'below', subjectKind: undefined };
      expect(describeControl(pinned(), JSON.parse(JSON.stringify(whole)))).toMatch(
        /below 30 percent, across the organization\.$/,
      );
    });

    test('names no observation type itself and uses the comparison vocabulary of the value check', () => {
      const definition = JSON.stringify({ ...operatingLimitControlType, describe: undefined, validate: undefined });
      expect(definition).not.toMatch(/battery|wind/i);
      const schema = operatingLimitControlType.parameterSchema as { properties: Record<string, { enum?: string[] }> };
      const checkSchema = valueWithinLimitV1.parameterSchema as { properties: Record<string, { enum?: string[] }> };
      expect(schema.properties.comparison!.enum).toEqual(checkSchema.properties.comparison!.enum);
      // Every parameter is a plain string, number or choice, so the record page generates its form without JSON.
      for (const [name, property] of Object.entries(schema.properties) as [
        string,
        { type?: string; title?: string; enum?: unknown },
      ][]) {
        expect(property.title, name).toBeTruthy();
        expect(
          Array.isArray(property.enum) || ['string', 'number', 'integer'].includes(String(property.type)),
          name,
        ).toBe(true);
      }
    });

    test('refuses at proposal what it can tell without a problem: the observation type, field path and scope', () => {
      const problem = (change: Record<string, unknown>) =>
        controlParameterProblem(pinned(), JSON.parse(JSON.stringify({ ...reserve, ...change })));
      expect(problem({ observationType: 'toy.unregistered' })).toMatch(/toy\.unregistered version 1 is not registered/);
      expect(problem({ observationVersion: 99 })).toMatch(/version 99 is not registered/);
      expect(problem({ field: 'values..totalRemainingPercent' })).toMatch(/\/field/);
      expect(problem({ field: 'values.total-remaining' })).toMatch(/\/field/);
      expect(problem({ comparison: 'within' })).toMatch(/\/comparison/);
      expect(problem({ subjectKind: 'person' })).toMatch(/does not report on a person/);
      expect(problem({ scope: 'organization' })).toMatch(/whole organization names no kind of subject/);
      expect(problem({ subjectKind: undefined })).toMatch(/needs the kind of subject/);
      expect(problem({ subjectIds: 'tail-1' })).toMatch(/lists no subjects/);
      expect(problem({ scope: 'listed_subjects' })).toMatch(/needs their ids/);
      expect(problem({ scope: 'listed_subjects', subjectIds: 'tail-1,,tail-2' })).toMatch(/\/subjectIds/);
      expect(problem({ unit: ' ' })).toMatch(/\/unit/);
    });
  });

  describe('avoidance area', () => {
    const pinned = () => ({
      id: avoidanceAreaControlType.id,
      version: 1,
      digest: registeredControlTypeDigest(avoidanceAreaControlType.id, 1)!,
    });
    const circle = { center: { latitude: 41.8873, longitude: -87.6398 }, radiusMeters: 250, site: 'Canal Market' };

    test('applies to an area, is checked automatically and describes its circle', () => {
      expect(pinned().digest).toBe(controlTypeDigest(avoidanceAreaControlType));
      expect(listControlTypes().find((type) => type.id === avoidanceAreaControlType.id)).toMatchObject({
        appliesTo: ['area'],
        checkedAutomatically: true,
        digest: pinned().digest,
      });
      expect(controlParameterProblem(pinned(), circle)).toBeUndefined();
      expect(describeControl(pinned(), circle)).toBe(
        'Keep planned routes clear of the circle of 250 m around 41.8873, -87.6398 (Canal Market), at all altitudes.',
      );
      const { site: _site, ...unnamed } = circle;
      expect(controlArea(pinned(), unnamed)).toEqual({ center: circle.center, radiusMeters: 250 });
      expect(controlArea(pinned(), circle)).toEqual(circle);
      expect(describeControl(pinned(), { ...circle, appliesWithinMeters: 1500 })).toBe(
        'Keep planned routes clear of the circle of 250 m around 41.8873, -87.6398 (Canal Market), at all altitudes. ' +
          'Applies to flights whose planned route comes within 1 500 m of the area.',
      );
      expect(controlArea(pinned(), { ...circle, appliesWithinMeters: 1500 })).toEqual(circle);
    });

    test('is the only shipped type with an area, found by its pinned digest', () => {
      expect(areaControlTypes().map(({ id, version, digest }) => ({ id, version, digest }))).toContainEqual(pinned());
      expect(areaControlTypes().some((type) => type.id === operatingLimitControlType.id)).toBe(false);
      expect(controlArea({ ...pinned(), digest: 'a'.repeat(64) }, circle)).toBeUndefined();
      expect(controlArea({ id: operatingLimitControlType.id, version: 1, digest: pinned().digest }, circle)).toBe(
        undefined,
      );
    });

    test('refuses a circle the route check cannot use', () => {
      const problem = (change: Record<string, unknown>) =>
        controlParameterProblem(pinned(), JSON.parse(JSON.stringify({ ...circle, ...change })));
      expect(problem({ radiusMeters: 0 })).toMatch(/\/radiusMeters/);
      expect(problem({ radiusMeters: 10001 })).toMatch(/\/radiusMeters/);
      expect(problem({ center: { latitude: 91, longitude: 0 } })).toMatch(/\/center\/latitude/);
      expect(problem({ center: { latitude: 41 } })).toMatch(/\/center/);
      expect(problem({ site: ' ' })).toMatch(/\/site/);
      expect(problem({ appliesWithinMeters: -1 })).toMatch(/\/appliesWithinMeters/);
      expect(problem({ appliesWithinMeters: 50001 })).toMatch(/\/appliesWithinMeters/);
      expect(problem({ appliesWithinMeters: 0 })).toBeUndefined();
      expect(controlArea(pinned(), { ...circle, radiusMeters: -1 })).toBeUndefined();
    });
  });

  test('no core module names a control type', () => {
    const core = [
      'packages/domain/src/control-types.ts',
      'packages/domain/src/control-applicability.ts',
      'packages/contracts/src/control-applicability.ts',
      'packages/domain/src/sms-controls.ts',
      'packages/domain/src/sms-envelope.ts',
      'packages/domain/src/sms-decisions.ts',
      'packages/domain/src/sms-reads.ts',
      'packages/domain/src/accepted-control-rules.ts',
      'packages/domain/src/mission-release-controls.ts',
      'packages/contracts/src/sms.ts',
      'apps/web/src/SmsControls.tsx',
      'apps/web/src/SmsForms.tsx',
      'apps/web/src/SmsRecord.tsx',
    ];
    for (const file of core) {
      const source = readFileSync(join(repositoryRoot, file), 'utf8');
      expect(source, file).not.toContain(describedMeasureControlType.id);
      expect(source, file).not.toContain(operatingLimitControlType.id);
      expect(source, file).not.toContain(avoidanceAreaControlType.id);
      expect(source, file).not.toMatch(/area_avoidance/);
    }
  });
});
