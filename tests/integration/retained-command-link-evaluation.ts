import { randomUUID } from 'node:crypto';
import type {
  CommandLinkInput,
  EvaluationRecord,
  LinkStatusObservationV1,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { appendEvent, type AuthContext, type PoolClient } from '../../packages/persistence/src/index.js';
import { readSubjectEvidence, retainSubjectEvidence } from '../../packages/domain/src/cuts.js';
import { refreshFindingSummary } from '../../packages/domain/src/findings.js';
import {
  commandLinkEvidenceLeafV1,
  commandLinkReportFromObservation,
  commandLinkStatusBindingV1,
  evaluateCommandLinkEvidence,
  type CommandLinkEvidenceReport,
} from '../../packages/domain/src/rules/command-link-evidence-v1.js';

// RETAINED HISTORY FIXTURE. Before pack version 5 the lost-link review ran in its own evaluator, which recorded flight
// evaluations, findings and timeline items in this shape. Nothing records them now; tests that read retained history,
// such as the older decision packet format, record them as that evaluator did, in its built-in draft mode.

interface ReportRow {
  event_id: string;
  receipt_id: string;
  flight_id: string;
  source_id: string;
  source_session_id: string;
  occurred_at: Date;
  payload: CommandLinkInput['payload'] | null;
  observation: LinkStatusObservationV1 | null;
}

async function retainedReports(client: PoolClient, tenantId: string, flightId: string) {
  const rows = await client.query<ReportRow>(
    `SELECT e.id AS event_id,r.id AS receipt_id,c.flight_id,c.source_id,c.source_session_id,e.occurred_at,
     CASE WHEN e.event_type='command-link.status' THEN e.payload->'payload' END AS payload,
     CASE WHEN e.event_type='observation' THEN o.observation END AS observation FROM command_link_source_events c
     JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
     JOIN receipts r ON r.tenant_id=c.tenant_id AND r.id=c.receipt_id
     LEFT JOIN observations o ON o.tenant_id=c.tenant_id AND o.event_id=e.id
     WHERE c.tenant_id=$1 AND c.flight_id=$2 AND e.event_type IN ('command-link.status','observation') ORDER BY e.id`,
    [tenantId, flightId],
  );
  return rows.rows.flatMap((row): CommandLinkEvidenceReport[] => {
    const retained = { flightId: row.flight_id, eventId: row.event_id, receiptId: row.receipt_id };
    if (row.observation) {
      const report = commandLinkReportFromObservation(row.observation, { ...retained, sourceId: row.source_id });
      return report ? [report] : [];
    }
    return [
      {
        ...retained,
        sourceId: row.source_id,
        sourceSessionId: row.source_session_id,
        sourceEventId: row.payload!.sourceEventId,
        incidentId: row.payload!.incidentId,
        aircraftId: row.payload!.aircraftId,
        occurredAt: row.occurred_at.toISOString(),
        status: row.payload!.status,
      },
    ];
  });
}

/** Records the retained evaluation the older evaluator made when it projected the report event `triggerId`. */
export async function recordRetainedCommandLinkEvaluation(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  triggerId: string,
): Promise<void> {
  await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
    principal.tenantId,
    flightId,
  ]);
  const clock = {
    mode: 'wall' as const,
    evaluatedAt: (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString(),
  };
  const reports = await retainedReports(client, principal.tenantId, flightId);
  const result = evaluateCommandLinkEvidence({ flightId, reports, clock });
  const newLoss = reports.some((report) => report.eventId === triggerId && report.status === 'lost');
  if (newLoss)
    result.explanation.summary = `A newly recorded command-link loss report needs review. ${result.explanation.summary}`;
  const inputDigest = canonicalDigest({ triggerEventId: triggerId, reports });
  const leaf = commandLinkEvidenceLeafV1;
  const binding = commandLinkStatusBindingV1;
  const findingId = `finding:${canonicalDigest({ tenant: principal.tenantId, flightId, leafId: leaf.id, scope: 'flight' })}`;
  const previous = (
    await client.query<{ status: string }>('SELECT status FROM finding_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
      principal.tenantId,
      findingId,
    ])
  ).rows[0];
  const needsReview = newLoss || (reports.some((report) => report.status === 'lost') && result.outcome === 'attention');
  const basis = await readSubjectEvidence(client, flightId, principal, { lock: true });
  const id = randomUUID();
  const event = await appendEvent(client, principal, {
    id,
    type: 'evaluation.recorded',
    stream: `evaluation:${flightId}`,
    causationId: triggerId,
    payload: {
      flightId,
      findingId: needsReview || previous ? findingId : null,
      evaluation: {
        ...result,
        clock,
        inputCut: basis.rendered,
        acceptedInputCut: basis.accepted,
        dependencyBasis: basis.dependencyBasis,
      },
      leaf,
      binding,
      declaredSubjects: [flightId],
    },
  });
  const record: EvaluationRecord = {
    ...result,
    rule: { reference: leaf.source.reference, text: leaf.source.text, review: leaf.review, adopted: leaf.adopted },
    id,
    clock,
    inputCut: basis.rendered,
    acceptedInputCut: basis.accepted,
    dependencyBasis: basis.dependencyBasis,
    recordedAt: event.received_at.toISOString(),
  };
  await client.query(
    `INSERT INTO flight_evaluations(id,tenant_id,flight_id,leaf_id,leaf_version,binding_id,binding_version,input_digest,record)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, principal.tenantId, flightId, leaf.id, leaf.version, binding.id, binding.version, inputDigest, record],
  );
  if (needsReview && !previous) {
    await client.query(
      'INSERT INTO findings(id,tenant_id,flight_id,leaf_id,initial_evaluation_id,opened_at) VALUES($1,$2,$3,$4,$5,$6)',
      [findingId, principal.tenantId, flightId, leaf.id, id, event.received_at],
    );
    await client.query(
      "INSERT INTO finding_views(id,tenant_id,flight_id,latest_evaluation_id,status) VALUES($1,$2,$3,$4,'open')",
      [findingId, principal.tenantId, flightId, id],
    );
  } else if (previous)
    await client.query(
      `UPDATE finding_views SET latest_evaluation_id=$1,status=CASE WHEN status='resolved' AND $2
       THEN CASE WHEN owner_id IS NULL THEN 'open' ELSE 'acknowledged' END ELSE status END,
       closed_by=CASE WHEN status='resolved' AND $2 THEN NULL ELSE closed_by END,
       closed_at=CASE WHEN status='resolved' AND $2 THEN NULL ELSE closed_at END WHERE tenant_id=$3 AND id=$4`,
      [id, needsReview, principal.tenantId, findingId],
    );
  await retainSubjectEvidence(client, principal.tenantId, [flightId], event);
  if (needsReview || previous)
    await client.query(
      `INSERT INTO timeline_items(id,tenant_id,flight_id,lane,kind,title,occurred_at,received_at,actor_id,payload,link_status)
       VALUES($1,$2,$3,'checks','evaluation.recorded',$4,$5,$6,$7,$8,'linked')`,
      [
        id,
        principal.tenantId,
        flightId,
        result.title,
        clock.evaluatedAt,
        event.received_at,
        principal.id,
        { findingId, evaluationId: id, summary: result.explanation.summary, outcome: result.outcome },
      ],
    );
  await client.query(
    `INSERT INTO projection_offsets(tenant_id,stream_id,sequence,projector_version) VALUES($1,$2,$3,'flight-evaluations.1')
     ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence,projector_version=EXCLUDED.projector_version`,
    [principal.tenantId, event.stream_id, event.stream_sequence],
  );
  await client.query(
    "UPDATE work_items SET state='completed',completed_at=clock_timestamp() WHERE event_id=$1 AND state='pending' AND generation=0",
    [id],
  );
  await client.query(
    'UPDATE flight_views SET revision=revision+1,basis_revision=basis_revision+1 WHERE tenant_id=$1 AND id=$2',
    [principal.tenantId, flightId],
  );
  await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
    principal.tenantId,
    flightId,
    id,
  ]);
  await refreshFindingSummary(client, flightId);
}

/** Records, as the older evaluator did, an evaluation for each projected report event that has none yet. */
export async function recordRetainedCommandLinkEvaluations(client: PoolClient, principal: AuthContext): Promise<void> {
  const pending = await client.query<{ id: string; flight_id: string }>(
    `SELECT e.id,c.flight_id FROM command_link_source_events c JOIN journal_events e ON e.tenant_id=c.tenant_id AND e.id=c.event_id
     JOIN work_items w ON w.tenant_id=e.tenant_id AND w.event_id=e.id AND w.state='completed'
     WHERE c.tenant_id=$1 AND e.event_type='command-link.status'
     AND NOT EXISTS(SELECT 1 FROM journal_events v WHERE v.tenant_id=e.tenant_id AND v.causation_id=e.id
       AND v.event_type='evaluation.recorded') ORDER BY e.stream_sequence,e.id`,
    [principal.tenantId],
  );
  for (const row of pending.rows) await recordRetainedCommandLinkEvaluation(client, principal, row.flight_id, row.id);
}
