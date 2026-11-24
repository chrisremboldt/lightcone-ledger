import type { LinkStatusObservationV1 } from '@ledger/contracts';
import type { RuleLeaf } from './demo-procedures-v1.js';

export interface CommandLinkEvidenceReport {
  flightId: string;
  eventId: string;
  receiptId: string;
  sourceId: string;
  sourceSessionId: string;
  sourceEventId: string;
  incidentId: string;
  aircraftId: string;
  occurredAt: string;
  status: string;
}

export interface CommandLinkEvidenceInput {
  flightId: string;
  reports: readonly CommandLinkEvidenceReport[];
  clock: { mode: 'wall'; evaluatedAt: string };
}

export interface CommandLinkEvidenceGroup {
  sourceId: string;
  sourceSessionId: string;
  incidentId: string;
  aircraftId: string;
  state: 'unresolved' | 'restored' | 'conflicting' | 'insufficient';
  lossEventIds: string[];
  restorationEventIds: string[];
}

export type CommandLinkExplanationCode =
  | 'command_link_reports_unavailable'
  | 'command_link_restoration_missing'
  | 'command_link_reports_conflicting'
  | 'command_link_reports_invalid'
  | 'command_link_losses_restored';

export interface CommandLinkEvidenceResult {
  flightId: string;
  leafId: string;
  leafVersion: number;
  bindingId: string;
  bindingVersion: number;
  applicability: 'applicable';
  evidenceState: 'supported' | 'insufficient' | 'conflicting';
  outcome: 'pass' | 'attention' | 'pending';
  title: string;
  explanation: {
    kind: 'command_link';
    code: CommandLinkExplanationCode;
    summary: string;
    evidence: CommandLinkEvidenceReport[];
    groups: CommandLinkEvidenceGroup[];
    evaluatedAt: string;
  };
}

type CommandLinkDependency = 'command-link.reports' | 'command-link.scope' | 'clock.wall';

export const COMMAND_LINK_LOSS_LEAF_ID = 'ledger.demo.command-link-loss-review';
export const commandLinkStatusBindingV1 = Object.freeze({
  id: 'ledger.command-link-status',
  version: 1,
  inputKind: 'command-link.status',
  supportedFields: Object.freeze([
    'sourceId',
    'sourceSessionId',
    'occurredAt',
    'subject.flightId',
    'payload.sourceEventId',
    'payload.incidentId',
    'payload.aircraftId',
    'payload.status',
  ] as const),
  correctionHandling: 'immutable_receipts_selected_by_caller',
} as const);

const procedureText =
  'For each reported command-link loss on a flight, review evidence within the exact source, capture session, incident and reported aircraft. A strictly later unambiguous restoration in that same scope permits manual resolution of the review. Missing, future or unorderable evidence remains insufficient. Simultaneous loss and restoration remain conflicting until clarified by a later restoration. Reported restoration does not establish command-link health, monitored exposure or a loss rate.';

export const commandLinkEvidenceLeafV1 = Object.freeze({
  id: COMMAND_LINK_LOSS_LEAF_ID,
  version: 1,
  title: 'Reported command-link loss',
  source: Object.freeze({
    kind: 'operator_procedure',
    reference: 'ledger.demo-procedures.3',
    text: procedureText,
    textSpan: Object.freeze({ start: 0, end: procedureText.length }),
  }),
  review: 'ai_drafted',
  adopted: false,
  bindingId: commandLinkStatusBindingV1.id,
  bindingVersion: commandLinkStatusBindingV1.version,
  dependencies: Object.freeze(['command-link.reports', 'command-link.scope', 'clock.wall'] as const),
} satisfies Omit<RuleLeaf, 'dependencies'> & { dependencies: readonly CommandLinkDependency[] });

/** The retained identity of one accepted observation that the rule cites as a report. */
export interface CommandLinkObservationIdentity {
  flightId: string;
  eventId: string;
  receiptId: string;
  sourceId: string;
}

/**
 * Reads a link.status@1 observation as a command-link report: a transition of the command and control link to down
 * (lost) or up (restored) that names its capture session, source event, episode and reported aircraft. Any other
 * link.status observation is not a report this rule reads, and gives undefined.
 */
export function commandLinkReportFromObservation(
  observation: LinkStatusObservationV1,
  retained: CommandLinkObservationIdentity,
): CommandLinkEvidenceReport | undefined {
  const { values, secondarySubject } = observation;
  if (values.link !== 'command_control' || values.report !== 'transition') return undefined;
  if (values.state !== 'down' && values.state !== 'up') return undefined;
  if (secondarySubject?.kind !== 'aircraft' || secondarySubject.scope !== 'source') return undefined;
  if (!observation.sourceSessionId || !observation.sourceEventId || !values.sourceEpisodeId) return undefined;
  return {
    ...retained,
    sourceSessionId: observation.sourceSessionId,
    sourceEventId: observation.sourceEventId,
    incidentId: values.sourceEpisodeId,
    aircraftId: secondarySubject.id,
    // Read as the journal reads an occurrence time, so the same report gives the same evidence either way.
    occurredAt: new Date(Date.parse(observation.occurredAt)).toISOString(),
    status: values.state === 'down' ? 'lost' : 'restored',
  };
}

function utcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}

const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
function reportKey(report: CommandLinkEvidenceReport): string {
  return JSON.stringify([
    report.sourceId,
    report.sourceSessionId,
    report.incidentId,
    report.aircraftId,
    report.occurredAt,
    report.eventId,
    report.receiptId,
    report.sourceEventId,
    report.status,
  ]);
}

interface GroupEvidence {
  group: CommandLinkEvidenceGroup;
  hasLoss: boolean;
  invalid: boolean;
}

function groupEvidence(reports: CommandLinkEvidenceReport[], evaluatedAt: number): GroupEvidence {
  const first = reports[0];
  const losses = reports.filter((report) => report.status === 'lost');
  const restorations = reports.filter((report) => report.status === 'restored');
  const group: CommandLinkEvidenceGroup = {
    sourceId: first.sourceId,
    sourceSessionId: first.sourceSessionId,
    incidentId: first.incidentId,
    aircraftId: first.aircraftId,
    state: 'insufficient',
    lossEventIds: [...new Set(losses.map((report) => report.eventId))],
    restorationEventIds: [...new Set(restorations.map((report) => report.eventId))],
  };
  const invalid = reports.some((report) => {
    const occurredAt = utcTimestamp(report.occurredAt);
    return (
      ![
        report.eventId,
        report.receiptId,
        report.sourceId,
        report.sourceSessionId,
        report.sourceEventId,
        report.incidentId,
        report.aircraftId,
      ].every(identity) ||
      !['lost', 'restored'].includes(report.status) ||
      occurredAt === undefined ||
      occurredAt > evaluatedAt
    );
  });
  if (invalid || !losses.length) return { group, hasLoss: losses.length > 0, invalid };

  const latestLoss = Math.max(...losses.map((report) => utcTimestamp(report.occurredAt)!));
  const latestRestoration = restorations.length
    ? Math.max(...restorations.map((report) => utcTimestamp(report.occurredAt)!))
    : undefined;
  group.state =
    latestRestoration === latestLoss
      ? 'conflicting'
      : latestRestoration !== undefined && latestRestoration > latestLoss
        ? 'restored'
        : 'unresolved';
  return { group, hasLoss: true, invalid: false };
}

export function evaluateCommandLinkEvidence(input: CommandLinkEvidenceInput): CommandLinkEvidenceResult {
  const evaluatedAt = utcTimestamp(input.clock.evaluatedAt);
  if (input.clock.mode !== 'wall' || evaluatedAt === undefined)
    throw new TypeError('Command-link evaluation requires an explicit valid UTC wall clock');
  if (!identity(input.flightId)) throw new TypeError('Command-link evaluation requires an exact flight identity');
  const reports = input.reports
    .filter((report) => report.flightId === input.flightId)
    .map((report) => ({
      flightId: report.flightId,
      eventId: report.eventId,
      receiptId: report.receiptId,
      sourceId: report.sourceId,
      sourceSessionId: report.sourceSessionId,
      sourceEventId: report.sourceEventId,
      incidentId: report.incidentId,
      aircraftId: report.aircraftId,
      occurredAt: report.occurredAt,
      status: report.status,
    }))
    .sort((left, right) => compare(reportKey(left), reportKey(right)));
  const scoped = new Map<string, CommandLinkEvidenceReport[]>();
  for (const report of reports) {
    const key = JSON.stringify([report.sourceId, report.sourceSessionId, report.incidentId, report.aircraftId]);
    const group = scoped.get(key) ?? [];
    group.push(report);
    scoped.set(key, group);
  }
  const grouped = [...scoped.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([, group]) => groupEvidence(group, evaluatedAt));
  const lossGroups = grouped.filter((group) => group.hasLoss);
  let code: CommandLinkExplanationCode;
  let summary: string;
  let evidenceState: CommandLinkEvidenceResult['evidenceState'];
  let outcome: CommandLinkEvidenceResult['outcome'];
  if (grouped.some((group) => group.invalid)) {
    code = 'command_link_reports_invalid';
    summary =
      'A scoped report has invalid identity, status or time, or occurs after the evaluation time. Restoration cannot be established.';
    evidenceState = 'insufficient';
    outcome = 'attention';
  } else if (lossGroups.some(({ group }) => group.state === 'conflicting')) {
    code = 'command_link_reports_conflicting';
    summary =
      'Loss and restoration are reported at the same latest instant within an incident scope. Review the conflicting reports.';
    evidenceState = 'conflicting';
    outcome = 'attention';
  } else if (lossGroups.some(({ group }) => group.state === 'unresolved')) {
    code = 'command_link_restoration_missing';
    summary =
      'A reported loss lacks a strictly later restoration in the same source, session, incident and aircraft scope.';
    evidenceState = 'insufficient';
    outcome = 'attention';
  } else if (!lossGroups.length) {
    code = 'command_link_reports_unavailable';
    summary =
      'No scoped loss report is available to review. Restoration-only reports do not establish command-link health.';
    evidenceState = 'insufficient';
    outcome = 'pending';
  } else {
    code = 'command_link_losses_restored';
    summary =
      'Every known loss scope has a strictly later restoration. The finding is eligible for manual resolution; it remains open until reviewed.';
    evidenceState = 'supported';
    outcome = 'pass';
  }
  return {
    flightId: input.flightId,
    leafId: commandLinkEvidenceLeafV1.id,
    leafVersion: commandLinkEvidenceLeafV1.version,
    bindingId: commandLinkStatusBindingV1.id,
    bindingVersion: commandLinkStatusBindingV1.version,
    applicability: 'applicable',
    evidenceState,
    outcome,
    title: commandLinkEvidenceLeafV1.title,
    explanation: {
      kind: 'command_link',
      code,
      summary,
      evidence: reports,
      groups: grouped.map(({ group }) => group),
      evaluatedAt: new Date(evaluatedAt).toISOString(),
    },
  };
}
