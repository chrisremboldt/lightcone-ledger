import { randomUUID } from 'node:crypto';
import { dueRuleEvaluationWorkSql } from './rule-evaluations.js';
import type {
  CommandRecord,
  OrganizationDecisionCommand,
  OrganizationDecisionsResponse,
  PackAdoptionAcceptance,
  SubjectDecisionAcceptance,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { organization } from './adoptions.js';
import { lockProjectionSubjects, readSubjectEvidence, retainSubjectEvidence } from './cuts.js';

interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  revision: string;
}
interface DecisionRow {
  record: SubjectDecisionAcceptance;
  projected: boolean;
  work_state: string | null;
}

const DECISION_LIMIT = 100;

export async function acceptOrganizationDecision(
  client: PoolClient,
  principal: AuthContext,
  command: OrganizationDecisionCommand,
): Promise<CommandRecord> {
  if (command.subject?.kind !== 'organization' || command.decision.kind !== 'adoption.review')
    throw new DomainError(
      400,
      'unsupported_organization_decision',
      'Organization decisions support an informational adoption review',
    );
  const actor = (
    await client.query<PrincipalRow>(
      'SELECT id,tenant_id,name,kind,capabilities,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!actor) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (!actor.capabilities.includes('decision:write'))
    throw new DomainError(403, 'capability_required', 'Capability decision:write is required');
  const current: AuthContext = {
    id: actor.id,
    tenantId: actor.tenant_id,
    name: actor.name,
    kind: actor.kind,
    capabilities: actor.capabilities,
    revision: Number(actor.revision),
  };
  const org = await organization(client, current.tenantId, 'UPDATE');
  const revision = Number(org.revision);
  const evidence = await readSubjectEvidence(client, org.id, current, { lock: true, decision: true });
  if (
    command.expectedRevision !== revision ||
    command.inputCut.basisRevision !== revision ||
    command.inputCut.principalRevision !== current.revision ||
    command.expectedDependencyBasis !== evidence.dependencyBasis ||
    canonicalDigest(command.inputCut.streams) !== canonicalDigest(evidence.rendered.streams)
  )
    throw new DomainError(
      409,
      'stale_basis',
      'Organization information or authority changed; refresh the review basis',
    );
  const adoption = (
    await client.query<{ record: PackAdoptionAcceptance }>(
      'SELECT record FROM organization_pack_adoptions WHERE tenant_id=$1 AND organization_id=$2 AND id=$3',
      [current.tenantId, org.id, command.adoption.id],
    )
  ).rows[0]?.record;
  if (!adoption) throw new DomainError(404, 'adoption_not_found', 'Adoption was not found within your organization');
  if (
    command.adoption.acceptedRevision !== adoption.acceptedRevision ||
    command.adoption.pack.packId !== adoption.pack.packId ||
    command.adoption.pack.version !== adoption.pack.version ||
    command.adoption.pack.digest !== adoption.pack.digest
  )
    throw new DomainError(
      400,
      'invalid_adoption_reference',
      'Review must cite the exact retained adoption and rule pack version',
    );
  const subject = { kind: 'organization' as const, id: org.id };
  const acceptance: Omit<SubjectDecisionAcceptance, 'id' | 'recordedAt'> = {
    subject,
    acceptedRevision: revision + 1,
    actor: {
      id: current.id,
      name: current.name,
      kind: actor.kind,
      principalRevision: current.revision,
      capabilities: [...current.capabilities],
      checkedCapabilities: ['decision:write'],
      policyVersion: 'ledger.organization-review-authority.1',
      historicalProfile: 'retained',
      scope: { ...subject },
    },
    adoption: {
      id: adoption.id,
      acceptedRevision: adoption.acceptedRevision,
      pack: { packId: adoption.pack.packId, version: adoption.pack.version, digest: adoption.pack.digest },
    },
    kind: 'adoption.review',
    note: command.decision.note,
    renderedInputCut: { ...evidence.rendered, basisRevision: revision },
    acceptedInputCut: { ...evidence.accepted, basisRevision: revision },
    acceptedBasisRevision: revision,
    dependencyBasis: evidence.dependencyBasis,
    basisManifest: evidence.basisManifest,
  };
  const event = await appendEvent(client, current, {
    id: randomUUID(),
    type: command.kind,
    stream: org.id,
    payload: { ...command, acceptance },
  });
  const record: SubjectDecisionAcceptance = {
    ...acceptance,
    id: event.id,
    recordedAt: event.received_at.toISOString(),
  };
  await client.query(
    `INSERT INTO decisions(id,tenant_id,flight_id,subject_id,adoption_id,accepted_revision,actor_id,kind,note,
     recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision,record)
     VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      event.id,
      current.tenantId,
      org.id,
      adoption.id,
      record.acceptedRevision,
      current.id,
      record.kind,
      record.note,
      event.received_at,
      record.renderedInputCut,
      record.acceptedInputCut,
      record.acceptedBasisRevision,
      record,
    ],
  );
  await client.query('UPDATE organizations SET revision=$1 WHERE tenant_id=$2 AND id=$3', [
    record.acceptedRevision,
    current.tenantId,
    org.id,
  ]);
  await retainSubjectEvidence(client, current.tenantId, [org.id], event);
  await client.query(
    'INSERT INTO command_records(id,tenant_id,kind,actor_id,recorded_at,payload) VALUES($1,$2,$3,$4,$5,$6)',
    [event.id, current.tenantId, command.kind, current.id, event.received_at, command],
  );
  return {
    id: event.id,
    kind: command.kind,
    actorId: current.id,
    recordedAt: event.received_at.toISOString(),
    payload: { ...command },
  };
}

export async function projectOrganizationDecision(client: PoolClient, event: JournalEvent): Promise<void> {
  if (event.event_type !== 'decision.record' || event.payload.subject?.kind !== 'organization')
    throw new DomainError(400, 'invalid_subject_decision_event', 'Only an organization review can update its history');
  const org = await organization(client, event.tenant_id, 'UPDATE');
  // The projection's subjects come after the organization row and before anything it writes.
  await lockProjectionSubjects(client);
  const row = (
    await client.query<{ record: SubjectDecisionAcceptance }>(
      'SELECT record FROM decisions WHERE tenant_id=$1 AND subject_id=$2 AND id=$3',
      [event.tenant_id, org.id, event.id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      409,
      'subject_decision_acceptance_missing',
      'The immutable organization decision acceptance is unavailable',
    );
  const { id, recordedAt, ...acceptance } = row.record;
  if (
    id !== event.id ||
    recordedAt !== event.received_at.toISOString() ||
    row.record.subject.id !== org.id ||
    row.record.actor.id !== event.principal_id ||
    canonicalDigest(acceptance) !== canonicalDigest(event.payload.acceptance)
  )
    throw new DomainError(
      409,
      'subject_decision_commitment_mismatch',
      'Organization decision acceptance differs from its immutable journal event',
    );
  await client.query(
    `INSERT INTO organization_decision_views(id,tenant_id,organization_id,accepted_revision)
     VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [id, event.tenant_id, org.id, row.record.acceptedRevision],
  );
  await client.query(
    'UPDATE organizations SET projected_revision=GREATEST(projected_revision,$1) WHERE tenant_id=$2 AND id=$3',
    [row.record.acceptedRevision, event.tenant_id, org.id],
  );
}

/** A read at REPEATABLE READ passes `reading` and takes no lock on the organization row. */
export async function getOrganizationDecisions(
  client: PoolClient,
  principal: AuthContext,
  reading = false,
): Promise<OrganizationDecisionsResponse> {
  const org = await organization(client, principal.tenantId, reading ? 'NONE' : 'SHARE');
  const evidence = await readSubjectEvidence(client, org.id, principal, { decision: true });
  const clock = (
    await client.query<{ now: Date; projection_revision: string; outstanding: string }>(
      `SELECT clock_timestamp() AS now,(SELECT COALESCE(MAX(id),0)::text FROM view_changes) AS projection_revision,
       ((SELECT COUNT(*) FROM work_items WHERE state<>'completed')+${dueRuleEvaluationWorkSql()})::text AS outstanding`,
    )
  ).rows[0];
  const rows = await client.query<DecisionRow>(
    `SELECT d.record,v.id IS NOT NULL AS projected,w.state AS work_state FROM decisions d
     LEFT JOIN organization_decision_views v ON v.tenant_id=d.tenant_id AND v.id=d.id
     LEFT JOIN work_items w ON w.tenant_id=d.tenant_id AND w.event_id=d.id
     WHERE d.tenant_id=$1 AND d.subject_id=$2 ORDER BY d.accepted_revision DESC LIMIT $3`,
    [principal.tenantId, org.id, DECISION_LIMIT + 1],
  );
  return {
    organization: {
      id: org.id,
      label: org.label,
      revision: Number(org.revision),
      projectedRevision: Number(org.projected_revision),
    },
    decisions: rows.rows.slice(0, DECISION_LIMIT).map((row) => ({
      ...row.record,
      processing: { status: row.projected ? 'projected' : row.work_state === 'failed' ? 'failed' : 'pending' },
    })),
    limit: DECISION_LIMIT,
    hasOlder: rows.rows.length > DECISION_LIMIT,
    meta: {
      requestId: '',
      projectionRevision: Number(clock.projection_revision),
      inputCut: { ...evidence.rendered, basisRevision: Number(org.revision) },
      dependencyBasis: evidence.dependencyBasis,
      computedAt: clock.now.toISOString(),
      outstandingWork: Number(clock.outstanding),
    },
  };
}
