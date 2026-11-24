import type { AcceptedObservation, EvaluationRecord } from '../../../src/index.js';

// The landing-disagreement evaluations and the reports they cite. The flight-side hazard examples that once lived
// here were retired with that system; the file keeps its name so existing importers keep working.
const flightId = 'resolved-landing-flight';
const flightCut = {
  streams: {
    'resolved-organization-stream': 1,
    'resolved-landing-flight-stream': 1,
    'resolved-landing-source-stream': 2,
  },
  basisRevision: 3,
  principalRevision: 1,
};
const reports = [
  {
    eventId: 'resolved-aircraft-landing-event',
    receiptId: 'resolved-aircraft-landing-receipt',
    sourceId: 'aircraft-log',
    occurredAt: '2026-10-16T14:12:00.000Z',
  },
  {
    eventId: 'resolved-ground-landing-event',
    receiptId: 'resolved-ground-landing-receipt',
    sourceId: 'ground-log',
    occurredAt: '2026-10-16T14:13:00.000Z',
  },
];
export const landingDisagreementEvaluation = {
  id: 'resolved-landing-evaluation',
  flightId,
  leafId: 'ledger.demo.landing-disagreement',
  leafVersion: 1,
  bindingId: 'ledger.flight-observation',
  bindingVersion: 1,
  applicability: 'applicable',
  evidenceState: 'conflicting',
  outcome: 'attention',
  title: 'Landing time disagreement',
  rule: {
    reference: 'ledger.demo-procedures.1',
    text: 'For a flight that is not cancelled, review distinct valid UTC landing times reported by active flight observations.',
    review: 'ai_drafted',
    adopted: false,
  },
  explanation: {
    code: 'landing_times_disagree',
    summary: '2 distinct landing times are reported. Review the retained observations.',
    evidence: reports,
    landingTimes: reports.map((report) => ({
      ...report,
      field: 'landingTime' as const,
      value: report.occurredAt,
      valid: true,
      normalizedTime: report.occurredAt,
    })),
    evaluatedAt: '2026-10-16T14:14:00.000Z',
  },
  clock: { mode: 'wall', evaluatedAt: '2026-10-16T14:14:00.000Z' },
  inputCut: flightCut,
  acceptedInputCut: flightCut,
  dependencyBasis: '86d884a479b169260b8293eeea14a7d87bf3b761966c506e7e7fc9c6f24fbc6d',
  recordedAt: '2026-10-16T14:14:00.000Z',
} satisfies EvaluationRecord;
/** The same disagreement as the generic evaluator records it, shown in the flight's evaluation shape. */
export const landingDisagreementRuleEvaluation = {
  ...landingDisagreementEvaluation,
  id: 'resolved-landing-rule-evaluation',
  leafVersion: 2,
  bindingId: 'ledger.demo-procedures',
  bindingVersion: 4,
  rule: { ...landingDisagreementEvaluation.rule, reference: 'ledger.demo-procedures.4' },
  explanation: {
    kind: 'rule',
    code: 'values_disagree',
    summary: '2 distinct landing times are reported. Review the retained observations.',
    evidence: reports.map((report) => ({
      ...report,
      observationId: report.eventId,
      type: 'flight.report',
      version: 1,
    })),
    details: {
      values: reports.map((report) => report.occurredAt).join(', '),
      valueCount: 2,
      reportCount: 2,
    },
    parameters: { fields: ['values.landingAt'], valueType: 'utc_instant' },
    inputs: [{ name: 'reports', type: 'flight.report', observationIds: reports.map((report) => report.eventId) }],
    ruleEvaluation: {
      pack: { id: 'ledger.demo-procedures', version: 4, digest: '0'.repeat(64) },
      ruleDigest: '1'.repeat(64),
      check: { kind: 'values.disagree', version: 1 },
      mode: 'active',
      subjectKey: `ledger/flight/${flightId}`,
    },
    evaluatedAt: '2026-10-16T14:14:00.000Z',
  },
} satisfies EvaluationRecord;

/** The flight reports the rule evaluation cites, as the observation reads return them. */
export const landingReportObservations: AcceptedObservation[] = reports.map((report) => ({
  id: report.eventId,
  receiptId: report.receiptId,
  eventId: report.eventId,
  artifactId: `${report.eventId}-artifact`,
  sourceId: report.sourceId,
  type: 'flight.report',
  version: 1,
  subject: { kind: 'flight', id: flightId, scope: 'ledger', ledgerId: flightId, resolution: 'ledger' },
  occurredAt: report.occurredAt,
  receivedAt: report.occurredAt,
  fidelity: 'synthetic_contract',
  observation: {
    type: 'flight.report',
    version: 1,
    subject: { kind: 'flight', id: flightId, scope: 'ledger' },
    occurredAt: report.occurredAt,
    fidelity: 'synthetic_contract',
    limitations: [],
    originalArtifactId: `${report.eventId}-artifact`,
    values: { activity: 'landed', landingAt: report.occurredAt },
  },
}));
