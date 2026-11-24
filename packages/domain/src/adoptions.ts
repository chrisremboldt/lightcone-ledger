import { randomUUID } from 'node:crypto';
import { startAdoptionQueueing } from './adoption-queueing.js';
import { dueRuleEvaluationWorkSql, lockAdoptedRules, organizationIdOf } from './rule-evaluations.js';
import { adoptionStands } from '@ledger/contracts';
import type {
  AdoptionMode,
  CommandRecord,
  OrganizationCoverageResponse,
  PackAdoptionAcceptance,
  PackAdoptionCommand,
  PackAdoptionRecord,
  RulePackVersion,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { adoptionParameterProblem } from './checked-rules.js';
import { lockProjectionSubjects, readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import { getRulePackVersion, rulePackOrigin } from './rule-pack-registry.js';
import { enqueueRuleSelectionFanout } from './rule-selections.js';

interface OrganizationRow {
  id: string;
  label: string;
  revision: string;
  projected_revision: string;
}
interface AdoptionRow {
  record: PackAdoptionAcceptance;
  mode: AdoptionMode;
  projected: boolean;
  work_state: string | null;
  revised_by: string | null;
  revision_projected: boolean;
  successor: { id: string; version: number; start: string } | null;
  successor_projected: boolean;
}
interface RevisedRow {
  record: PackAdoptionAcceptance;
  mode: AdoptionMode;
  revised: boolean;
  succeeded: boolean;
  /** It, or an adoption it revises, succeeds an earlier version. */
  successor: boolean;
}
interface PrincipalRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: string;
  capabilities: string[];
  revision: string;
}
interface VersionReference {
  id: string;
  version: number;
  digest: string;
}

const COVERAGE_LIMIT = 100;

/**
 * The tenant's organization row. A command locks it (`SHARE` to read a basis, `UPDATE` to change it); a read at
 * REPEATABLE READ passes `NONE`, since its snapshot already gives it one consistent view and a lock there only turns a
 * concurrent change of the row into a serialization failure.
 */
export async function organization(
  client: PoolClient,
  tenantId: string,
  lock: 'SHARE' | 'UPDATE' | 'NONE',
): Promise<OrganizationRow> {
  const row = (
    await client.query<OrganizationRow>(
      `SELECT o.id,t.name AS label,o.revision,o.projected_revision FROM organizations o
       JOIN tenants t ON t.id=o.tenant_id WHERE o.tenant_id=$1 AND o.id=$2${lock === 'NONE' ? '' : ` FOR ${lock} OF o`}`,
      [tenantId, `organization:${tenantId}`],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'organization_not_found', 'Organization was not found within your scope');
  return row;
}

function utcTime(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}

function sameReferences(supplied: VersionReference[], retained: VersionReference[]): boolean {
  const digests = (references: VersionReference[]) =>
    references.map(({ id, version, digest }) => canonicalDigest({ id, version, digest })).sort();
  return canonicalDigest(digests(supplied)) === canonicalDigest(digests(retained));
}

function retainedPack(command: PackAdoptionCommand): RulePackVersion {
  const pack = getRulePackVersion(command.pack.packId, command.pack.version);
  if (!pack) throw new DomainError(404, 'rule_pack_not_found', 'The exact rule pack version is unavailable');
  if (
    command.pack.digest !== pack.digest ||
    !sameReferences(command.pack.leaves, pack.leaves) ||
    !sameReferences(command.pack.bindings, pack.bindings)
  )
    throw new DomainError(
      400,
      'invalid_pack_reference',
      'Adoption must identify every exact retained leaf and binding',
    );
  return pack;
}

function modeProblem(pack: RulePackVersion, mode: AdoptionMode): string | undefined {
  if (mode === 'active' && pack.leaves.some((leaf) => leaf.source.kind === 'proposed_regulation'))
    return 'This pack cites proposed rule text, which is not in force. It can only be adopted in shadow, where its findings are recorded but not counted.';
  // Rules bound to the built-in flight evaluator record no adoption mode, so their findings could not be kept apart.
  if (mode === 'shadow' && pack.leaves.some((leaf) => 'bindingId' in leaf))
    return 'This pack has rules the built-in flight evaluator runs, which cannot record findings in shadow. Adopt it as active.';
  return undefined;
}

function sameInterval(left: PackAdoptionCommand['effectiveInterval'], right: PackAdoptionCommand['effectiveInterval']) {
  return Date.parse(left.start) === Date.parse(right.start) && Date.parse(left.end) === Date.parse(right.end);
}

/**
 * SQL for the instant an adoption stops being in effect: the end of its own interval, or the start of the adoption
 * that succeeds it when that comes first. `alias` names the adoption row.
 */
export function adoptionEndSql(alias: string): string {
  return `LEAST(${alias}.effective_end,(SELECT successor.effective_start FROM organization_pack_adoptions successor
    WHERE successor.tenant_id=${alias}.tenant_id AND successor.succeeds_id=${alias}.id))`;
}

/**
 * The adoption a command names to revise or succeed, with whether a later adoption already revised or succeeded it,
 * and whether it or an adoption it revises succeeds an earlier version: then its start is where that version ends.
 */
async function namedAdoption(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  id: string,
): Promise<RevisedRow | undefined> {
  return (
    await client.query<RevisedRow>(
      `WITH RECURSIVE revised_chain(id,revises_id,succeeds_id) AS (
         SELECT id,revises_id,succeeds_id FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=$3
         UNION ALL SELECT p.id,p.revises_id,p.succeeds_id FROM organization_pack_adoptions p
         JOIN revised_chain c ON p.tenant_id=$1 AND p.id=c.revises_id)
       SELECT a.record,a.mode,EXISTS(SELECT 1 FROM organization_pack_adoptions r
         WHERE r.tenant_id=a.tenant_id AND r.revises_id=a.id) AS revised,
       EXISTS(SELECT 1 FROM organization_pack_adoptions s WHERE s.tenant_id=a.tenant_id AND s.succeeds_id=a.id) AS succeeded,
       EXISTS(SELECT 1 FROM revised_chain WHERE succeeds_id IS NOT NULL) AS successor
       FROM organization_pack_adoptions a WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.id=$3`,
      [tenantId, organizationId, id],
    )
  ).rows[0];
}

/**
 * A revision holds the exact pack of the latest adoption it names with a new mode, new dates or new values, and
 * replaces it whole. A revision of an adoption that succeeds an earlier version keeps its start, where that version
 * ends.
 */
async function checkRevision(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  command: PackAdoptionCommand,
): Promise<void> {
  if (command.revises === undefined) return;
  const revised = await namedAdoption(client, tenantId, organizationId, command.revises);
  if (!revised) throw new DomainError(404, 'adoption_not_found', 'The adoption to revise was not found');
  if (revised.revised)
    throw new DomainError(
      409,
      'adoption_already_revised',
      'That adoption already has a later revision; revise that one',
    );
  if (revised.succeeded)
    throw new DomainError(
      409,
      'adoption_succeeded',
      'A later version of the pack succeeds that adoption; revise the successor instead',
    );
  const pack = revised.record.pack;
  if (
    pack.packId !== command.pack.packId ||
    pack.version !== command.pack.version ||
    pack.digest !== command.pack.digest
  )
    throw new DomainError(
      400,
      'invalid_adoption_revision',
      `A revision keeps the exact pack version of the adoption it revises, ${pack.packId} version ${pack.version}; a later version succeeds it instead`,
    );
  const sameDates = sameInterval(revised.record.effectiveInterval, command.effectiveInterval);
  if (
    revised.mode === command.mode &&
    sameDates &&
    canonicalDigest(revised.record.parameters ?? null) === canonicalDigest(command.parameters ?? null)
  )
    throw new DomainError(
      400,
      'adoption_unchanged',
      'That revision changes nothing: it gives the same mode, dates and values as the adoption it revises',
    );
  if (
    revised.successor &&
    Date.parse(revised.record.effectiveInterval.start) !== Date.parse(command.effectiveInterval.start)
  )
    throw new DomainError(
      400,
      'invalid_adoption_revision',
      `That adoption succeeds an earlier version of the pack, which ends where it starts (${revised.record.effectiveInterval.start}); a revision keeps that start`,
    );
}

/**
 * A successor adopts a higher version of the pack of the latest adoption it names, from a start inside that adoption's
 * interval; the adoption it succeeds ends there. A successor that starts at or before that adoption's start and ends at
 * or after its end replaces it for its whole period, so it is in effect at no instant (docs/design/rule-coverage.md).
 * Nothing recorded about the earlier adoption changes.
 */
async function checkSuccession(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  command: PackAdoptionCommand,
): Promise<void> {
  if (command.succeeds === undefined) return;
  const succeeded = await namedAdoption(client, tenantId, organizationId, command.succeeds);
  if (!succeeded) throw new DomainError(404, 'adoption_not_found', 'The adoption to succeed was not found');
  if (succeeded.revised)
    throw new DomainError(
      409,
      'adoption_already_revised',
      'That adoption already has a later revision; succeed that one',
    );
  if (succeeded.succeeded)
    throw new DomainError(409, 'adoption_already_succeeded', 'A later version already succeeds that adoption');
  const earlier = succeeded.record;
  if (earlier.pack.packId !== command.pack.packId || command.pack.version <= earlier.pack.version)
    throw new DomainError(
      400,
      'invalid_adoption_successor',
      `A successor adopts a higher version of the same pack; that adoption holds ${earlier.pack.packId} version ${earlier.pack.version}`,
    );
  const start = Date.parse(command.effectiveInterval.start);
  const end = Date.parse(command.effectiveInterval.end);
  const earlierStart = Date.parse(earlier.effectiveInterval.start);
  const earlierEnd = Date.parse(earlier.effectiveInterval.end);
  if (start >= earlierEnd)
    throw new DomainError(
      400,
      'invalid_adoption_successor',
      'A successor starts before the end of the adoption it succeeds: after its start, to take over from then, or at or before its start, to replace it for its whole period',
    );
  if (start <= earlierStart && end < earlierEnd)
    throw new DomainError(
      400,
      'invalid_adoption_successor',
      `A successor that starts at or before the start of the adoption it succeeds replaces it for its whole period, so it ends at or after that adoption's end (${earlier.effectiveInterval.end})`,
    );
}

export async function acceptPackAdoption(
  client: PoolClient,
  principal: AuthContext,
  command: PackAdoptionCommand,
): Promise<CommandRecord> {
  const actor = (
    await client.query<PrincipalRow>(
      'SELECT id,tenant_id,name,kind,capabilities,revision FROM principals WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE',
      [principal.tenantId, principal.id],
    )
  ).rows[0];
  if (!actor) throw new DomainError(403, 'principal_inactive', 'Principal no longer has access');
  if (!actor.capabilities.includes('pack:adopt'))
    throw new DomainError(403, 'capability_required', 'Capability pack:adopt is required');
  if (actor.kind !== 'human')
    throw new DomainError(
      403,
      'person_required',
      `Adopting a rule pack, and revising or succeeding an adoption, is a person's decision. This credential belongs to ${actor.kind === 'source' ? 'a source' : actor.kind === 'service' ? 'a service' : 'something other than a person'}; the person who decides adopts with their own credential and their own reason.`,
    );
  const current: AuthContext = {
    id: actor.id,
    tenantId: actor.tenant_id,
    name: actor.name,
    kind: actor.kind,
    capabilities: actor.capabilities,
    revision: Number(actor.revision),
  };
  const pack = retainedPack(command);
  const parameterProblem = adoptionParameterProblem(pack, command.parameters);
  if (parameterProblem) throw new DomainError(400, 'invalid_adoption_parameters', parameterProblem);
  if (command.mode !== 'shadow' && command.mode !== 'active')
    throw new DomainError(400, 'invalid_adoption_mode', 'Adoption requires a mode: shadow or active');
  const mode = modeProblem(pack, command.mode);
  if (mode) throw new DomainError(400, 'adoption_mode_refused', mode);
  const start = utcTime(command.effectiveInterval.start);
  const end = utcTime(command.effectiveInterval.end);
  if (start === undefined || end === undefined || end <= start)
    throw new DomainError(
      400,
      'invalid_effective_interval',
      'Adoption requires a finite UTC interval with its end after its start',
    );
  const org = await organization(client, current.tenantId, 'UPDATE');
  const revision = Number(org.revision);
  const evidence = await readSubjectEvidence(client, org.id, current, { lock: true, decision: true });
  if (
    command.expectedRevision !== revision ||
    command.inputCut.principalRevision !== current.revision ||
    (command.inputCut.basisRevision !== undefined && command.inputCut.basisRevision !== revision) ||
    command.expectedDependencyBasis !== evidence.dependencyBasis ||
    canonicalDigest(command.inputCut.streams) !== canonicalDigest(evidence.rendered.streams)
  )
    throw new DomainError(
      409,
      'stale_basis',
      'Organization information or authority changed; refresh the adoption basis',
    );
  if (command.revises !== undefined && command.succeeds !== undefined)
    throw new DomainError(
      400,
      'invalid_adoption_successor',
      'An adoption either revises another or succeeds it, not both',
    );
  await checkRevision(client, current.tenantId, org.id, command);
  await checkSuccession(client, current.tenantId, org.id, command);
  const overlap = await client.query(
    `SELECT a.id FROM organization_pack_adoptions a WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.pack_id=$3
     AND a.effective_start<$5::timestamptz AND ${adoptionEndSql('a')}>$4::timestamptz AND a.id IS DISTINCT FROM $6
     AND NOT EXISTS(SELECT 1 FROM organization_pack_adoptions r WHERE r.tenant_id=a.tenant_id AND r.revises_id=a.id)
     LIMIT 1`,
    [
      current.tenantId,
      org.id,
      pack.packId,
      command.effectiveInterval.start,
      command.effectiveInterval.end,
      command.revises ?? command.succeeds ?? null,
    ],
  );
  if (overlap.rowCount)
    throw new DomainError(
      409,
      'adoption_interval_overlap',
      'This rule pack already has an adoption during that interval',
    );
  const acceptance: Omit<PackAdoptionAcceptance, 'id' | 'acceptedAt'> = {
    organizationId: org.id,
    acceptedRevision: revision + 1,
    actor: {
      id: current.id,
      name: current.name,
      kind: actor.kind,
      principalRevision: current.revision,
      capabilities: [...current.capabilities],
      checkedCapabilities: ['pack:adopt'],
      policyVersion: 'ledger.pack-adoption-authority.1',
    },
    pack,
    scope: { kind: 'organization', organizationId: org.id },
    effectiveInterval: { ...command.effectiveInterval },
    note: command.note,
    ...(command.parameters ? { parameters: structuredClone(command.parameters) } : {}),
    mode: command.mode,
    ...(command.revises ? { revises: command.revises } : {}),
    ...(command.succeeds ? { succeeds: command.succeeds } : {}),
    renderedInputCut: { ...evidence.rendered, basisRevision: revision },
    acceptedInputCut: { ...evidence.accepted, basisRevision: revision },
    dependencyBasis: evidence.dependencyBasis,
  };
  const event = await appendEvent(client, current, {
    id: randomUUID(),
    type: command.kind,
    stream: org.id,
    payload: { ...command, acceptance },
  });
  const record: PackAdoptionAcceptance = { ...acceptance, id: event.id, acceptedAt: event.received_at.toISOString() };
  await client.query(
    `INSERT INTO organization_pack_adoptions(id,tenant_id,organization_id,accepted_revision,pack_id,effective_start,
       effective_end,mode,revises_id,succeeds_id,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      event.id,
      current.tenantId,
      org.id,
      record.acceptedRevision,
      pack.packId,
      record.effectiveInterval.start,
      record.effectiveInterval.end,
      command.mode,
      command.revises ?? null,
      command.succeeds ?? null,
      record,
    ],
  );
  await client.query('UPDATE organizations SET revision=$1 WHERE tenant_id=$2 AND id=$3', [
    record.acceptedRevision,
    current.tenantId,
    org.id,
  ]);
  await retainSubjectEvidence(client, current.tenantId, [org.id], event);
  await enqueueRuleSelectionFanout(client, current.tenantId, org.id, event.id, 'accepted');
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

export async function projectPackAdoption(client: PoolClient, event: JournalEvent): Promise<void> {
  if (event.event_type !== 'rule-pack.adopt')
    throw new DomainError(400, 'invalid_adoption_event', 'Only a pack adoption can update organization coverage');
  // Before anything is written: queueing that read the adopted rules finishes first, and queueing that starts after
  // waits for this commit and then sees the adoption, whose own pages read what that queueing's records hold.
  await lockAdoptedRules(client, event.tenant_id, 'exclusive');
  const org = await organization(client, event.tenant_id, 'UPDATE');
  // The projection's subjects come after the organization row and before anything it writes.
  await lockProjectionSubjects(client);
  const row = (
    await client.query<{ record: PackAdoptionAcceptance }>(
      'SELECT record FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=$2 AND organization_id=$3',
      [event.tenant_id, event.id, org.id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(409, 'adoption_acceptance_missing', 'The immutable adoption acceptance is unavailable');
  const { id, acceptedAt, ...acceptance } = row.record;
  if (
    id !== event.id ||
    acceptedAt !== event.received_at.toISOString() ||
    canonicalDigest(acceptance) !== canonicalDigest(event.payload.acceptance)
  )
    throw new DomainError(
      409,
      'adoption_commitment_mismatch',
      'Adoption acceptance differs from its immutable journal event',
    );
  await client.query(
    `INSERT INTO organization_pack_adoption_views(id,tenant_id,organization_id,accepted_revision)
     VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [id, event.tenant_id, org.id, row.record.acceptedRevision],
  );
  await client.query(
    'UPDATE organizations SET projected_revision=GREATEST(projected_revision,$1) WHERE tenant_id=$2 AND id=$3',
    [row.record.acceptedRevision, event.tenant_id, org.id],
  );
  await enqueueRuleSelectionFanout(client, event.tenant_id, org.id, event.id, 'projected');
  await startAdoptionQueueing(client, event.tenant_id, { id: event.id, record: row.record });
}

function adoptionView(row: AdoptionRow, asOf: string): PackAdoptionRecord {
  const state = !row.projected
    ? 'pending'
    : row.revision_projected
      ? 'revised'
      : row.successor &&
          row.successor_projected &&
          (Date.parse(asOf) >= Date.parse(row.successor.start) ||
            Date.parse(row.successor.start) <= Date.parse(row.record.effectiveInterval.start))
        ? 'succeeded'
        : Date.parse(asOf) < Date.parse(row.record.effectiveInterval.start)
          ? 'scheduled'
          : Date.parse(asOf) >= Date.parse(row.record.effectiveInterval.end)
            ? 'expired'
            : 'effective';
  return {
    ...row.record,
    mode: row.mode,
    ...(row.revised_by ? { revisedBy: row.revised_by } : {}),
    ...(row.successor ? { succeededBy: row.successor } : {}),
    processing: { status: row.projected ? 'projected' : row.work_state === 'failed' ? 'failed' : 'pending' },
    state,
    coverage: row.record.pack.leaves.map((leaf) => ({
      leafId: leaf.id,
      coverage: leaf.coverage,
      evidenceState:
        leaf.coverage === 'manual'
          ? 'manual_review_required'
          : leaf.coverage === 'unsupported'
            ? 'unsupported'
            : 'inactive',
    })),
  };
}

/** Where each registered pack version the adoptions name came from, once per version. */
function packOrigins(
  adoptions: OrganizationCoverageResponse['adoptions'],
): OrganizationCoverageResponse['packOrigins'] {
  const seen = new Set<string>();
  return adoptions.flatMap(({ pack: { packId, version } }) => {
    const origin = rulePackOrigin(packId, version);
    if (!origin || seen.has(`${packId}@${version}`)) return [];
    seen.add(`${packId}@${version}`);
    return [{ packId, version, origin }];
  });
}

/**
 * The organization's adoptions with what a reader needs to say their state as of the instant: those in effect then
 * first, then the latest accepted, at most `limit` when one is given.
 */
async function adoptionRows(
  client: PoolClient,
  tenantId: string,
  organizationId: string,
  asOf: string,
  limit: number | null,
): Promise<AdoptionRow[]> {
  const rows = await client.query<AdoptionRow>(
    `SELECT a.record,a.mode,v.id IS NOT NULL AS projected,w.state AS work_state,r.id AS revised_by,
       rv.id IS NOT NULL AS revision_projected,
       CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('id',s.id,'version',(s.record->'pack'->>'version')::integer,
         'start',s.record->'effectiveInterval'->>'start') END AS successor,
       sv.id IS NOT NULL AS successor_projected FROM organization_pack_adoptions a
     LEFT JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
     LEFT JOIN work_items w ON w.tenant_id=a.tenant_id AND w.event_id=a.id
     LEFT JOIN organization_pack_adoptions r ON r.tenant_id=a.tenant_id AND r.revises_id=a.id
     LEFT JOIN organization_pack_adoption_views rv ON rv.tenant_id=r.tenant_id AND rv.id=r.id
     LEFT JOIN organization_pack_adoptions s ON s.tenant_id=a.tenant_id AND s.succeeds_id=a.id
     LEFT JOIN organization_pack_adoption_views sv ON sv.tenant_id=s.tenant_id AND sv.id=s.id
     WHERE a.tenant_id=$1 AND a.organization_id=$2
     ORDER BY (v.id IS NOT NULL AND a.effective_start<=$4::timestamptz AND ${adoptionEndSql('a')}>$4::timestamptz) DESC,
       a.accepted_revision DESC LIMIT $3`,
    [tenantId, organizationId, limit, asOf],
  );
  return rows.rows;
}

/**
 * The adoptions that stand as of the instant, for every reader that lists what the organization has adopted:
 * projected, neither revised nor succeeded (so one a later version replaced from its first day is never among them),
 * and not ended. In order of pack, then highest version first.
 */
export async function standingAdoptionRecords(
  client: PoolClient,
  tenantId: string,
  asOf: string,
): Promise<PackAdoptionRecord[]> {
  const rows = await adoptionRows(client, tenantId, organizationIdOf(tenantId), asOf, null);
  return rows
    .map((row) => adoptionView(row, asOf))
    .filter((adoption) => adoptionStands(adoption) && adoption.state !== 'pending' && adoption.state !== 'expired')
    .sort(
      (a, b) =>
        (a.pack.packId < b.pack.packId ? -1 : a.pack.packId > b.pack.packId ? 1 : 0) ||
        b.pack.version - a.pack.version ||
        b.acceptedRevision - a.acceptedRevision,
    );
}

export async function getOrganizationCoverage(
  client: PoolClient,
  principal: AuthContext,
): Promise<OrganizationCoverageResponse> {
  const org = await organization(client, principal.tenantId, 'NONE');
  const evidence = await readSubjectEvidence(client, org.id, principal, { decision: true });
  const clock = (
    await client.query<{ now: Date; projection_revision: string; outstanding: string }>(
      `SELECT clock_timestamp() AS now,(SELECT COALESCE(MAX(id),0)::text FROM view_changes) AS projection_revision,
       ((SELECT COUNT(*) FROM work_items WHERE state<>'completed')+${dueRuleEvaluationWorkSql()})::text AS outstanding`,
    )
  ).rows[0];
  const asOf = clock.now.toISOString();
  const rows = await adoptionRows(client, principal.tenantId, org.id, asOf, COVERAGE_LIMIT + 1);
  const adoptions = rows.slice(0, COVERAGE_LIMIT).map((row) => adoptionView(row, asOf));
  return {
    organization: {
      id: org.id,
      label: org.label,
      revision: Number(org.revision),
      projectedRevision: Number(org.projected_revision),
    },
    asOf,
    adoptions,
    packOrigins: packOrigins(adoptions),
    limit: COVERAGE_LIMIT,
    hasOlder: rows.length > COVERAGE_LIMIT,
    meta: {
      requestId: '',
      projectionRevision: Number(clock.projection_revision),
      inputCut: { ...evidence.rendered, basisRevision: Number(org.revision) },
      dependencyBasis: evidence.dependencyBasis,
      computedAt: asOf,
      outstandingWork: Number(clock.outstanding),
    },
  };
}
