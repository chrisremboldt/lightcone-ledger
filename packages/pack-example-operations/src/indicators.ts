import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '@ledger/domain';
import { EXAMPLE_OPERATIONS_PACK_ID } from './example-operations-v1.js';
import { BATTERY_AT_LANDING_LEAF_ID } from './example-operations-v2.js';
import { BATTERY_FOR_FLIGHT_LEAF_ID } from './example-operations-v3.js';

export const LOW_RESERVE_LANDINGS_PER_100_FLIGHTS_ID = 'example-operations.low-reserve-landings-per-100-flights';
export const RESERVE_EXCEEDANCES_PER_FLIGHT_HOUR_ID = 'example-operations.reserve-exceedances-per-flight-hour';

const flightsInScope = {
  scope: { kind: 'subject_kind' as const, subjectKind: 'flight' as const },
  window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
  completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
};

/**
 * Flights that landed with the battery below the reserve, per 100 reported flights. The landing rule is evaluated
 * per flight and opens at most one finding for each flight, so each flight counts once.
 */
export function lowReserveLandingsPer100FlightsV1(): IndicatorDefinition {
  return defineIndicator({
    id: LOW_RESERVE_LANDINGS_PER_100_FLIGHTS_ID,
    version: 1,
    title: 'Low-reserve landings per 100 flights',
    description:
      'The flights in scope whose battery, as last reported at or before the landing, was below the reserve the organization adopted for the example landing rule, per 100 of those flights reported as taking off in the window. The landing rule opens one finding for each such flight, so a flight counts once however many reports or evaluations show it; a flight counts in the window in which its finding was opened.',
    events: { kind: 'findings', packId: EXAMPLE_OPERATIONS_PACK_ID, ruleId: BATTERY_AT_LANDING_LEAF_ID },
    exposure: { kind: 'exposure.flights', version: 1, params: {} },
    unit: { per: 100, label: 'per 100 flights', fractionDigits: 2 },
    ...flightsInScope,
  });
}

/**
 * Each stretch of battery reports below the reserve between takeoff and landing, per reported flight hour. Two
 * stretches on one flight count as two.
 */
export function reserveExceedancesPerFlightHourV1(): IndicatorDefinition {
  return defineIndicator({
    id: RESERVE_EXCEEDANCES_PER_FLIGHT_HOUR_ID,
    version: 1,
    title: 'Battery reserve exceedances per flight hour',
    description:
      'The stretches of battery reports below the adopted reserve that the example whole-flight rule named for the flights in scope, per hour of reported takeoff-to-landing time in the window. Each stretch counts once however many evaluations name it, two stretches on one flight count as two, and each is placed by when it began and ended.',
    events: { kind: 'issues', packId: EXAMPLE_OPERATIONS_PACK_ID, ruleId: BATTERY_FOR_FLIGHT_LEAF_ID },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 2 },
    ...flightsInScope,
  });
}

/** The indicators over this pack's rules, for whoever registers them with the pack. */
export function exampleOperationsIndicators(): IndicatorDefinition[] {
  return [lowReserveLandingsPer100FlightsV1(), reserveExceedancesPerFlightHourV1()];
}
