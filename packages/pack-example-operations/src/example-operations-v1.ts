import type { CheckedRuleLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, valueWithinLimitV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';

export const EXAMPLE_OPERATIONS_PACK_ID = 'ledger.example-operations';
export const BATTERY_RESERVE_LEAF_ID = 'ledger.example-operations.battery-reserve';

const VERSION_ONE_DIGEST = 'e56e599b0e0fd54f8dbc9de743c1b61edb115a2f47b232358a2df80fea7606bb';

/** Invented for this repository. It is not a regulation and not a manufacturer limit. */
export const BATTERY_RESERVE_PROCEDURE_V1 =
  'Example operating procedure 3.2, battery reserve. Each aircraft keeps its reported remaining battery at or above the reserve percentage this organization sets when it adopts the procedure. A report below that reserve needs attention from the crew and the operations lead.';

/** The aircraft's latest reported total remaining battery, compared with the reserve the organization adopted. */
export function batteryReserveLeafV1(procedureText: string = BATTERY_RESERVE_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: BATTERY_RESERVE_LEAF_ID,
    version: 1,
    title: 'Battery below adopted reserve',
    source: {
      kind: 'operator_procedure',
      reference: 'Example operating procedure 3.2 (invented for this repository)',
      text: procedureText,
    },
    target: { subjectKind: 'aircraft' },
    reads: [
      { name: 'subject', type: 'battery.state', versions: [1], about: 'target', required: true, select: 'latest' },
    ],
    check: {
      kind: valueWithinLimitV1,
      params: { field: 'values.totalRemainingPercent', comparison: 'at_least' },
    },
    adoptionParameters: [
      { name: 'limit', title: 'Battery reserve (percent remaining)', valueType: 'number', minimum: 1, maximum: 100 },
    ],
  });
}

/** Assembles version 1 and refuses it when its content no longer matches the pinned digest. */
export function exampleOperationsVersionOne(leaves: CheckedRuleLeaf[] = [batteryReserveLeafV1()]): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_OPERATIONS_PACK_ID,
    version: 1,
    title: 'Example operating procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

/** Version 1 alone. The registered pack, with every version, is exampleOperationsRulePack in example-operations-v2.ts. */
export function exampleOperationsRulePack() {
  return { packId: EXAMPLE_OPERATIONS_PACK_ID, versions: [exampleOperationsVersionOne()] };
}
