import type { DecisionRecord, TimelineItem } from '@ledger/contracts';

/**
 * Which packet the decision record offers. A treatment of a finding whose basis is a rule evaluation offers the
 * finding's packet; a treatment of a retained lost-link evaluation in its own explanation format shows the older
 * decision packets issued for it, which are no longer issued. The answer comes from the retained records only.
 */
export type DecisionPacketOffer = { kind: 'finding'; findingId: string } | { kind: 'older' } | { kind: 'none' };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const none: DecisionPacketOffer = { kind: 'none' };

export function decisionPacketOffer(decision: DecisionRecord, item: TimelineItem | null): DecisionPacketOffer {
  if (!item || item.id !== decision.id || item.kind !== 'decision.record') return none;
  const payload = item.payload;
  const treatment = payload.findingTreatment;
  const retainedDecision = payload.decision;
  const basis = payload.acceptedFindingBasis;
  if (
    payload.flightId !== decision.flightId ||
    !object(treatment) ||
    !object(retainedDecision) ||
    !object(basis) ||
    !['acknowledge', 'respond', 'resolve'].includes(String(treatment.action)) ||
    retainedDecision.kind !== `finding.${treatment.action}` ||
    retainedDecision.kind !== decision.kind ||
    typeof treatment.findingId !== 'string' ||
    !treatment.findingId ||
    typeof basis.id !== 'string' ||
    !basis.id ||
    treatment.evaluationId !== basis.id ||
    basis.flightId !== decision.flightId ||
    !object(basis.explanation)
  )
    return none;
  // A finding from a rule evaluation has the generic finding packet; the server confirms the records when it issues.
  if (basis.explanation.kind === 'rule') return { kind: 'finding', findingId: treatment.findingId };
  // Only a retained lost-link evaluation, in its own explanation format, ever had the older packet format.
  return basis.explanation.kind === 'command_link' && Array.isArray(basis.explanation.evidence)
    ? { kind: 'older' }
    : none;
}
