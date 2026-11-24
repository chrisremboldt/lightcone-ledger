import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import { adoptionParameterProblem, registerRulePack, runCheckedRule } from '../../domain/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import {
  BATTERY_RESERVE_LEAF_ID,
  BATTERY_RESERVE_PROCEDURE_V1,
  EXAMPLE_OPERATIONS_PACK_ID,
  batteryReserveLeafV1,
  exampleOperationsVersionOne,
} from '../src/index.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-05T10:00:00.000Z' };

function battery(id: string, occurredAt: string, totalRemainingPercent?: number) {
  return {
    id,
    type: 'battery.state',
    version: 1,
    occurredAt,
    observation: { values: totalRemainingPercent === undefined ? {} : { totalRemainingPercent } },
  };
}

describe('example operating procedures pack', () => {
  it('is registered with its pinned digest, schema-valid, with the procedure text pinned by hash', () => {
    const pack = getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 1)!;
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack).toMatchObject({
      packId: 'ledger.example-operations',
      version: 1,
      status: 'draft',
      review: 'ai_drafted',
      adopted: false,
      bindings: [],
      digest: 'e56e599b0e0fd54f8dbc9de743c1b61edb115a2f47b232358a2df80fea7606bb',
    });
    const [leaf] = pack.leaves;
    expect(pack.leaves).toHaveLength(1);
    expect(leaf).toEqual(batteryReserveLeafV1());
    expect(leaf).toMatchObject({
      id: BATTERY_RESERVE_LEAF_ID,
      title: 'Battery below adopted reserve',
      coverage: 'automated',
      source: {
        kind: 'operator_procedure',
        text: BATTERY_RESERVE_PROCEDURE_V1,
        sha256: sha256(Buffer.from(BATTERY_RESERVE_PROCEDURE_V1, 'utf8')),
        textSpan: { start: 0, end: Buffer.byteLength(BATTERY_RESERVE_PROCEDURE_V1), unit: 'utf8_byte' },
      },
      target: { subjectKind: 'aircraft' },
      reads: [{ name: 'subject', type: 'battery.state', versions: [1], about: 'target', required: true }],
      check: { kind: 'value.within-limit', version: 1, params: { field: 'values.totalRemainingPercent' } },
      adoptionParameters: [{ name: 'limit', valueType: 'number', minimum: 1, maximum: 100 }],
    });
    expect(BATTERY_RESERVE_PROCEDURE_V1).not.toMatch(/regulat|CFR|manufacturer/i);
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('refuses a changed procedure text without a new pack version', () => {
    const edited = batteryReserveLeafV1(`${BATTERY_RESERVE_PROCEDURE_V1} Edited.`);
    expect(edited.digest).not.toBe(batteryReserveLeafV1().digest);
    expect(() => exampleOperationsVersionOne([edited])).toThrow(
      'Rule pack ledger.example-operations version 1 changed without a new pack version',
    );
    // Editing the text in place, even with the pack digest recomputed, leaves the rule's own digest stale.
    const { digest: _digest, ...pack } = getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 1)!;
    const leaf = pack.leaves[0]!;
    const content = {
      ...pack,
      packId: 'test.edited-example',
      leaves: [{ ...leaf, source: { ...leaf.source, text: 'x' } }],
    };
    expect(() =>
      registerRulePack({ packId: content.packId, versions: [{ ...content, digest: canonicalDigest(content) }] }),
    ).toThrow(`Rule ${BATTERY_RESERVE_LEAF_ID} version 1 does not match its digest`);
  });

  it('needs the organization to set a reserve between 1 and 100 percent on adoption', () => {
    const pack = getRulePackVersion(EXAMPLE_OPERATIONS_PACK_ID, 1)!;
    expect(adoptionParameterProblem(pack, undefined)).toBe(`Leaf ${BATTERY_RESERVE_LEAF_ID} needs parameter limit`);
    expect(adoptionParameterProblem(pack, { [BATTERY_RESERVE_LEAF_ID]: {} })).toBe(
      `Leaf ${BATTERY_RESERVE_LEAF_ID} needs parameter limit`,
    );
    for (const limit of [0, 101, -5, '25', true])
      expect(adoptionParameterProblem(pack, { [BATTERY_RESERVE_LEAF_ID]: { limit } }), String(limit)).toBe(
        `Leaf ${BATTERY_RESERVE_LEAF_ID}: Parameter limit is not a valid number`,
      );
    expect(adoptionParameterProblem(pack, { [BATTERY_RESERVE_LEAF_ID]: { limit: 25, field: 'values.x' } })).toBe(
      `Leaf ${BATTERY_RESERVE_LEAF_ID} does not declare parameter field`,
    );
    for (const limit of [1, 25, 30.5, 100])
      expect(adoptionParameterProblem(pack, { [BATTERY_RESERVE_LEAF_ID]: { limit } })).toBeUndefined();
  });

  it('passes at or above the reserve, needs attention below it, and is insufficient without battery data', () => {
    const leaf = batteryReserveLeafV1();
    const params = { ...leaf.check.params, limit: 25 };
    const run = (observations: ReturnType<typeof battery>[]) =>
      runCheckedRule(leaf, params, { subject: observations }, clock);
    expect(
      run([battery('b-2', '2026-10-05T09:00:05.000Z', 25), battery('b-1', '2026-10-05T09:00:00.000Z', 20)]),
    ).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      reasonCode: 'value_within_limit',
      evidence: ['b-2'],
    });
    expect(run([battery('b-3', '2026-10-05T09:00:10.000Z', 24.5)])).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      evidence: ['b-3'],
    });
    expect(run([])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
      evidence: [],
    });
    expect(run([battery('b-4', '2026-10-05T09:00:15.000Z')])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'value_missing',
    });
  });
});
