import type { InputCut, SubjectBasisManifest } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { DomainError, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { RECORDS_ON_FILE_SOURCE } from './records-on-file-source.js';

type EvidenceEvent = Pick<JournalEvent, 'id' | 'stream_id' | 'stream_sequence'>;
interface EvidenceFrontier {
  subjectId: string;
  streamId: string;
  sequence: number;
  projectedSequence: number;
}
interface EvidenceState {
  subjects: string[];
  edges: { subjectId: string; dependencySubjectId: string; eventId: string }[];
  frontiers: EvidenceFrontier[];
  authority: { streamId: string; sequence: number; projectedSequence: number } | null;
}
export interface SubjectEvidence {
  rendered: InputCut;
  accepted: InputCut;
  dependencyBasis: string;
  basisManifest: SubjectBasisManifest;
}

/** The event a connection is projecting, and the subjects its projection has locked once it has locked any. */
interface ProjectionSubjects {
  event: Pick<JournalEvent, 'tenant_id' | 'stream_id' | 'stream_sequence'>;
  held: Set<string> | null;
}
const projections = new WeakMap<PoolClient, ProjectionSubjects>();

/**
 * Marks the connection as projecting the event until `endProjectionSubjects`. Its first subject lock then takes, in
 * one statement in id order, the subjects asked for and every subject that retained the event's stream at or after
 * the event. A later subject lock of the projection finds its rows already held, or created by the projection itself:
 * a projection takes subjects once and never comes back to them.
 */
export function beginProjectionSubjects(
  client: PoolClient,
  event: Pick<JournalEvent, 'tenant_id' | 'stream_id' | 'stream_sequence'>,
): void {
  projections.set(client, { event, held: null });
}

export function endProjectionSubjects(client: PoolClient): void {
  projections.delete(client);
}

/** The projection's subjects, if no step of it has locked a subject yet. */
export async function lockProjectionSubjects(client: PoolClient): Promise<void> {
  const projection = projections.get(client);
  if (projection && !projection.held) await lockSubjects(client, projection.event.tenant_id, [], 'UPDATE');
}

/** Locks Ledger subjects' rows in id order. */
export async function lockSubjects(
  client: PoolClient,
  tenantId: string,
  subjectIds: string[],
  mode: 'SHARE' | 'UPDATE',
): Promise<void> {
  const ids = [...new Set(subjectIds)];
  const projection = projections.get(client);
  if (projection && !projection.held) {
    const { event } = projection;
    const locked = await client.query<{ id: string }>(
      `SELECT s.id FROM subjects s WHERE s.tenant_id=$1 AND (s.id=ANY($2::text[]) OR EXISTS(
         SELECT 1 FROM subject_stream_dependencies d WHERE d.tenant_id=s.tenant_id AND d.subject_id=s.id
         AND d.stream_id=$3 AND d.sequence>=$4))
       ORDER BY s.id COLLATE "C" FOR UPDATE`,
      [event.tenant_id, ids, event.stream_id, event.stream_sequence],
    );
    projection.held = new Set(locked.rows.map((row) => row.id));
    if (ids.some((id) => !projection.held!.has(id)))
      throw new DomainError(404, 'subject_not_found', 'Evidence subject was not found within your scope');
    return;
  }
  if (!ids.length) return;
  const subjects = await client.query<{ id: string }>(
    `SELECT id FROM subjects WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id COLLATE "C" FOR ${mode}`,
    [tenantId, ids],
  );
  if (subjects.rows.length !== ids.length)
    throw new DomainError(404, 'subject_not_found', 'Evidence subject was not found within your scope');
}

export async function retainSubjectEvidence(
  client: PoolClient,
  tenantId: string,
  subjectIds: string[],
  event: EvidenceEvent,
): Promise<void> {
  const ids = [...new Set(subjectIds)].sort();
  if (!ids.length) return;
  await lockSubjects(client, tenantId, ids, 'UPDATE');
  await client.query(
    `INSERT INTO subject_stream_dependencies(tenant_id,subject_id,stream_id,sequence,event_id)
     SELECT $1,id,$3,$4,$5 FROM unnest($2::text[]) AS id
     ON CONFLICT(tenant_id,subject_id,stream_id) DO UPDATE
     SET sequence=EXCLUDED.sequence,event_id=EXCLUDED.event_id
     WHERE EXCLUDED.sequence>subject_stream_dependencies.sequence`,
    [tenantId, ids, event.stream_id, event.stream_sequence, event.id],
  );
}

export async function linkSubjectDependency(
  client: PoolClient,
  tenantId: string,
  subjectId: string,
  dependencySubjectId: string,
  eventId: string,
): Promise<void> {
  const event = (
    await client.query<EvidenceEvent>(
      'SELECT id,stream_id,stream_sequence FROM journal_events WHERE tenant_id=$1 AND id=$2',
      [tenantId, eventId],
    )
  ).rows[0];
  if (!event)
    throw new DomainError(404, 'dependency_event_not_found', 'Dependency evidence was not found within your scope');
  await retainSubjectEvidence(client, tenantId, [subjectId], event);
  const dependency = await client.query('SELECT 1 FROM subjects WHERE tenant_id=$1 AND id=$2', [
    tenantId,
    dependencySubjectId,
  ]);
  if (!dependency.rowCount)
    throw new DomainError(404, 'subject_not_found', 'Dependency subject was not found within your scope');
  await client.query(
    `INSERT INTO subject_dependencies(tenant_id,subject_id,dependency_subject_id,event_id)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [tenantId, subjectId, dependencySubjectId, eventId],
  );
}

const evidenceStateSql = `WITH RECURSIVE dependency_subjects(id) AS (
  SELECT id FROM subjects WHERE tenant_id=$1 AND id=$2
  UNION
  SELECT d.dependency_subject_id FROM subject_dependencies d
  JOIN dependency_subjects parent ON parent.id=d.subject_id WHERE d.tenant_id=$1
), frontiers AS (
  SELECT d.subject_id,d.stream_id,d.sequence,LEAST(d.sequence,COALESCE(p.sequence,0)) AS projected_sequence
  FROM dependency_subjects subject JOIN subject_stream_dependencies d ON d.subject_id=subject.id AND d.tenant_id=$1
  LEFT JOIN projection_offsets p ON p.tenant_id=d.tenant_id AND p.stream_id=d.stream_id
), authority AS (
  SELECT s.id,s.sequence,COALESCE(p.sequence,0) AS projected_sequence
  FROM streams s LEFT JOIN projection_offsets p ON p.tenant_id=s.tenant_id AND p.stream_id=s.id
  WHERE s.tenant_id=$1 AND s.name=$3
)
SELECT
  COALESCE((SELECT array_agg(id ORDER BY id COLLATE "C") FROM dependency_subjects),'{}') AS subjects,
  COALESCE((SELECT json_agg(json_build_object('subjectId',d.subject_id,'dependencySubjectId',d.dependency_subject_id,'eventId',d.event_id)
    ORDER BY d.subject_id COLLATE "C",d.dependency_subject_id COLLATE "C")
    FROM subject_dependencies d JOIN dependency_subjects parent ON parent.id=d.subject_id WHERE d.tenant_id=$1),'[]') AS edges,
  COALESCE((SELECT json_agg(json_build_object('subjectId',subject_id,'streamId',stream_id,'sequence',sequence,'projectedSequence',projected_sequence)
    ORDER BY subject_id COLLATE "C",stream_id COLLATE "C") FROM frontiers),'[]') AS frontiers,
  (SELECT json_build_object('streamId',id,'sequence',sequence,'projectedSequence',projected_sequence) FROM authority) AS authority`;

/**
 * Locks a subject's basis closure in id order: the subject itself in `own` mode, the rest `FOR SHARE`, one statement
 * for the ids before the subject, one for the subject and one for the ids after it (a statement takes one lock
 * strength). An edge commits only once its subject is locked `FOR UPDATE`, so the closure read again after the
 * locks are held is final. If it grew meanwhile, the new subjects may sort before ones already held: the round's
 * locks are released by rolling back to a savepoint, and the larger closure is locked again from the start, so the
 * locks are always taken in id order.
 */
async function lockClosure(
  client: PoolClient,
  principal: AuthContext,
  subjectId: string,
  own: 'SHARE' | 'UPDATE',
): Promise<EvidenceState> {
  const load = async () =>
    (await client.query<EvidenceState>(evidenceStateSql, [principal.tenantId, subjectId, `authority:${principal.id}`]))
      .rows[0]!;
  let state = await load();
  while (state.subjects.length) {
    await client.query('SAVEPOINT ledger_subject_closure');
    const lock = (mode: 'SHARE' | 'UPDATE', where = '', ...beside: string[]) =>
      client.query(
        `SELECT id FROM subjects WHERE tenant_id=$1 AND id=ANY($2::text[])${where} ORDER BY id COLLATE "C" FOR ${mode}`,
        [principal.tenantId, state.subjects, ...beside],
      );
    if (own === 'SHARE') await lock('SHARE');
    else {
      await lock('SHARE', ' AND id COLLATE "C"<$3', subjectId);
      await lock('UPDATE', ' AND id=$3', subjectId);
      await lock('SHARE', ' AND id COLLATE "C">$3', subjectId);
    }
    const locked = state;
    state = await load();
    if (state.subjects.every((id) => locked.subjects.includes(id))) {
      await client.query('RELEASE SAVEPOINT ledger_subject_closure');
      return state;
    }
    await client.query('ROLLBACK TO SAVEPOINT ledger_subject_closure');
    await client.query('RELEASE SAVEPOINT ledger_subject_closure');
  }
  return state;
}

/**
 * Locks a subject `FOR UPDATE` and the other subjects of its basis closure `FOR SHARE`, together in id order, so a
 * command that changes the subject holds every subject it rests on before any record.
 */
export async function lockSubjectAndClosure(
  client: PoolClient,
  principal: AuthContext,
  subjectId: string,
): Promise<void> {
  await lockClosure(client, principal, subjectId, 'UPDATE');
}

/**
 * The frontiers a person's decision rests on (docs/design/decision-basis.md): the closure's frontiers without the
 * organization's own rule evaluations and Ledger's records of what is on file. Neither is evidence about a flight, a
 * finding, a safety record or an adoption, and no decision shows either as what it decides on: a decision that rests on
 * an evaluation cites that evaluation itself.
 */
async function decisionFrontiers(
  client: PoolClient,
  tenantId: string,
  frontiers: EvidenceFrontier[],
): Promise<EvidenceFrontier[]> {
  if (!frontiers.length) return frontiers;
  const derived = await client.query<{ id: string; evaluation: boolean }>(
    `SELECT s.id,s.name LIKE 'rule-evaluation:%' AS evaluation FROM streams s
     WHERE s.tenant_id=$1 AND s.id=ANY($2::text[]) AND (s.name LIKE 'rule-evaluation:%' OR NOT EXISTS(
       SELECT 1 FROM journal_events e WHERE e.tenant_id=s.tenant_id AND e.stream_id=s.id
       AND e.source_id IS DISTINCT FROM $3))`,
    [tenantId, [...new Set(frontiers.map((frontier) => frontier.streamId))], RECORDS_ON_FILE_SOURCE],
  );
  const onFile = new Set(derived.rows.filter((row) => !row.evaluation).map((row) => row.id));
  const evaluations = new Set(derived.rows.filter((row) => row.evaluation).map((row) => row.id));
  const organization = `organization:${tenantId}`;
  return frontiers.filter(
    (frontier) =>
      !onFile.has(frontier.streamId) && !(frontier.subjectId === organization && evaluations.has(frontier.streamId)),
  );
}

/**
 * A subject's evidence basis: its dependency closure, the frontier of each stream its subjects retain, and the cuts
 * those make. With `decision`, the basis is the one a person's decision rests on (`decisionFrontiers`); without it,
 * the whole closure, as rule evaluations and rule selection read it.
 */
export async function readSubjectEvidence(
  client: PoolClient,
  subjectId: string,
  principal: AuthContext,
  options: { lock?: boolean; decision?: boolean } = {},
): Promise<SubjectEvidence> {
  const read = options.lock
    ? await lockClosure(client, principal, subjectId, 'SHARE')
    : (
        await client.query<EvidenceState>(evidenceStateSql, [
          principal.tenantId,
          subjectId,
          `authority:${principal.id}`,
        ])
      ).rows[0]!;
  const state = options.decision
    ? { ...read, frontiers: await decisionFrontiers(client, principal.tenantId, read.frontiers) }
    : read;
  if (!state.subjects.length)
    throw new DomainError(404, 'subject_not_found', 'Evidence subject was not found within your scope');
  const accepted: InputCut = { streams: {}, principalRevision: principal.revision };
  const rendered: InputCut = { streams: {}, principalRevision: principal.revision };
  for (const frontier of [...state.frontiers, ...(state.authority ? [state.authority] : [])]) {
    accepted.streams[frontier.streamId] = Math.max(accepted.streams[frontier.streamId] ?? 0, frontier.sequence);
    rendered.streams[frontier.streamId] = Math.max(
      rendered.streams[frontier.streamId] ?? 0,
      frontier.projectedSequence,
    );
  }
  const basisManifest: SubjectBasisManifest = {
    version: 'subject-evidence.1',
    subjectId,
    principalId: principal.id,
    principalRevision: principal.revision,
    ...state,
  };
  return { rendered, accepted, dependencyBasis: canonicalDigest(basisManifest), basisManifest };
}
