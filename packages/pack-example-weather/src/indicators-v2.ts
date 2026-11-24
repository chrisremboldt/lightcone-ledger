import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '@ledger/domain';
import { EXAMPLE_WEATHER_PACK_ID } from './example-weather-v1.js';
import { WIND_AT_TAKEOFF_LEAF_ID, WIND_FOR_FLIGHT_LEAF_ID } from './example-weather-v2.js';

export const WIND_EXCEEDANCES_PER_100_FLIGHTS_ID = 'example-weather.wind-exceedances-per-100-flights';
export const FLIGHTS_WITH_WIND_ABOVE_LIMIT_ID = 'example-weather.flights-with-wind-above-limit';

const windRules = {
  kind: 'issues' as const,
  packId: EXAMPLE_WEATHER_PACK_ID,
  ruleId: WIND_AT_TAKEOFF_LEAF_ID,
  alsoRules: [{ packId: EXAMPLE_WEATHER_PACK_ID, ruleId: WIND_FOR_FLIGHT_LEAF_ID }],
};

const perHundredFlights = {
  scope: { kind: 'subject_kind' as const, subjectKind: 'flight' as const },
  exposure: { kind: 'exposure.flights', version: 1, params: {} },
  window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
  completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
  unit: { per: 100, label: 'per 100 flights', fractionDigits: 2 },
};

/**
 * Each wind exceedance, per 100 reported flights: the wind in effect at takeoff above the limit is one, and each
 * stretch of measured wind above the limit during the flight is one more.
 */
export function windExceedancesPer100FlightsV1(): IndicatorDefinition {
  return defineIndicator({
    id: WIND_EXCEEDANCES_PER_100_FLIGHTS_ID,
    version: 1,
    title: 'Wind exceedances per 100 flights',
    description:
      'The issues the example takeoff and whole-flight wind rules named for the flights in scope, per 100 of those flights reported as taking off in the window. The wind in effect at takeoff above the limit is one exceedance, and each stretch of measured wind above the limit between takeoff and landing is another, so two stretches on one flight count as two. Each is placed by when it began and ended.',
    events: windRules,
    ...perHundredFlights,
  });
}

/** Flights with any wind exceedance, at takeoff or during the flight, per 100 reported flights; each flight once. */
export function flightsWithWindAboveLimitV1(): IndicatorDefinition {
  return defineIndicator({
    id: FLIGHTS_WITH_WIND_ABOVE_LIMIT_ID,
    version: 1,
    title: 'Flights with wind above the limit, per 100 flights',
    description:
      'The flights in scope with at least one issue named by the example takeoff or whole-flight wind rule in the window, per 100 of those flights reported as taking off in the window. A flight is counted once however many stretches above the limit it had and under however many of the two rules.',
    events: { ...windRules, countEach: 'subject' },
    ...perHundredFlights,
  });
}
