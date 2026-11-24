import type {
  CommandLinkEvaluationEvidence,
  EvaluationEvidence,
  EvaluationRecord,
  Receipt,
  TelemetryGap,
  TelemetryResponse,
  TelemetrySampleView,
  TimelineItem,
} from '@ledger/contracts';
import { commandLinkReportFields } from '@ledger/contracts';
import { isDisagreement, isEpisodeReview, ruleExplanation, type CitedValueRow } from './evaluation-reads.js';
import type { Coordinate } from './geography.js';
import { reportField } from './landing-reconciliation.js';

export type OccurrenceEvaluation = Pick<
  EvaluationRecord,
  | 'id'
  | 'flightId'
  | 'leafId'
  | 'leafVersion'
  | 'bindingId'
  | 'bindingVersion'
  | 'explanation'
  | 'clock'
  | 'profile'
  | 'execution'
>;

export type LocationMethod = 'source_report' | 'telemetry_exact' | 'interpolated' | 'nearby';
export interface LocationCandidate {
  position: Coordinate;
  method: LocationMethod;
  sourceId: string;
  sourceSessionId?: string;
  deviceId?: string;
  sampleIds: string[];
  occurredAt: string;
  signedOffsetMs: number;
  bracketOffsetsMs?: [number, number];
  uncertainty: string;
}
export interface OccurrenceLocation {
  id: string;
  report: EvaluationEvidence;
  eventTime: string;
  eventTimeBasis: 'reported_occurrence' | 'reported_landing';
  status: 'located' | 'missing' | 'ambiguous';
  method?: LocationMethod;
  position?: Coordinate;
  candidates: LocationCandidate[];
  reason: string;
}
export interface SelectedOccurrenceLocation {
  id: string;
  evaluation: Pick<OccurrenceEvaluation, 'id' | 'flightId' | 'clock'>;
  occurrenceId: string;
  report: EvaluationEvidence;
  eventTime: string;
  eventTimeBasis: OccurrenceLocation['eventTimeBasis'];
  candidate: LocationCandidate;
}

export function selectOccurrenceLocation(
  evaluation: OccurrenceEvaluation,
  occurrence: OccurrenceLocation,
  candidate: LocationCandidate,
): SelectedOccurrenceLocation {
  const id = JSON.stringify([
    evaluation.id,
    occurrence.id,
    occurrence.report.eventId,
    occurrence.report.receiptId,
    occurrence.report.sourceId,
    occurrence.eventTime,
    candidate.method,
    candidate.sourceId,
    candidate.sourceSessionId ?? null,
    candidate.deviceId ?? null,
    candidate.sampleIds,
    candidate.occurredAt,
    candidate.signedOffsetMs,
    candidate.bracketOffsetsMs ?? null,
    candidate.position.latitude,
    candidate.position.longitude,
  ]);
  return structuredClone({
    id,
    evaluation: { id: evaluation.id, flightId: evaluation.flightId, clock: evaluation.clock },
    occurrenceId: occurrence.id,
    report: occurrence.report,
    eventTime: occurrence.eventTime,
    eventTimeBasis: occurrence.eventTimeBasis,
    candidate,
  });
}

export interface OccurrenceLocations {
  evaluationId: string;
  flightId: string;
  occurrences: OccurrenceLocation[];
  samples: TelemetrySampleView[];
  gaps: TelemetryGap[];
  truncated: boolean;
}
export interface OccurrenceReportRead {
  eventId: string;
  item?: TimelineItem | null;
  receipt?: Receipt | null;
  error?: string;
}
export interface OccurrenceReference {
  report: EvaluationEvidence;
  eventTime: string;
  eventTimeBasis: OccurrenceLocation['eventTimeBasis'];
  commandLink?: CommandLinkEvaluationEvidence;
  /** A transition a reported-episode finding cites; its fields are read from the report it names. */
  transition?: boolean;
  /** The value a disagreement finding read from this report, from the observation it cites. */
  reported?: CitedValueRow;
}
export const OCCURRENCE_REPORT_LIMIT = 12;
export const OCCURRENCE_WINDOW_SECONDS = 60;
const MAX_NEARBY_OFFSET_MS = 30_000;
const MAX_INTERPOLATION_SPAN_MS = 60_000;

export function occurrenceReferences(
  evaluation: OccurrenceEvaluation,
  cited: readonly CitedValueRow[] = [],
): OccurrenceReference[] {
  const explanation = evaluation.explanation;
  // A retained lost-link evaluation, in the explanation format its own evaluator recorded.
  if (
    'kind' in explanation &&
    explanation.kind === 'command_link' &&
    evaluation.leafVersion === 1 &&
    evaluation.bindingVersion === 1
  )
    return explanation.evidence.map((report) => ({
      report,
      eventTime: report.occurredAt,
      eventTimeBasis: 'reported_occurrence',
      commandLink: report,
    }));
  // Reported episodes: each cited transition at the instant it reports.
  if (isEpisodeReview(evaluation))
    return (ruleExplanation(evaluation)?.evidence ?? []).map((item) => ({
      report: {
        eventId: item.eventId,
        receiptId: item.receiptId,
        sourceId: item.sourceId,
        occurredAt: item.occurredAt,
      },
      eventTime: item.occurredAt,
      eventTimeBasis: 'reported_occurrence',
      transition: true,
    }));
  // Reports that disagree: each cited report at the instant it states, when it states one.
  if (isDisagreement(evaluation))
    return cited.map((row) => ({
      report: { eventId: row.eventId, receiptId: row.receiptId, sourceId: row.sourceId, occurredAt: row.occurredAt },
      reported: row,
      eventTime: row.reportedTime ?? row.occurredAt,
      eventTimeBasis: row.reportedTime ? 'reported_landing' : 'reported_occurrence',
    }));
  return [];
}

function coordinate(value: unknown): Coordinate | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as Record<string, unknown>;
  return typeof point.latitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Math.abs(point.latitude) <= 90 &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.longitude) <= 180
    ? { latitude: point.latitude, longitude: point.longitude }
    : null;
}
function sameTime(left: string, right: string) {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
}
function trackKey(sample: Pick<TelemetrySampleView, 'sourceId' | 'sourceSessionId' | 'deviceId'>) {
  return JSON.stringify([sample.sourceId, sample.sourceSessionId, sample.deviceId]);
}
function reportMatches(reference: OccurrenceReference, read: OccurrenceReportRead | undefined, flightId: string) {
  const report = reference.report;
  const item = read?.item;
  if (
    !item ||
    (item.id !== report.eventId && item.id !== `${report.eventId}:${flightId}`) ||
    (item.sourceId ?? (item.kind === 'evidence.correct' && !report.receiptId ? 'operator-correction' : undefined)) !==
      report.sourceId ||
    !sameTime(item.occurredAt, report.occurredAt) ||
    item.linkStatus !== 'linked'
  )
    return false;
  if (
    report.receiptId &&
    (!read?.receipt ||
      read.receipt.id !== report.receiptId ||
      read.receipt.eventId !== report.eventId ||
      read.receipt.sourceId !== report.sourceId ||
      read.receipt.flightId !== flightId ||
      !sameTime(read.receipt.occurredAt, report.occurredAt) ||
      read.receipt.processing.status !== 'completed' ||
      read.receipt.linkStatus !== 'linked' ||
      item.receiptId !== report.receiptId ||
      item.kind !== read.receipt.kind)
  )
    return false;
  if (
    reference.reported &&
    (!['flight.observation', 'evidence.correct'].includes(item.kind) || !reportField(item, reference.reported))
  )
    return false;
  const command = reference.commandLink;
  if (command) {
    const itemReport = commandLinkReportFields(item.kind, item.payload);
    const receiptReport = read?.receipt ? commandLinkReportFields(read.receipt.kind, read.receipt.payload) : null;
    if (
      command.flightId !== flightId ||
      !['lost', 'restored'].includes(command.status) ||
      !itemReport ||
      itemReport.sourceSessionId !== command.sourceSessionId
    )
      return false;
    for (const field of ['sourceEventId', 'incidentId', 'aircraftId', 'status'] as const)
      if (itemReport[field] !== command[field] || receiptReport?.[field] !== command[field]) return false;
    const itemPoint = coordinate(itemReport.position);
    const receiptPoint = coordinate(receiptReport?.position);
    if (JSON.stringify(itemPoint) !== JSON.stringify(receiptPoint)) return false;
  }
  if (reference.transition) {
    const itemReport = commandLinkReportFields(item.kind, item.payload);
    const receiptReport = read?.receipt ? commandLinkReportFields(read.receipt.kind, read.receipt.payload) : null;
    if (!itemReport || !receiptReport) return false;
    for (const field of ['sourceEventId', 'incidentId', 'aircraftId', 'status'] as const)
      if (itemReport[field] !== receiptReport[field]) return false;
    if (JSON.stringify(coordinate(itemReport.position)) !== JSON.stringify(coordinate(receiptReport.position)))
      return false;
  }
  return true;
}

function candidate(sample: TelemetrySampleView, eventTime: number): LocationCandidate {
  return {
    position: { latitude: sample.latitude, longitude: sample.longitude },
    method: Date.parse(sample.occurredAt) === eventTime ? 'telemetry_exact' : 'nearby',
    sourceId: sample.sourceId,
    sourceSessionId: sample.sourceSessionId,
    deviceId: sample.deviceId,
    sampleIds: [sample.id],
    occurredAt: sample.occurredAt,
    signedOffsetMs: Date.parse(sample.occurredAt) - eventTime,
    uncertainty:
      'Exact-flight telemetry; native aircraft/session correspondence and spatial accuracy are not reported.',
  };
}

function telemetryCandidates(snapshot: TelemetryResponse, eventTime: number): LocationCandidate[] {
  const tracks = new Map<string, TelemetrySampleView[]>();
  for (const sample of snapshot.samples) {
    if (!coordinate(sample) || !Number.isFinite(Date.parse(sample.occurredAt))) continue;
    const key = trackKey(sample);
    tracks.set(key, [...(tracks.get(key) ?? []), sample]);
  }
  const candidates: LocationCandidate[] = [];
  for (const track of tracks.values()) {
    track.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const exact = track.filter((sample) => Date.parse(sample.occurredAt) === eventTime);
    if (exact.length) {
      if (exact.length === 1 && !exact[0]!.conflict) candidates.push(candidate(exact[0]!, eventTime));
      else
        for (const sample of exact)
          candidates.push({
            ...candidate(sample, eventTime),
            uncertainty: 'Conflicting or repeated capture claims at the occurrence time; choose a location manually.',
          });
      continue;
    }
    const before = track.filter((sample) => Date.parse(sample.occurredAt) < eventTime).at(-1);
    const after = track.find((sample) => Date.parse(sample.occurredAt) > eventTime);
    const crossedGap =
      before &&
      after &&
      snapshot.gaps.some(
        (gap) =>
          trackKey(gap) === trackKey(before) && gap.fromSequence <= after.sequence && gap.toSequence >= before.sequence,
      );
    const ordered = track.every(
      (sample, index) => !index || Date.parse(sample.occurredAt) > Date.parse(track[index - 1]!.occurredAt),
    );
    if (
      before &&
      after &&
      ordered &&
      !before.conflict &&
      !after.conflict &&
      !crossedGap &&
      after.sequence === before.sequence + 1 &&
      Date.parse(after.occurredAt) - Date.parse(before.occurredAt) <= MAX_INTERPOLATION_SPAN_MS &&
      Math.abs(after.longitude - before.longitude) < 180
    ) {
      const fraction =
        (eventTime - Date.parse(before.occurredAt)) / (Date.parse(after.occurredAt) - Date.parse(before.occurredAt));
      candidates.push({
        ...candidate(before, eventTime),
        position: {
          latitude: before.latitude + fraction * (after.latitude - before.latitude),
          longitude: before.longitude + fraction * (after.longitude - before.longitude),
        },
        method: 'interpolated',
        sampleIds: [before.id, after.id],
        occurredAt: new Date(eventTime).toISOString(),
        signedOffsetMs: 0,
        bracketOffsetsMs: [Date.parse(before.occurredAt) - eventTime, Date.parse(after.occurredAt) - eventTime],
        uncertainty:
          'Linear display interpolation between consecutive exact-flight captures; path between samples and spatial accuracy are unknown.',
      });
      continue;
    }
    const nearby = track
      .filter(
        (sample) => !sample.conflict && Math.abs(Date.parse(sample.occurredAt) - eventTime) <= MAX_NEARBY_OFFSET_MS,
      )
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.occurredAt) - eventTime) - Math.abs(Date.parse(b.occurredAt) - eventTime) ||
          a.id.localeCompare(b.id),
      );
    if (nearby[0]) {
      const tied = nearby.filter(
        (sample) =>
          Math.abs(Date.parse(sample.occurredAt) - eventTime) ===
          Math.abs(Date.parse(nearby[0]!.occurredAt) - eventTime),
      );
      candidates.push(
        ...tied.map((sample) => ({
          ...candidate(sample, eventTime),
          uncertainty: 'Nearby capture only. No continuous track or position at the occurrence time is established.',
        })),
      );
    }
  }
  return candidates;
}

export function resolveOccurrenceLocations({
  flightId,
  evaluation,
  reports,
  telemetry,
  cited = [],
}: {
  flightId: string;
  evaluation: OccurrenceEvaluation;
  reports: OccurrenceReportRead[];
  telemetry: TelemetryResponse[];
  cited?: readonly CitedValueRow[];
}): OccurrenceLocations {
  const references = occurrenceReferences(evaluation, cited);
  const reads = new Map(reports.map((read) => [read.eventId, read]));
  const reportTimes = new Set(
    references.slice(0, OCCURRENCE_REPORT_LIMIT).map((reference) => Date.parse(reference.eventTime)),
  );
  const scoped = telemetry.filter((snapshot) => {
    const window = snapshot.window.occurrence;
    if (snapshot.flightId !== flightId || !window) return false;
    const around = Date.parse(window.around);
    const from = Date.parse(window.from);
    const until = Date.parse(window.until);
    return (
      reportTimes.has(around) &&
      from <= around &&
      until >= around &&
      until - from <= 600_000 &&
      snapshot.samples.every(
        (sample) => Date.parse(sample.occurredAt) >= from && Date.parse(sample.occurredAt) <= until,
      )
    );
  });
  const occurrences = references.slice(0, OCCURRENCE_REPORT_LIMIT).map((reference): OccurrenceLocation => {
    const read = reads.get(reference.report.eventId);
    const base = {
      id: reference.reported ? `${reference.report.eventId}:${reference.reported.field}` : reference.report.eventId,
      report: reference.report,
      eventTime: reference.eventTime,
      eventTimeBasis: reference.eventTimeBasis,
    };
    const missing = (reason: string): OccurrenceLocation => ({ ...base, status: 'missing', candidates: [], reason });
    if (evaluation.flightId !== flightId || !reportMatches(reference, read, flightId))
      return missing(
        read?.error ?? 'The exact evaluated source report could not be confirmed. Place the area manually.',
      );
    const direct =
      (reference.commandLink || reference.transition) && read?.receipt
        ? coordinate(commandLinkReportFields(read.receipt.kind, read.receipt.payload)?.position)
        : null;
    const session =
      reference.commandLink?.sourceSessionId ??
      (read?.item ? commandLinkReportFields(read.item.kind, read.item.payload)?.sourceSessionId : undefined);
    if (direct) {
      const directCandidate: LocationCandidate = {
        position: direct,
        method: 'source_report',
        sourceId: reference.report.sourceId,
        ...(typeof session === 'string' ? { sourceSessionId: session } : {}),
        sampleIds: [],
        occurredAt: reference.report.occurredAt,
        signedOffsetMs: Date.parse(reference.report.occurredAt) - Date.parse(reference.eventTime),
        uncertainty: 'Position reported by this exact source; spatial accuracy is not reported.',
      };
      return {
        ...base,
        status: 'located',
        method: directCandidate.method,
        position: direct,
        candidates: [directCandidate],
        reason: 'Position retained in the exact evaluated source report.',
      };
    }
    const snapshots = scoped.filter((snapshot) => sameTime(snapshot.window.occurrence!.around, reference.eventTime));
    if (!snapshots.length)
      return missing('No historical telemetry window is available for this occurrence. Place the area manually.');
    const snapshot = snapshots[0]!;
    const candidates = telemetryCandidates(snapshot, Date.parse(reference.eventTime));
    if (snapshot.segments.some((segment) => segment.processing.status !== 'completed'))
      return {
        ...base,
        status: candidates.length ? 'ambiguous' : 'missing',
        candidates,
        reason:
          'A telemetry segment in this historical window is not successfully processed. A unique occurrence location is unconfirmed; review a candidate or place the area manually.',
      };
    if (snapshot.window.truncated)
      return {
        ...base,
        status: candidates.length ? 'ambiguous' : 'missing',
        candidates,
        reason:
          'Historical telemetry is truncated. It cannot establish a unique occurrence location; review a candidate or place the area manually.',
      };
    if (candidates.length !== 1)
      return {
        ...base,
        status: candidates.length ? 'ambiguous' : 'missing',
        candidates,
        reason: candidates.length
          ? 'Multiple source tracks or equally close claims are available. Select the evidence position to use, or place the area manually.'
          : 'No nonconflicting capture is close enough to this occurrence. Place the area manually.',
      };
    const selected = candidates[0]!;
    if (selected.sampleIds.some((id) => snapshot.samples.some((sample) => sample.id === id && sample.conflict)))
      return { ...base, status: 'ambiguous', candidates, reason: selected.uncertainty };
    return {
      ...base,
      status: 'located',
      method: selected.method,
      position: selected.position,
      candidates,
      reason:
        selected.method === 'interpolated'
          ? 'Suggested from a bounded interpolation of one recorded track.'
          : selected.method === 'nearby'
            ? 'Suggested nearby capture; its time offset remains explicit.'
            : 'Recorded telemetry at the occurrence time.',
    };
  });
  const samples = new Map<string, TelemetrySampleView>();
  const gaps = new Map<string, TelemetryGap>();
  for (const snapshot of scoped) {
    for (const sample of snapshot.samples) samples.set(sample.id, sample);
    for (const gap of snapshot.gaps) gaps.set(JSON.stringify(gap), gap);
  }
  return {
    evaluationId: evaluation.id,
    flightId,
    occurrences,
    samples: [...samples.values()],
    gaps: [...gaps.values()],
    truncated: references.length > OCCURRENCE_REPORT_LIMIT || scoped.some((snapshot) => snapshot.window.truncated),
  };
}
