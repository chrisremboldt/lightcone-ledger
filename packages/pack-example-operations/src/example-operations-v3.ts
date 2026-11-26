import type { CheckedRuleLeaf, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, windowValuesWithinLimitV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import {
  batteryReserveLeafV1,
  EXAMPLE_OPERATIONS_PACK_ID,
  exampleOperationsVersionOne,
} from './example-operations-v1.js';
import {
  batteryAtLandingLeafV1,
  exampleOperationsVersionTwo,
  flightRecordRead,
  recordedBattery,
} from './example-operations-v2.js';

export const BATTERY_FOR_FLIGHT_LEAF_ID = 'ledger.example-operations.battery-reserve-for-flight';

const VERSION_THREE_DIGEST = '8dce3b5596d3f9694129bc2c520fc3e4bce0e56bd5f04e92b0bd490f8cf1648a';

/** Invented for this repository. It is not a regulation and not a manufacturer limit. */
export const BATTERY_FOR_FLIGHT_PROCEDURE_V1 =
  'Example operating procedure 3.4, battery reserve for the whole flight. For each flight, every remaining battery the aircraft named in its flight report reports from the takeoff to the landing stays at or above the reserve percentage this organization sets when it adopts the procedure. Where the aircraft reports no battery for a flight, the battery remaining at landing the crew writes in the flight log is checked against the same reserve. Each stretch of reports below that reserve needs attention from the crew and the operations lead, and so does a flight with no battery report between its takeoff and landing.';

/**
 * Per flight, from takeoff to landing: the aircraft is the flight report's secondary subject, and every battery
 * report it makes between the takeoff and the landing the report states is checked. Each stretch below the reserve
 * is one issue with its times.
 */
export function batteryForFlightLeafV1(procedureText: string = BATTERY_FOR_FLIGHT_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: BATTERY_FOR_FLIGHT_LEAF_ID,
    version: 1,
    title: 'Battery below adopted reserve during the flight',
    source: {
      kind: 'operator_procedure',
      reference: 'Example operating procedure 3.4 (invented for this repository)',
      text: procedureText,
    },
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'aircraft',
        subjectKind: 'aircraft',
        fanOut: false,
        whenNone: 'empty',
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
        name: 'values',
        type: 'battery.state',
        versions: [1],
        about: { related: 'aircraft' },
        required: false,
        select: { within: { read: 'window', startField: 'values.takeoffAt', endField: 'values.landingAt' } },
      },
      flightRecordRead,
    ],
    applicability: [{ input: 'window', field: 'values.activity', oneOf: ['active', 'landed'], whenAbsent: 'applies' }],
    check: {
      kind: windowValuesWithinLimitV1,
      params: {
        field: 'values.totalRemainingPercent',
        comparison: 'at_least',
        windowStartField: 'values.takeoffAt',
        windowEndField: 'values.landingAt',
        coverage: 'required',
        unit: '%',
        ...recordedBattery('values.record.takeoffAt'),
      },
    },
    adoptionParameters: [
      {
        name: 'limit',
        title: 'Battery reserve during the flight (percent remaining)',
        valueType: 'number',
        minimum: 1,
        maximum: 100,
      },
    ],
    wording: {
      attention:
        'The battery was below the {limit}% reserve during the flight from {firstRunStartedAt}, {runCount} stretch(es) and {secondsOutside} s in all; the lowest was {worstValue}% at {worstValueAt}.{recordedNote}',
    },
  });
}

/** Version 3: the rules of version 2, unchanged, and the per-flight rule over the whole flight. */
export function exampleOperationsVersionThree(
  leaves: CheckedRuleLeaf[] = [batteryReserveLeafV1(), batteryAtLandingLeafV1(), batteryForFlightLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_OPERATIONS_PACK_ID,
    version: 3,
    title: 'Example operating procedures',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_THREE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 3 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

/** Every registered version; versions 1 and 2 stay as pinned. */
export function exampleOperationsRulePack() {
  return {
    packId: EXAMPLE_OPERATIONS_PACK_ID,
    versions: [exampleOperationsVersionOne(), exampleOperationsVersionTwo(), exampleOperationsVersionThree()],
  };
}
