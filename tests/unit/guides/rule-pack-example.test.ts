import { describe, expect, test } from 'vitest';
import type { CheckedRuleLeaf, RulePackVersion } from '../../../packages/contracts/src/index.js';
import { canonicalDigest, sha256 } from '../../../packages/integrity/src/index.js';
import { valueWithinLimitV1 } from '../../../packages/domain/src/check-kind-library.js';
import {
  adoptionParameterProblem,
  defineCheckedRule,
  runCheckedRule,
} from '../../../packages/domain/src/checked-rules.js';
import { getRulePackVersion, registerRulePack } from '../../../packages/domain/src/rule-pack-registry.js';

// The worked example of docs/guides/write-a-rule-pack.md. If this test changes, change the guide with it.

const PACK_ID = 'example.guide-wind';
const LEAF_ID = 'example.guide-wind.takeoff-wind';

/** Invented for the guide. It is not a regulation and not a manufacturer limit. */
const PROCEDURE =
  'Example procedure 7.1, wind. Crews read the wind at the aircraft before takeoff. The reported wind speed stays at or below the limit this organization sets when it adopts the procedure.';
const QUOTED = 'The reported wind speed stays at or below the limit';

function takeoffWindLeaf(): CheckedRuleLeaf {
  const start = PROCEDURE.indexOf(QUOTED);
  return defineCheckedRule({
    id: LEAF_ID,
    version: 1,
    title: 'Wind above adopted limit',
    source: {
      kind: 'operator_procedure',
      reference: 'Example procedure 7.1 (invented for this guide)',
      text: PROCEDURE,
      span: { start, end: PROCEDURE.length },
    },
    target: { subjectKind: 'aircraft' },
    reads: [
      { name: 'subject', type: 'weather.wind', versions: [1], about: 'target', required: true, select: 'latest' },
    ],
    check: {
      kind: valueWithinLimitV1,
      params: { field: 'values.speedMetersPerSecond', comparison: 'at_most' },
    },
    adoptionParameters: [
      { name: 'limit', title: 'Wind limit (metres per second)', valueType: 'number', minimum: 1, maximum: 30 },
    ],
  });
}

const VERSION_ONE_DIGEST = 'd03bbdfc131ea44049fc61d5f284abcaa9c6c03aac13f0300dcc43bc23f46874';

function guideWindVersionOne(): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PACK_ID,
    version: 1,
    title: 'Example wind procedure (guide)',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: [takeoffWindLeaf()],
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(`Rule pack ${PACK_ID} version 1 changed without a new version`);
  return pack;
}

function wind(id: string, occurredAt: string, speedMetersPerSecond: number) {
  return {
    id,
    type: 'weather.wind',
    version: 1,
    occurredAt,
    observation: { values: { method: 'measured', speedMetersPerSecond } },
  };
}

describe('the rule pack guide example', () => {
  test('pins the quoted span of the procedure text by byte offsets and SHA-256', () => {
    const { source } = takeoffWindLeaf();
    const start = Buffer.byteLength(PROCEDURE.slice(0, PROCEDURE.indexOf(QUOTED)));
    expect(source).toMatchObject({
      kind: 'operator_procedure',
      text: PROCEDURE,
      sha256: sha256(Buffer.from(PROCEDURE, 'utf8')),
      textSpan: { start, end: Buffer.byteLength(PROCEDURE), unit: 'utf8_byte' },
    });
  });

  test('registers with its pinned digest and asks the organization for a limit', () => {
    registerRulePack({ packId: PACK_ID, versions: [guideWindVersionOne()] });
    const pack = getRulePackVersion(PACK_ID, 1)!;
    expect(pack.digest).toBe(VERSION_ONE_DIGEST);
    expect(adoptionParameterProblem(pack, undefined)).toBe(`Leaf ${LEAF_ID} needs parameter limit`);
    expect(adoptionParameterProblem(pack, { [LEAF_ID]: { limit: 10 } })).toBeUndefined();
  });

  test('needs attention when the latest wind is above the adopted limit', () => {
    const leaf = takeoffWindLeaf();
    const result = runCheckedRule(
      leaf,
      { ...leaf.check.params, limit: 10 },
      // The engine hands a check its inputs newest first.
      { subject: [wind('w-2', '2026-10-05T09:05:00.000Z', 12.5), wind('w-1', '2026-10-05T09:00:00.000Z', 6)] },
      { mode: 'wall', evaluatedAt: '2026-10-05T09:10:00.000Z' },
    );
    expect(result).toMatchObject({
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'value_outside_limit',
      evidence: ['w-2'],
    });
  });
});
