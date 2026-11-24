import { randomUUID } from 'node:crypto';
import {
  isCheckedRuleLeaf,
  type FlightRuleSelectionAdoptionV3,
  type FlightRuleSelectionConvergence,
  type FlightRuleSelectionRecord,
  type FlightRuleSelectionRecordV3,
  type PackAdoptionAcceptance,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, appendLiveChange, DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { adoptionEndSql, organization } from './adoptions.js';
import { linkSubjectDependency, readSubjectEvidence, retainSubjectEvidence } from './cuts.js';

// A flight's rule selection: the adopted pack version whose checked rules about flights the generic evaluator runs
// for the flight's organization, and when that changes. Any pack qualifies; the rules are read from the adoption.

const evaluatorDefinition = {
  id: 'ledger.rule-evaluator' as const,
  version: 1 as const,
  record: 'ledger.rule-evaluation.1',
  clock: 'wall',
};
/** The generic evaluator, as a selection names what runs the selected rules. */
export const ruleEvaluatorReference = Object.freeze({
  id: evaluatorDefinition.id,
  version: evaluatorDefinition.version,
  digest: canonicalDigest(evaluatorDefinition),
});

interface AdoptionRow {
  id: string;
  record: PackAdoptionAcceptance;
  projected: boolean;
  effective_start: Date;
  effective_end: Date;
}
type SelectionState = Pick<
  FlightRuleSelectionRecordV3,
  | 'version'
  | 'flightId'
  | 'organizationId'
  | 'adoptionRevision'
  | 'projectedAdoptionRevision'
  | 'selection'
  | 'execution'
  | 'nextBoundary'
>;

async function clock(client: PoolClient): Promise<string> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
}

/** The adopted pack's checked rules about flights, or none when it holds no such rule. */
function flightRules(record: PackAdoptionAcceptance): FlightRuleSelectionAdoptionV3['rules'] {
  return record.pack.leaves
    .filter(isCheckedRuleLeaf)
    .filter((leaf) => leaf.target.subjectKind === 'flight')
    .map((leaf) => ({ id: leaf.id, version: leaf.version, digest: leaf.digest }));
}

function adoptionReference(record: PackAdoptionAcceptance): FlightRuleSelectionAdoptionV3 {
  return {
    id: record.id,
    acceptedRevision: record.acceptedRevision,
    pack: { id: record.pack.packId, version: record.pack.version, digest: record.pack.digest },
    rules: flightRules(record),
    effectiveInterval: record.effectiveInterval,
  };
}

/** In effect first, then the earliest future one, then the latest past one. */
function selectionOrder(at: number) {
  const rank = (row: AdoptionRow) =>
    row.effective_start.getTime() <= at && row.effective_end.getTime() > at
      ? 0
      : row.effective_start.getTime() > at
        ? 1
        : 2;
  return (left: AdoptionRow, right: AdoptionRow): number =>
    rank(left) - rank(right) ||
    (rank(left) < 2 ? left.effective_start.getTime() - right.effective_start.getTime() : 0) ||
    right.effective_end.getTime() - left.effective_end.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

async function selectionState(
  client: PoolClient,
  tenantId: string,
  flightId: string,
  evaluatedAt: string,
): Promise<SelectionState> {
  const organizationId = `organization:${tenantId}`;
  const revisions = (
    await client.query<{ accepted: string; projected: string }>(
      `SELECT COALESCE(MAX(a.accepted_revision),0) AS accepted,
       COALESCE(MAX(a.accepted_revision) FILTER(WHERE v.id IS NOT NULL),0) AS projected
       FROM organization_pack_adoptions a LEFT JOIN organization_pack_adoption_views v
       ON v.tenant_id=a.tenant_id AND v.id=a.id WHERE a.tenant_id=$1 AND a.organization_id=$2`,
      [tenantId, organizationId],
    )
  ).rows[0];
  const at = Date.parse(evaluatedAt);
  const adoptions = (
    await client.query<AdoptionRow>(
      `SELECT a.id,a.record,v.id IS NOT NULL AS projected,a.effective_start,${adoptionEndSql('a')} AS effective_end
       FROM organization_pack_adoptions a LEFT JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
       WHERE a.tenant_id=$1 AND a.organization_id=$2
        AND NOT EXISTS(SELECT 1 FROM organization_pack_adoptions r WHERE r.tenant_id=a.tenant_id AND r.revises_id=a.id)`,
      [tenantId, organizationId],
    )
  ).rows.filter((row) => flightRules(row.record).length);
  const candidate = [...adoptions].sort(selectionOrder(at))[0];
  const next = adoptions
    .flatMap((row) => [
      { at: row.effective_start, adoptionId: row.id, kind: 'start' as const },
      { at: row.effective_end, adoptionId: row.id, kind: 'end' as const },
    ])
    .filter((boundary) => boundary.at.getTime() > at)
    .sort(
      (left, right) =>
        left.at.getTime() - right.at.getTime() ||
        (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
        (left.adoptionId < right.adoptionId ? -1 : 1),
    )[0];
  const state = !candidate
    ? 'not_adopted'
    : !candidate.projected
      ? 'pending'
      : at < Date.parse(candidate.record.effectiveInterval.start)
        ? 'scheduled'
        : at >= Date.parse(candidate.record.effectiveInterval.end)
          ? 'expired'
          : 'eligible';
  return {
    version: 'flight.rule-selection.3',
    flightId,
    organizationId,
    adoptionRevision: Number(revisions.accepted),
    projectedAdoptionRevision: Number(revisions.projected),
    selection: { state, adoption: candidate ? adoptionReference(candidate.record) : null },
    execution: { status: state === 'eligible' ? 'active' : 'inactive', evaluator: { ...ruleEvaluatorReference } },
    nextBoundary: next ? { at: next.at.toISOString(), adoptionId: next.adoptionId, kind: next.kind } : null,
  };
}

async function retainedSelection(
  client: PoolClient,
  tenantId: string,
  flightId: string,
): Promise<FlightRuleSelectionRecord | null> {
  return (
    (
      await client.query<{ record: FlightRuleSelectionRecord }>(
        `SELECT r.record FROM flight_rule_selection_views v JOIN flight_rule_selections r
         ON r.tenant_id=v.tenant_id AND r.id=v.current_id WHERE v.tenant_id=$1 AND v.flight_id=$2`,
        [tenantId, flightId],
      )
    ).rows[0]?.record ?? null
  );
}

function convergence(
  retained: FlightRuleSelectionRecord | null,
  state: SelectionState,
  asOf: string,
): FlightRuleSelectionConvergence {
  const reason = !retained
    ? 'bootstrap'
    : retained.nextBoundary && retained.nextBoundary.at <= asOf
      ? 'boundary_due'
      : retained.selectionDigest !== canonicalDigest(state)
        ? 'organization_changed'
        : null;
  return { status: reason ? 'pending' : 'current', reason };
}

export async function enqueueRuleSelectionFanout(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  adoptionId: string,
  phase: 'accepted' | 'projected',
): Promise<void> {
  await client.query(
    `INSERT INTO selection_work(id,tenant_id,organization_id,kind,adoption_id,phase)
     VALUES($1,$2,$3,'adoption',$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), tenantId, organizationId, adoptionId, phase],
  );
}

export async function registerFlightOrganization(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  eventId: string,
): Promise<void> {
  const org = await organization(client, principal.tenantId, 'SHARE');
  await linkSubjectDependency(client, principal.tenantId, flightId, org.id, eventId);
  await client.query(
    `INSERT INTO selection_work(id,tenant_id,organization_id,kind,flight_id)
     VALUES($1,$2,$3,'refresh',$4) ON CONFLICT DO NOTHING`,
    [randomUUID(), principal.tenantId, org.id, flightId],
  );
}

export async function refreshFlightRuleSelection(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  options: { evaluatedAt?: string } = {},
): Promise<{ record: FlightRuleSelectionRecordV3; changed: boolean }> {
  const flight = (
    await client.query<{ basis_revision: string }>(
      'SELECT basis_revision FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [principal.tenantId, flightId],
    )
  ).rows[0];
  if (!flight) throw new DomainError(404, 'not_found', 'Flight was not found within your scope');
  const org = await organization(client, principal.tenantId, 'SHARE');
  const created = (
    await client.query<{ id: string }>(
      `SELECT e.id FROM streams s JOIN journal_events e ON e.tenant_id=s.tenant_id AND e.stream_id=s.id
       WHERE s.tenant_id=$1 AND s.name=$2 AND e.event_type='flight.created' ORDER BY e.stream_sequence LIMIT 1`,
      [principal.tenantId, `flight:${flightId}`],
    )
  ).rows[0];
  if (!created) throw new DomainError(409, 'flight_creation_missing', 'Retained flight creation is unavailable');
  await linkSubjectDependency(client, principal.tenantId, flightId, org.id, created.id);
  const evaluatedAt = options.evaluatedAt ?? (await clock(client));
  const state = await selectionState(client, principal.tenantId, flightId, evaluatedAt);
  if (state.nextBoundary)
    await client.query(
      `INSERT INTO selection_work(id,tenant_id,organization_id,kind,flight_id,adoption_id,due_at,available_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        principal.tenantId,
        org.id,
        state.nextBoundary.kind,
        flightId,
        state.nextBoundary.adoptionId,
        state.nextBoundary.at,
      ],
    );
  const selectionDigest = canonicalDigest(state);
  const retained = await retainedSelection(client, principal.tenantId, flightId);
  if (retained?.version === 'flight.rule-selection.3' && retained.selectionDigest === selectionDigest)
    return { record: retained, changed: false };
  const basis = await readSubjectEvidence(client, flightId, principal, { lock: true });
  const id = randomUUID();
  const record: FlightRuleSelectionRecordV3 = {
    ...state,
    id,
    clock: { mode: 'wall', evaluatedAt },
    renderedInputCut: { ...basis.rendered, basisRevision: Number(flight.basis_revision) },
    acceptedInputCut: { ...basis.accepted, basisRevision: Number(flight.basis_revision) },
    dependencyBasis: basis.dependencyBasis,
    basisManifest: basis.basisManifest,
    selectionDigest,
  };
  const event = await appendEvent(client, principal, {
    id,
    type: 'flight.rule-selection.recorded',
    stream: `rule-selection:${flightId}`,
    payload: { flightId, selection: record, declaredSubjects: [flightId] },
  });
  await client.query(
    `INSERT INTO flight_rule_selections(id,tenant_id,flight_id,selection_digest,record,recorded_at)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [id, principal.tenantId, flightId, selectionDigest, record, event.received_at],
  );
  await client.query(
    `INSERT INTO flight_rule_selection_views(tenant_id,flight_id,current_id) VALUES($1,$2,$3)
     ON CONFLICT(tenant_id,flight_id) DO UPDATE SET current_id=EXCLUDED.current_id`,
    [principal.tenantId, flightId, id],
  );
  await retainSubjectEvidence(client, principal.tenantId, [flightId], event);
  await client.query(
    `INSERT INTO projection_offsets(tenant_id,stream_id,sequence,projector_version) VALUES($1,$2,$3,'flight.rule-selection.3')
     ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence,projector_version=EXCLUDED.projector_version`,
    [principal.tenantId, event.stream_id, event.stream_sequence],
  );
  await client.query(
    "UPDATE work_items SET state='completed',completed_at=clock_timestamp() WHERE event_id=$1 AND state='pending' AND generation=0",
    [id],
  );
  await client.query('UPDATE flight_views SET revision=revision+1,basis_revision=basis_revision+1 WHERE id=$1', [
    flightId,
  ]);
  await client.query('INSERT INTO view_changes(tenant_id,flight_id,event_id) VALUES($1,$2,$3)', [
    principal.tenantId,
    flightId,
    id,
  ]);
  await appendLiveChange(client, principal.tenantId, flightId, id, 'flight.updated');
  return { record, changed: true };
}

export async function getFlightRuleSelection(client: PoolClient, principal: AuthContext, flightId: string) {
  const found = await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2', [
    principal.tenantId,
    flightId,
  ]);
  if (!found.rowCount) throw new DomainError(404, 'not_found', 'Flight was not found within your scope');
  const asOf = await clock(client);
  const state = await selectionState(client, principal.tenantId, flightId, asOf);
  const selection = await retainedSelection(client, principal.tenantId, flightId);
  return { selection, asOf, convergence: convergence(selection, state, asOf) };
}

export async function getFlightRuleSelectionRecord(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  selectionId: string,
): Promise<FlightRuleSelectionRecord> {
  const selection = (
    await client.query<{ record: FlightRuleSelectionRecord }>(
      'SELECT record FROM flight_rule_selections WHERE tenant_id=$1 AND flight_id=$2 AND id=$3',
      [principal.tenantId, flightId, selectionId],
    )
  ).rows[0]?.record;
  if (!selection) throw new DomainError(404, 'not_found', 'Rule selection was not found within this flight');
  return selection;
}

export async function validateFlightRuleSelection(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
): Promise<void> {
  const asOf = await clock(client);
  const state = await selectionState(client, principal.tenantId, flightId, asOf);
  if (state.selection.state === 'not_adopted') return;
  const retained = await retainedSelection(client, principal.tenantId, flightId);
  // A flight not yet selected for has nothing to pin; its first selection is recorded by the selection worker.
  if (!retained) return;
  if (convergence(retained, state, asOf).status !== 'current')
    throw new DomainError(409, 'stale_basis', 'Rule selection changed; refresh after selection work converges');
}
