import {
  evaluationMode,
  subjectReferenceKey,
  type EvaluationRecord,
  type FindingRecord,
  type FindingTreatment,
  type RuleEvaluationRecord,
} from '@ledger/contracts';
import { appendLiveChange, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import {
  findingActionOf,
  findingClosureOf,
  findingWorkColumns,
  treatmentsOf,
  validateFindingTreatment,
  type FindingWorkRow,
} from './finding-work.js';
import { registerSubjectFindingView } from './subject-findings.js';

// A flight's findings: those its own flight evaluations opened, and those the generic evaluator opened about the
// flight under an adoption in active mode. Both are shown, counted and treated the same way. A finding whose latest
// evaluation an active waiver adoption relieves is not counted while it is relieved.

function flightKey(flightId: string): string {
  return subjectReferenceKey({ scope: 'ledger', kind: 'flight', id: flightId });
}

/** Findings about one flight with their latest evaluation's title, outcome and time; $1 is the flight, $2 its key. */
const flightFindings = `SELECT v.id,v.status,v.owner_id,e.record->>'title' AS title,e.record->>'outcome' AS outcome,
   e.record->>'recordedAt' AS recorded_at,e.id AS evaluation_id
 FROM finding_views v JOIN flight_evaluations e ON e.tenant_id=v.tenant_id AND e.id=v.latest_evaluation_id
 WHERE v.flight_id=$1
 UNION ALL
 SELECT v.id,v.status,v.owner_id,r.record->'rule'->>'title',r.outcome,r.record->>'recordedAt',r.id
 FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
 JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.latest_rule_evaluation_id
 WHERE f.subject_key=$2 AND r.record->'adoption'->>'mode' IS DISTINCT FROM 'shadow' AND r.outcome<>'relieved'`;

export async function refreshFindingSummary(client: PoolClient, flightId: string): Promise<void> {
  await client.query(
    `WITH current AS (${flightFindings})
     UPDATE flight_views SET open_finding_count=(SELECT COUNT(*) FROM current WHERE status<>'resolved'),
     unowned_finding_count=(SELECT COUNT(*) FROM current WHERE status<>'resolved' AND owner_id IS NULL),
     latest_finding_title=(SELECT title FROM current WHERE status<>'resolved'
       ORDER BY CASE WHEN outcome='attention' THEN 0 ELSE 1 END,recorded_at DESC,evaluation_id DESC LIMIT 1)
     WHERE id=$1`,
    [flightId, flightKey(flightId)],
  );
}

/** A generic rule evaluation of a flight, in the shape a flight's findings show every evaluation. */
export function flightEvaluationRecord(record: RuleEvaluationRecord): EvaluationRecord {
  return {
    id: record.id,
    flightId: record.subject.id,
    leafId: record.rule.id,
    leafVersion: record.rule.version,
    bindingId: record.pack.id,
    bindingVersion: record.pack.version,
    applicability: record.applicability,
    evidenceState: record.evidenceState,
    outcome: record.outcome,
    title: record.rule.title,
    rule: {
      reference: record.rule.source.reference,
      text: record.rule.source.text,
      review: 'ai_drafted',
      adopted: false,
    },
    explanation: {
      kind: 'rule',
      code: record.reasonCode,
      summary: record.summary,
      evidence: record.evidence.map((item) => ({
        eventId: item.eventId,
        receiptId: item.receiptId,
        sourceId: item.sourceId,
        occurredAt: item.occurredAt,
        observationId: item.observationId,
        type: item.type,
        version: item.version,
      })),
      details: { ...(record.details ?? {}) },
      parameters: structuredClone(record.parameters),
      inputs: record.inputs.map((input) => ({
        name: input.name,
        type: input.type,
        observationIds: [...input.observationIds],
      })),
      ruleEvaluation: {
        pack: { ...record.pack },
        ruleDigest: record.rule.digest,
        check: { kind: record.check.kind, version: record.check.version },
        mode: evaluationMode(record),
        subjectKey: record.subjectKey,
      },
      evaluatedAt: record.clock.evaluatedAt,
      ...(record.nextBoundary ? { nextBoundary: record.nextBoundary } : {}),
      ...(record.readAsPlans ? { readAsPlans: structuredClone(record.readAsPlans) } : {}),
    },
    clock: { ...record.clock },
    inputCut: record.inputCut,
    acceptedInputCut: record.inputCut,
    dependencyBasis: record.dependencyBasis,
    recordedAt: record.recordedAt,
    ...(record.nextBoundary ? { dueAt: record.nextBoundary } : {}),
  };
}

interface FindingRow extends FindingWorkRow {
  tenant_id: string;
  opened_at: Date;
  status: FindingRecord['status'];
  owner_id: string | null;
  owner_name: string | null;
  initial_flight: EvaluationRecord | null;
  latest_flight: EvaluationRecord | null;
  initial_rule: RuleEvaluationRecord | null;
  latest_rule: RuleEvaluationRecord | null;
}

function evaluationOf(flight: EvaluationRecord | null, rule: RuleEvaluationRecord | null): EvaluationRecord {
  return flight ?? flightEvaluationRecord(rule!);
}

export async function getFindings(client: PoolClient, flightId: string): Promise<FindingRecord[]> {
  const rows = await client.query<FindingRow>(
    `SELECT f.id,f.tenant_id,f.opened_at,v.status,v.owner_id,p.name AS owner_name,${findingWorkColumns},
       fi.record AS initial_flight,fl.record AS latest_flight,ri.record AS initial_rule,rl.record AS latest_rule
     FROM findings f JOIN finding_views v ON v.tenant_id=f.tenant_id AND v.id=f.id
     LEFT JOIN flight_evaluations fi ON fi.tenant_id=f.tenant_id AND fi.id=f.initial_evaluation_id
     LEFT JOIN flight_evaluations fl ON fl.tenant_id=v.tenant_id AND fl.id=v.latest_evaluation_id
     LEFT JOIN rule_evaluations ri ON ri.tenant_id=f.tenant_id AND ri.id=f.initial_rule_evaluation_id
     LEFT JOIN rule_evaluations rl ON rl.tenant_id=v.tenant_id AND rl.id=v.latest_rule_evaluation_id
     LEFT JOIN principals p ON p.id=v.owner_id
     WHERE f.flight_id=$1 OR (f.subject_key=$2 AND rl.record->'adoption'->>'mode' IS DISTINCT FROM 'shadow')
     ORDER BY f.opened_at,f.id`,
    [flightId, flightKey(flightId)],
  );
  const findings: FindingRecord[] = [];
  for (const row of rows.rows) {
    const initialEvaluation = evaluationOf(row.initial_flight, row.initial_rule);
    const action = findingActionOf(row);
    const closure = await findingClosureOf(
      client,
      row.tenant_id,
      row,
      (row.initial_rule?.evidence ?? []).map((item) => item.observationId),
    );
    findings.push({
      id: row.id,
      flightId,
      status: row.status,
      owner: row.owner_id ? { id: row.owner_id, name: row.owner_name! } : null,
      openedAt: row.opened_at.toISOString(),
      initialEvaluation,
      latestEvaluation: evaluationOf(row.latest_flight, row.latest_rule),
      ...(await treatmentsOf(client, row.tenant_id, row.id)),
      ...(action ? { action } : {}),
      ...(closure ? { closure } : {}),
    });
  }
  return findings;
}

/**
 * Checks a treatment recorded through the flight's decision command and returns the finding's latest evaluation in
 * the shape the flight's decisions pin.
 */
export async function validateFlightFindingTreatment(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  treatment: FindingTreatment,
): Promise<EvaluationRecord> {
  const basis = await validateFindingTreatment(client, principal, treatment, flightId);
  return basis.kind === 'flight' ? basis.record : flightEvaluationRecord(basis.record);
}

/** A finding's own event about the flight's finding changes what a decision about the flight must have seen. */
async function changedByFindingEvent(client: PoolClient, flightId: string, event: JournalEvent): Promise<void> {
  await client.query('UPDATE flight_views SET revision=revision+1,basis_revision=basis_revision+1 WHERE id=$1', [
    flightId,
  ]);
  await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
    event.tenant_id,
    flightId,
    event.id,
  ]);
  await appendLiveChange(client, event.tenant_id, flightId, event.id, 'flight.updated');
}

// Generic findings about a flight appear in its thread and counts, as its own flight evaluations' findings do.
registerSubjectFindingView('flight', {
  async lockSubject(client, flightId) {
    await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [flightId]);
  },
  async recorded(client, principal, flightId, evaluation, event, findingId) {
    if (evaluationMode(evaluation) === 'shadow') return;
    const flight = await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [flightId]);
    if (!flight.rowCount) return;
    if (findingId)
      await client.query(
        `INSERT INTO timeline_items(id,tenant_id,flight_id,lane,kind,title,occurred_at,received_at,actor_id,payload,link_status)
         VALUES($1,$2,$3,'checks','evaluation.recorded',$4,$5,$6,$7,$8,'linked')`,
        [
          event.id,
          principal.tenantId,
          flightId,
          evaluation.rule.title,
          evaluation.clock.evaluatedAt,
          event.received_at,
          principal.id,
          { findingId, evaluationId: evaluation.id, summary: evaluation.summary, outcome: evaluation.outcome },
        ],
      );
    // A recorded evaluation changes what a decision about the flight must have seen.
    await client.query('UPDATE flight_views SET revision=revision+1,basis_revision=basis_revision+1 WHERE id=$1', [
      flightId,
    ]);
    await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
      principal.tenantId,
      flightId,
      event.id,
    ]);
    await appendLiveChange(client, principal.tenantId, flightId, event.id, 'flight.updated');
    await refreshFindingSummary(client, flightId);
  },
  async treated(client, flightId, event) {
    if (event) await changedByFindingEvent(client, flightId, event);
    await refreshFindingSummary(client, flightId);
  },
});
