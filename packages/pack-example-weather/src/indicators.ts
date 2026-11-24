import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '@ledger/domain';
import { EXAMPLE_WEATHER_PACK_ID, WIND_IN_FLIGHT_LEAF_ID } from './example-weather-v1.js';

export const FLIGHTS_WITH_WIND_ABOVE_LIMIT_IN_FLIGHT_ID = 'example-weather.flights-with-wind-above-limit-in-flight';

/**
 * Flights with an in-flight wind finding, per 100 reported flights. The in-flight rule opens at most one finding per
 * flight and site, however many readings are above the limit, so its findings count flights. Wind above the limit at
 * departure is a second rule and is not counted: an event selection names one rule.
 */
export function flightsWithWindAboveLimitInFlightV1(): IndicatorDefinition {
  return defineIndicator({
    id: FLIGHTS_WITH_WIND_ABOVE_LIMIT_IN_FLIGHT_ID,
    version: 1,
    title: 'Flights with wind above the limit in flight, per 100 flights',
    description:
      'Findings opened by the example in-flight wind rule for the flights in scope, per 100 of those flights reported as taking off in the window. The rule opens one finding per flight, which stays open across later readings above the limit until a person resolves it, so this counts flights, not readings. A finding is placed by when it opened. Wind above the limit at departure alone is not counted.',
    scope: { kind: 'subject_kind', subjectKind: 'flight' },
    events: { kind: 'findings', packId: EXAMPLE_WEATHER_PACK_ID, ruleId: WIND_IN_FLIGHT_LEAF_ID },
    exposure: { kind: 'exposure.flights', version: 1, params: {} },
    window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 100, label: 'per 100 flights', fractionDigits: 2 },
  });
}
