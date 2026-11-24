import { describe, expect, test } from 'vitest';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import {
  ACCEPTED_CONTROL_PACK_ID,
  acceptedControlLeafId,
  acceptedControlLeaves,
  acceptedControlPack,
  type ControlInForce,
} from '../../packages/domain/src/accepted-control-rules.js';
import { runCheckedRule } from '../../packages/domain/src/checked-rules.js';
import {
  controlCheck,
  controlRules,
  describeControl,
  registeredControlTypeDigest,
} from '../../packages/domain/src/control-types.js';
import {
  avoidanceAreaControlType,
  describedMeasureControlType,
  operatingLimitControlType,
} from '../../packages/domain/src/control-type-library.js';
import { registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import { RulePackVersionSchema } from '../../packages/contracts/src/index.js';
import { exampleOperationsRulePack } from '../../packages/pack-example-operations/src/example-operations-v1.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { CheckObservation } from '../../packages/domain/src/check-kinds.js';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validPack = ajv.compile(RulePackVersionSchema);

const pinned = (type: { id: string }) => ({
  id: type.id,
  version: 1,
  digest: registeredControlTypeDigest(type.id, 1)!,
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

function control(parameters: Record<string, unknown>, type: { id: string } = operatingLimitControlType, version = 1) {
  const body = {
    hazardId: 'hazard-fictional',
    controlType: pinned(type),
    parameters,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  };
  return {
    hazardId: 'hazard-fictional',
    hazardTitle: 'Battery below the reserve',
    controlId: 'control-fictional',
    versionNumber: version,
    controlEventId: 'control-fictional-event',
    acceptanceId: 'acceptance-fictional',
    bodyDigest: canonicalDigest(body),
    title: 'Battery reserve',
    body,
    effectiveFrom: body.effectiveFrom,
    effectiveUntil: null,
  } satisfies ControlInForce;
}

function battery(id: string, percent: number, subject = { kind: 'aircraft', id: 'tail-7', scope: 'source' }) {
  return {
    id,
    type: 'battery.state',
    version: 1,
    occurredAt: '2026-11-03T09:30:00.000Z',
    observation: { type: 'battery.state', version: 1, subject, values: { totalRemainingPercent: percent } },
  } satisfies CheckObservation;
}

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-03T10:00:00.000Z' };

describe('accepted controls as rules', () => {
  test('an operating limit becomes the value check its parameters describe, about the kind of subject it names', () => {
    expect(controlRules(pinned(operatingLimitControlType), reserve)).toEqual([
      {
        target: { subjectKind: 'aircraft' },
        reads: [
          { name: 'subject', type: 'battery.state', versions: [1], about: 'target', required: true, select: 'latest' },
        ],
        check: {
          kind: 'value.within-limit',
          version: 1,
          params: { field: 'values.totalRemainingPercent', comparison: 'at_least', limit: 30 },
        },
      },
    ]);
    const whole = { ...reserve, scope: 'organization' } as Record<string, unknown>;
    delete whole.subjectKind;
    expect(controlRules(pinned(operatingLimitControlType), whole)?.map((rule) => rule.target.subjectKind)).toEqual([
      'aircraft',
      'flight',
    ]);
    expect(controlRules(pinned(operatingLimitControlType), { ...reserve, limit: 'thirty' })).toBeUndefined();
  });

  test('the rule quotes the control’s own words, pins its version and reads the limit it states', () => {
    const accepted = control(reserve);
    const [leaf] = acceptedControlLeaves(accepted);
    expect(leaf).toMatchObject({
      id: acceptedControlLeafId('control-fictional', 'aircraft'),
      version: 1,
      title: 'Battery reserve',
      target: { subjectKind: 'aircraft' },
      check: { kind: 'value.within-limit', version: 1 },
      source: {
        kind: 'operator_procedure',
        reference: `Accepted control control-fictional version 1, body ${accepted.bodyDigest}`,
        text: describeControl(accepted.body.controlType, reserve),
      },
    });
    expect(runCheckedRule(leaf!, leaf!.check.params, { subject: [battery('low', 12)] }, clock)).toMatchObject({
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
    });
    expect(runCheckedRule(leaf!, leaf!.check.params, { subject: [battery('high', 40)] }, clock).outcome).toBe('pass');
    expect(runCheckedRule(leaf!, leaf!.check.params, {}, clock)).toMatchObject({
      outcome: 'pending',
      evidenceState: 'insufficient',
    });
    // The same control version gives the same rule; a new limit in a new version keeps the rule's id.
    expect(acceptedControlLeaves(accepted)[0]!.digest).toBe(leaf!.digest);
    const [changed] = acceptedControlLeaves(control({ ...reserve, limit: 10 }, operatingLimitControlType, 2));
    expect(changed).toMatchObject({ id: leaf!.id, version: 2, check: { params: { limit: 10 } } });
    expect(changed!.digest).not.toBe(leaf!.digest);
  });

  test('a limit for listed subjects applies only where the observation’s own subject is listed', () => {
    const listed = { ...reserve, scope: 'listed_subjects', subjectIds: 'tail-7, tail-9' };
    expect(controlRules(pinned(operatingLimitControlType), listed)?.[0]?.subjectIds).toEqual(['tail-7', 'tail-9']);
    const [leaf] = acceptedControlLeaves(control(listed));
    expect(runCheckedRule(leaf!, leaf!.check.params, { subject: [battery('listed', 12)] }, clock).outcome).toBe(
      'attention',
    );
    const other = battery('other', 12, { kind: 'aircraft', id: 'tail-3', scope: 'source' });
    expect(runCheckedRule(leaf!, leaf!.check.params, { subject: [other] }, clock)).toMatchObject({
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
    });
  });

  test('an area stays with route review and a described measure with a person; neither becomes a rule', () => {
    const circle = { center: { latitude: 41.8873, longitude: -87.6398 }, radiusMeters: 250 };
    expect(acceptedControlLeaves(control(circle, avoidanceAreaControlType))).toEqual([]);
    expect(acceptedControlLeaves(control({ measure: 'Brief the crew' }, describedMeasureControlType))).toEqual([]);
    expect(controlCheck(pinned(operatingLimitControlType))).toBe('rule');
    expect(controlCheck(pinned(avoidanceAreaControlType))).toBe('route_review');
    expect(controlCheck(pinned(describedMeasureControlType))).toBe('person');
    expect(controlCheck({ ...pinned(operatingLimitControlType), digest: 'a'.repeat(64) })).toBeUndefined();
  });

  test('a pack version holds the rules in id order and recomputes from its content', () => {
    const first = acceptedControlLeaves({ ...control(reserve), controlId: 'b-control' });
    const second = acceptedControlLeaves({ ...control(reserve), controlId: 'a-control' });
    const pack = acceptedControlPack(3, [...first, ...second]);
    const { digest, ...content } = pack;
    expect(digest).toBe(canonicalDigest(content));
    expect(pack).toMatchObject({ packId: ACCEPTED_CONTROL_PACK_ID, version: 3, bindings: [] });
    expect(pack.leaves.map((leaf) => leaf.id)).toEqual([second[0]!.id, first[0]!.id]);
    expect(acceptedControlPack(3, [...second, ...first]).digest).toBe(digest);
    expect(acceptedControlPack(1, []).leaves).toEqual([]);
  });

  test('the registry refuses the accepted-controls pack id, which lives only in adoptions', () => {
    const pack = acceptedControlPack(1, []);
    expect(() => registerRulePack({ packId: ACCEPTED_CONTROL_PACK_ID, versions: [pack] })).toThrow(
      /assembled from accepted controls/,
    );
  });

  test('the pack says Ledger assembled it from controls a person accepted and signed', () => {
    const pack = acceptedControlPack(2, acceptedControlLeaves(control(reserve)));
    expect(pack).toMatchObject({ status: 'assembled', review: 'accepted_and_signed', adopted: false });
    expect(validPack(pack), JSON.stringify(validPack.errors)).toBe(true);
    // A version recorded before these labels existed stays valid as recorded.
    const { digest, ...content } = { ...pack, status: 'draft' as const, review: 'ai_drafted' as const };
    expect(validPack({ ...content, digest: canonicalDigest(content) })).toBe(true);
  });

  test('no registered pack can carry the labels of the assembled pack', () => {
    const [shipped] = exampleOperationsRulePack().versions;
    const { digest, ...content } = { ...shipped!, status: 'assembled' as const };
    expect(() =>
      registerRulePack({ packId: 'fictional.labelled', versions: [{ ...content, digest: canonicalDigest(content) }] }),
    ).toThrow(/labels only the accepted-controls pack carries/);
  });
});
