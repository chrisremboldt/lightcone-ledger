import type {
  CommandLinkEvaluationEvidence,
  EvaluationEvidence,
  EvaluationRecord,
  FindingRecord,
  TimelineItem,
} from '@ledger/contracts';
import { commandLinkReportFields } from '@ledger/contracts';
import { isEpisodeReview, ruleExplanation } from './evaluation-reads.js';

type ReportGroup = Extract<EvaluationRecord['explanation'], { kind: 'command_link' }>['groups'][number];

/**
 * The reports a reported-episode finding cites, read back from the flight's own record, grouped as the episode
 * check groups them: by source, session, episode and aircraft.
 */
function episodeGroups(
  evaluation: EvaluationRecord,
  byId: ReadonlyMap<string, TimelineItem>,
  flightId: string,
): { evidence: CommandLinkEvaluationEvidence[]; groups: ReportGroup[] } {
  const evidence = (ruleExplanation(evaluation)?.evidence ?? []).flatMap((cited) => {
    const item = byId.get(cited.eventId);
    const fields = item && commandLinkReportFields(item.kind, item.payload);
    if (!fields || typeof fields.sourceSessionId !== 'string') return [];
    return [
      {
        flightId,
        eventId: cited.eventId,
        ...(cited.receiptId ? { receiptId: cited.receiptId } : {}),
        sourceId: cited.sourceId,
        occurredAt: cited.occurredAt,
        sourceSessionId: fields.sourceSessionId,
        sourceEventId: String(fields.sourceEventId),
        incidentId: String(fields.incidentId),
        aircraftId: String(fields.aircraftId),
        status: fields.status,
      } as CommandLinkEvaluationEvidence,
    ];
  });
  const scopes = new Map<string, CommandLinkEvaluationEvidence[]>();
  for (const report of evidence) {
    const key = JSON.stringify([report.sourceId, report.sourceSessionId, report.incidentId, report.aircraftId]);
    scopes.set(key, [...(scopes.get(key) ?? []), report]);
  }
  const groups = [...scopes.values()].flatMap((reports): ReportGroup[] => {
    const losses = reports.filter((report) => report.status === 'lost');
    const restorations = reports.filter((report) => report.status === 'restored');
    if (!losses.length) return [];
    const latestLoss = Math.max(...losses.map((report) => instant(report.occurredAt) ?? NaN));
    const latestRestoration = restorations.length
      ? Math.max(...restorations.map((report) => instant(report.occurredAt) ?? NaN))
      : undefined;
    const first = reports[0]!;
    return [
      {
        sourceId: first.sourceId,
        sourceSessionId: first.sourceSessionId,
        incidentId: first.incidentId,
        aircraftId: first.aircraftId,
        state: Number.isNaN(latestLoss)
          ? 'insufficient'
          : latestRestoration === latestLoss
            ? 'conflicting'
            : latestRestoration !== undefined && latestRestoration > latestLoss
              ? 'restored'
              : 'unresolved',
        lossEventIds: losses.map((report) => report.eventId),
        restorationEventIds: restorations.map((report) => report.eventId),
      },
    ];
  });
  return { evidence, groups };
}

export interface RecordAnomalyReference {
  eventId: string;
  receiptId?: string;
  sourceId?: string;
  occurredAt?: string;
  reportedAt?: string;
  label: string;
}

export interface RecordAnomaly {
  kind:
    | 'command-link-loss'
    | 'command-link-restoration'
    | 'landing-disagreement'
    | 'authorization-problem'
    | 'evaluation-attention'
    | 'evaluation-pending'
    | 'evidence-correction';
  label: string;
  tone: 'advisory' | 'attention' | 'neutral';
  severity: 'unknown';
  detail?: string;
  related?: RecordAnomalyReference[];
  findingId?: string;
  evaluationId?: string;
}

function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : null;
}

function duration(milliseconds: number): string {
  const seconds = Number((milliseconds / 1000).toFixed(3));
  if (seconds < 60) return `${seconds} s`;
  const remainder = Number((seconds % 60).toFixed(3));
  return `${Math.floor(seconds / 60)} min${remainder ? ` ${remainder} s` : ''}`;
}

function reference(evidence: EvaluationEvidence, label: string): RecordAnomalyReference {
  return {
    eventId: evidence.eventId,
    ...(evidence.receiptId ? { receiptId: evidence.receiptId } : {}),
    sourceId: evidence.sourceId,
    occurredAt: evidence.occurredAt,
    label,
  };
}

function matches(item: TimelineItem, evidence: EvaluationEvidence): boolean {
  return (
    item.id === evidence.eventId &&
    (!evidence.receiptId || item.receiptId === evidence.receiptId) &&
    (item.sourceId === evidence.sourceId ||
      (item.kind === 'evidence.correct' && !item.sourceId && evidence.sourceId === 'operator-correction'))
  );
}

export function buildAnomalyPresentation(
  items: readonly TimelineItem[],
  findings: readonly FindingRecord[],
  flightId: string,
): Map<string, RecordAnomaly> {
  const result = new Map<string, RecordAnomaly>();
  const byId = new Map(items.map((item) => [item.id, item]));
  const corrections = new Map<string, TimelineItem[]>();
  const correctionTargets = new Map<string, string>();
  for (const item of items) {
    if (!item.correctionOf) continue;
    const target = byId.has(item.correctionOf)
      ? item.correctionOf
      : items.find((candidate) => `${candidate.id}:${flightId}` === item.correctionOf)?.id;
    if (target) {
      corrections.set(target, [...(corrections.get(target) ?? []), item]);
      correctionTargets.set(item.id, target);
    }
  }

  for (const item of items) {
    const commandLink = commandLinkReportFields(item.kind, item.payload);
    if (commandLink) {
      const lost = commandLink.status === 'lost';
      result.set(item.id, {
        kind: lost ? 'command-link-loss' : 'command-link-restoration',
        label: lost ? 'Command-link loss reported' : 'Command-link restoration reported',
        tone: lost ? 'attention' : 'advisory',
        severity: 'unknown',
        detail: lost
          ? 'Related restoration is not confirmed in the available record.'
          : 'Related loss and interval are not confirmed in the available record.',
      });
    }
    if (
      item.kind === 'airspace.status' &&
      typeof item.payload.status === 'string' &&
      ['STATUS_DENIED', 'STATUS_RESCINDED', 'STATUS_REVOKED'].includes(item.payload.status)
    ) {
      result.set(item.id, {
        kind: 'authorization-problem',
        label: `Authorization ${String(item.payload.status).slice(7).toLowerCase()} reported`,
        tone: 'attention',
        severity: 'unknown',
        detail: 'Retained source report; this does not establish the current authorization state.',
      });
    }
  }

  const evaluations = new Map<string, { evaluation: EvaluationRecord; finding: FindingRecord }>();
  for (const finding of findings) {
    if (finding.flightId !== flightId) continue;
    for (const evaluation of [finding.initialEvaluation, finding.latestEvaluation]) {
      if (evaluation.flightId !== flightId) continue;
      evaluations.set(evaluation.id, { evaluation, finding });
      const explanation = evaluation.explanation;
      // A retained lost-link evaluation carries its groups; a reported-episode finding's are read from the record.
      const episodes =
        'kind' in explanation &&
        explanation.kind === 'command_link' &&
        evaluation.leafVersion === 1 &&
        evaluation.bindingVersion === 1 &&
        (evaluation.profile === undefined || evaluation.profile === 'ledger.c2-evaluation.2')
          ? { evidence: explanation.evidence, groups: explanation.groups }
          : isEpisodeReview(evaluation)
            ? episodeGroups(evaluation, byId, flightId)
            : null;
      if (episodes) {
        for (const group of episodes.groups) {
          const ids = [...group.lossEventIds, ...group.restorationEventIds];
          const reports = episodes.evidence.filter((report) => ids.includes(report.eventId));
          const scoped = reports.every(
            (report) =>
              report.flightId === flightId &&
              report.sourceId === group.sourceId &&
              report.sourceSessionId === group.sourceSessionId &&
              report.incidentId === group.incidentId &&
              report.aircraftId === group.aircraftId &&
              (report.status === 'lost'
                ? group.lossEventIds.includes(report.eventId)
                : report.status === 'restored' && group.restorationEventIds.includes(report.eventId)),
          );
          const complete = scoped && new Set(reports.map((report) => report.eventId)).size === new Set(ids).size;
          const loss = reports.find((report) => report.status === 'lost');
          const restoration = reports.find((report) => report.status === 'restored');
          const start = instant(loss?.occurredAt);
          const end = instant(restoration?.occurredAt);
          const clock = instant(evaluation.clock.evaluatedAt);
          const interval =
            complete &&
            group.state === 'restored' &&
            reports.length === 2 &&
            group.lossEventIds.length === 1 &&
            group.restorationEventIds.length === 1 &&
            start !== null &&
            end !== null &&
            clock !== null &&
            end > start &&
            end <= clock &&
            ids.every((id) => !corrections.has(id))
              ? `${duration(end - start)} between the reported loss and restoration.`
              : 'Duration unknown; the retained reports do not establish one unambiguous interval.';
          const state = {
            restored: 'Later restoration recorded',
            unresolved: 'No qualifying later restoration in this evaluation',
            conflicting: 'Loss and restoration reports conflict',
            insufficient: 'Incident evidence is insufficient',
          }[group.state];
          for (const report of reports) {
            const item = byId.get(report.eventId);
            const shown = item && commandLinkReportFields(item.kind, item.payload);
            if (!complete || !item || !shown || !matches(item, report)) continue;
            if (
              shown.status !== report.status ||
              shown.sourceSessionId !== report.sourceSessionId ||
              shown.incidentId !== report.incidentId ||
              shown.aircraftId !== report.aircraftId ||
              shown.sourceEventId !== report.sourceEventId ||
              instant(item.occurredAt) !== instant(report.occurredAt)
            )
              continue;
            result.set(item.id, {
              ...result.get(item.id)!,
              detail: `${state}. ${interval}`,
              findingId: finding.id,
              evaluationId: evaluation.id,
              related: reports
                .filter((other) => other.eventId !== item.id)
                .map((other: CommandLinkEvaluationEvidence) =>
                  reference(other, other.status === 'lost' ? 'Reported loss' : 'Reported restoration'),
                ),
            });
          }
        }
      } else if (
        'kind' in explanation &&
        explanation.kind === 'rule' &&
        explanation.code === 'values_disagree' &&
        evaluation.evidenceState === 'conflicting' &&
        evaluation.outcome === 'attention'
      ) {
        // Reports that disagree: the check's details hold the distinct values it compared.
        const values = typeof explanation.details.values === 'string' ? explanation.details.values.split(', ') : [];
        const times = values.map(instant).filter((time): time is number => time !== null);
        const span =
          times.length === values.length && times.length > 1
            ? `Reported times span ${duration(Math.max(...times) - Math.min(...times))}.`
            : `${values.length} distinct values are reported.`;
        if (values.length < 2) continue;
        for (const report of explanation.evidence) {
          const item = byId.get(report.eventId);
          if (!item || !matches(item, report) || !['flight.observation', 'evidence.correct'].includes(item.kind))
            continue;
          result.set(item.id, {
            kind: 'landing-disagreement',
            label: 'Disagreeing reports recorded',
            tone: 'attention',
            severity: 'unknown',
            detail: span,
            findingId: finding.id,
            evaluationId: evaluation.id,
            related: explanation.evidence
              .filter((other) => other.eventId !== item.id)
              .map((other) => reference(other, 'Related report')),
          });
        }
      }
    }
  }

  for (const item of items) {
    if (
      item.kind !== 'evaluation.recorded' ||
      (item.payload.outcome !== 'attention' && item.payload.outcome !== 'pending')
    )
      continue;
    const exact = evaluations.get(item.id);
    const known =
      exact && item.payload.evaluationId === exact.evaluation.id && item.payload.findingId === exact.finding.id;
    result.set(item.id, {
      kind: item.payload.outcome === 'attention' ? 'evaluation-attention' : 'evaluation-pending',
      label: item.payload.outcome === 'attention' ? 'Check needs attention' : 'Check pending',
      tone: item.payload.outcome === 'attention' ? 'attention' : 'neutral',
      severity: 'unknown',
      ...(known ? { findingId: exact.finding.id, evaluationId: exact.evaluation.id } : {}),
    });
  }

  for (const [target, entries] of corrections) {
    const original = result.get(target);
    if (!original) continue;
    result.set(target, {
      ...original,
      detail: `${original.detail ?? ''} A correction is appended; this original remains retained.`.trim(),
      related: [
        ...(original.related ?? []),
        ...entries.map((entry) => ({ eventId: entry.id, occurredAt: entry.occurredAt, label: 'Appended correction' })),
      ],
    });
  }
  for (const [id, immediateTarget] of correctionTargets) {
    if (result.has(id)) continue;
    let target: string | undefined = immediateTarget;
    const visited = new Set([id]);
    while (target && !visited.has(target)) {
      visited.add(target);
      if (result.has(target)) {
        result.set(id, {
          kind: 'evidence-correction',
          label: 'Correction to recorded concern',
          tone: 'advisory',
          severity: 'unknown',
          related: [{ eventId: immediateTarget, label: 'Original report' }],
        });
        break;
      }
      target = correctionTargets.get(target);
    }
  }
  return result;
}
