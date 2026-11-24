import type { CheckedRuleLeaf, RuleRead, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, windowValuesWithinLimitV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';
import { EXAMPLE_WEATHER_PACK_ID, exampleWeatherVersionOne } from './example-weather-v1.js';

export const WIND_AT_TAKEOFF_LEAF_ID = 'ledger.example-weather.wind-at-takeoff';
export const WIND_FOR_FLIGHT_LEAF_ID = 'ledger.example-weather.wind-for-flight';

const VERSION_TWO_DIGEST = '9c706716d0018e540ae00e4afb7b50f30d325642df0f1149a4981203a1530ad7';

/** Invented for this repository. It is not a regulation and not a manufacturer limit. */
export const WIND_LIMIT_PROCEDURE_V2 =
  'Example operating procedure 5.3, wind limit for the whole flight. A flight takes off only when the wind last measured at its site at or before the takeoff is at or below the wind limit this organization sets when it adopts the procedure, and every wind measured at the site from the takeoff to the landing is at or below that limit. The site of a flight is the operating site its flight plan names. Only measured wind counts; an estimate or a forecast does not. Where the site reports no wind for a flight, the wind at takeoff the crew writes in the flight log is checked against the same limit. Each stretch of measurements above the limit needs attention from the crew and the operations lead, and the site must report wind at least once a minute while the flight is in the air.';

const source = {
  kind: 'operator_procedure' as const,
  reference: 'Example operating procedure 5.3 (invented for this repository)',
};

/** The flight's site is the operating site its latest flight plan names; with none, the flight record is read. */
const siteOfFlight = [
  {
    name: 'site',
    subjectKind: 'site' as const,
    fanOut: false,
    whenNone: 'empty' as const,
    from: { read: 'plan', field: 'values.record.siteId' },
  },
];

const planRead: RuleRead = {
  name: 'plan',
  type: 'operator.record',
  versions: [1],
  about: 'target',
  required: false,
  select: 'latest',
  where: [
    { field: 'values.recordType', oneOf: ['flight.plan'] },
    { field: 'values.recordVersion', oneOf: [1] },
  ],
};

/** The latest flight report, which states the window: its takeoff and, once landed, its landing. */
const windowRead: RuleRead = {
  name: 'window',
  type: 'flight.report',
  versions: [1],
  about: 'target',
  required: false,
  select: 'latest',
  where: [{ field: 'values.takeoffAt', filled: true }],
};

const windAtSite = (select: RuleRead['select']): RuleRead => ({
  name: 'values',
  type: 'weather.wind',
  versions: [1],
  about: { related: 'site' },
  required: false,
  select,
  where: [{ field: 'values.method', oneOf: ['measured'] }],
});

/** A flight reported as flown, or known only from the operator's record of it as flown. */
const flown = [
  { input: 'window', field: 'values.activity', oneOf: ['active', 'landed'], whenAbsent: 'applies' as const },
];

/** The operator's own flight record, read when the site reports no wind for the flight. */
const flightRecordRead: RuleRead = {
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

/** The wind at takeoff the operator recorded, and the record's takeoff to landing as the window. */
const recordedWind = (windowEndField: string) => ({
  recordedField: 'values.record.windAtTakeoffMetersPerSecond',
  recordedAtField: 'values.record.takeoffAt',
  recordedStartField: 'values.record.takeoffAt',
  recordedEndField: windowEndField,
  recordedDescribes: 'wind at takeoff in the operator’s flight record',
  reportedDescribes: 'measured wind at the site',
});

const limitParameter = [
  {
    name: 'limit',
    title: 'Wind limit (meters per second)',
    valueType: 'number' as const,
    minimum: 1,
    maximum: 40,
  },
];

const compared = { field: 'values.speedMetersPerSecond', comparison: 'at_most', coverage: 'required', unit: 'm/s' };

/** The wind in effect at the flight's site at its takeoff: the latest measured at or before the takeoff. */
export function windAtTakeoffLeafV1(procedureText: string = WIND_LIMIT_PROCEDURE_V2): CheckedRuleLeaf {
  return defineCheckedRule({
    id: WIND_AT_TAKEOFF_LEAF_ID,
    version: 1,
    title: 'Wind at the site above the adopted limit at takeoff',
    source: { ...source, text: procedureText },
    target: { subjectKind: 'flight' },
    related: siteOfFlight,
    reads: [
      planRead,
      windowRead,
      windAtSite({ latestAtOrBefore: { read: 'window', field: 'values.takeoffAt' } }),
      flightRecordRead,
    ],
    applicability: flown,
    check: {
      kind: windowValuesWithinLimitV1,
      params: {
        ...compared,
        windowStartField: 'values.takeoffAt',
        windowEndField: 'values.takeoffAt',
        includeValueAtStart: true,
        ...recordedWind('values.record.takeoffAt'),
      },
    },
    adoptionParameters: limitParameter,
    wording: {
      attention: 'At takeoff the measured wind was {worstValue} m/s, above the {limit} m/s limit.{recordedNote}',
    },
  });
}

/**
 * Every measured wind at the flight's site from its takeoff to its landing. While the flight is in the air the
 * result covers the wind so far; after the landing it covers the whole flight and does not change when the site
 * reports more wind. Each stretch above the limit is one issue with its times.
 */
export function windForFlightLeafV1(procedureText: string = WIND_LIMIT_PROCEDURE_V2): CheckedRuleLeaf {
  return defineCheckedRule({
    id: WIND_FOR_FLIGHT_LEAF_ID,
    version: 1,
    title: 'Wind at the site above the adopted limit during the flight',
    source: { ...source, text: procedureText },
    target: { subjectKind: 'flight' },
    related: siteOfFlight,
    reads: [
      planRead,
      windowRead,
      windAtSite({ within: { read: 'window', startField: 'values.takeoffAt', endField: 'values.landingAt' } }),
      flightRecordRead,
    ],
    applicability: flown,
    check: {
      kind: windowValuesWithinLimitV1,
      params: {
        ...compared,
        windowStartField: 'values.takeoffAt',
        windowEndField: 'values.landingAt',
        maxGapSeconds: 60,
        ...recordedWind('values.record.landingAt'),
      },
    },
    adoptionParameters: limitParameter,
    wording: {
      attention:
        '{runCount} stretch(es) of measured wind above the {limit} m/s limit from {firstRunStartedAt}, {secondsOutside} s in all; the highest was {worstValue} m/s at {worstValueAt}.{recordedNote}',
    },
  });
}

/**
 * Version 2: the takeoff and whole-flight rules, which name each stretch above the limit, in place of version 1's
 * two rules over the latest reading. Version 1 stays registered as pinned.
 */
export function exampleWeatherVersionTwo(
  leaves: CheckedRuleLeaf[] = [windAtTakeoffLeafV1(), windForFlightLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_WEATHER_PACK_ID,
    version: 2,
    title: 'Example weather procedures',
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
export function exampleWeatherRulePack() {
  return { packId: EXAMPLE_WEATHER_PACK_ID, versions: [exampleWeatherVersionOne(), exampleWeatherVersionTwo()] };
}
