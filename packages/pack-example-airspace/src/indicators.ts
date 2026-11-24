import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '@ledger/domain';
import { EXAMPLE_AIRSPACE_PACK_ID, OPERATING_AREA_LEAF_ID } from './example-airspace-v1.js';
import { OPERATING_AREA_PER_FLIGHT_LEAF_ID } from './example-airspace-v2.js';

export const EXCURSIONS_PER_FLIGHT_HOUR_ID = 'example-airspace.excursions-per-flight-hour';

/**
 * Excursions from the adopted operating area per flight hour of the aircraft in scope. An excursion is a finding the
 * operating-area rule opened, placed by when it opened; flight hours are the reported takeoff to landing time.
 */
export function excursionsPerFlightHourV1(): IndicatorDefinition {
  return defineIndicator({
    id: EXCURSIONS_PER_FLIGHT_HOUR_ID,
    version: 1,
    title: 'Operating area excursions per flight hour',
    description:
      'Findings opened by the example operating-area rule for the aircraft in scope, per reported flight hour of those aircraft. A finding stays open across later excursions of the same aircraft until a person resolves it, so this counts aircraft found outside their area, not every excursion.',
    scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
    events: { kind: 'findings', packId: EXAMPLE_AIRSPACE_PACK_ID, ruleId: OPERATING_AREA_LEAF_ID },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
  });
}

/**
 * Version 2: every excursion the per-flight operating-area rule named, per flight hour of the flights in scope. Each
 * excursion is one issue, so two excursions on one flight count as two.
 */
export function excursionsPerFlightHourV2(): IndicatorDefinition {
  return defineIndicator({
    id: EXCURSIONS_PER_FLIGHT_HOUR_ID,
    version: 2,
    title: 'Operating area excursions per flight hour',
    description:
      'The excursions the example per-flight operating-area rule named for the flights in scope, between each flight’s takeoff and landing, per reported flight hour of those flights. Each excursion is counted once, placed by its first and last positions, however many evaluations name it, so two excursions on one flight count as two.',
    scope: { kind: 'subject_kind', subjectKind: 'flight' },
    events: { kind: 'issues', packId: EXAMPLE_AIRSPACE_PACK_ID, ruleId: OPERATING_AREA_PER_FLIGHT_LEAF_ID },
    exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
    window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
    unit: { per: 1, label: 'per flight hour', fractionDigits: 3 },
  });
}
