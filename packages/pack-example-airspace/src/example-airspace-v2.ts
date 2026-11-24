import type { CheckedRuleLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, positionInAreaV2 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import { EXAMPLE_AIRSPACE_PACK_ID, exampleAirspaceVersionOne, operatingAreaLeafV1 } from './example-airspace-v1.js';

export const OPERATING_AREA_PER_FLIGHT_LEAF_ID = 'ledger.example-airspace.operating-area-per-flight';

const VERSION_TWO_DIGEST = '3ec667d5e305a7083990aed54ddcd05f488240db2e862807db3eb888a47ca074';

/** Invented for this repository. It is not a regulation, an airspace authorization or a manufacturer limit. */
export const OPERATING_AREA_PER_FLIGHT_PROCEDURE_V1 =
  'Example operating procedure 4.2, operating area per flight. From the takeoff to the landing its flight report states, the aircraft named in the report keeps its reported position inside the circular operating area this organization sets when it adopts the procedure, widened by the margin it sets. Two or more consecutive reported positions outside the area and margin are an excursion, and each excursion needs attention from the crew and the operations lead. A position reported with no fix, or with a horizontal accuracy worse than 50 meters, is left out; a position whose fix quality the source does not state is used, and the evaluation says how many positions were left out.';

/**
 * Per flight, between takeoff and landing: the aircraft is the flight report's secondary subject, and its positions
 * are read from the takeoff to the landing the report states, or to the evaluation while the flight is in the air.
 * Each excursion is one issue with its times.
 */
export function operatingAreaPerFlightLeafV1(
  procedureText: string = OPERATING_AREA_PER_FLIGHT_PROCEDURE_V1,
): CheckedRuleLeaf {
  const v1 = operatingAreaLeafV1();
  return defineCheckedRule({
    id: OPERATING_AREA_PER_FLIGHT_LEAF_ID,
    version: 1,
    title: 'Position outside the adopted operating area during the flight',
    source: {
      kind: 'operator_procedure',
      reference: 'Example operating procedure 4.2 (invented for this repository)',
      text: procedureText,
    },
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'aircraft',
        subjectKind: 'aircraft',
        fanOut: false,
        whenNone: 'insufficient',
        from: { read: 'window', field: 'secondarySubject' },
      },
    ],
    reads: [
      {
        name: 'window',
        type: 'flight.report',
        versions: [1],
        about: 'target',
        required: false,
        select: 'latest',
        where: [{ field: 'values.takeoffAt', filled: true }],
      },
      {
        name: 'positions',
        type: 'position.fix',
        versions: [1],
        about: { related: 'aircraft' },
        required: false,
        select: { within: { read: 'window', startField: 'values.takeoffAt', endField: 'values.landingAt' } },
      },
    ],
    applicability: [
      { input: 'window', field: 'values.activity', oneOf: ['active', 'landed'], whenAbsent: 'not_applicable' },
    ],
    check: {
      kind: positionInAreaV2,
      params: {
        expect: 'inside',
        scope: 'any',
        minPositions: 2,
        unusable: [{ field: 'values.fix', oneOf: ['none'] }],
        accuracyField: 'values.horizontalAccuracyMeters',
        maxAccuracyMeters: 50,
        windowStartField: 'values.takeoffAt',
        windowEndField: 'values.landingAt',
        coverage: 'required',
      },
    },
    adoptionParameters: v1.adoptionParameters,
    wording: {
      attention:
        '{excursionCount} excursion(s) outside the operating area and margin during the flight, {secondsOutside} s in all; the first from {excursionStartedAt} to {excursionLastAt} ({excursionPositions} positions), up to {maxDistanceOutsideMeters} m beyond.',
    },
  });
}

/**
 * Version 2: the per-flight rule, which reads the aircraft's positions between takeoff and landing and names each
 * excursion, in place of version 1's rule over the aircraft's latest positions. Version 1 stays registered as pinned.
 */
export function exampleAirspaceVersionTwo(
  leaves: CheckedRuleLeaf[] = [operatingAreaPerFlightLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_AIRSPACE_PACK_ID,
    version: 2,
    title: 'Example operating area procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_TWO_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 2 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

/** Every registered version; version 1 stays as pinned. */
export function exampleAirspaceRulePack() {
  return { packId: EXAMPLE_AIRSPACE_PACK_ID, versions: [exampleAirspaceVersionOne(), exampleAirspaceVersionTwo()] };
}
