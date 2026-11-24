import type {
  FlightRuleSelectionAdoption,
  FlightRuleSelectionParams,
  FlightRuleSelectionRecordV1,
  FlightRuleSelectionRecordParams,
  FlightRuleSelectionRecordResponse,
  FlightRuleSelectionResponse,
} from '../../../src/index.js';

export const ruleSelectionRead = { id: 'resolved-flight-1' } satisfies FlightRuleSelectionParams;
const adoption = {
  id: 'resolved-company-v3-adoption',
  acceptedRevision: 2,
  pack: {
    id: 'ledger.demo-procedures',
    version: 3,
    digest: '46f777c1c391b696cffc45b450cb61b8563b28417f67ac087522b57e34e56188',
  },
  leaf: {
    id: 'ledger.demo.command-link-loss-review',
    version: 1,
    digest: '77f0b870a2b60221f39b3a35687cc5dac8f525adcdbf18e273d56517aa0a84e3',
  },
  binding: {
    id: 'ledger.command-link-status',
    version: 1,
    digest: 'a8d3e22580e514d8a1910aef848325d08ac621e44ffc266d533c1a6f1bdc7eb0',
  },
  effectiveInterval: { start: '2026-10-15T14:05:00Z', end: '2026-10-15T14:20:00Z' },
} satisfies FlightRuleSelectionAdoption;

function selectionResponse(
  state: 'scheduled' | 'eligible' | 'expired' | 'pending',
  evaluatedAt: string,
  selectionDigest: string,
  dependencyBasis: string,
): Omit<FlightRuleSelectionResponse, 'selection'> & { selection: FlightRuleSelectionRecordV1 } {
  const organizationId = 'organization:fixture-tenant';
  const projectedAdoptionRevision = state === 'pending' ? 1 : 2;
  const renderedInputCut = {
    streams: { 'resolved-flight-stream': 1, 'resolved-organization-stream': projectedAdoptionRevision },
    basisRevision: 3,
    principalRevision: 1,
  };
  const record: FlightRuleSelectionRecordV1 = {
    version: 'flight.rule-selection.1',
    id: `resolved-rule-selection-${state}`,
    flightId: ruleSelectionRead.id,
    organizationId,
    clock: { mode: 'wall', evaluatedAt },
    adoptionRevision: 2,
    projectedAdoptionRevision,
    selection: { state, adoption },
    execution: { status: 'inactive', baseline: 'builtin_draft' },
    nextBoundary:
      state === 'scheduled' || state === 'pending'
        ? { at: adoption.effectiveInterval.start, adoptionId: adoption.id, kind: 'start' }
        : state === 'eligible'
          ? { at: adoption.effectiveInterval.end, adoptionId: adoption.id, kind: 'end' }
          : null,
    renderedInputCut,
    acceptedInputCut: {
      ...renderedInputCut,
      streams: { ...renderedInputCut.streams, 'resolved-organization-stream': 2 },
    },
    dependencyBasis,
    basisManifest: {
      version: 'subject-evidence.1',
      subjectId: ruleSelectionRead.id,
      principalId: 'resolved-worker',
      principalRevision: 1,
      subjects: [organizationId, ruleSelectionRead.id],
      edges: [
        {
          subjectId: ruleSelectionRead.id,
          dependencySubjectId: organizationId,
          eventId: 'resolved-selection-flight-created-event',
        },
      ],
      frontiers: [
        {
          subjectId: organizationId,
          streamId: 'resolved-organization-stream',
          sequence: 2,
          projectedSequence: projectedAdoptionRevision,
        },
        {
          subjectId: ruleSelectionRead.id,
          streamId: 'resolved-flight-stream',
          sequence: 1,
          projectedSequence: 1,
        },
      ],
      authority: null,
    },
    selectionDigest,
  };
  return {
    selection: record,
    asOf: evaluatedAt,
    convergence: { status: 'current', reason: null },
    meta: {
      requestId: `rule-selection-${state}`,
      projectionRevision: 3,
      inputCut: renderedInputCut,
      dependencyBasis,
      computedAt: evaluatedAt,
      outstandingWork: state === 'pending' ? 1 : 0,
    },
  };
}

export const ruleSelectionScheduled = selectionResponse(
  'scheduled',
  '2026-10-15T14:00:00Z',
  'adfd70f1b8477bfb0a1055f9d8171a3b2ce4b900f00cca847bb878d665ee0927',
  '930d02abd650f8093bdbbda5cf96f16e2705b661dc56f3846a60bb36e2b63a05',
);
export const ruleSelectionEligible = selectionResponse(
  'eligible',
  '2026-10-15T14:10:00Z',
  'fd8247dabd2d7b67973f232941b258afc8d715a9a299a8ab8a70693e405d3d5d',
  '930d02abd650f8093bdbbda5cf96f16e2705b661dc56f3846a60bb36e2b63a05',
);
export const ruleSelectionExpired = selectionResponse(
  'expired',
  '2026-10-15T14:20:00Z',
  'b5c316dddf7a5d3eb55848b68282be5af9d7c0b70ea8fe2a485c6c5fd3f6f199',
  '930d02abd650f8093bdbbda5cf96f16e2705b661dc56f3846a60bb36e2b63a05',
);
export const ruleSelectionPending = selectionResponse(
  'pending',
  '2026-10-15T14:00:00Z',
  '8b78e0ce6c7981a0a21d62a54c9e519a645e27b295da5e2e847507a46b31a561',
  '650fb0d4de34511d32ca8fc63657162c94d17a92e98a15ec755ddb1d0ed5ddfe',
);

export const ruleSelectionRecordRead = {
  id: ruleSelectionRead.id,
  selectionId: ruleSelectionEligible.selection.id,
} satisfies FlightRuleSelectionRecordParams;
export const ruleSelectionRecordV1 = {
  selection: ruleSelectionEligible.selection,
} satisfies FlightRuleSelectionRecordResponse;
export const ruleSelectionRecordV2 = {
  selection: {
    ...ruleSelectionEligible.selection,
    id: 'resolved-rule-selection-historical-v2',
    version: 'flight.rule-selection.2',
    execution: {
      status: 'active',
      baseline: 'builtin_draft',
      policyVersion: 'ledger.company-c2-execution.1',
      evaluator: {
        id: 'ledger.command-link-evidence',
        version: 1,
        digest: 'c25bef5721e555b19b3db564f6999d0fae967db642e7e5a56cd5dba490f46482',
      },
    },
    selectionDigest: 'f7f340c91f861493f0f74605173846ffa42c072b448a73a69b589a128174b649',
  },
} satisfies FlightRuleSelectionRecordResponse;
