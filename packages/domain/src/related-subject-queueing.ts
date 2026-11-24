import { randomUUID } from 'node:crypto';
import { subjectReferenceKey, type CheckedRuleLeaf, type RuleRead, type SubjectReference } from '@ledger/contracts';
import type { JournalEvent, PoolClient } from '@ledger/persistence';
import { observationField, observationMatches, utcMillis, type CheckObservation } from './check-kinds.js';
import { valueAt } from './observation-references.js';
import { referencingField, relatedReferencingField, relationOf } from './related-subjects.js';
import type { RuleEvaluationTrigger } from './rule-evaluations.js';
import { subjectStateLoader } from './subject-state.js';

/**
 * Queueing for related subjects (docs/design/fan-out-and-related-reads.md, section 4). A new record about a related
 * subject queues the subjects whose current records name it, found through the reference index; a record whose
 * reference names a subject queues that subject for the reads about referencing records. Targets are queued a page
 * at a time: the first page with the event, each further page by a 'related' work row a worker continues from.
 */

/** Targets one transaction queues for one related subject; the rest continue in a later one. */
export const RELATED_QUEUE_PAGE = 500;

type Relation = NonNullable<CheckedRuleLeaf['related']>[number];

/** What queueing knows about an observation: its type and version, and its id and content when it has them. */
export interface RelatedQueueObservation {
  type: string;
  version: number;
  content?: CheckObservation;
}

/** Queues one evaluation; the same event, subject and rule are queued once. */
type Queue = (subject: SubjectReference, trigger: RuleEvaluationTrigger) => Promise<void>;

function takes(read: RuleRead, observation: RelatedQueueObservation): boolean {
  return (
    read.type === observation.type &&
    read.versions.includes(observation.version) &&
    (!observation.content || observationMatches(observation.content, read.where))
  );
}

interface NamingRow {
  id: string;
  observation_type: string;
  observation_version: number;
  occurred_at: Date;
  observation: Record<string, unknown>;
  source_id: string;
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_current: string | null;
  secondary_subject_kind: SubjectReference['kind'] | null;
  secondary_subject_id: string | null;
  secondary_current: string | null;
  target_reference_scope: SubjectReference['scope'] | null;
  target_reference_id: string | null;
  target_reference_resolved: string | null;
}

/** The latest alias resolution (on reference alias `ref`) of a source reference at the observation's time. */
export const aliasOf = (ref: string) => `(SELECT r.ledger_subject_id FROM observation_subject_resolutions r
  JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
  WHERE r.tenant_id=o.tenant_id AND r.observation_id IS NULL AND r.source_id=${ref}.reference_source_id
    AND r.subject_kind=${ref}.reference_kind AND r.external_id=${ref}.reference_id
    AND (r.valid_from IS NULL OR r.valid_from<=o.occurred_at) AND (r.valid_to IS NULL OR r.valid_to>o.occurred_at)
  ORDER BY re.received_at DESC,r.id DESC LIMIT 1)`;

/** The current Ledger subject of an observation role, after subject resolutions. */
export const currentRole = (column: string, role: string) => `COALESCE((SELECT r.ledger_subject_id
  FROM observation_subject_resolutions r JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
  WHERE r.tenant_id=o.tenant_id AND ((r.observation_id=o.id AND r.role='${role}')
    OR (r.observation_id IS NULL AND o.${column}_scope='source' AND o.${column}_resolution='unresolved'
      AND r.source_id=o.source_id AND r.subject_kind=o.${column}_kind AND r.external_id=o.${column}_id
      AND (r.valid_from IS NULL OR r.valid_from<=o.occurred_at) AND (r.valid_to IS NULL OR r.valid_to>o.occurred_at)))
  ORDER BY re.received_at DESC,r.id DESC LIMIT 1),o.${column}_ledger_id)`;

/**
 * One page of current observations of the from-read's type that name the subject at the relation's field: a
 * reference written as the subject's key, a source reference whose alias resolution points at the Ledger subject,
 * or the subject in the named envelope role. For a from-read about referencing records, each row also carries the
 * reference at that field, which names the target.
 */
async function namingPage(
  client: PoolClient,
  tenantId: string,
  from: RuleRead,
  relation: Relation,
  named: SubjectReference,
  after: string,
): Promise<NamingRow[]> {
  const field = relation.from.field;
  const role = field === 'subject' || field === 'secondarySubject' ? field : undefined;
  const column = role === 'secondarySubject' ? 'secondary_subject' : 'subject';
  const naming = role
    ? named.scope === 'ledger'
      ? `o.${column}_kind=n.kind AND ${currentRole(column, role)}=n.id`
      : `o.source_id=n.source_id AND o.${column}_scope='source' AND o.${column}_kind=n.kind AND o.${column}_id=n.id`
    : `EXISTS(SELECT 1 FROM observation_references ref WHERE ref.tenant_id=o.tenant_id AND ref.observation_id=o.id
        AND ref.field=n.field AND (ref.reference_key=n.key OR (n.source_id IS NULL AND ref.reference_scope='source'
          AND ref.reference_kind=n.kind AND ${aliasOf('ref')}=n.id)))`;
  const referencing = referencingField(from);
  const rows = await client.query<NamingRow>(
    `WITH n AS (SELECT $5::text AS key,$6::text AS kind,$7::text AS id,$8::text AS source_id,$9::text AS field)
     SELECT o.id,o.observation_type,o.observation_version,o.occurred_at,o.observation,o.source_id,o.subject_kind,
       o.subject_id,${currentRole('subject', 'subject')} AS subject_current,o.secondary_subject_kind,o.secondary_subject_id,
       ${currentRole('secondary_subject', 'secondarySubject')} AS secondary_current,
       tr.reference_scope AS target_reference_scope,tr.reference_id AS target_reference_id,
       CASE WHEN tr.reference_scope='source' THEN ${aliasOf('tr')} END AS target_reference_resolved
     FROM n CROSS JOIN observations o
     LEFT JOIN observation_references tr ON tr.tenant_id=o.tenant_id AND tr.observation_id=o.id AND tr.field=$10
     WHERE o.tenant_id=$1 AND o.observation_type=$2 AND o.observation_version=ANY($3::integer[]) AND o.id>$4
       AND NOT EXISTS(SELECT 1 FROM observations rep WHERE rep.tenant_id=o.tenant_id AND rep.replaces_observation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
       AND ${naming}
     ORDER BY o.id LIMIT $11`,
    [
      tenantId,
      from.type,
      from.versions,
      after,
      subjectReferenceKey(named),
      named.kind,
      named.id,
      named.scope === 'source' ? named.sourceId : null,
      role ? null : field,
      referencing ?? null,
      RELATED_QUEUE_PAGE + 1,
    ],
  );
  return rows.rows;
}

/** The subject of the target's kind a naming row is about, or that its referencing field names. */
function targetOf(row: NamingRow, leaf: CheckedRuleLeaf, from: RuleRead): SubjectReference | undefined {
  const kind = leaf.target.subjectKind;
  if (referencingField(from)) {
    if (!row.target_reference_id) return undefined;
    const ledgerId = row.target_reference_scope === 'ledger' ? row.target_reference_id : row.target_reference_resolved;
    return ledgerId
      ? { scope: 'ledger', kind, id: ledgerId }
      : { scope: 'source', kind, id: row.target_reference_id, sourceId: row.source_id };
  }
  const roles = [
    [row.subject_kind, row.subject_id, row.subject_current],
    [row.secondary_subject_kind, row.secondary_subject_id, row.secondary_current],
  ] as const;
  const match = roles.find(([roleKind]) => roleKind === kind);
  if (!match) return undefined;
  const [, id, current] = match;
  return current ? { scope: 'ledger', kind, id: current } : { scope: 'source', kind, id: id!, sourceId: row.source_id };
}

function asContent(row: NamingRow): CheckObservation {
  return {
    id: row.id,
    type: row.observation_type,
    version: row.observation_version,
    occurredAt: row.occurred_at.toISOString(),
    observation: row.observation,
  };
}

interface Continuation {
  relation: string;
  after: string;
  triggerKind: RuleEvaluationTrigger['kind'];
  /** For a relation that declares requeue: the targets the page ending at `after` named but did not queue. */
  skipped?: number;
}

type Requeue = NonNullable<Relation['requeue']>;
const DAY_MS = 86_400_000;
/** Observations read, newest first, to find the latest one about a target that meets the window read's conditions. */
const WINDOW_PAGE = 50;

/**
 * The value at the window's field for one target: from its subject state, or from the latest current observation of
 * the window read about it. Observations named through a source alias are not looked for; such a target reads as
 * having no recorded end, and is queued.
 */
async function windowEnd(
  client: PoolClient,
  tenantId: string,
  leaf: CheckedRuleLeaf,
  at: Requeue['windowEnd'],
  target: SubjectReference,
): Promise<unknown> {
  if (leaf.subjectState?.name === at.read) {
    const loader = subjectStateLoader(target.kind);
    const state = target.scope === 'ledger' && loader ? await loader(client, target.id, {}) : undefined;
    return state ? valueAt(state.state, at.field) : undefined;
  }
  const read = leaf.reads.find((candidate) => candidate.name === at.read);
  if (!read) return undefined;
  const about =
    target.scope === 'ledger'
      ? `(o.subject_ledger_id=$5 OR o.secondary_subject_ledger_id=$5 OR o.id IN (SELECT r.observation_id
          FROM observation_subject_resolutions r WHERE r.tenant_id=$1 AND r.ledger_subject_id=$5))
         AND ((o.subject_kind=$4 AND ${currentRole('subject', 'subject')}=$5)
          OR (o.secondary_subject_kind=$4 AND ${currentRole('secondary_subject', 'secondarySubject')}=$5))`
      : `o.source_id=$7 AND ((o.subject_scope='source' AND o.subject_kind=$4 AND o.subject_id=$5)
          OR (o.secondary_subject_scope='source' AND o.secondary_subject_kind=$4 AND o.secondary_subject_id=$5))`;
  const rows = await client.query<NamingRow>(
    `SELECT o.id,o.observation_type,o.observation_version,o.occurred_at,o.observation FROM observations o
     WHERE o.tenant_id=$1 AND o.observation_type=$2 AND o.observation_version=ANY($3::integer[])
       AND NOT EXISTS(SELECT 1 FROM observations rep WHERE rep.tenant_id=o.tenant_id AND rep.replaces_observation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
       AND ${about}
     ORDER BY o.span_start DESC,o.id DESC LIMIT $6`,
    [
      tenantId,
      read.type,
      read.versions,
      target.kind,
      target.id,
      WINDOW_PAGE,
      ...(target.scope === 'source' ? [target.sourceId] : []),
    ],
  );
  const latest = rows.rows.map(asContent).find((observation) => observationMatches(observation, read.where));
  return latest ? observationField(latest, at.field) : undefined;
}

/** The targets whose window has not ended, or ended within the declared days; one with no recorded end is open. */
async function stillOpen(
  client: PoolClient,
  tenantId: string,
  leaf: CheckedRuleLeaf,
  requeue: Requeue,
  targets: SubjectReference[],
): Promise<SubjectReference[]> {
  if (!targets.length) return targets;
  const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
  const horizon = now - (requeue.endedWithinDays ?? 0) * DAY_MS;
  const open: SubjectReference[] = [];
  for (const target of targets) {
    const end = utcMillis(await windowEnd(client, tenantId, leaf, requeue.windowEnd, target));
    if (end === undefined || end > horizon) open.push(target);
  }
  return open;
}

/**
 * Records one page of queueing on a 'related' work row: pending when a worker is to queue the next page from it,
 * completed when it only records the targets this page skipped.
 */
async function recordPage(
  client: PoolClient,
  tenantId: string,
  packId: string,
  leafId: string,
  named: SubjectReference,
  eventId: string,
  continuation: Continuation,
  state: 'pending' | 'completed',
): Promise<void> {
  await client.query(
    `INSERT INTO rule_evaluation_work(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,subject_source_id,
       pack_id,leaf_id,trigger_kind,trigger_event_id,due_at,available_at,continuation,state,completed_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'related',$10,clock_timestamp(),clock_timestamp(),$11,$12,
       CASE WHEN $12='completed' THEN clock_timestamp() END) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      tenantId,
      subjectReferenceKey(named),
      named.scope,
      named.kind,
      named.id,
      named.sourceId ?? null,
      packId,
      leafId,
      eventId,
      continuation,
      state,
    ],
  );
}

/**
 * Queues one page of the targets whose current from-read records name the subject, and when more remain, a 'related'
 * work row from which a worker queues the next page. Returns the number of targets queued.
 */
async function queueNamingPage(
  client: PoolClient,
  tenantId: string,
  packId: string,
  leaf: CheckedRuleLeaf,
  relation: Relation,
  named: SubjectReference,
  trigger: RuleEvaluationTrigger,
  queue: Queue,
  after = '',
): Promise<number> {
  const from = leaf.reads.find((read) => read.name === relation.from.read);
  // A relation taken from the subject state names no record that the index could find.
  if (!from || relationOf(from) !== undefined) return 0;
  const rows = await namingPage(client, tenantId, from, relation, named, after);
  const page = rows.slice(0, RELATED_QUEUE_PAGE);
  const targets = new Map<string, SubjectReference>();
  for (const row of page) {
    if (!observationMatches(asContent(row), from.where)) continue;
    const target = targetOf(row, leaf, from);
    if (target) targets.set(subjectReferenceKey(target), target);
  }
  // A relation that declares requeue skips targets whose window has closed; each keeps its last evaluation.
  const candidates = [...targets.values()];
  const open = relation.requeue ? await stillOpen(client, tenantId, leaf, relation.requeue, candidates) : candidates;
  const skipped = candidates.length - open.length;
  for (const target of open) await queue(target, trigger);
  const continuation: Continuation = {
    relation: relation.name,
    after: page.at(-1)?.id ?? after,
    triggerKind: trigger.kind,
    ...(relation.requeue ? { skipped } : {}),
  };
  if (rows.length > RELATED_QUEUE_PAGE)
    await recordPage(client, tenantId, packId, leaf.id, named, trigger.eventId, continuation, 'pending');
  else if (skipped)
    await recordPage(client, tenantId, packId, leaf.id, named, trigger.eventId, continuation, 'completed');
  return open.length;
}

/** The subjects an observation's reference rows at a field name, resolved through current alias resolutions. */
export async function referencedSubjects(
  client: PoolClient,
  tenantId: string,
  observationId: string,
  field: string,
  kind: SubjectReference['kind'],
): Promise<SubjectReference[]> {
  const rows = await client.query<{
    reference_scope: SubjectReference['scope'];
    reference_id: string;
    reference_source_id: string | null;
    resolved: string | null;
  }>(
    `SELECT ref.reference_scope,ref.reference_id,ref.reference_source_id,
       CASE WHEN ref.reference_scope='source' THEN ${aliasOf('ref')} END AS resolved
     FROM observation_references ref JOIN observations o ON o.tenant_id=ref.tenant_id AND o.id=ref.observation_id
     WHERE ref.tenant_id=$1 AND ref.observation_id=$2 AND ref.field=$3 AND ref.reference_kind=$4`,
    [tenantId, observationId, field, kind],
  );
  return rows.rows.map((row) =>
    row.reference_scope === 'ledger' || row.resolved
      ? { scope: 'ledger', kind, id: row.resolved ?? row.reference_id }
      : { scope: 'source', kind, id: row.reference_id, sourceId: row.reference_source_id! },
  );
}

/**
 * Queues, for one leaf, the targets an accepted or corrected observation affects through related subjects: for each
 * read about a related subject that takes it, the targets whose records name a subject it is about; for each read
 * about referencing records that takes it, the subjects its reference names. Returns the number queued.
 */
export async function queueRelatedTargets(
  client: PoolClient,
  tenantId: string,
  packId: string,
  leaf: CheckedRuleLeaf,
  observation: RelatedQueueObservation,
  subjects: SubjectReference[],
  trigger: RuleEvaluationTrigger,
  queue: Queue,
): Promise<number> {
  if (!leaf.related) return 0;
  let queued = 0;
  for (const read of leaf.reads.filter((candidate) => takes(candidate, observation))) {
    const relation = leaf.related.find((item) => item.name === relationOf(read));
    const named = relatedReferencingField(read);
    // A read about the records that name the related subject in a reference takes the subjects that reference names.
    const relatedSubjects =
      relation && named !== undefined
        ? observation.content
          ? await referencedSubjects(client, tenantId, observation.content.id, named, relation.subjectKind)
          : []
        : subjects;
    if (relation)
      for (const subject of relatedSubjects.filter((item) => item.kind === relation.subjectKind))
        queued += await queueNamingPage(client, tenantId, packId, leaf, relation, subject, trigger, queue);
    const field = referencingField(read);
    if (field && observation.content)
      for (const target of await referencedSubjects(
        client,
        tenantId,
        observation.content.id,
        field,
        leaf.target.subjectKind,
      )) {
        await queue(target, trigger);
        queued++;
      }
  }
  return queued;
}

/**
 * Queues, for one leaf, what an alias from a source's own id to a Ledger subject changes: the targets whose records
 * name the source identity in a reference (the event lists no body references among what it affected), and the
 * subject itself for reads about records referencing it.
 */
export async function queueRelatedTargetsForAlias(
  client: PoolClient,
  event: JournalEvent,
  packId: string,
  leaf: CheckedRuleLeaf,
  queue: Queue,
): Promise<number> {
  if (event.event_type !== 'subject.alias' || !leaf.related) return 0;
  const { sourceId, subjectKind, externalId, ledgerSubjectId } = event.payload as Record<string, string>;
  const trigger: RuleEvaluationTrigger = { kind: 'correction', eventId: event.id };
  const identity = { scope: 'source', kind: subjectKind, id: externalId, sourceId } as SubjectReference;
  let queued = 0;
  for (const relation of leaf.related.filter((item) => item.subjectKind === subjectKind))
    queued += await queueNamingPage(client, event.tenant_id, packId, leaf, relation, identity, trigger, queue);
  if (leaf.target.subjectKind === subjectKind && leaf.reads.some((read) => referencingField(read))) {
    await queue({ scope: 'ledger', kind: identity.kind, id: ledgerSubjectId! }, trigger);
    queued++;
  }
  return queued;
}

/**
 * Continues queueing from a 'related' work row: the next page of targets naming the row's subject, for the relation
 * and position it carries, under the trigger of the event that started it.
 */
export async function continueRelatedQueueing(
  client: PoolClient,
  work: {
    tenantId: string;
    subject: SubjectReference;
    packId: string;
    leaf: CheckedRuleLeaf | undefined;
    eventId: string;
    continuation: Continuation;
  },
  queue: Queue,
): Promise<number> {
  const relation = work.leaf?.related?.find((item) => item.name === work.continuation.relation);
  if (!work.leaf || !relation) return 0;
  const kind = work.continuation.triggerKind;
  const trigger = { kind, eventId: work.eventId } as RuleEvaluationTrigger;
  return queueNamingPage(
    client,
    work.tenantId,
    work.packId,
    work.leaf,
    relation,
    work.subject,
    trigger,
    queue,
    work.continuation.after,
  );
}
