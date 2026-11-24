import type {
  Command,
  Input,
  OrderQuery,
  Receipt,
  ReceiptQuery,
  RulePackVersionParams,
  RulePackVersion,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionAcceptance,
  OrganizationDecisionsResponse,
  OrganizationDecisionCommand,
} from '../../../src/index.js';
export {
  ruleSelectionRead,
  ruleSelectionScheduled,
  ruleSelectionEligible,
  ruleSelectionExpired,
  ruleSelectionPending,
} from './rule-selection.js';

export const nprmPackRead = { packId: 'ledger.part108-nprm', version: 1 } satisfies RulePackVersionParams;

export function reviewShownAdoption(
  shown: OrganizationDecisionsResponse,
  adoption: Pick<PackAdoptionAcceptance, 'id' | 'acceptedRevision' | 'pack'>,
  note: string,
): OrganizationDecisionCommand {
  return {
    kind: 'decision.record',
    subject: { kind: 'organization' },
    expectedRevision: shown.organization.revision,
    inputCut: {
      ...shown.meta.inputCut,
      basisRevision: shown.organization.revision,
      principalRevision: shown.meta.inputCut.principalRevision!,
    },
    expectedDependencyBasis: shown.meta.dependencyBasis!,
    adoption: {
      id: adoption.id,
      acceptedRevision: adoption.acceptedRevision,
      pack: { packId: adoption.pack.packId, version: adoption.pack.version, digest: adoption.pack.digest },
    },
    decision: { kind: 'adoption.review', note },
  };
}

export function adoptShownPack(
  shown: OrganizationCoverageResponse,
  pack: RulePackVersion,
  effectiveInterval: PackAdoptionCommand['effectiveInterval'],
  note: string,
  mode: PackAdoptionCommand['mode'],
): PackAdoptionCommand {
  const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
    id,
    version,
    digest,
  });
  return {
    kind: 'rule-pack.adopt',
    expectedRevision: shown.organization.revision,
    inputCut: {
      ...shown.meta.inputCut,
      basisRevision: shown.organization.revision,
      principalRevision: shown.meta.inputCut.principalRevision!,
    },
    expectedDependencyBasis: shown.meta.dependencyBasis!,
    pack: {
      packId: pack.packId,
      version: pack.version,
      digest: pack.digest,
      leaves: pack.leaves.map(reference),
      bindings: pack.bindings.map(reference),
    },
    effectiveInterval,
    note,
    mode,
  };
}

export const draftProcedurePackRead = {
  packId: 'ledger.demo-procedures',
  version: 1,
} satisfies RulePackVersionParams;

export const draftAuthorizationPackRead = {
  packId: 'ledger.demo-procedures',
  version: 2,
} satisfies RulePackVersionParams;

export const reportedAuthorization = {
  sourceId: 'airspace-link',
  sourceSessionId: 'demo-71031:airspace:capture:1',
  kind: 'airspace.status',
  occurredAt: '2026-10-15T14:00:00Z',
  subject: { flightId: 'resolved-flight-1' },
  artifactId: 'resolved-authorization-artifact-1',
  fidelity: 'synthetic_contract',
  payload: {
    authorizationId: 'demo-71031:authorization:1',
    status: 'STATUS_APPROVED',
    authorizationRecord: {
      id: 'demo-71031:authorization:1',
      status: 'STATUS_APPROVED',
      lastUpdatedAt: '2026-10-15T14:00:00Z',
      startTime: '2026-10-15T14:05:00Z',
      endTime: '2026-10-15T14:20:00Z',
    },
  },
} satisfies Input;

export const identity = {
  runId: 'demo-71031',
  sourceId: 'partner-orders',
  sourceSessionId: 'demo-71031:partner:capture:1',
  intentId: 'demo-71031:intent:1',
  originationKey: 'demo-71031:intent:1:attempt:1',
  flightId: 'resolved-flight-1',
};

export const partnerOrder = {
  order_id: 'demo-71031:order:1',
  version: 1,
  state: 'accepted',
  updated_at: '2026-10-15T14:00:00Z',
  requested_work: { name: 'Pharmacy run · Eastside Clinic' },
  schedule: { start: '2026-10-15T14:05:00Z', end: '2026-10-15T14:20:00Z' },
  flights: [
    {
      flight_intent_id: identity.intentId,
      attempt: 1,
      order_refs: ['demo-71031:order:1'],
      aircraft_id: 'demo-71031:aircraft:1',
    },
  ],
};

export const orderInput = {
  sourceId: identity.sourceId,
  sourceSessionId: identity.sourceSessionId,
  kind: 'order.revision',
  occurredAt: partnerOrder.updated_at,
  sourceRevision: 1,
  subject: { orderId: partnerOrder.order_id },
  artifactId: 'resolved-order-artifact-1',
  fidelity: 'synthetic_contract',
  payload: {
    externalId: partnerOrder.order_id,
    revision: 1,
    status: 'accepted',
    label: partnerOrder.requested_work.name,
    scheduledStart: partnerOrder.schedule.start,
    scheduledEnd: partnerOrder.schedule.end,
    fulfillments: [
      {
        originationKey: identity.originationKey,
        label: partnerOrder.requested_work.name,
        aircraft: 'demo-71031:aircraft:1',
        scheduledStart: partnerOrder.schedule.start,
        scheduledEnd: partnerOrder.schedule.end,
        orderRefs: [{ orderId: partnerOrder.order_id, revision: 1 }],
        aliases: [{ sourceId: identity.sourceId, externalId: identity.intentId }],
      },
    ],
  },
} satisfies Input;

export const landing = {
  sourceId: 'flight-log',
  sourceSessionId: 'demo-71031:log:capture:1',
  kind: 'flight.observation',
  occurredAt: '2026-10-15T14:20:00Z',
  subject: { originationKey: identity.originationKey },
  artifactId: 'resolved-log-artifact-1',
  fidelity: 'synthetic_contract',
  payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
} satisfies Input;

export const lateLanding = {
  ...landing,
  sourceId: 'buffered-log',
  sourceSessionId: 'demo-71031:buffered:capture:1',
  artifactId: 'resolved-buffered-artifact-1',
  occurredAt: '2026-10-15T14:22:00Z',
  payload: { activity: 'landed', landingTime: '2026-10-15T14:22:00Z' },
} satisfies Input;

export const acceptedReceipt = {
  id: 'resolved-receipt-1',
  sourceId: landing.sourceId,
  kind: landing.kind,
  receivedAt: '2026-10-15T14:25:00Z',
  occurredAt: landing.occurredAt,
  status: 'accepted',
  processing: { status: 'pending', attempts: 0 },
  linkStatus: 'linked',
  flightId: identity.flightId,
  artifactId: landing.artifactId,
  eventId: 'resolved-event-1',
  payload: landing.payload,
} satisfies Receipt;

export const completedReceipt = {
  ...acceptedReceipt,
  processing: { status: 'completed', attempts: 1 },
} satisfies Receipt;

export const displayedBasis = {
  flight: { id: identity.flightId, revision: 4, basisRevision: 4 },
  meta: {
    inputCut: { streams: { 'resolved-stream-1': 3 }, basisRevision: 4, principalRevision: 1 },
    dependencyBasis: 'a'.repeat(64),
  },
};

export const decision = {
  kind: 'decision.record',
  flightId: identity.flightId,
  expectedRevision: displayedBasis.flight.revision,
  expectedBasisRevision: displayedBasis.flight.basisRevision,
  inputCut: displayedBasis.meta.inputCut,
  expectedDependencyBasis: displayedBasis.meta.dependencyBasis,
  decision: { kind: 'record.review', note: 'Reviewed the two landing reports; request the retained aircraft log.' },
} satisfies Command;

export const findingTreatmentDecision = {
  ...decision,
  findingTreatment: { findingId: 'resolved-finding-1', evaluationId: 'resolved-evaluation-1', action: 'acknowledge' },
  decision: {
    kind: 'finding.acknowledge',
    note: 'I will obtain the retained landing log and review the disagreement.',
  },
} satisfies Command;

export const awaitingFlightOrdersQuery = {
  sourceId: identity.sourceId,
  view: 'awaiting-flight',
  limit: 25,
} satisfies OrderQuery;

export const unlinkedEvidenceQuery = {
  linkStatus: 'unlinked',
  excludeKind: 'order.revision',
  limit: 25,
} satisfies ReceiptQuery;

export const deliveryCases = {
  retry: {
    endpoint: '/v1/inputs',
    key: 'demo-71031:flight-log:landing:1',
    body: landing,
    recoveredReceipt: completedReceipt,
    expected: 'same_receipt_and_event',
  },
  conflictingRetry: {
    endpoint: '/v1/inputs',
    key: 'demo-71031:flight-log:landing:1',
    body: { ...landing, payload: { ...landing.payload, landingTime: '2026-10-15T14:21:00Z' } },
    expected: { status: 409, code: 'idempotency_conflict' },
  },
  landingDisagreement: {
    inputs: [landing, lateLanding],
    expected: { coverage: 'conflicting', recordedFinding: false },
  },
  staleDecision: {
    body: decision,
    currentDependencyBasis: 'b'.repeat(64),
    expected: { status: 409, code: 'stale_basis', action: 'refresh_and_review' },
  },
};
