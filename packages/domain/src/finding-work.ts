import {
  findOperatorRecordDefinition,
  type EvaluationRecord,
  type FindingAction,
  type FindingClosure,
  type FindingTreatment,
  type FindingTreatmentCommand,
  type RuleEvaluationRecord,
  type TreatmentRecord,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { noticeFindingAssigned } from './notice-events.js';
import { observationRegistry } from './observation-registry.js';
import { subjectFindingView } from './subject-findings.js';

/**
 * What a person records on a finding about any subject (docs/design/finding-work.md): taking it, assigning it, an
 * action with a due date, what was done, and closing it with a reason. One set of functions serves a finding about a
 * flight, recorded through the flight's decision command, and a finding about any other subject, recorded through
 * `finding.treat`; which subject a finding is about is data, never a branch here.
 */

/** The finding view's columns this module reads: its action, its closure and whether the action is overdue. */
export const findingWorkColumns = `v.action_note,v.action_due_on::text AS action_due_on,v.action_done_at,
  (v.action_due_on<(SELECT (clock_timestamp() AT TIME ZONE COALESCE(t.time_zone,'UTC'))::date FROM tenants t
    WHERE t.id=v.tenant_id) AND v.action_done_at IS NULL) AS action_overdue,
  v.closed_by,v.closed_at,v.closing_rule_evaluation_id`;

export interface FindingWorkRow {
  id: string;
  action_note: string | null;
  action_due_on: string | null;
  action_done_at: Date | null;
  action_overdue: boolean | null;
  closed_by: 'record' | 'person' | null;
  closed_at: Date | null;
  closing_rule_evaluation_id: string | null;
}

export function findingActionOf(row: FindingWorkRow): FindingAction | undefined {
  if (row.action_note === null || row.action_due_on === null) return undefined;
  return {
    note: row.action_note,
    dueOn: row.action_due_on,
    overdue: Boolean(row.action_overdue),
    ...(row.action_done_at ? { doneAt: row.action_done_at.toISOString() } : {}),
  };
}

/** The title a person knows a record by: its operator record type's title, else its observation type. */
async function recordTitles(
  client: PoolClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, { title: string; occurredAt: string }>> {
  if (!ids.length) return new Map();
  const rows = await client.query<{
    id: string;
    type: string;
    record_type: string | null;
    version: string | null;
    occurred_at: Date;
  }>(
    `SELECT id,observation_type AS type,observation->'values'->>'recordType' AS record_type,
       observation->'values'->>'recordVersion' AS version,occurred_at
     FROM observations WHERE tenant_id=$1 AND id=ANY($2::text[])`,
    [tenantId, ids],
  );
  return new Map(
    rows.rows.map((row) => {
      const definition =
        row.record_type && row.version
          ? findOperatorRecordDefinition(observationRegistry(), row.record_type, Number(row.version))
          : undefined;
      return [
        row.id,
        { title: definition?.title ?? row.record_type ?? row.type, occurredAt: row.occurred_at.toISOString() },
      ];
    }),
  );
}

/**
 * How a closed finding was closed. Closed by a record: the closing evaluation, and the records it read that the
 * evaluation which opened the finding did not (all it read, when it read nothing new). Closed by a person: their last
 * closing treatment.
 */
export async function findingClosureOf(
  client: PoolClient,
  tenantId: string,
  row: FindingWorkRow,
  initialEvidence: readonly string[],
): Promise<FindingClosure | undefined> {
  if (!row.closed_by || !row.closed_at) return undefined;
  const closedAt = row.closed_at.toISOString();
  if (row.closed_by === 'record' && row.closing_rule_evaluation_id) {
    const closing = (
      await client.query<{ record: RuleEvaluationRecord }>(
        'SELECT record FROM rule_evaluations WHERE tenant_id=$1 AND id=$2',
        [tenantId, row.closing_rule_evaluation_id],
      )
    ).rows[0]?.record;
    if (closing) {
      const read = [...new Set(closing.evidence.map((item) => item.observationId))];
      const added = read.filter((id) => !initialEvidence.includes(id));
      const shown = added.length ? added : read;
      const titles = await recordTitles(client, tenantId, shown);
      return {
        by: 'record',
        closedAt,
        evaluationId: closing.id,
        summary: closing.summary,
        records: shown.flatMap((id) => {
          const found = titles.get(id);
          return found ? [{ observationId: id, ...found }] : [];
        }),
      };
    }
  }
  const last = (
    await client.query<{ action: string; reason: string | null; note: string; actor_name: string }>(
      `SELECT t.action,t.reason,t.note,p.name AS actor_name FROM finding_treatments t
       JOIN principals p ON p.tenant_id=t.tenant_id AND p.id=t.actor_id
       WHERE t.tenant_id=$1 AND t.finding_id=$2 AND t.action IN ('close','resolve')
       ORDER BY t.recorded_at DESC,t.id DESC LIMIT 1`,
      [tenantId, row.id],
    )
  ).rows[0];
  if (!last) return undefined;
  return {
    by: 'person',
    closedAt,
    reason:
      last.action === 'close'
        ? (last.reason as Exclude<FindingClosure, { by: 'record' }>['reason'])
        : 'evidence_cleared',
    actorName: last.actor_name,
    note: last.note,
  };
}

/** The finding's treatments, oldest first, at most 50, and whether older ones exist. */
export async function treatmentsOf(
  client: PoolClient,
  tenantId: string,
  findingId: string,
): Promise<{ treatments: TreatmentRecord[]; hasOlderTreatments: boolean }> {
  const rows = await client.query<{
    id: string;
    evaluation_id: string;
    action: FindingTreatment['action'];
    actor_id: string;
    actor_name: string;
    note: string;
    recorded_at: Date;
    assignee_id: string | null;
    assignee_name: string | null;
    due_on: string | null;
    reason: TreatmentRecord['reason'] | null;
    decision_id: string;
    decision_count: number | null;
  }>(
    `SELECT t.id,COALESCE(t.evaluation_id,t.rule_evaluation_id) AS evaluation_id,t.action,t.actor_id,t.note,
       t.recorded_at,p.name AS actor_name,t.assignee_id,a.name AS assignee_name,t.due_on::text AS due_on,t.reason,
       t.decision_id,CASE WHEN t.decision_id<>t.id THEN jsonb_array_length(c.payload->'findings') END AS decision_count
     FROM finding_treatments t JOIN principals p ON p.tenant_id=t.tenant_id AND p.id=t.actor_id
     LEFT JOIN principals a ON a.tenant_id=t.tenant_id AND a.id=t.assignee_id
     LEFT JOIN command_records c ON c.tenant_id=t.tenant_id AND c.id=t.decision_id AND t.decision_id<>t.id
     WHERE t.tenant_id=$1 AND t.finding_id=$2 ORDER BY t.recorded_at DESC,t.id DESC LIMIT 51`,
    [tenantId, findingId],
  );
  return {
    treatments: rows.rows
      .slice(0, 50)
      .reverse()
      .map((item) => ({
        id: item.id,
        evaluationId: item.evaluation_id,
        action: item.action,
        actorId: item.actor_id,
        actorName: item.actor_name,
        note: item.note,
        recordedAt: item.recorded_at.toISOString(),
        ...(item.assignee_id
          ? { assignee: { id: item.assignee_id, name: item.assignee_name ?? item.assignee_id } }
          : {}),
        ...(item.due_on ? { dueOn: item.due_on } : {}),
        ...(item.reason ? { reason: item.reason } : {}),
        ...(item.decision_count ? { decision: { id: item.decision_id, findingCount: item.decision_count } } : {}),
      })),
    hasOlderTreatments: rows.rows.length > 50,
  };
}

interface TreatedRow {
  flight_id: string | null;
  subject_scope: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  latest_evaluation_id: string | null;
  latest_rule_evaluation_id: string | null;
  status: string;
  owner_id: string | null;
  action_note: string | null;
  action_done_at: Date | null;
  flight_record: EvaluationRecord | null;
  rule_record: RuleEvaluationRecord | null;
}

async function treatedFinding(client: PoolClient, findingId: string, lock: boolean): Promise<TreatedRow | undefined> {
  return (
    await client.query<TreatedRow>(
      `SELECT v.flight_id,f.subject_scope,f.subject_kind,f.subject_id,v.latest_evaluation_id,
         v.latest_rule_evaluation_id,v.status,v.owner_id,v.action_note,v.action_done_at,
         e.record AS flight_record,r.record AS rule_record
       FROM finding_views v JOIN findings f ON f.tenant_id=v.tenant_id AND f.id=v.id
       LEFT JOIN flight_evaluations e ON e.tenant_id=v.tenant_id AND e.id=v.latest_evaluation_id
       LEFT JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
       WHERE v.id=$1${lock ? ' FOR UPDATE OF v' : ''}`,
      [findingId],
    )
  ).rows[0];
}

/** The Ledger subject a finding is about: its flight, or the subject of a generic finding. */
function aboutSubject(row: TreatedRow): { kind: string; id: string } | undefined {
  if (row.flight_id) return { kind: 'flight', id: row.flight_id };
  if (row.subject_scope === 'ledger' && row.subject_kind && row.subject_id)
    return { kind: row.subject_kind, id: row.subject_id };
  return undefined;
}

/** A flight evaluation as recorded, or a rule evaluation: the record a treatment pins as its basis. */
export type TreatedEvaluation =
  { kind: 'flight'; record: EvaluationRecord } | { kind: 'rule'; record: RuleEvaluationRecord };

export function treatmentShapeProblem(
  treatment: Pick<FindingTreatment, 'action' | 'assigneeId' | 'dueOn' | 'reason'>,
): string | undefined {
  const { action } = treatment;
  if ((action === 'assign') !== Boolean(treatment.assigneeId))
    return 'Name the person a finding is assigned to, and only when assigning it';
  if ((action === 'plan') !== Boolean(treatment.dueOn))
    return 'Give the day an action is due, and only when recording an action';
  if ((action === 'close') !== Boolean(treatment.reason))
    return 'Give the reason a finding is closed, and only when closing it';
  if (treatment.dueOn && Number.isNaN(Date.parse(`${treatment.dueOn}T00:00:00Z`)))
    return 'The day an action is due must be a calendar date, such as 2026-12-01';
  return undefined;
}

export function requirePerson(principal: AuthContext): void {
  if (principal.kind !== 'human')
    throw new DomainError(
      403,
      'person_required',
      'Taking, assigning, acting on and closing a finding are decisions of a person. This credential belongs to a service or a source; the person who decides records it with their own credential.',
    );
}

/**
 * Checks a treatment against the finding's latest evaluation, which is a flight evaluation or a rule evaluation, and
 * returns that evaluation as the basis the decision pins. `flightId` limits the finding to one flight's, for a
 * treatment recorded through the flight's decision command.
 */
export async function validateFindingTreatment(
  client: PoolClient,
  principal: AuthContext,
  treatment: FindingTreatment,
  flightId?: string,
): Promise<TreatedEvaluation> {
  requirePerson(principal);
  const shape = treatmentShapeProblem(treatment);
  if (shape) throw new DomainError(400, 'invalid_finding_treatment', shape);
  const row = await treatedFinding(client, treatment.findingId, true);
  const about = row ? aboutSubject(row) : undefined;
  if (!row || (flightId !== undefined && (about?.kind !== 'flight' || about.id !== flightId)))
    throw new DomainError(
      404,
      'finding_not_found',
      flightId === undefined
        ? 'Finding was not found in your organization'
        : 'Finding was not found within this flight',
    );
  if ((row.latest_evaluation_id ?? row.latest_rule_evaluation_id) !== treatment.evaluationId)
    throw new DomainError(409, 'stale_finding', 'The evaluation changed; refresh and review the finding');
  if (row.status === 'resolved') throw new DomainError(409, 'finding_resolved', 'This finding is already closed');
  if (treatment.action === 'assign') await requireAssignee(client, principal.tenantId, treatment.assigneeId!);
  else if (treatment.action !== 'acknowledge' && row.owner_id !== principal.id)
    throw new DomainError(409, 'finding_owner_required', 'Take responsibility before responding to this finding');
  const evaluation: TreatedEvaluation = row.flight_record
    ? { kind: 'flight', record: row.flight_record }
    : { kind: 'rule', record: row.rule_record! };
  if (treatment.action === 'resolve' && !['pass', 'not_applicable'].includes(evaluation.record.outcome))
    throw new DomainError(
      409,
      'finding_evidence_required',
      'The check still needs attention; close the finding with a reason, or add or correct its evidence',
    );
  return evaluation;
}

/** A finding is assigned to an active person in the organization who may treat findings. */
export async function requireAssignee(client: PoolClient, tenantId: string, assigneeId: string): Promise<void> {
  const assignee = (
    await client.query<{ kind: string; capabilities: string[] }>(
      'SELECT kind,capabilities FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [tenantId, assigneeId],
    )
  ).rows[0];
  if (!assignee || assignee.kind !== 'human')
    throw new DomainError(400, 'assignee_not_found', 'A finding is assigned to a person in your organization');
  if (!assignee.capabilities.includes('decision:write'))
    throw new DomainError(
      400,
      'assignee_cannot_treat',
      'That person cannot record decisions on findings; give them the decision:write capability first',
    );
}

const statusAfter: Record<FindingTreatment['action'], string | null> = {
  acknowledge: 'acknowledged',
  assign: 'acknowledged',
  plan: null,
  respond: 'responding',
  resolve: 'resolved',
  close: 'resolved',
};

/**
 * Records one treatment row and the finding's projection; the subject's own hook is the caller's. `decisionId` is the
 * command that decided it: the treatment's own id for one finding, or one decision about many.
 */
export async function insertFindingTreatment(
  client: PoolClient,
  principal: AuthContext,
  ids: { treatmentId: string; decisionId: string },
  treatment: FindingTreatment,
  note: string,
  recordedAt: Date,
): Promise<{ kind: string; id: string } | undefined> {
  const row = (await treatedFinding(client, treatment.findingId, false))!;
  // A treatment is keyed by the evaluation it was recorded against: a flight evaluation or a rule evaluation.
  const generic = row.latest_rule_evaluation_id !== null;
  await client.query(
    `INSERT INTO finding_treatments(id,tenant_id,finding_id,evaluation_id,rule_evaluation_id,action,actor_id,note,
       recorded_at,assignee_id,due_on,reason,decision_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13)`,
    [
      ids.treatmentId,
      principal.tenantId,
      treatment.findingId,
      generic ? null : treatment.evaluationId,
      generic ? treatment.evaluationId : null,
      treatment.action,
      principal.id,
      note,
      recordedAt,
      treatment.assigneeId ?? null,
      treatment.dueOn ?? null,
      treatment.reason ?? null,
      ids.decisionId,
    ],
  );
  const closes = treatment.action === 'resolve' || treatment.action === 'close';
  await client.query(
    `UPDATE finding_views SET status=COALESCE($1,status),
       owner_id=CASE $2 WHEN 'acknowledge' THEN $3 WHEN 'assign' THEN $4 ELSE owner_id END,
       action_note=CASE WHEN $2='plan' THEN $5 ELSE action_note END,
       action_due_on=CASE WHEN $2='plan' THEN $6::date ELSE action_due_on END,
       action_done_at=CASE WHEN $2='plan' THEN NULL WHEN $2='respond' AND action_note IS NOT NULL
         THEN COALESCE(action_done_at,$7) ELSE action_done_at END,
       closed_by=CASE WHEN $8 THEN 'person' ELSE closed_by END,
       closed_at=CASE WHEN $8 THEN $7 ELSE closed_at END,
       closing_rule_evaluation_id=CASE WHEN $8 THEN $9 ELSE closing_rule_evaluation_id END
     WHERE id=$10`,
    [
      statusAfter[treatment.action],
      treatment.action,
      principal.id,
      treatment.assigneeId ?? null,
      note,
      treatment.dueOn ?? null,
      recordedAt,
      closes,
      closes && generic ? treatment.evaluationId : null,
      treatment.findingId,
    ],
  );
  // The person a finding is assigned to hears of it; a notice that cannot be written changes nothing here.
  if (treatment.action === 'assign')
    await noticeFindingAssigned(client, principal, ids.treatmentId, treatment.findingId, treatment.assigneeId!);
  return aboutSubject(row);
}

export async function recordFindingTreatment(
  client: PoolClient,
  principal: AuthContext,
  commandId: string,
  treatment: FindingTreatment,
  note: string,
  recordedAt: Date,
  /** The finding's own event, when the treatment was not recorded as a decision of the subject it is about. */
  event?: JournalEvent,
): Promise<void> {
  const about = await insertFindingTreatment(
    client,
    principal,
    { treatmentId: commandId, decisionId: commandId },
    treatment,
    note,
    recordedAt,
  );
  if (about) await subjectFindingView(about.kind)?.treated(client, about.id, event);
}

/**
 * `finding.treat`: a person's treatment of a finding about any subject, pinned to the finding's latest evaluation.
 * Locks: the module that owns a Ledger subject's kind locks its record first (for a flight, its view), then the
 * finding, then the finding's stream.
 */
export async function acceptFindingTreatment(
  client: PoolClient,
  principal: AuthContext,
  command: FindingTreatmentCommand,
): Promise<string> {
  const subject = (
    await client.query<{
      flight_id: string | null;
      subject_scope: string | null;
      subject_kind: string | null;
      subject_id: string | null;
    }>('SELECT flight_id,subject_scope,subject_kind,subject_id FROM findings WHERE tenant_id=$1 AND id=$2', [
      principal.tenantId,
      command.treatment.findingId,
    ])
  ).rows[0];
  const kind = subject?.flight_id ? 'flight' : subject?.subject_scope === 'ledger' ? subject.subject_kind : null;
  const id = subject?.flight_id ?? subject?.subject_id;
  if (kind && id) await subjectFindingView(kind)?.lockSubject?.(client, id);
  const basis = await validateFindingTreatment(client, principal, command.treatment);
  const event = await appendEvent(client, principal, {
    type: command.kind,
    stream: `finding:${command.treatment.findingId}`,
    payload: {
      ...command,
      acceptedEvaluation: { kind: basis.kind, id: basis.record.id, digest: canonicalDigest(basis.record) },
    },
  });
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, principal.tenantId, command.kind, principal.id, event.received_at, command],
  );
  await recordFindingTreatment(client, principal, event.id, command.treatment, command.note, event.received_at, event);
  return event.id;
}
