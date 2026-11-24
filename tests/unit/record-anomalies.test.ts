import { describe, expect, it } from 'vitest';
import type {
  CommandLinkEvaluationEvidence,
  EvaluationRecord,
  FindingRecord,
  RuleEvaluationEvidence,
  RuleEvaluationExplanation,
  TimelineItem,
} from '@ledger/contracts';
import { buildAnomalyPresentation } from '../../apps/web/src/record-anomalies.js';
import {
  commandLinkLossEvidence,
  commandLinkRestorationEvidence,
  restoredCommandLinkFinding,
} from '../../packages/contracts/fixtures/demo/v1/command-link-findings.js';
import { landingDisagreementRuleEvaluation } from '../../packages/contracts/fixtures/demo/v1/landing-hazards.js';

function item(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  occurredAt = '2026-10-15T14:12:00Z',
): TimelineItem {
  return {
    id,
    kind,
    payload,
    occurredAt,
    receivedAt: '2026-10-18T14:00:00Z',
    title: 'Routine record',
    lane: 'observed',
    actorId: 'source-principal',
    linkStatus: 'linked',
  };
}

function report(evidence: CommandLinkEvaluationEvidence): TimelineItem {
  return {
    ...item(
      evidence.eventId,
      'command-link.status',
      {
        status: evidence.status,
        sourceSessionId: evidence.sourceSessionId,
        incidentId: evidence.incidentId,
        aircraftId: evidence.aircraftId,
        sourceEventId: evidence.sourceEventId,
      },
      evidence.occurredAt,
    ),
    receiptId: evidence.receiptId,
    sourceId: evidence.sourceId,
  };
}

function finding(evaluation: EvaluationRecord): FindingRecord {
  return {
    id: 'landing-finding',
    flightId: evaluation.flightId,
    status: 'open',
    owner: null,
    openedAt: evaluation.recordedAt,
    initialEvaluation: evaluation,
    latestEvaluation: evaluation,
    treatments: [],
    hasOlderTreatments: false,
  };
}

describe('typed retained timeline concerns', () => {
  it('keeps loss history highlighted after restoration and explicit resolution, independent of row order and titles', () => {
    const resolved: FindingRecord = { ...restoredCommandLinkFinding, status: 'resolved' };
    const loss = report(commandLinkLossEvidence);
    const restoration = report(commandLinkRestorationEvidence);
    const unrelated = item('ordinary', 'source.observation', { title: 'Command link lost' });
    const result = buildAnomalyPresentation([restoration, unrelated, loss], [resolved], loss.id);
    expect(result.get(loss.id)?.findingId).toBeUndefined();
    const exact = buildAnomalyPresentation([restoration, unrelated, loss], [resolved], resolved.flightId);
    expect(exact.get(loss.id)).toMatchObject({
      kind: 'command-link-loss',
      tone: 'attention',
      severity: 'unknown',
      findingId: resolved.id,
      related: [{ eventId: restoration.id, label: 'Reported restoration' }],
    });
    expect(exact.get(loss.id)?.detail).toContain('30 s between the reported loss and restoration');
    expect(exact.get(loss.id)?.detail).not.toContain('Finding resolved');
    expect(exact.get(restoration.id)?.kind).toBe('command-link-restoration');
    expect(exact.has(unrelated.id)).toBe(false);
  });

  it('reads reports that arrived as link.status observations as it reads recorded command-link reports', () => {
    const observed = (evidence: CommandLinkEvaluationEvidence): TimelineItem => ({
      ...report(evidence),
      kind: 'observation',
      payload: {
        type: 'link.status',
        version: 1,
        subject: { kind: 'flight', id: evidence.flightId, scope: 'ledger' },
        secondarySubject: { kind: 'aircraft', id: evidence.aircraftId, scope: 'source' },
        occurredAt: evidence.occurredAt,
        sourceEventId: evidence.sourceEventId,
        sourceSessionId: evidence.sourceSessionId,
        values: {
          link: 'command_control',
          state: evidence.status === 'lost' ? 'down' : 'up',
          report: 'transition',
          sourceEpisodeId: evidence.incidentId,
        },
      },
    });
    const finding = restoredCommandLinkFinding;
    const recorded = buildAnomalyPresentation(
      [report(commandLinkLossEvidence), report(commandLinkRestorationEvidence)],
      [finding],
      finding.flightId,
    );
    const loss = observed(commandLinkLossEvidence);
    const restoration = observed(commandLinkRestorationEvidence);
    expect(buildAnomalyPresentation([loss, restoration], [finding], finding.flightId)).toEqual(recorded);
    const video = {
      ...loss,
      payload: { ...loss.payload, values: { ...(loss.payload.values as object), link: 'video' } },
    };
    expect(buildAnomalyPresentation([video], [], finding.flightId).has(video.id)).toBe(false);
  });

  it('does not pair adjacent native reports or accept mismatched retained source scopes', () => {
    const loss = report(commandLinkLossEvidence);
    const other = report({ ...commandLinkRestorationEvidence, incidentId: 'another-incident' });
    const noContext = buildAnomalyPresentation([loss, other], [], restoredCommandLinkFinding.flightId);
    expect(noContext.get(loss.id)?.related).toBeUndefined();
    expect(noContext.get(loss.id)?.detail).toContain('Related restoration is not confirmed');
    for (const field of ['sourceId', 'sourceSessionId', 'incidentId', 'aircraftId'] as const) {
      const mismatched = structuredClone(restoredCommandLinkFinding) as FindingRecord;
      if (!('kind' in mismatched.latestEvaluation.explanation)) throw new Error('Expected C2 fixture');
      const restoration = mismatched.latestEvaluation.explanation.evidence[1]!;
      restoration[field] = `another-${field}`;
      const wrongScope = report(restoration);
      const result = buildAnomalyPresentation([loss, wrongScope], [mismatched], mismatched.flightId);
      expect(result.get(loss.id)?.detail).not.toContain('30 s');
      expect(result.get(wrongScope.id)?.findingId).toBeUndefined();
    }
  });

  it('keeps tied and repeated reports explicit without inventing a zero or continuous outage duration', () => {
    for (const mode of ['tie', 'multiple'] as const) {
      const retained = structuredClone(restoredCommandLinkFinding) as FindingRecord;
      if (!('kind' in retained.latestEvaluation.explanation)) throw new Error('Expected C2 fixture');
      const explanation = retained.latestEvaluation.explanation;
      if (mode === 'tie') {
        explanation.groups[0]!.state = 'conflicting';
        explanation.evidence[1]!.occurredAt = explanation.evidence[0]!.occurredAt;
      } else {
        explanation.evidence.push({ ...explanation.evidence[0]!, eventId: 'second-loss' });
        explanation.groups[0]!.lossEventIds.push('second-loss');
      }
      const reports = explanation.evidence.map(report);
      const result = buildAnomalyPresentation(reports, [retained], retained.flightId);
      expect(result.get(commandLinkLossEvidence.eventId)?.detail).toContain('Duration unknown');
      expect(result.get(commandLinkLossEvidence.eventId)?.detail).not.toContain('30 s between');
    }
  });

  it('uses retained landing evidence, including receiptless corrections, while preserving the original disagreement', () => {
    const retained = finding(structuredClone(landingDisagreementRuleEvaluation));
    const explanation = retained.initialEvaluation.explanation as RuleEvaluationExplanation;
    const [first, second] = explanation.evidence as [RuleEvaluationEvidence, RuleEvaluationEvidence];
    const reports = [first, second].map((evidence) => ({
      ...item(
        evidence.eventId,
        'flight.observation',
        { activity: 'landed', landingTime: evidence.occurredAt },
        evidence.occurredAt,
      ),
      sourceId: evidence.sourceId,
      receiptId: evidence.receiptId,
    }));
    const correction: TimelineItem = {
      ...item('correction', 'evidence.correct', { activity: 'landed', landingTime: second.occurredAt }),
      correctionOf: `${first.eventId}:${retained.flightId}`,
    };
    const secondCorrection: TimelineItem = {
      ...item('second-correction', 'evidence.correct', { activity: 'landed', landingTime: second.occurredAt }),
      correctionOf: correction.id,
    };
    retained.latestEvaluation = {
      ...retained.initialEvaluation,
      id: 'cleared-evaluation',
      outcome: 'pass',
      evidenceState: 'supported',
      explanation: { ...explanation, code: 'values_agree', details: { ...explanation.details, valueCount: 1 } },
    };
    retained.status = 'resolved';
    const result = buildAnomalyPresentation([secondCorrection, ...reports, correction], [retained], retained.flightId);
    expect(result.get(first.eventId)?.kind).toBe('landing-disagreement');
    expect(result.get(first.eventId)?.detail).toContain('1 min');
    expect(result.get(first.eventId)?.detail).toContain('correction is appended');
    expect(result.get(correction.id)).toMatchObject({
      kind: 'evidence-correction',
      related: [{ eventId: first.eventId }],
    });
    expect(result.get(secondCorrection.id)).toMatchObject({
      kind: 'evidence-correction',
      related: [{ eventId: correction.id }],
    });
    expect(buildAnomalyPresentation(reports, [], retained.flightId).size).toBe(0);
  });

  it('keeps subminute and fractional landing discrepancies precise', () => {
    for (const [milliseconds, label] of [
      [45000, '45 s'],
      [1250, '1.25 s'],
    ] as const) {
      const evaluation = structuredClone(landingDisagreementRuleEvaluation) as EvaluationRecord;
      const explanation = evaluation.explanation as RuleEvaluationExplanation;
      const [first, second] = explanation.evidence as [RuleEvaluationEvidence, RuleEvaluationEvidence];
      const later = new Date(Date.parse(first.occurredAt) + milliseconds).toISOString();
      explanation.details = { ...explanation.details, values: `${first.occurredAt}, ${later}` };
      const reports = [first, second].map((evidence) => ({
        ...item(
          evidence.eventId,
          'flight.observation',
          { activity: 'landed', landingTime: evidence.occurredAt },
          evidence.occurredAt,
        ),
        sourceId: evidence.sourceId,
        receiptId: evidence.receiptId,
      }));
      const result = buildAnomalyPresentation(reports, [finding(evaluation)], evaluation.flightId);
      expect(result.get(first.eventId)?.detail).toContain(`Reported times span ${label}.`);
    }
  });

  it('keeps routine evaluation results quiet and pending results neutral without deriving severity from titles', () => {
    const rows = ['pass', 'not_applicable', 'pending', 'attention'].map((outcome) =>
      item(outcome, 'evaluation.recorded', { outcome, summary: 'Command-link alarm' }),
    );
    const result = buildAnomalyPresentation(rows, [], 'flight');
    expect(result.has('pass')).toBe(false);
    expect(result.has('not_applicable')).toBe(false);
    expect(result.get('pending')).toMatchObject({ kind: 'evaluation-pending', tone: 'neutral', severity: 'unknown' });
    expect(result.get('attention')).toMatchObject({
      kind: 'evaluation-attention',
      tone: 'attention',
      severity: 'unknown',
    });
  });

  it('retains adverse authorization reports after later approval without claiming the current state', () => {
    const denied = item('denied', 'airspace.status', { status: 'STATUS_DENIED' });
    const approved = item('approved', 'airspace.status', { status: 'STATUS_APPROVED' });
    const fake = item('fake', 'flight.observation', { status: 'STATUS_DENIED', severity: 'critical' });
    const result = buildAnomalyPresentation([denied, approved, fake], [], 'flight');
    expect(result.get('denied')).toMatchObject({ kind: 'authorization-problem', severity: 'unknown' });
    expect(result.get('denied')?.detail).toContain('does not establish the current authorization state');
    expect(result.has('approved')).toBe(false);
    expect(result.has('fake')).toBe(false);
  });
});
