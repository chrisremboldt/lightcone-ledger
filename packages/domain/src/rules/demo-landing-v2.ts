import type { CheckedRuleLeaf, RuleRead } from '@ledger/contracts';
import { evidenceDueV1, valuesDisagreeV1 } from '../check-kind-evidence.js';
import { defineCheckedRule } from '../checked-rules.js';

// The demo procedures' two landing checks as data: they read flight reports and the flight's own state through the
// generic evaluator. Version 1 of each ran in the built-in flight evaluator and stays in pack versions 1 to 3.

const REFERENCE = 'ledger.demo-procedures.4';
const flightReports: Omit<RuleRead, 'name'> = {
  type: 'flight.report',
  versions: [1],
  about: 'target',
  required: false,
  select: 'all',
};
const flightState = { name: 'state', required: true } as const;
// A cancelled flight is not checked for landing evidence.
const notCancelled: CheckedRuleLeaf['applicability'] = [
  { input: 'state', field: 'status', oneOf: ['unknown', 'planned', 'active', 'landed'], whenAbsent: 'insufficient' },
];
const landingAt = { fields: ['values.landingAt'], valueType: 'utc_instant' } as const;

export const landingDisagreementLeafV2: CheckedRuleLeaf = defineCheckedRule({
  id: 'ledger.demo.landing-disagreement',
  version: 2,
  title: 'Landing time disagreement',
  source: {
    kind: 'operator_procedure',
    reference: REFERENCE,
    text: 'For a flight that is not cancelled, review distinct valid UTC landing times reported by current flight reports.',
  },
  target: { subjectKind: 'flight' },
  reads: [{ name: 'reports', ...flightReports }],
  subjectState: flightState,
  applicability: notCancelled,
  check: { kind: valuesDisagreeV1, params: { ...landingAt } },
  wording: {
    attention: '{valueCount} distinct landing times are reported. Review the retained observations.',
    pass: 'The valid recorded landing times do not disagree.',
    pending: 'No valid UTC landing time is recorded to compare.',
  },
});

export const missingLandingEvidenceLeafV2: CheckedRuleLeaf = defineCheckedRule({
  id: 'ledger.demo.missing-landing-evidence',
  version: 2,
  title: 'Landing evidence overdue',
  source: {
    kind: 'operator_procedure',
    reference: REFERENCE,
    text: 'For a flight that is not cancelled, record a valid UTC landing time by five minutes after its scheduled end.',
  },
  target: { subjectKind: 'flight' },
  reads: [{ name: 'evidence', ...flightReports }],
  subjectState: flightState,
  applicability: notCancelled,
  check: { kind: evidenceDueV1, params: { ...landingAt, deadlineField: 'scheduledEnd', graceSeconds: 300 } },
  wording: {
    pass: 'A valid UTC landing time is recorded.',
    attention: 'No valid UTC landing time is recorded after the five-minute grace period.',
    pending: 'Landing evidence is awaited until {dueAt}, five minutes after the scheduled end.',
  },
});

export const landingLeavesV2: readonly CheckedRuleLeaf[] = [landingDisagreementLeafV2, missingLandingEvidenceLeafV2];
