import type { CheckedRuleLeaf, RuleRead, RulePackVersion } from '@ledger/contracts';
import { defineCheckedRule, valueWithinLimitV1 } from '@ledger/domain';
import { canonicalDigest } from '@ledger/integrity';

export const EXAMPLE_WEATHER_PACK_ID = 'ledger.example-weather';
export const WIND_AT_DEPARTURE_LEAF_ID = 'ledger.example-weather.wind-at-departure';
export const WIND_IN_FLIGHT_LEAF_ID = 'ledger.example-weather.wind-in-flight';

const VERSION_ONE_DIGEST = '4d1dac7e716b00bf34fd90e7f0c027cc240a0d6710b57770a30913a4b81f3426';

/** Invented for this repository. It is not a regulation and not a manufacturer limit. */
export const WIND_LIMIT_PROCEDURE_V1 =
  'Example operating procedure 5.2, wind limit. A flight takes off only when the wind last measured at its site at or before the takeoff is at or below the wind limit this organization sets when it adopts the procedure, and the wind measured at the site while the flight is reported in the air stays at or below that limit. The site of a flight is the operating site its flight plan names. Only measured wind counts; an estimate or a forecast does not. Wind above the limit needs attention from the crew and the operations lead.';

const source = {
  kind: 'operator_procedure' as const,
  reference: 'Example operating procedure 5.2 (invented for this repository)',
};

/** The flight's site is the operating site its latest flight plan names. */
const siteOfFlight = [
  {
    name: 'site',
    subjectKind: 'site' as const,
    fanOut: false,
    whenNone: 'insufficient' as const,
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

const reportRead: RuleRead = {
  name: 'report',
  type: 'flight.report',
  versions: [1],
  about: 'target',
  required: false,
  select: 'latest',
  where: [{ field: 'values.takeoffAt', filled: true }],
};

const windAtSite = (select: RuleRead['select']): RuleRead => ({
  name: 'subject',
  type: 'weather.wind',
  versions: [1],
  about: { related: 'site' },
  required: true,
  select,
  where: [{ field: 'values.method', oneOf: ['measured'] }],
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

const check = {
  kind: valueWithinLimitV1,
  params: { field: 'values.speedMetersPerSecond', comparison: 'at_most' },
};

/** The latest measured wind at the flight's site at or before the takeoff its flight report states. */
export function windAtDepartureLeafV1(procedureText: string = WIND_LIMIT_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: WIND_AT_DEPARTURE_LEAF_ID,
    version: 1,
    title: 'Wind at the site above the adopted limit at takeoff',
    source: { ...source, text: procedureText },
    target: { subjectKind: 'flight' },
    related: siteOfFlight,
    reads: [planRead, reportRead, windAtSite({ latestAtOrBefore: { read: 'report', field: 'values.takeoffAt' } })],
    applicability: [
      { input: 'report', field: 'values.activity', oneOf: ['active', 'landed'], whenAbsent: 'not_applicable' },
    ],
    check,
    adoptionParameters: limitParameter,
  });
}

/**
 * The latest measured wind at the flight's site while its latest flight report says it is in the air. The check
 * reads one value, so the rule is evaluated as each wind report arrives; once the flight is reported landed it no
 * longer applies, and a finding opened while it was in the air stays open until a person resolves it.
 */
export function windInFlightLeafV1(procedureText: string = WIND_LIMIT_PROCEDURE_V1): CheckedRuleLeaf {
  return defineCheckedRule({
    id: WIND_IN_FLIGHT_LEAF_ID,
    version: 1,
    title: 'Wind at the site above the adopted limit in flight',
    source: { ...source, text: procedureText },
    target: { subjectKind: 'flight' },
    related: siteOfFlight,
    reads: [planRead, reportRead, windAtSite('latest')],
    applicability: [{ input: 'report', field: 'values.activity', oneOf: ['active'], whenAbsent: 'not_applicable' }],
    check,
    adoptionParameters: limitParameter,
  });
}

/** Assembles version 1 and refuses it when its content no longer matches the pinned digest. */
export function exampleWeatherVersionOne(
  leaves: CheckedRuleLeaf[] = [windAtDepartureLeafV1(), windInFlightLeafV1()],
): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: EXAMPLE_WEATHER_PACK_ID,
    version: 1,
    title: 'Example weather procedures',
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

export function exampleWeatherRulePack() {
  return { packId: EXAMPLE_WEATHER_PACK_ID, versions: [exampleWeatherVersionOne()] };
}
