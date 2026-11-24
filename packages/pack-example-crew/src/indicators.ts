import type { IndicatorDefinition } from '@ledger/contracts';
import { defineIndicator } from '@ledger/domain';
import { ASSIGNED_CREW_LEAF_ID, EXAMPLE_CREW_PACK_ID } from './example-crew-v1.js';

export const ASSIGNMENTS_OUTSIDE_LIMITS_ID = 'example-crew.assignments-outside-limits-per-duty-period';

/**
 * Flight assignments found outside the adopted limits, per 100 recorded duty periods of the people in scope. The
 * event is a finding of the per-flight rule: one person on one flight, placed by when it opened. It is not one event
 * per exceedance: a duty period that staffs three flights gives three findings, and a finding stays open across later
 * evaluations until a person resolves it.
 */
export function assignmentsOutsideLimitsV1(): IndicatorDefinition {
  return defineIndicator({
    id: ASSIGNMENTS_OUTSIDE_LIMITS_ID,
    version: 1,
    title: 'Crew assignments outside duty and rest limits per 100 duty periods',
    description:
      'Findings opened by the example per-flight crew rule for the people in scope (each one person assigned to one flight while outside an adopted duty or rest limit), per 100 duty and flight-duty periods those people have in the roster. A finding stays open until a person resolves it, and one long duty period counts once for every flight it staffs, so this counts assignments, not exceedances.',
    scope: { kind: 'subject_kind', subjectKind: 'person' },
    events: { kind: 'findings', packId: EXAMPLE_CREW_PACK_ID, ruleId: ASSIGNED_CREW_LEAF_ID },
    exposure: { kind: 'exposure.duty-period-count', version: 1, params: { periods: ['duty', 'flight_duty'] } },
    window: { maxMilliseconds: 92 * 24 * 60 * 60 * 1000 },
    completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: false },
    unit: { per: 100, label: 'per 100 duty periods', fractionDigits: 2 },
  });
}
