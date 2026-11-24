import type {
  CommandLinkEvaluationEvidence,
  EvaluationRecord,
  FindingRecord,
  RulePackVersionParams,
} from '../../../src/index.js';
import { commandLinkLoss, commandLinkLossSource, commandLinkRestorationSource } from './command-link.js';

export const commandLinkProcedurePackRead = {
  packId: 'ledger.demo-procedures',
  version: 3,
} satisfies RulePackVersionParams;

export const commandLinkLossEvidence = {
  sourceSessionId: commandLinkLossSource.sourceSessionId,
  sourceEventId: commandLinkLossSource.sourceEventId,
  incidentId: commandLinkLossSource.incidentId,
  aircraftId: commandLinkLossSource.aircraftId,
  occurredAt: commandLinkLossSource.occurredAt,
  status: commandLinkLossSource.status,
  flightId: commandLinkLoss.subject.flightId,
  eventId: 'resolved-link-loss-event',
  receiptId: 'resolved-link-loss-receipt',
  sourceId: commandLinkLoss.sourceId,
} satisfies CommandLinkEvaluationEvidence;
export const commandLinkRestorationEvidence = {
  sourceSessionId: commandLinkRestorationSource.sourceSessionId,
  sourceEventId: commandLinkRestorationSource.sourceEventId,
  incidentId: commandLinkRestorationSource.incidentId,
  aircraftId: commandLinkRestorationSource.aircraftId,
  occurredAt: commandLinkRestorationSource.occurredAt,
  status: commandLinkRestorationSource.status,
  flightId: commandLinkLoss.subject.flightId,
  eventId: 'resolved-link-restoration-event',
  receiptId: 'resolved-link-restoration-receipt',
  sourceId: commandLinkLoss.sourceId,
} satisfies CommandLinkEvaluationEvidence;

const group = {
  sourceId: commandLinkLoss.sourceId,
  sourceSessionId: commandLinkLoss.sourceSessionId,
  incidentId: commandLinkLoss.payload.incidentId,
  aircraftId: commandLinkLoss.payload.aircraftId,
  lossEventIds: [commandLinkLossEvidence.eventId],
};
const basis = { streams: { 'resolved-link-stream': 1 }, basisRevision: 3, principalRevision: 1 };
export const commandLinkLossEvaluation = {
  id: 'resolved-link-loss-evaluation',
  flightId: commandLinkLoss.subject.flightId,
  leafId: 'ledger.demo.command-link-loss-review',
  leafVersion: 1,
  bindingId: 'ledger.command-link-status',
  bindingVersion: 1,
  applicability: 'applicable',
  evidenceState: 'insufficient',
  outcome: 'attention',
  title: 'Reported command-link loss',
  explanation: {
    kind: 'command_link',
    code: 'command_link_restoration_missing',
    summary: 'A reported loss lacks a later restoration in the same source, session, incident and aircraft scope.',
    evidence: [commandLinkLossEvidence],
    groups: [{ ...group, state: 'unresolved', restorationEventIds: [] }],
    evaluatedAt: '2026-10-15T14:12:05Z',
  },
  clock: { mode: 'wall', evaluatedAt: '2026-10-15T14:12:05Z' },
  inputCut: basis,
  acceptedInputCut: basis,
  dependencyBasis: 'c'.repeat(64),
  recordedAt: '2026-10-15T14:12:05Z',
} satisfies EvaluationRecord;
export const commandLinkRestoredEvaluation = {
  ...commandLinkLossEvaluation,
  id: 'resolved-link-restoration-evaluation',
  evidenceState: 'supported',
  outcome: 'pass',
  explanation: {
    kind: 'command_link',
    code: 'command_link_losses_restored',
    summary: 'Matching restoration is recorded. The finding remains open for explicit human resolution.',
    evidence: [commandLinkLossEvidence, commandLinkRestorationEvidence],
    groups: [{ ...group, state: 'restored', restorationEventIds: [commandLinkRestorationEvidence.eventId] }],
    evaluatedAt: '2026-10-15T14:12:35Z',
  },
  clock: { mode: 'wall', evaluatedAt: '2026-10-15T14:12:35Z' },
  inputCut: { ...basis, streams: { 'resolved-link-stream': 2 } },
  acceptedInputCut: { ...basis, streams: { 'resolved-link-stream': 2 } },
  recordedAt: '2026-10-15T14:12:35Z',
} satisfies EvaluationRecord;
export const restoredCommandLinkFinding = {
  id: 'resolved-command-link-finding',
  flightId: commandLinkLoss.subject.flightId,
  status: 'acknowledged',
  owner: { id: 'resolved-operator', name: 'Dana Ortiz' },
  openedAt: commandLinkLossEvaluation.recordedAt,
  initialEvaluation: commandLinkLossEvaluation,
  latestEvaluation: commandLinkRestoredEvaluation,
  treatments: [],
  hasOlderTreatments: false,
} satisfies FindingRecord;
