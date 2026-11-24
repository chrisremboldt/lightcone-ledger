import type {
  CommandLinkEvaluationEvidence,
  CommandLinkInput,
  CommandLinkSource,
  FindingRecord,
  TimelineItem,
} from '../../../src/index.js';
import {
  bindInvestigationProposal,
  type InvestigationAdvice,
  type InvestigationCitation,
  type InvestigationContext,
  type InvestigationMissingEvidence,
  type InvestigationRequest,
  type InvestigationResponse,
} from '../../../src/investigation.js';
import { canonicalDigest, canonicalize, sha256 } from '../../../../integrity/src/index.js';
import { adoptedCommandLinkFinding, draftCommandLinkFinding } from './c2-execution.js';
import { commandLinkLossEvidence, commandLinkRestorationEvidence } from './command-link-findings.js';
import {
  commandLinkLoss,
  commandLinkLossSource,
  commandLinkRestoration,
  commandLinkRestorationSource,
} from './command-link.js';

function collectedReport(
  input: CommandLinkInput,
  original: CommandLinkSource,
  evidence: CommandLinkEvaluationEvidence,
) {
  const bytes = canonicalize(original);
  const receivedAt = new Date(Date.parse(evidence.occurredAt) + 1000).toISOString();
  const item: TimelineItem = {
    id: evidence.eventId,
    lane: 'observed',
    kind: 'command-link.status',
    title: input.payload.status === 'lost' ? 'Command-link loss reported' : 'Command-link restoration reported',
    occurredAt: evidence.occurredAt,
    receivedAt,
    actorId: 'resolved-command-link-adapter',
    sourceId: evidence.sourceId,
    payload: { ...input.payload, sourceSessionId: input.sourceSessionId },
    receiptId: evidence.receiptId,
    artifactId: input.artifactId,
    linkStatus: 'linked',
  };
  const citation: InvestigationCitation = {
    ...evidence,
    id: evidence.receiptId,
    status: input.payload.status,
    receivedAt,
    artifact: {
      id: input.artifactId,
      sha256: sha256(bytes),
      byteLength: Buffer.byteLength(bytes, 'utf8'),
      contentType: 'application/json',
    },
    publicTimelineItemDigest: canonicalDigest(item),
  };
  return { item, citation, original: { artifactId: input.artifactId, bytes } };
}

const loss = collectedReport(commandLinkLoss, commandLinkLossSource, commandLinkLossEvidence);
const restoration = collectedReport(
  commandLinkRestoration,
  commandLinkRestorationSource,
  commandLinkRestorationEvidence,
);
export const investigationTimelineItems = [loss.item, restoration.item];
export const investigationOriginals = [loss.original, restoration.original];

function context(
  finding: FindingRecord,
  citations: InvestigationCitation[],
  missingEvidence: InvestigationMissingEvidence[],
): InvestigationContext {
  const initial = finding.initialEvaluation;
  const selected = finding.latestEvaluation;
  const before = new Set(initial.explanation.evidence.map((report) => report.receiptId));
  const after = new Set(selected.explanation.evidence.map((report) => report.receiptId));
  const principalRevision = 4;
  const content: Omit<InvestigationContext, 'digest'> = {
    version: 'ledger.investigation-context.1',
    pin: {
      apiUrl: 'https://ledger.invalid',
      tenantId: 'fixture-tenant',
      principalId: finding.owner!.id,
      principalRevision,
      flightId: finding.flightId,
      findingId: finding.id,
      evaluation: { id: selected.id, digest: canonicalDigest(selected) },
      basis: {
        revision: 7,
        basisRevision: 3,
        inputCut: { ...selected.acceptedInputCut, principalRevision },
        dependencyBasis: selected.dependencyBasis,
        view: 'record',
      },
    },
    finding: { status: finding.status, owner: finding.owner, openedAt: finding.openedAt },
    initialEvaluation: { record: initial, digest: canonicalDigest(initial) },
    selectedEvaluation: { record: selected, digest: canonicalDigest(selected) },
    history: {
      scope: 'initial_and_selected_evaluations',
      treatments: finding.treatments,
      omittedTreatments: finding.hasOlderTreatments,
    },
    citations,
    comparison: {
      initial: { id: initial.id, digest: canonicalDigest(initial) },
      selected: { id: selected.id, digest: canonicalDigest(selected) },
      addedCitationIds: [...after].filter((id) => !before.has(id)),
      removedCitationIds: [...before].filter((id) => !after.has(id)),
    },
    missingEvidence,
    allowedActions: selected.outcome === 'pass' ? ['respond', 'resolve'] : ['respond'],
  };
  return { ...structuredClone(content), digest: canonicalDigest(content) };
}

export const investigationContext = context(adoptedCommandLinkFinding, [loss.citation, restoration.citation], []);
export const investigationAdvice = {
  summary: 'The selected evaluation records a matching restoration for the reported command-link loss.',
  citations: [investigationContext.selectedEvaluation.record.id, loss.citation.id, restoration.citation.id],
  comparison: {
    summary: 'The selected evaluation adds a restoration report to the loss retained by the initial evaluation.',
    citations: [
      investigationContext.initialEvaluation.record.id,
      investigationContext.selectedEvaluation.record.id,
      restoration.citation.id,
    ],
  },
  missingEvidence: [],
  suggestedTreatment: {
    action: 'resolve',
    note: 'Reviewed the matching loss and later restoration reports in the selected evaluation.',
    rationale: 'The recorded owner may review resolution against the current finding before accepting any treatment.',
    citations: [loss.citation.id, restoration.citation.id, adoptedCommandLinkFinding.treatments[0]!.id],
  },
} satisfies InvestigationAdvice;
export const investigationProposal = bindInvestigationProposal(investigationContext, investigationAdvice);
export const proposedInvestigationRequest = {
  evaluation: structuredClone(investigationContext.pin.evaluation),
  basis: structuredClone(investigationContext.pin.basis),
} satisfies InvestigationRequest;
export const proposedInvestigationResponse = {
  proposal: bindInvestigationProposal(investigationContext, investigationAdvice),
  execution: { provider: 'fixture-provider', model: 'fixture-model' },
} satisfies InvestigationResponse;

export const insufficientInvestigationContext = context(
  draftCommandLinkFinding,
  [loss.citation],
  [
    {
      id: 'selected-restoration-missing',
      code: 'qualifying_restoration_not_in_selected_evaluation',
      evaluationId: draftCommandLinkFinding.latestEvaluation.id,
      citationIds: [loss.citation.id],
    },
    {
      id: 'selected-evidence-insufficient',
      code: 'selected_evaluation_insufficient',
      evaluationId: draftCommandLinkFinding.latestEvaluation.id,
      citationIds: [draftCommandLinkFinding.latestEvaluation.id],
    },
  ],
);
export const insufficientInvestigationAdvice = {
  summary: 'The selected evaluation lacks a qualifying restoration strictly later than its latest loss.',
  citations: [loss.citation.id, draftCommandLinkFinding.latestEvaluation.id],
  comparison: {
    summary: 'The initial and selected evaluations are the same collected record.',
    citations: [draftCommandLinkFinding.initialEvaluation.id],
  },
  missingEvidence: [
    {
      id: 'selected-restoration-missing',
      note: 'The selected evaluation has no qualifying restoration strictly later than the latest loss in this scope.',
    },
    { id: 'selected-evidence-insufficient', note: 'The selected evaluation explicitly records insufficient evidence.' },
  ],
  suggestedTreatment: null,
} satisfies InvestigationAdvice;
export const insufficientInvestigationProposal = bindInvestigationProposal(
  insufficientInvestigationContext,
  insufficientInvestigationAdvice,
);
