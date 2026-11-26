import type { CheckedRuleLeaf, RulePackVersion, RuleRead } from '@ledger/contracts';
import { defineCheckedRule, windowValuesWithinLimitV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import {
  batteryReserveLeafV1,
  EXAMPLE_OPERATIONS_PACK_ID,
  exampleOperationsVersionOne,
} from './example-operations-v1.js';

export const BATTERY_AT_LANDING_LEAF_ID = 'ledger.example-operations.battery-reserve-at-landing';

const VERSION_TWO_DIGEST = 'eec5d43781e50a519d94e7c4a2fdecebff4140367f655e3f8efb4827012b8c1d';

/** Invented for this repository. It is not a regulation and not a manufacturer limit. */
export const BATTERY_AT_LANDING_PROCEDURE_V1 =
  'Example operating procedure 3.3, battery reserve at landing. For each flight that lands, the aircraft named in its flight report keeps the remaining battery it last reported at or before the landing at or above the reserve percentage this organization sets when it adopts the procedure. Where the aircraft reports no battery for a flight, the battery remaining at landing the crew writes in the flight log is checked against the same reserve. A lower value needs attention from the crew and the operations lead.';

/**
 * Per flight, at the landing: the aircraft is the flight report's secondary subject, and its battery is the latest
 * report at or before the landing time the flight report states. Where no report states the battery, the battery
 * remaining at landing in the operator's own flight record is read.
 */
export function batteryAtLandingLeafV1(procedureText: string = BATTERY_AT_LANDING_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: BATTERY_AT_LANDING_LEAF_ID,
    version: 1,
    title: 'Battery below adopted reserve at landing',
    source: {
      kind: 'operator_procedure',
      reference: 'Example operating procedure 3.3 (invented for this repository)',
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
        where: [{ field: 'values.landingAt', filled: true }],
      },
      {
        name: 'values',
        type: 'battery.state',
        versions: [1],
        about: { related: 'aircraft' },
        required: false,
        select: { latestAtOrBefore: { read: 'window', field: 'values.landingAt' } },
      },
      flightRecordRead,
    ],
    applicability: [{ input: 'window', field: 'values.activity', oneOf: ['landed'], whenAbsent: 'applies' }],
    check: {
      kind: windowValuesWithinLimitV1,
      params: {
        field: 'values.totalRemainingPercent',
        comparison: 'at_least',
        coverage: 'required',
        windowStartField: 'values.landingAt',
        windowEndField: 'values.landingAt',
        includeValueAtStart: true,
        unit: '%',
        ...recordedBattery('values.record.landingAt'),
      },
    },
    adoptionParameters: [
      {
        name: 'limit',
        title: 'Battery reserve at landing (percent remaining)',
        valueType: 'number',
        minimum: 1,
        maximum: 100,
      },
    ],
  });
}

/** The operator's own flight record, read when the aircraft reports no battery for the flight. */
export const flightRecordRead: RuleRead = {
  name: 'recorded',
  type: 'operator.record',
  versions: [1],
  about: 'target',
  required: false,
  select: 'latest',
  where: [
    { field: 'values.recordType', oneOf: ['flight.record'] },
    { field: 'values.recordVersion', oneOf: [1] },
  ],
};

/** The battery remaining at landing the operator recorded, and the record's window from the given start to its landing. */
export const recordedBattery = (windowStartField: string) => ({
  recordedField: 'values.record.batteryAtLandingPercent',
  recordedAtField: 'values.record.landingAt',
  recordedStartField: windowStartField,
  recordedEndField: 'values.record.landingAt',
  recordedDescribes: 'battery remaining at landing in the operator’s flight record',
  reportedDescribes: 'battery remaining',
});

/** Version 2: the aircraft rule of version 1, unchanged, and the per-flight rule at the landing. */
export function exampleOperationsVersionTwo(
  leaves: CheckedRuleLeaf[] = [batteryReserveLeafV1(), batteryAtLandingLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_OPERATIONS_PACK_ID,
    version: 2,
    title: 'Example operating procedures',
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
export function exampleOperationsRulePack() {
  return {
    packId: EXAMPLE_OPERATIONS_PACK_ID,
    versions: [exampleOperationsVersionOne(), exampleOperationsVersionTwo()],
  };
}
