import type { CheckedRuleLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, positionInAreaV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';

export const EXAMPLE_AIRSPACE_PACK_ID = 'ledger.example-airspace';
export const OPERATING_AREA_LEAF_ID = 'ledger.example-airspace.operating-area';

const VERSION_ONE_DIGEST = 'f67a8435a27ae4939dc4b7be15256965feda566aee6d4f6d3e9deb127d572d3c';

/** Invented for this repository. It is not a regulation, an airspace authorization or a manufacturer limit. */
export const OPERATING_AREA_PROCEDURE_V1 =
  'Example operating procedure 4.1, operating area. Each aircraft keeps its reported position inside the circular operating area this organization sets when it adopts the procedure, widened by the margin it sets. Two or more consecutive reported positions outside the area and margin are an excursion and need attention from the crew and the operations lead. A position reported with no fix, or with a horizontal accuracy worse than 50 meters, is left out; a position whose fix quality the source does not state is used, and the evaluation says how many positions were left out.';

/**
 * The aircraft's reported positions against the operating area the organization adopted. The rule reads the
 * aircraft's own positions: until a rule can read a related subject, the area is an adoption parameter rather than
 * the flight's recorded area.
 */
export function operatingAreaLeafV1(procedureText: string = OPERATING_AREA_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: OPERATING_AREA_LEAF_ID,
    version: 1,
    title: 'Position outside the adopted operating area',
    source: {
      kind: 'operator_procedure',
      reference: 'Example operating procedure 4.1 (invented for this repository)',
      text: procedureText,
    },
    target: { subjectKind: 'aircraft' },
    reads: [{ name: 'positions', type: 'position.fix', versions: [1], about: 'target', required: true, select: 'all' }],
    check: {
      kind: positionInAreaV1,
      params: {
        expect: 'inside',
        scope: 'latest',
        minPositions: 2,
        unusable: [{ field: 'values.fix', oneOf: ['none'] }],
        accuracyField: 'values.horizontalAccuracyMeters',
        maxAccuracyMeters: 50,
      },
    },
    adoptionParameters: [
      {
        name: 'centerLatitude',
        title: 'Operating area centre latitude (degrees)',
        valueType: 'number',
        minimum: -80,
        maximum: 80,
      },
      {
        name: 'centerLongitude',
        title: 'Operating area centre longitude (degrees)',
        valueType: 'number',
        minimum: -180,
        maximum: 180,
      },
      {
        name: 'radiusMeters',
        title: 'Operating area radius (meters)',
        valueType: 'number',
        minimum: 1,
        maximum: 10_000,
      },
      {
        name: 'marginMeters',
        title: 'Margin beyond the area (meters)',
        valueType: 'number',
        minimum: 0,
        maximum: 1_000,
      },
    ],
    wording: {
      attention:
        'Outside the operating area and margin from {excursionStartedAt} to {excursionLastAt} ({excursionPositions} positions), up to {maxDistanceOutsideMeters} m beyond.',
    },
  });
}

/** Assembles version 1 and refuses it when its content no longer matches the pinned digest. */
export function exampleAirspaceVersionOne(leaves: CheckedRuleLeaf[] = [operatingAreaLeafV1()]): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_AIRSPACE_PACK_ID,
    version: 1,
    title: 'Example operating area procedures',
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

export function exampleAirspaceRulePack() {
  return { packId: EXAMPLE_AIRSPACE_PACK_ID, versions: [exampleAirspaceVersionOne()] };
}
