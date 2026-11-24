import type { RuleLeaf } from './demo-procedures-v1.js';

export interface AuthorizationScope {
  sourceId: string;
  authorizationId: string;
}

export interface ReportedAuthorizationInterval {
  start: string;
  end: string;
}

export interface AuthorizationStatusClaim extends AuthorizationScope {
  eventId: string;
  receiptId: string;
  occurredAt: string;
  status: string;
  reportedInterval?: ReportedAuthorizationInterval;
}

export interface AuthorizationEvidenceInput {
  scope: AuthorizationScope;
  claims: readonly AuthorizationStatusClaim[];
  clock: { mode: 'wall'; evaluatedAt: string };
}

type AuthorizationDependency = 'authorization.status' | 'authorization.scope' | 'clock.wall';
type AuthorizationExplanationCode =
  | 'clock_invalid'
  | 'scope_invalid'
  | 'status_missing'
  | 'occurrence_invalid'
  | 'identity_invalid'
  | 'interval_unavailable'
  | 'interval_outside'
  | 'status_unknown'
  | 'status_conflicting'
  | 'approval_recorded'
  | 'nonapproval_recorded';

export interface AuthorizationEvidenceResult {
  leafId: string;
  leafVersion: number;
  bindingId: string;
  bindingVersion: number;
  scope: AuthorizationScope;
  applicability: 'applicable' | 'undetermined';
  evidenceState: 'supported' | 'insufficient' | 'conflicting';
  outcome: 'pass' | 'attention';
  title: string;
  explanation: {
    code: AuthorizationExplanationCode;
    summary: string;
    evidence: AuthorizationStatusClaim[];
    evaluatedAt: string;
  };
}

export const authorizationStatusBindingV1 = Object.freeze({
  id: 'ledger.authorization-status',
  version: 1,
  inputKind: 'airspace.status',
  supportedFields: Object.freeze([
    'authorizationId',
    'status',
    'authorizationRecord.startTime',
    'authorizationRecord.endTime',
    'callback.startTime',
    'callback.duration',
  ] as const),
  correctionHandling: 'active_claims_selected_by_caller',
  intervalHandling: 'reported_utc_half_open_required',
  callbackDurationUnit: 'minute',
} as const);

const procedureText =
  'For the selected source and authorization at the stated wall time, retain a status report with a reported UTC interval covering that time. Reported approval is recorded evidence only, not legal clearance. Missing, unknown or ambiguous evidence needs attention.';

export const authorizationEvidenceLeafV1 = Object.freeze({
  id: 'ledger.demo.authorization-evidence-recorded',
  version: 1,
  title: 'Authorization evidence recorded',
  source: Object.freeze({
    kind: 'operator_procedure',
    reference: 'ledger.demo-procedures.2',
    text: procedureText,
    textSpan: Object.freeze({ start: 0, end: procedureText.length }),
  }),
  review: 'ai_drafted',
  adopted: false,
  bindingId: authorizationStatusBindingV1.id,
  bindingVersion: authorizationStatusBindingV1.version,
  dependencies: Object.freeze(['authorization.status', 'authorization.scope', 'clock.wall'] as const),
} satisfies Omit<RuleLeaf, 'dependencies'> & { dependencies: readonly AuthorizationDependency[] });

const nonapprovalStatuses = new Set([
  'STATUS_RESCINDED',
  'STATUS_RESCIND_ACK',
  'STATUS_AUTOCANCEL',
  'STATUS_DENIED',
  'STATUS_CLOSED',
  'STATUS_CANCELED',
  'STATUS_INVALID_CANCEL',
  'STATUS_INVALID',
  'STATUS_EXPIRED',
  'STATUS_REVOKED',
]);

function utcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}

function hasIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function evidenceOrder(left: AuthorizationStatusClaim, right: AuthorizationStatusClaim): number {
  const leftKey = JSON.stringify([left.eventId, left.receiptId, left.occurredAt, left.status, left.reportedInterval]);
  const rightKey = JSON.stringify([
    right.eventId,
    right.receiptId,
    right.occurredAt,
    right.status,
    right.reportedInterval,
  ]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function result(
  input: AuthorizationEvidenceInput,
  evidence: AuthorizationStatusClaim[],
  code: AuthorizationExplanationCode,
  summary: string,
  evidenceState: AuthorizationEvidenceResult['evidenceState'] = 'insufficient',
  applicability: AuthorizationEvidenceResult['applicability'] = 'undetermined',
  outcome: AuthorizationEvidenceResult['outcome'] = 'attention',
): AuthorizationEvidenceResult {
  const evaluatedAt = utcTimestamp(input.clock.evaluatedAt);
  return {
    leafId: authorizationEvidenceLeafV1.id,
    leafVersion: authorizationEvidenceLeafV1.version,
    bindingId: authorizationStatusBindingV1.id,
    bindingVersion: authorizationStatusBindingV1.version,
    scope: { ...input.scope },
    applicability,
    evidenceState,
    outcome,
    title: authorizationEvidenceLeafV1.title,
    explanation: {
      code,
      summary,
      evidence: structuredClone(evidence),
      evaluatedAt: evaluatedAt === undefined ? input.clock.evaluatedAt : new Date(evaluatedAt).toISOString(),
    },
  };
}

export function evaluateAuthorizationEvidence(input: AuthorizationEvidenceInput): AuthorizationEvidenceResult {
  const evaluatedAt = utcTimestamp(input.clock.evaluatedAt);
  if (input.clock.mode !== 'wall' || evaluatedAt === undefined)
    return result(
      input,
      [],
      'clock_invalid',
      'A valid explicit UTC wall clock is needed to assess the supplied report.',
    );
  if (!hasIdentity(input.scope.sourceId) || !hasIdentity(input.scope.authorizationId))
    return result(input, [], 'scope_invalid', 'An explicit source and authorization identity are needed.');

  const scoped = input.claims
    .filter((claim) => claim.sourceId === input.scope.sourceId && claim.authorizationId === input.scope.authorizationId)
    .sort(evidenceOrder);
  const unorderable = scoped.filter((claim) => utcTimestamp(claim.occurredAt) === undefined);
  if (unorderable.length)
    return result(
      input,
      unorderable,
      'occurrence_invalid',
      'A scoped report has no valid UTC occurrence time; the latest status cannot be established.',
    );
  const known = scoped.filter((claim) => utcTimestamp(claim.occurredAt)! <= evaluatedAt);
  if (!known.length)
    return result(input, [], 'status_missing', 'No scoped status report is available as of the evaluation time.');
  const latestAt = Math.max(...known.map((claim) => utcTimestamp(claim.occurredAt)!));
  const latest = known.filter((claim) => utcTimestamp(claim.occurredAt) === latestAt);
  if (latest.some((claim) => !hasIdentity(claim.eventId) || !hasIdentity(claim.receiptId)))
    return result(
      input,
      latest,
      'identity_invalid',
      'The latest scoped report lacks its retained event or receipt identity.',
    );

  const intervals = latest.map((claim) => ({
    start: utcTimestamp(claim.reportedInterval?.start),
    end: utcTimestamp(claim.reportedInterval?.end),
  }));
  if (intervals.some(({ start, end }) => start === undefined || end === undefined || start >= end))
    return result(
      input,
      latest,
      'interval_unavailable',
      'The latest scoped report lacks a valid reported UTC interval; applicability is unknown.',
    );
  if (latest.some((claim) => claim.status !== 'STATUS_APPROVED' && !nonapprovalStatuses.has(claim.status)))
    return result(
      input,
      latest,
      'status_unknown',
      'The latest scoped report does not supply a supported approval or nonapproval status.',
    );

  const statuses = new Set(latest.map((claim) => claim.status));
  const intervalBounds = new Set(intervals.map(({ start, end }) => `${start}:${end}`));
  if (statuses.size > 1 || intervalBounds.size > 1)
    return result(
      input,
      latest,
      'status_conflicting',
      'Simultaneous latest scoped reports disagree on status or reported interval.',
      'conflicting',
    );
  const interval = intervals[0];
  if (evaluatedAt < interval.start! || evaluatedAt >= interval.end!)
    return result(
      input,
      latest,
      'interval_outside',
      'The latest scoped report does not cover the evaluation time; an older report is not substituted.',
    );

  if (latest[0].status === 'STATUS_APPROVED')
    return result(
      input,
      latest,
      'approval_recorded',
      'An approval is reported for this source, authorization and reported interval. This does not establish legal clearance.',
      'supported',
      'applicable',
      'pass',
    );
  return result(
    input,
    latest,
    'nonapproval_recorded',
    'The latest applicable scoped report does not report approval; review its recorded status.',
    'supported',
    'applicable',
  );
}
