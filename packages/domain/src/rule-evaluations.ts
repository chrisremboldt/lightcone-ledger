import { randomUUID } from 'node:crypto';
import {
  adoptionMode,
  findObservationType,
  isCheckedRuleLeaf,
  OBSERVATION_PAGE_LIMIT,
  subjectReferenceKey,
  type AcceptedObservation,
  type CheckedRuleLeaf,
  type InputCut,
  type PackAdoptionAcceptance,
  type ReadAsPlans,
  type RuleEvaluationRecord,
  type SubjectReference,
  localizeInstants,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { appendEvent, type AuthContext, type JournalEvent, type PoolClient } from '@ledger/persistence';
import { continueAdoptionQueueing, type AdoptionPagePosition } from './adoption-queueing.js';
import {
  findCheckKind,
  observationMatches,
  type CheckClock,
  type CheckInputs,
  type CheckObservation,
} from './check-kinds.js';
import {
  checkParameters,
  narrowRead,
  readUpperBound,
  readWindow,
  readWindowOf,
  runCheckedRule,
  type CheckedRuleOutcome,
} from './checked-rules.js';
import { readSubjectEvidence, retainSubjectEvidence } from './cuts.js';
import type { AffectedObservation } from './observation-corrections.js';
import { listObservations } from './observations.js';
import { organizationTimeZone } from './organization-zone.js';
import { observationRegistry } from './observation-registry.js';
import { evaluateWithRelatedSubjects } from './related-subject-evaluation.js';
import {
  continueRelatedQueueing,
  queueRelatedTargets,
  queueRelatedTargetsForAlias,
} from './related-subject-queueing.js';
import { referencingField, relatedReferencingField, relationOf } from './related-subjects.js';
import { joiningSubjects, populationScope, type JoiningObservation } from './rule-populations.js';
import {
  correctedSessions,
  SESSION_READ_LIMIT,
  sessionReadOf,
  sessionsOf,
  sessionsRead,
  subjectsInSession,
  widenedBySessions,
  type CaptureSession,
} from './session-reads.js';
import { subjectFindingView } from './subject-findings.js';
import { subjectStateLoader, subjectStateRevision, type SubjectState } from './subject-state.js';
import { observationStreamsSql } from './observation-streams.js';
import {
  coveringProvisions,
  provisionResultPart,
  readProvisionResults,
  reliefDigestPart,
  reliefFor,
  relievedAnswer,
  type ReliefGrant,
} from './waiver-relief.js';

export type RuleEvaluationTrigger =
  | { kind: 'observation' | 'state' | 'correction' | 'adoption'; eventId: string }
  | { kind: 'deadline'; eventId: string; dueAt: string };

/** One unit of work for the generic evaluator: evaluate one adopted rule for one subject reference. */
export interface RuleEvaluationTask {
  subject: SubjectReference;
  packId: string;
  leafId: string;
  trigger: RuleEvaluationTrigger;
}

export interface AdoptionRow {
  id: string;
  record: PackAdoptionAcceptance;
}

interface ObservationSubjectRow {
  source_id: string;
  observation_type: string;
  observation_version: number;
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_ledger_id: string | null;
  secondary_subject_kind: SubjectReference['kind'] | null;
  secondary_subject_id: string | null;
  secondary_subject_ledger_id: string | null;
}

export interface GatheredInput {
  read: CheckedRuleLeaf['reads'][number];
  observations: AcceptedObservation[];
  truncated: boolean;
  /** The related subject a read about one read about. */
  subject?: SubjectReference;
  /** For a required read that does not read plans and came back empty: the earliest record it would take later. */
  later?: { from: string; observationId: string };
}

export interface GatheredState {
  name: string;
  kind: SubjectReference['kind'];
  state: SubjectState | undefined;
}

export interface Gathered {
  reads: GatheredInput[];
  state?: GatheredState;
}

/**
 * SQL counting the generic evaluator's unfinished work about a subject that is due now: queued work whose time has
 * come, or work a worker holds. Work waiting for a later boundary is not counted, so a subject with only a future
 * deadline reads as settled. `subjectKey` is an SQL expression for the subject key; without it, all of the caller's
 * tenant's due work is counted.
 */
export function dueRuleEvaluationWorkSql(subjectKey?: string): string {
  return `(SELECT COUNT(*) FROM rule_evaluation_work due_work
    WHERE due_work.tenant_id=current_setting('ledger.tenant_id',true)
      ${subjectKey === undefined ? '' : `AND due_work.subject_key=${subjectKey}`}
      AND (due_work.state='leased' OR (due_work.state='pending' AND due_work.available_at<=clock_timestamp()
        AND due_work.due_at<=clock_timestamp())))`;
}

/** The number of generic evaluations about a subject that are due and unfinished. */
export async function dueRuleEvaluationWork(client: PoolClient, subject: SubjectReference): Promise<number> {
  const row = await client.query<{ count: string }>(`SELECT ${dueRuleEvaluationWorkSql('$1')} AS count`, [
    subjectReferenceKey(subject),
  ]);
  return Number(row.rows[0]!.count);
}

const EARLIEST = '1970-01-01T00:00:00.000Z';
const LATEST = '9999-12-31T23:59:59.998Z';
// Observations sharing the newest span start are read together, so disagreeing reports stay visible.
const LATEST_PAGE = 20;

/** The Ledger organization subject of a tenant: the subject rules read with `about: organization`. */
export function organizationIdOf(tenantId: string): string {
  return `organization:${tenantId}`;
}

async function now(client: PoolClient): Promise<string> {
  return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
}

/**
 * Takes the tenant's lock on its adopted rules for this transaction: exclusive where an adoption becomes visible to
 * the evaluator, shared where the adopted rules are read to queue evaluations. Shared holders do not block each other.
 */
export async function lockAdoptedRules(
  client: PoolClient,
  tenantId: string,
  mode: 'shared' | 'exclusive',
): Promise<void> {
  const lock = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await client.query(`SELECT ${lock}(hashtextextended($1,0))`, [`adopted-rules:${tenantId}`]);
}

/**
 * The adoptions in effect now, read to queue evaluations. An adoption projected at the same time either commits
 * first, and this read sees it, or waits for this transaction, after which its own queueing reads what this one
 * recorded; so whether a record is evaluated never depends on which projection ran first.
 */
async function adoptionsForQueueing(client: PoolClient, tenantId: string): Promise<AdoptionRow[]> {
  await lockAdoptedRules(client, tenantId, 'shared');
  return adoptionsInEffect(client, tenantId, await now(client));
}

/**
 * Projected adoptions whose effective interval contains the instant, at most one per pack. An adoption a projected
 * revision replaced is not in effect, and one a later version succeeds ends where that version starts.
 */
async function adoptionsInEffect(client: PoolClient, tenantId: string, at: string): Promise<AdoptionRow[]> {
  const rows = await client.query<AdoptionRow>(
    `SELECT a.id,a.record FROM organization_pack_adoptions a
     JOIN organization_pack_adoption_views v ON v.tenant_id=a.tenant_id AND v.id=a.id
     WHERE a.tenant_id=$1 AND a.organization_id=$2 AND a.effective_start<=$3::timestamptz AND a.effective_end>$3::timestamptz
      AND NOT EXISTS(SELECT 1 FROM organization_pack_adoptions s WHERE s.tenant_id=a.tenant_id AND s.succeeds_id=a.id
        AND s.effective_start<=$3::timestamptz)
      AND NOT EXISTS(SELECT 1 FROM organization_pack_adoptions r
        JOIN organization_pack_adoption_views rv ON rv.tenant_id=r.tenant_id AND rv.id=r.id
        WHERE r.tenant_id=a.tenant_id AND r.revises_id=a.id)
     ORDER BY a.pack_id,a.accepted_revision DESC`,
    [tenantId, organizationIdOf(tenantId), at],
  );
  return rows.rows.filter(
    (row, index, all) => all.findIndex((other) => other.record.pack.packId === row.record.pack.packId) === index,
  );
}

/** The checked rules of the adoptions in effect now, each as the JSON of its pack id and rule id. */
export async function rulesInEffect(client: PoolClient, tenantId: string): Promise<Set<string>> {
  const adoptions = await adoptionsInEffect(client, tenantId, await now(client));
  return new Set(
    adoptions.flatMap((adoption) =>
      adoption.record.pack.leaves
        .filter(isCheckedRuleLeaf)
        .map((leaf) => JSON.stringify([adoption.record.pack.packId, leaf.id])),
    ),
  );
}

/** An observation that may queue rules: its type and version, and its content when it is known. */
interface QueuedObservation {
  type: string;
  version: number;
  content?: CheckObservation;
}

/** True when the read would gather the observation: its type, version and, when the content is known, conditions. */
function readTakes(read: Read, observation: QueuedObservation): boolean {
  return (
    read.type === observation.type &&
    read.versions.includes(observation.version) &&
    (!observation.content || observationMatches(observation.content, read.where))
  );
}

function readsObservation(leaf: CheckedRuleLeaf, subject: SubjectReference, observation: QueuedObservation): boolean {
  if (leaf.target.subjectKind !== subject.kind) return false;
  return leaf.reads.some(
    (read) => (read.about === 'target' || subject.kind === 'organization') && readTakes(read, observation),
  );
}

/** True when a rule about another kind of subject reads the observation about the organization. */
function readsAboutOrganization(
  leaf: CheckedRuleLeaf,
  subject: SubjectReference,
  organizationId: string,
  observation: QueuedObservation,
): boolean {
  if (leaf.target.subjectKind === 'organization') return false;
  if (subject.scope !== 'ledger' || subject.kind !== 'organization' || subject.id !== organizationId) return false;
  return leaf.reads.some((read) => read.about === 'organization' && readTakes(read, observation));
}

interface ObservationContentRow {
  id: string;
  observation_type: string;
  observation_version: number;
  occurred_at: Date;
  interval_start: Date | null;
  interval_end: Date | null;
  observation: Record<string, unknown>;
}

function contentOf(row: ObservationContentRow): CheckObservation {
  return {
    id: row.id,
    type: row.observation_type,
    version: row.observation_version,
    occurredAt: row.occurred_at.toISOString(),
    ...(row.interval_start
      ? {
          interval: {
            start: row.interval_start.toISOString(),
            ...(row.interval_end ? { end: row.interval_end.toISOString() } : {}),
          },
        }
      : {}),
    observation: row.observation,
  };
}

const OBSERVATION_CONTENT_COLUMNS =
  'o.id,o.observation_type,o.observation_version,o.occurred_at,o.interval_start,o.interval_end,o.observation';

/**
 * The content of the one observation a correction names: the withdrawn or re-attached observation, or the one a
 * replacement replaced. Undefined when the correction names none or several (an alias), whose rules are queued
 * without their reads' conditions.
 */
async function correctedObservation(
  client: PoolClient,
  event: JournalEvent,
  affected: AffectedObservation[],
): Promise<CheckObservation | undefined> {
  if (affected.length !== 1) return undefined;
  const named = typeof event.payload.observationId === 'string' ? event.payload.observationId : null;
  const rows = await client.query<ObservationContentRow>(
    `SELECT ${OBSERVATION_CONTENT_COLUMNS} FROM observations o WHERE o.tenant_id=$1 AND (o.id=$2 OR o.id=(
       SELECT r.replaces_observation_id FROM observations r WHERE r.tenant_id=$1 AND r.event_id=$3))`,
    [event.tenant_id, named, event.id],
  );
  return rows.rows.length === 1 ? contentOf(rows.rows[0]!) : undefined;
}

interface EvaluatedSubjectRow {
  subject_key: string;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
}

// Subjects a rule has evaluated are read and queued this many at a time.
const EVALUATED_SUBJECT_PAGE = 500;

/** Queues a rule for every subject it has already evaluated, a page at a time. */
async function queueEvaluatedSubjects(
  client: PoolClient,
  tenantId: string,
  packId: string,
  leafId: string,
  trigger: RuleEvaluationTrigger,
): Promise<number> {
  let queued = 0;
  let after = '';
  for (;;) {
    const page = await client.query<EvaluatedSubjectRow>(
      `SELECT DISTINCT ON(subject_key) subject_key,subject_scope,subject_kind,subject_id,subject_source_id
       FROM rule_evaluations WHERE tenant_id=$1 AND pack_id=$2 AND leaf_id=$3 AND subject_key>$4
       ORDER BY subject_key LIMIT $5`,
      [tenantId, packId, leafId, after, EVALUATED_SUBJECT_PAGE],
    );
    for (const row of page.rows) {
      const subject: SubjectReference =
        row.subject_scope === 'source'
          ? { scope: 'source', kind: row.subject_kind, id: row.subject_id, sourceId: row.subject_source_id! }
          : { scope: 'ledger', kind: row.subject_kind, id: row.subject_id };
      await queueWork(client, tenantId, subject, packId, leafId, trigger);
      queued++;
    }
    if (page.rows.length < EVALUATED_SUBJECT_PAGE) return queued;
    after = page.rows.at(-1)!.subject_key;
  }
}

function namedSubjects(row: ObservationSubjectRow): SubjectReference[] {
  const named = [
    { kind: row.subject_kind, id: row.subject_id, ledgerId: row.subject_ledger_id },
    ...(row.secondary_subject_kind && row.secondary_subject_id
      ? [{ kind: row.secondary_subject_kind, id: row.secondary_subject_id, ledgerId: row.secondary_subject_ledger_id }]
      : []),
  ];
  const subjects = named.map((subject): SubjectReference =>
    subject.ledgerId
      ? { scope: 'ledger', kind: subject.kind, id: subject.ledgerId }
      : { scope: 'source', kind: subject.kind, id: subject.id, sourceId: row.source_id },
  );
  return subjects.filter(
    (subject, index) =>
      subjects.findIndex((other) => subjectReferenceKey(other) === subjectReferenceKey(subject)) === index,
  );
}

export async function queueWork(
  client: PoolClient,
  tenantId: string,
  subject: SubjectReference,
  packId: string,
  leafId: string,
  trigger: RuleEvaluationTrigger,
): Promise<void> {
  await client.query(
    `INSERT INTO rule_evaluation_work(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,subject_source_id,
       pack_id,leaf_id,trigger_kind,trigger_event_id,due_at,available_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::timestamptz,clock_timestamp()),COALESCE($12::timestamptz,clock_timestamp()))
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      tenantId,
      subjectReferenceKey(subject),
      subject.scope,
      subject.kind,
      subject.id,
      subject.sourceId ?? null,
      packId,
      leafId,
      trigger.kind,
      trigger.eventId,
      trigger.kind === 'deadline' ? trigger.dueAt : null,
    ],
  );
}

/**
 * Queues evaluation of every rule in effect that reads this accepted observation's type and version, once for each
 * subject the observation names. Called when the observation event is projected.
 */
export async function queueRuleEvaluationsForObservation(client: PoolClient, event: JournalEvent): Promise<number> {
  const row = (
    await client.query<
      ObservationSubjectRow &
        ObservationContentRow & { source_session_id: string | null; source_event_id: string | null }
    >(
      `SELECT o.source_id,o.subject_kind,o.subject_id,o.subject_ledger_id,o.secondary_subject_kind,
       o.secondary_subject_id,o.secondary_subject_ledger_id,o.source_session_id,o.source_event_id,${OBSERVATION_CONTENT_COLUMNS}
       FROM observations o WHERE o.tenant_id=$1 AND o.event_id=$2`,
      [event.tenant_id, event.id],
    )
  ).rows[0];
  if (!row) return 0;
  const subjects = namedSubjects(row);
  const observation: QueuedObservation = {
    type: row.observation_type,
    version: row.observation_version,
    content: contentOf(row),
  };
  const organizationId = organizationIdOf(event.tenant_id);
  const trigger: RuleEvaluationTrigger = { kind: 'observation', eventId: event.id };
  let queued = 0;
  const adoptions = await adoptionsForQueueing(client, event.tenant_id);
  const joining = joiningOf(row);
  const references = new Map<string, SubjectReference[]>();
  if (row.source_session_id && row.source_event_id)
    queued += await queueSessionSubjects(
      client,
      event.tenant_id,
      adoptions,
      { sourceId: row.source_id, sourceSessionId: row.source_session_id },
      observation,
      trigger,
    );
  for (const adoption of adoptions)
    for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
      const packId = adoption.record.pack.packId;
      for (const subject of subjects) {
        if (readsObservation(leaf, subject, observation)) {
          await queueWork(client, event.tenant_id, subject, packId, leaf.id, trigger);
          queued++;
        }
        if (readsAboutOrganization(leaf, subject, organizationId, observation))
          queued += await queueEvaluatedSubjects(client, event.tenant_id, packId, leaf.id, trigger);
      }
      queued += await queueRelatedTargets(
        client,
        event.tenant_id,
        packId,
        leaf,
        observation,
        subjects,
        trigger,
        (subject, cause) => queueWork(client, event.tenant_id, subject, packId, leaf.id, cause),
      );
      queued += await queuePopulationJoins(client, event.tenant_id, adoption, leaf, joining, references, trigger);
    }
  return queued;
}

function joiningOf(row: ObservationSubjectRow & ObservationContentRow): JoiningObservation {
  return {
    id: row.id,
    sourceId: row.source_id,
    subject: { kind: row.subject_kind, id: row.subject_id, ledgerId: row.subject_ledger_id },
    ...(row.secondary_subject_kind && row.secondary_subject_id
      ? {
          secondarySubject: {
            kind: row.secondary_subject_kind,
            id: row.secondary_subject_id,
            ledgerId: row.secondary_subject_ledger_id,
          },
        }
      : {}),
    content: contentOf(row),
  };
}

/**
 * Queues a rule that declares a population for each subject the observation brings into it that the rule has not
 * evaluated under the adoption (docs/design/rule-coverage.md). A subject already evaluated is queued, if at all, by
 * the reads that take the observation.
 */
async function queuePopulationJoins(
  client: PoolClient,
  tenantId: string,
  adoption: AdoptionRow,
  leaf: CheckedRuleLeaf,
  observation: JoiningObservation,
  references: Map<string, SubjectReference[]>,
  trigger: RuleEvaluationTrigger,
): Promise<number> {
  const scope = populationScope(tenantId, adoption.record, leaf);
  if (!scope) return 0;
  let queued = 0;
  for (const subject of await joiningSubjects(client, scope, observation, references)) {
    const evaluated = await client.query(
      `SELECT 1 FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3 AND leaf_id=$4
       AND adoption_id=$5 LIMIT 1`,
      [tenantId, subjectReferenceKey(subject), adoption.record.pack.packId, leaf.id, adoption.id],
    );
    if (evaluated.rowCount) continue;
    await queueWork(client, tenantId, subject, adoption.record.pack.packId, leaf.id, trigger);
    queued++;
  }
  return queued;
}

/**
 * Queues evaluation of every rule in effect that reads an observation a correction affected (a replacement, a
 * withdrawal or a subject resolution), once for each subject it was about before or after. Corrections list what
 * they affected in their event payload. Called when the correction event is projected.
 */
export async function queueRuleEvaluationsForCorrection(client: PoolClient, event: JournalEvent): Promise<number> {
  const affected = (event.payload.affected ?? []) as AffectedObservation[];
  const adoptions = await adoptionsForQueueing(client, event.tenant_id);
  let queued = 0;
  // An alias changes what body references resolve to, which the affected list does not name.
  for (const adoption of adoptions)
    for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
      const packId = adoption.record.pack.packId;
      queued += await queueRelatedTargetsForAlias(client, event, packId, leaf, (subject, cause) =>
        queueWork(client, event.tenant_id, subject, packId, leaf.id, cause),
      );
    }
  if (!affected.length) return queued;
  const content = await correctedObservation(client, event, affected);
  const organizationId = organizationIdOf(event.tenant_id);
  const trigger: RuleEvaluationTrigger = { kind: 'correction', eventId: event.id };
  for (const session of await correctedSessions(client, event)) {
    const item = affected.find((candidate) => candidate.type === session.type);
    if (item)
      queued += await queueSessionSubjects(
        client,
        event.tenant_id,
        adoptions,
        session,
        { type: item.type, version: item.version },
        trigger,
      );
  }
  for (const adoption of adoptions)
    for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
      const packId = adoption.record.pack.packId;
      for (const item of affected) {
        const observation: QueuedObservation = {
          type: item.type,
          version: item.version,
          ...(content ? { content } : {}),
        };
        for (const subject of item.subjects) {
          if (readsObservation(leaf, subject, observation)) {
            await queueWork(client, event.tenant_id, subject, packId, leaf.id, trigger);
            queued++;
          }
          if (readsAboutOrganization(leaf, subject, organizationId, observation))
            queued += await queueEvaluatedSubjects(client, event.tenant_id, packId, leaf.id, trigger);
        }
        queued += await queueRelatedTargets(
          client,
          event.tenant_id,
          packId,
          leaf,
          observation,
          item.subjects,
          trigger,
          (subject, cause) => queueWork(client, event.tenant_id, subject, packId, leaf.id, cause),
        );
      }
    }
  return queued;
}

/**
 * Queues the next page of evaluations a 'related' work row carries on from: the targets whose records name its
 * subject, for a rule in effect. Called by the worker for such a row instead of an evaluation.
 */
export async function continueRelatedRuleEvaluations(
  client: PoolClient,
  principal: AuthContext,
  work: { subject: SubjectReference; packId: string; leafId: string; eventId: string; continuation: unknown },
): Promise<number> {
  const adoption = (await adoptionsInEffect(client, principal.tenantId, await now(client))).find(
    (row) => row.record.pack.packId === work.packId,
  );
  const leaf = adoption?.record.pack.leaves.filter(isCheckedRuleLeaf).find((candidate) => candidate.id === work.leafId);
  return continueRelatedQueueing(
    client,
    {
      tenantId: principal.tenantId,
      subject: work.subject,
      packId: work.packId,
      leaf,
      eventId: work.eventId,
      continuation: work.continuation as Parameters<typeof continueRelatedQueueing>[1]['continuation'],
    },
    (subject, trigger) => queueWork(client, principal.tenantId, subject, work.packId, work.leafId, trigger),
  );
}

/**
 * Queues evaluation of every rule in effect that reads the state of this subject's kind, when the state differs
 * from the state the rule's latest evaluation for the subject read. Called by the module that owns the subject when
 * an event it projects may have changed that state.
 */
export async function queueRuleEvaluationsForSubjectState(
  client: PoolClient,
  event: JournalEvent,
  kind: SubjectReference['kind'],
  subjectId: string,
): Promise<number> {
  const loader = subjectStateLoader(kind);
  if (!loader) return 0;
  const readers = (await adoptionsForQueueing(client, event.tenant_id)).flatMap((adoption) =>
    adoption.record.pack.leaves
      .filter(isCheckedRuleLeaf)
      .filter((leaf) => leaf.subjectState && leaf.target.subjectKind === kind)
      .map((leaf) => ({ packId: adoption.record.pack.packId, leafId: leaf.id, leafVersion: leaf.version })),
  );
  if (!readers.length) return 0;
  const revision = (await loader(client, subjectId, {}))?.revision ?? null;
  const subject: SubjectReference = { scope: 'ledger', kind, id: subjectId };
  let queued = 0;
  for (const reader of readers) {
    const previous = (
      await client.query<{ revision: string | null }>(
        `SELECT record->'subjectState'->>'revision' AS revision FROM rule_evaluations
         WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3 AND leaf_id=$4 AND leaf_version=$5
         ORDER BY recorded_at DESC,id DESC LIMIT 1`,
        [event.tenant_id, subjectReferenceKey(subject), reader.packId, reader.leafId, reader.leafVersion],
      )
    ).rows[0];
    if (previous && previous.revision === revision) continue;
    await queueWork(client, event.tenant_id, subject, reader.packId, reader.leafId, {
      kind: 'state',
      eventId: event.id,
    });
    queued++;
  }
  return queued;
}

/**
 * Queues the next page of evaluations an 'adoption-page' work row carries on from (adoption-queueing.ts): the
 * adoption's rule for subjects already on record, with the adopting event as the trigger. Called by the worker for
 * such a row instead of an evaluation.
 */
export async function continueAdoptionRuleEvaluations(
  client: PoolClient,
  principal: AuthContext,
  work: { packId: string; leafId: string; eventId: string; continuation: unknown },
  limit?: number,
  bound?: number,
): Promise<number> {
  const adoption = (
    await client.query<AdoptionRow>('SELECT id,record FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=$2', [
      principal.tenantId,
      work.eventId,
    ])
  ).rows[0];
  if (!adoption) return 0;
  const trigger: RuleEvaluationTrigger = { kind: 'adoption', eventId: work.eventId };
  return continueAdoptionQueueing(
    client,
    principal.tenantId,
    adoption,
    { packId: work.packId, leafId: work.leafId },
    work.continuation as AdoptionPagePosition,
    (subject) => queueWork(client, principal.tenantId, subject, work.packId, work.leafId, trigger),
    limit,
    bound,
  );
}

export interface SubjectCut {
  inputCut: InputCut;
  dependencyBasis: string;
}

export function mergeStreams(target: Record<string, number>, streams: Record<string, number>): void {
  for (const [stream, sequence] of Object.entries(streams))
    target[stream] = Math.max(target[stream] ?? 0, Number(sequence));
}

/**
 * The accepted evidence cut for a subject reference: the organization's, the Ledger subject's own, and for a
 * source identity every source stream holding an observation that names it.
 */
export async function subjectCut(
  client: PoolClient,
  principal: AuthContext,
  subject: SubjectReference,
  organizationId: string,
): Promise<SubjectCut> {
  const organization = await readSubjectEvidence(client, organizationId, principal, { lock: true });
  const streams: Record<string, number> = {};
  mergeStreams(streams, organization.accepted.streams);
  const bases = [organization.dependencyBasis];
  if (subject.scope === 'ledger' && subject.id !== organizationId) {
    const own = await readSubjectEvidence(client, subject.id, principal, { lock: true });
    mergeStreams(streams, own.accepted.streams);
    bases.push(own.dependencyBasis);
  }
  if (subject.scope === 'source') {
    const rows = await client.query<{ stream_id: string; sequence: string }>(
      observationStreamsSql(`SELECT o.tenant_id,o.id,o.event_id FROM observations o
       WHERE o.tenant_id=$1 AND o.source_id=$2 AND ((o.subject_scope='source' AND o.subject_kind=$3 AND o.subject_id=$4)
         OR (o.secondary_subject_scope='source' AND o.secondary_subject_kind=$3 AND o.secondary_subject_id=$4))`),
      [principal.tenantId, subject.sourceId, subject.kind, subject.id],
    );
    mergeStreams(streams, Object.fromEntries(rows.rows.map((item) => [item.stream_id, Number(item.sequence)])));
  }
  const inputCut: InputCut = { streams, principalRevision: principal.revision };
  return {
    inputCut,
    dependencyBasis: canonicalDigest({
      format: 'ledger.rule-evaluation-basis.1',
      subjectKey: subjectReferenceKey(subject),
      bases,
      inputCut,
    }),
  };
}

function newestFirst(a: AcceptedObservation, b: AcceptedObservation): number {
  const left = Date.parse(a.interval?.start ?? a.occurredAt);
  const right = Date.parse(b.interval?.start ?? b.occurredAt);
  return right - left || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function checkObservation(observation: AcceptedObservation): CheckObservation {
  return {
    id: observation.id,
    sourceId: observation.sourceId,
    type: observation.type,
    version: observation.version,
    occurredAt: observation.occurredAt,
    ...(observation.interval ? { interval: observation.interval } : {}),
    observation: observation.observation,
  };
}

type Read = CheckedRuleLeaf['reads'][number];

interface ReadPage {
  observations: AcceptedObservation[];
  truncated: boolean;
}

/**
 * Reads one version of one read newest first, keeping only observations that meet its conditions, page by page
 * until enough match or the data ends. The page limit counts matching observations.
 */
async function readMatching(
  client: PoolClient,
  principal: AuthContext,
  about: SubjectReference,
  read: Read,
  version: number,
  to: string,
  cut: InputCut,
  session?: CaptureSession,
  from: string = EARLIEST,
): Promise<ReadPage> {
  const all = read.select === 'all' || readWindowOf(read) !== undefined;
  const keep = all ? OBSERVATION_PAGE_LIMIT : LATEST_PAGE;
  const referencing = referencingField(read) ?? relatedReferencingField(read);
  const kept: AcceptedObservation[] = [];
  let newest: number | undefined;
  let cursor: string | undefined;
  for (;;) {
    const page = await listObservations(
      client,
      principal,
      {
        subjectKind: about.kind,
        subjectId: about.id,
        subjectScope: about.scope,
        ...(about.scope === 'source' ? { sourceId: about.sourceId } : {}),
        type: read.type,
        version,
        from,
        to,
        order: 'newest_first',
        limit: read.where ? OBSERVATION_PAGE_LIMIT : keep,
        ...(cursor ? { cursor } : {}),
      },
      { evidenceCut: cut.streams, ...(referencing ? { referencing } : {}), ...(session ? { session } : {}) },
    );
    for (const observation of page.observations) {
      const start = Date.parse(observation.interval?.start ?? observation.occurredAt);
      // A latest selection needs only the observations sharing the newest matching span start.
      if (!all && newest !== undefined && start < newest) return { observations: kept, truncated: false };
      if (!observationMatches(checkObservation(observation), read.where)) continue;
      if (kept.length === keep) return { observations: kept, truncated: all };
      newest ??= start;
      kept.push(observation);
    }
    // Without conditions every observation matches, so one page answers as it always has.
    if (!page.page.hasMore || !page.page.nextCursor) return { observations: kept, truncated: false };
    if (!read.where) return { observations: kept, truncated: all };
    cursor = page.page.nextCursor;
  }
}

/**
 * The earliest record a read would take whose span starts after the instant and by its bound: the record that is on
 * file for a time that has not come. Undefined when there is none.
 */
async function laterRecord(
  client: PoolClient,
  principal: AuthContext,
  about: SubjectReference,
  read: Read,
  after: number,
  bound: number,
  cut: InputCut,
): Promise<{ from: string; observationId: string } | undefined> {
  let earliest: { at: number; id: string } | undefined;
  for (const version of read.versions) {
    let cursor: string | undefined;
    for (;;) {
      const page = await listObservations(
        client,
        principal,
        {
          subjectKind: about.kind,
          subjectId: about.id,
          subjectScope: about.scope,
          ...(about.scope === 'source' ? { sourceId: about.sourceId } : {}),
          type: read.type,
          version,
          from: new Date(after + 1).toISOString(),
          to: new Date(bound + 1).toISOString(),
          order: 'oldest_first',
          limit: OBSERVATION_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        },
        { evidenceCut: cut.streams },
      );
      const found = page.observations.find((observation) => {
        const at = Date.parse(observation.interval?.start ?? observation.occurredAt);
        return at > after && observationMatches(checkObservation(observation), read.where);
      });
      if (found) {
        const at = Date.parse(found.interval?.start ?? found.occurredAt);
        if (!earliest || at < earliest.at || (at === earliest.at && found.id < earliest.id))
          earliest = { at, id: found.id };
        break;
      }
      if (!page.page.hasMore || !page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
  }
  return earliest && { from: new Date(earliest.at).toISOString(), observationId: earliest.id };
}

async function gatherState(
  client: PoolClient,
  leaf: CheckedRuleLeaf,
  subject: SubjectReference,
  cut: InputCut,
): Promise<GatheredState | undefined> {
  if (!leaf.subjectState) return undefined;
  const loader = subjectStateLoader(subject.kind);
  if (!loader) throw new Error(`No subject state is registered for subject kind ${subject.kind}`);
  // Only a Ledger subject has state; a subject a source names by its own id has none.
  const state = subject.scope === 'ledger' ? await loader(client, subject.id, { inputCut: cut }) : undefined;
  if (state && state.revision !== subjectStateRevision(state.state))
    throw new Error(`The ${subject.kind} state loader returned a revision that is not the digest of its state`);
  return { name: leaf.subjectState.name, kind: subject.kind, state };
}

/** The subject state as one observation, so checks and applicability read it like any input. */
function stateObservation(gathered: GatheredState, evaluatedAt: string): CheckObservation[] {
  if (!gathered.state) return [];
  return [
    {
      id: `subject-state:${gathered.kind}:${gathered.state.revision}`,
      type: `${gathered.kind}.state`,
      version: 1,
      occurredAt: evaluatedAt,
      observation: structuredClone(gathered.state.state),
    },
  ];
}

export function checkInputs(gathered: Gathered, evaluatedAt: string): CheckInputs {
  return Object.fromEntries([
    ...(gathered.state ? [[gathered.state.name, stateObservation(gathered.state, evaluatedAt)] as const] : []),
    ...gathered.reads.map((input) => [input.read.name, input.observations.map(checkObservation)] as const),
  ]);
}

/** What one gather reads for, when the leaf declares related subjects. */
export interface GatherContext {
  /** The related subject of each relation for this result; a read about a relation absent here is empty. */
  related: Record<string, SubjectReference>;
  /** Reads not about a related subject, already gathered at the same cut, reused instead of read again. */
  base?: Gathered;
  /** The from-read narrowed to the observations that named this result's subject. */
  narrow?: { read: string; ids: ReadonlySet<string> };
}

/** The capture sessions of an earlier gathered read. */
function sessionsOfRead(gathered: Gathered, name: string): CaptureSession[] {
  return sessionsOf(gathered.reads.find((input) => input.read.name === name)?.observations ?? []);
}

export async function gatherInputs(
  client: PoolClient,
  principal: AuthContext,
  leaf: CheckedRuleLeaf,
  subject: SubjectReference,
  organizationId: string,
  evaluatedAt: string,
  cut: InputCut,
  context?: GatherContext,
): Promise<Gathered> {
  const state = context?.base ? context.base.state : await gatherState(client, leaf, subject, cut);
  const gathered: Gathered = { reads: [], ...(state ? { state } : {}) };
  for (const read of leaf.reads) {
    const relation = relationOf(read);
    const reused = relation === undefined ? context?.base?.reads.find((input) => input.read === read) : undefined;
    if (reused) {
      const narrow = context?.narrow?.read === read.name ? context.narrow.ids : undefined;
      const observations = narrow ? reused.observations.filter((item) => narrow.has(item.id)) : reused.observations;
      gathered.reads.push({ ...reused, observations });
      continue;
    }
    const related = relation === undefined ? undefined : context?.related[relation];
    const about: SubjectReference =
      related ??
      (read.about === 'organization' ? { scope: 'ledger', kind: 'organization', id: organizationId } : subject);
    const earlier = checkInputs(gathered, evaluatedAt);
    const bound = readUpperBound(read, earlier);
    if (bound === null || (relation !== undefined && !related)) {
      gathered.reads.push({ read, observations: [], truncated: false, ...(related ? { subject: related } : {}) });
      continue;
    }
    // A read of plans also takes records about a time that has not come; any other read stops at the evaluation.
    const upTo = read.plans ? (bound ?? Date.parse(LATEST)) : Math.min(Date.parse(evaluatedAt), bound ?? Infinity);
    const to = new Date(upTo + 1).toISOString();
    // A read within a window starts at the window; any other read starts at the earliest time.
    const windowStart = readWindow(read, earlier)?.start;
    const from = windowStart === undefined ? EARLIEST : new Date(windowStart).toISOString();
    if (from >= to) {
      gathered.reads.push({ read, observations: [], truncated: false, ...(related ? { subject: related } : {}) });
      continue;
    }
    const observations: AcceptedObservation[] = [];
    let truncated = false;
    const fromRead = sessionReadOf(read);
    const sessions = fromRead === undefined ? [undefined] : sessionsOfRead(gathered, fromRead);
    if (sessions.length > SESSION_READ_LIMIT) {
      sessions.length = SESSION_READ_LIMIT;
      truncated = true;
    }
    for (const session of sessions)
      for (const version of read.versions) {
        const page = await readMatching(client, principal, about, read, version, to, cut, session, from);
        observations.push(...page.observations);
        truncated ||= page.truncated;
      }
    if (fromRead !== undefined && observations.length > OBSERVATION_PAGE_LIMIT) {
      observations.sort(newestFirst);
      observations.length = OBSERVATION_PAGE_LIMIT;
      truncated = true;
    }
    observations.sort(newestFirst);
    const byId = new Map(observations.map((item) => [item.id, item]));
    const selected = narrowRead(read, observations.map(checkObservation), earlier).map((item) => byId.get(item.id)!);
    // A required read that stopped at the evaluation is told apart from one with nothing on file at all.
    const evaluated = Date.parse(evaluatedAt);
    const later =
      read.required && !read.plans && !selected.length && !truncated && fromRead === undefined && upTo === evaluated
        ? await laterRecord(client, principal, about, read, evaluated, bound ?? Date.parse(LATEST), cut)
        : undefined;
    gathered.reads.push({
      read,
      observations: selected,
      truncated,
      ...(related ? { subject: related } : {}),
      ...(later ? { later } : {}),
    });
  }
  return gathered;
}

/**
 * The digest of what one evaluation read. Parts a rule does not use are left out, so evaluations of rules that use
 * none of them keep the digests they had.
 */
export function ruleEvaluationObservationDigest(parts: {
  adoptionId: string;
  pack: { id: string; version: number; digest: string };
  leaf: { id: string; version: number; digest: string };
  parameters: Record<string, unknown>;
  inputs: { name: string; observationIds: string[]; truncated: boolean; later?: string }[];
  subjectState?: { name: string; revision: string | null };
  related?: { name: string; subjectKey: string; namedBy: { observationId: string; field: string }[] };
  relatedSubjects?: { name: string; subjectKey: string }[];
  relatedProblem?: string;
  relief?: ReturnType<typeof reliefDigestPart>;
  adoptionDates?: { start: string; end: string };
  timeZone?: string;
}): string {
  return canonicalDigest({
    format: 'ledger.rule-evaluation-inputs.1',
    adoptionId: parts.adoptionId,
    pack: parts.pack,
    leaf: parts.leaf,
    parameters: parts.parameters,
    inputs: parts.inputs,
    ...(parts.subjectState ? { subjectState: parts.subjectState } : {}),
    ...(parts.related ? { related: parts.related } : {}),
    ...(parts.relatedSubjects ? { relatedSubjects: parts.relatedSubjects } : {}),
    ...(parts.relatedProblem ? { relatedProblem: parts.relatedProblem } : {}),
    ...(parts.relief ? { relief: parts.relief } : {}),
    ...(parts.adoptionDates ? { adoptionDates: parts.adoptionDates } : {}),
    ...(parts.timeZone ? { timeZone: parts.timeZone } : {}),
  });
}

/** When the earliest later record of each read that found one starts, by read name. */
export function laterRecords(gathered: Gathered): Record<string, string> {
  return Object.fromEntries(
    gathered.reads.flatMap((input) => (input.later ? [[input.read.name, input.later.from] as const] : [])),
  );
}

/** The records the reads that declare plans took about a time after the evaluation instant, if any. */
export function readAsPlans(gathered: Gathered, evaluatedAt: string): ReadAsPlans | undefined {
  const now = Date.parse(evaluatedAt);
  const planned = gathered.reads
    .filter((input) => input.read.plans)
    .flatMap((input) => input.observations)
    .filter((item) => Date.parse(item.interval?.start ?? item.occurredAt) > now);
  if (!planned.length) return undefined;
  const from = Math.min(...planned.map((item) => Date.parse(item.interval?.start ?? item.occurredAt)));
  return {
    from: new Date(from).toISOString(),
    observationIds: [...new Set(planned.map((item) => item.id))],
  };
}

function evidenceOf(gathered: Gathered, ids: string[]): RuleEvaluationRecord['evidence'] {
  const byId = new Map(gathered.reads.flatMap((input) => input.observations.map((item) => [item.id, item] as const)));
  return ids.flatMap((id) => {
    const observation = byId.get(id);
    return observation
      ? [
          {
            observationId: observation.id,
            eventId: observation.eventId,
            receiptId: observation.receiptId,
            sourceId: observation.sourceId,
            type: observation.type,
            version: observation.version,
            occurredAt: observation.occurredAt,
          },
        ]
      : [];
  });
}

/** The id of the finding for a rule and subject, and for one related subject when the rule fans out. */
export function findingIdFor(
  tenantId: string,
  subjectKey: string,
  packId: string,
  leafId: string,
  relatedKey = '',
): string {
  // Without a related subject the id is the one every existing finding has.
  if (!relatedKey)
    return `finding:${canonicalDigest({ tenant: tenantId, subjectKey, packId, leafId, scope: 'subject' })}`;
  return `finding:${canonicalDigest({ tenant: tenantId, subjectKey, packId, leafId, relatedKey, scope: 'related' })}`;
}

function relatedColumns(related: RuleEvaluationRecord['related']): unknown[] {
  if (!related) return [null, null, null, null, null];
  return [
    related.name,
    related.subject.scope,
    related.subject.kind,
    related.subject.id,
    related.subject.sourceId ?? null,
  ];
}

/**
 * Whether an evaluation asks a person for something: an answer that needs attention, or an issue it names. A relieved
 * answer asks nothing; what the rule found is kept under its relief.
 */
function needsAttention(record: RuleEvaluationRecord): boolean {
  if (record.outcome === 'relieved') return false;
  return record.outcome === 'attention' || Boolean(record.issues?.length);
}

/**
 * Whether an evaluation reopens a closed finding. A check that names issues reopens it only for an issue the
 * evaluation it was closed on did not name; any other check reopens it on any answer needing attention.
 */
async function reopens(client: PoolClient, findingId: string, record: RuleEvaluationRecord): Promise<boolean> {
  if (!needsAttention(record)) return false;
  if (!record.issues) return record.outcome === 'attention';
  const closedOn = (
    await client.query<{ issues: string[] | null }>(
      `SELECT r.record->'issues' AS issues FROM finding_views v
       JOIN rule_evaluations r ON r.tenant_id=v.tenant_id AND r.id=v.closing_rule_evaluation_id WHERE v.id=$1`,
      [findingId],
    )
  ).rows[0];
  if (!closedOn?.issues) return needsAttention(record);
  return record.issues.some((issue) => !closedOn.issues!.includes(issue));
}

/**
 * Whether a later evaluation answers an open finding, so that it closes by itself: its check now passes, naming
 * nothing, and it read at least one input the opening evaluation did not, every one of them of a type marked as a
 * record people keep. A pass that rests on a new measurement means the world moved on; what the finding reported still
 * happened, and a person closes it. A rule that no longer applies answers nothing either.
 */
async function answersFinding(client: PoolClient, findingId: string, record: RuleEvaluationRecord): Promise<boolean> {
  if (record.outcome !== 'pass' || record.issues?.length) return false;
  const opening = (
    await client.query<{ evidence: { observationId: string }[] | null }>(
      `SELECT r.record->'evidence' AS evidence FROM findings f
       JOIN rule_evaluations r ON r.tenant_id=f.tenant_id AND r.id=f.initial_rule_evaluation_id WHERE f.id=$1`,
      [findingId],
    )
  ).rows[0];
  const read = new Set((opening?.evidence ?? []).map((item) => item.observationId));
  const added = record.evidence.filter((item) => !read.has(item.observationId));
  return (
    added.length > 0 &&
    added.every((item) => findObservationType(observationRegistry(), item.type, item.version)?.keptRecord === true)
  );
}

async function updateFinding(
  client: PoolClient,
  tenantId: string,
  record: RuleEvaluationRecord,
  openedAt: Date,
): Promise<string | null> {
  const relatedKey = record.related?.subjectKey ?? '';
  const findingId = findingIdFor(tenantId, record.subjectKey, record.pack.id, record.rule.id, relatedKey);
  const previous = (
    await client.query<{ status: string }>('SELECT status FROM finding_views WHERE id=$1 FOR UPDATE', [findingId])
  ).rows[0];
  if (!previous) {
    if (!needsAttention(record)) return null;
    await client.query(
      `INSERT INTO findings(id,tenant_id,leaf_id,opened_at,subject_key,subject_scope,subject_kind,subject_id,
         subject_source_id,pack_id,initial_rule_evaluation_id,related_key,related_name,related_scope,related_kind,
         related_id,related_source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        findingId,
        tenantId,
        record.rule.id,
        openedAt,
        record.subjectKey,
        record.subject.scope,
        record.subject.kind,
        record.subject.id,
        record.subject.sourceId ?? null,
        record.pack.id,
        record.id,
        relatedKey,
        ...relatedColumns(record.related),
      ],
    );
    await client.query(
      `INSERT INTO finding_views(id,tenant_id,subject_key,latest_rule_evaluation_id,status,related_key)
       VALUES($1,$2,$3,$4,'open',$5)`,
      [findingId, tenantId, record.subjectKey, record.id, relatedKey],
    );
    return findingId;
  }
  const reopened = previous.status === 'resolved' && (await reopens(client, findingId, record));
  // A finding a later record people keep answers closes by itself, keeping the evaluation that closed it.
  const closed = previous.status !== 'resolved' && (await answersFinding(client, findingId, record));
  await client.query(
    `UPDATE finding_views SET latest_rule_evaluation_id=$1,
       status=CASE WHEN $2 THEN CASE WHEN owner_id IS NULL THEN 'open' ELSE 'acknowledged' END
         WHEN $3 THEN 'resolved' ELSE status END,
       closed_by=CASE WHEN $2 THEN NULL WHEN $3 THEN 'record' ELSE closed_by END,
       closed_at=CASE WHEN $2 THEN NULL WHEN $3 THEN $4 ELSE closed_at END,
       closing_rule_evaluation_id=CASE WHEN $2 THEN NULL WHEN $3 THEN $1 ELSE closing_rule_evaluation_id END
     WHERE id=$5`,
    [record.id, reopened, closed, openedAt, findingId],
  );
  return findingId;
}

/**
 * Whether a provision's result for a subject differs from its latest one under the same adoption, or is its first:
 * relief for the rules it relieves depends on that result (waiver-relief.ts).
 */
async function provisionResultChanged(
  client: PoolClient,
  tenantId: string,
  subjectKey: string,
  packId: string,
  leafId: string,
  relatedKey: string,
  adoptionId: string,
  result: Parameters<typeof provisionResultPart>[0],
): Promise<boolean> {
  const previous = (
    await client.query<{ outcome: string; evidence_state: string; reason_code: string; summary: string }>(
      `SELECT outcome,evidence_state,record->>'reasonCode' AS reason_code,record->>'summary' AS summary
       FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3 AND leaf_id=$4 AND related_key=$5
         AND adoption_id=$6 ORDER BY recorded_at DESC,id DESC LIMIT 1`,
      [tenantId, subjectKey, packId, leafId, relatedKey, adoptionId],
    )
  ).rows[0];
  if (!previous) return true;
  const before = {
    outcome: previous.outcome,
    evidenceState: previous.evidence_state,
    reasonCode: previous.reason_code,
    summary: previous.summary,
  };
  return canonicalDigest(before) !== canonicalDigest(provisionResultPart(result));
}

/**
 * Queues the rules a provision relieves for the subject its result changed for, so their relief follows the result
 * whichever of the two was evaluated first. A relieved rule about another kind of subject finds nothing to evaluate.
 */
async function queueRelievedRules(
  client: PoolClient,
  tenantId: string,
  subject: SubjectReference,
  leaf: CheckedRuleLeaf,
  eventId: string,
): Promise<void> {
  for (const relief of leaf.relieves ?? [])
    for (const ruleId of relief.ruleIds)
      await queueWork(client, tenantId, subject, relief.packId, ruleId, { kind: 'state', eventId });
}

/** Everything one evaluation of one adopted rule for one subject shares across the results it records. */
export interface EvaluationContext {
  principal: AuthContext;
  task: RuleEvaluationTask;
  subjectKey: string;
  organizationId: string;
  evaluatedAt: string;
  adoption: AdoptionRow;
  leaf: CheckedRuleLeaf;
  parameters: Record<string, unknown>;
  /** The waiver adoption in effect that relieves the rule, or would in shadow. */
  relief?: ReliefGrant;
}

/** One result to record: what it read and, when the engine decided it without the check, its outcome. */
export interface EvaluationResult {
  gathered: Gathered;
  cut: SubjectCut;
  related?: NonNullable<RuleEvaluationRecord['related']>;
  /** The related subjects of a result without fan-out, part of its digest. */
  relatedSubjects?: { name: string; subjectKey: string }[];
  outcome?: CheckedRuleOutcome;
  /** Ledger subjects besides the target whose evidence retains the evaluation. */
  retainFor?: string[];
}

/**
 * Records one result unless the latest result for the same subject, rule and related subject read the same inputs
 * and its answer cannot have changed: the journal event, the evaluation record, the finding, the subject's own view
 * and the next boundary. Returns null when nothing was recorded.
 */
export async function recordEvaluation(
  client: PoolClient,
  context: EvaluationContext,
  result: EvaluationResult,
): Promise<RuleEvaluationRecord | null> {
  const { principal, task, subjectKey, organizationId, evaluatedAt, adoption, leaf, parameters } = context;
  const tenantId = principal.tenantId;
  const timeZone = await organizationTimeZone(client, tenantId);
  const pack = adoption.record.pack;
  const relatedKey = result.related?.subjectKey ?? '';
  const { gathered } = result;
  const subjectState = gathered.state
    ? { name: gathered.state.name, revision: gathered.state.state?.revision ?? null }
    : undefined;
  const adoptionDates = findCheckKind(leaf.check.kind, leaf.check.version)?.adoptionDates
    ? { start: adoption.record.effectiveInterval.start, end: adoption.record.effectiveInterval.end }
    : undefined;
  const observationDigest = ruleEvaluationObservationDigest({
    adoptionId: adoption.id,
    pack: { id: pack.packId, version: pack.version, digest: pack.digest },
    leaf: { id: leaf.id, version: leaf.version, digest: leaf.digest },
    parameters,
    inputs: gathered.reads.map((input) => ({
      name: input.read.name,
      observationIds: input.observations.map((item) => item.id),
      truncated: input.truncated,
      ...(input.later ? { later: input.later.observationId } : {}),
    })),
    ...(subjectState ? { subjectState } : {}),
    ...(result.related
      ? { related: { name: result.related.name, subjectKey: relatedKey, namedBy: result.related.namedBy } }
      : {}),
    ...(result.relatedSubjects ? { relatedSubjects: result.relatedSubjects } : {}),
    ...(result.outcome && leaf.related ? { relatedProblem: result.outcome.reasonCode } : {}),
    ...(context.relief ? { relief: reliefDigestPart(context.relief) } : {}),
    ...(adoptionDates ? { adoptionDates } : {}),
    // The summary states its times in the organization's zone, so a changed zone evaluates the rule again.
    timeZone,
  });
  const latest = (
    await client.query<{
      id: string;
      same: boolean;
      next_boundary: Date | null;
      superseded: boolean;
      evaluated_before: boolean;
    }>(
      `SELECT l.id,(l.leaf_version=$5 AND l.observation_digest=$6) AS same,l.next_boundary,
         COALESCE(l.next_boundary<=$7::timestamptz,false) AS superseded,
         EXISTS(SELECT 1 FROM rule_evaluations p WHERE p.tenant_id=$1 AND p.subject_key=$2 AND p.pack_id=$3
           AND p.leaf_id=$4 AND p.related_key=$8 AND p.leaf_version=$5 AND p.observation_digest=$6) AS evaluated_before
       FROM rule_evaluations l WHERE l.tenant_id=$1 AND l.subject_key=$2 AND l.pack_id=$3 AND l.leaf_id=$4
         AND l.related_key=$8
       ORDER BY l.recorded_at DESC,l.id DESC LIMIT 1`,
      [tenantId, subjectKey, pack.packId, leaf.id, leaf.version, observationDigest, evaluatedAt, relatedKey],
    )
  ).rows[0];
  // The same inputs as the latest evaluation give its answer until the boundary it named. Inputs that only an
  // earlier evaluation read are evaluated again, so the latest evaluation always reads the current inputs.
  if (latest?.same && !latest.superseded) return null;
  // Returning to inputs evaluated before starts an epoch named by the evaluation it follows, so it is recorded anew.
  const epoch = latest?.same
    ? (latest.next_boundary?.toISOString() ?? null)
    : latest?.evaluated_before
      ? latest.id
      : null;
  const inputDigest = canonicalDigest({ observationDigest, epoch });
  const clock: CheckClock = { mode: 'wall', evaluatedAt, timeZone };
  const inputs = checkInputs(gathered, evaluatedAt);
  const truncated = gathered.reads.filter((input) => input.truncated).map((input) => input.read.name);
  const plans = readAsPlans(gathered, evaluatedAt);
  const outcome: CheckedRuleOutcome =
    result.outcome ??
    (truncated.length
      ? {
          applicability: 'applicable',
          evidenceState: 'insufficient',
          outcome: 'pending',
          reasonCode: 'input_limit_exceeded',
          summary: `More observations are recorded for ${truncated.join(', ')} than one evaluation reads.`,
          evidence: [],
        }
      : runCheckedRule(
          leaf,
          parameters,
          inputs,
          adoptionDates ? { ...clock, adoption: adoptionDates } : clock,
          laterRecords(gathered),
        ));
  const answer = relievedAnswer(outcome, context.relief);
  const provisionChanged = leaf.relieves?.length
    ? await provisionResultChanged(client, tenantId, subjectKey, pack.packId, leaf.id, relatedKey, adoption.id, {
        outcome: answer.outcome,
        evidenceState: outcome.evidenceState,
        reasonCode: answer.reasonCode,
        summary: answer.summary,
      })
    : false;
  const id = randomUUID();
  const evaluation: Omit<RuleEvaluationRecord, 'recordedAt'> = {
    version: 'ledger.rule-evaluation.1',
    id,
    subject: { ...task.subject },
    subjectKey,
    organizationId,
    adoption: {
      id: adoption.id,
      acceptedRevision: adoption.record.acceptedRevision,
      effectiveInterval: { ...adoption.record.effectiveInterval },
      mode: adoptionMode(adoption.record),
    },
    pack: { id: pack.packId, version: pack.version, digest: pack.digest },
    rule: {
      id: leaf.id,
      version: leaf.version,
      digest: leaf.digest,
      title: leaf.title,
      source: {
        kind: leaf.source.kind,
        reference: leaf.source.reference,
        text: leaf.source.text,
        sha256: leaf.source.sha256,
      },
    },
    check: { kind: leaf.check.kind, version: leaf.check.version, definitionDigest: leaf.check.definitionDigest },
    parameters,
    applicability: outcome.applicability,
    evidenceState: outcome.evidenceState,
    outcome: answer.outcome,
    reasonCode: answer.reasonCode,
    summary: localizeInstants(answer.summary, timeZone),
    ...(outcome.details ? { details: outcome.details } : {}),
    ...(answer.issues ? { issues: answer.issues } : {}),
    ...(answer.issueTimes ? { issueTimes: answer.issueTimes } : {}),
    evidence: evidenceOf(gathered, outcome.evidence),
    inputs: gathered.reads.map((input) => ({
      name: input.read.name,
      type: input.read.type,
      about: input.read.about,
      ...(input.subject ? { subject: { ...input.subject } } : {}),
      required: input.read.required,
      observationIds: input.observations.map((item) => item.id),
      truncated: input.truncated,
      ...(input.later ? { later: { from: input.later.from, observationIds: [input.later.observationId] } } : {}),
    })),
    ...(result.related ? { related: result.related } : {}),
    ...(answer.relief ? { relief: answer.relief } : {}),
    ...(plans ? { readAsPlans: plans } : {}),
    // The projection may keep only current state, so the record holds the content the rule read.
    ...(gathered.state && subjectState
      ? {
          subjectState: {
            ...subjectState,
            kind: gathered.state.kind,
            state: gathered.state.state ? { ...gathered.state.state.state } : null,
          },
        }
      : {}),
    clock,
    ...(answer.nextBoundary ? { nextBoundary: answer.nextBoundary } : {}),
    trigger:
      task.trigger.kind === 'deadline'
        ? { kind: 'deadline', eventId: task.trigger.eventId, dueAt: task.trigger.dueAt }
        : { kind: task.trigger.kind, eventId: task.trigger.eventId },
    inputCut: result.cut.inputCut,
    dependencyBasis: result.cut.dependencyBasis,
    observationDigest,
    inputDigest,
  };
  const event = await appendEvent(client, principal, {
    id,
    type: 'rule-evaluation.recorded',
    stream: `rule-evaluation:${subjectKey}`,
    causationId: task.trigger.eventId,
    payload: { evaluation },
  });
  const record: RuleEvaluationRecord = { ...evaluation, recordedAt: event.received_at.toISOString() };
  await client.query(
    `INSERT INTO rule_evaluations(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,subject_source_id,
       organization_id,adoption_id,pack_id,pack_version,leaf_id,leaf_version,leaf_digest,check_kind,check_version,
       check_digest,observation_digest,input_digest,evidence_state,outcome,evaluated_at,next_boundary,recorded_at,record,
       related_key,related_name,related_scope,related_kind,related_id,related_source_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
    [
      id,
      tenantId,
      subjectKey,
      task.subject.scope,
      task.subject.kind,
      task.subject.id,
      task.subject.sourceId ?? null,
      organizationId,
      adoption.id,
      pack.packId,
      pack.version,
      leaf.id,
      leaf.version,
      leaf.digest,
      leaf.check.kind,
      leaf.check.version,
      leaf.check.definitionDigest,
      observationDigest,
      inputDigest,
      record.evidenceState,
      record.outcome,
      evaluatedAt,
      record.nextBoundary ?? null,
      event.received_at,
      record,
      relatedKey,
      ...relatedColumns(record.related),
    ],
  );
  const retained = [...(task.subject.scope === 'ledger' ? [task.subject.id] : []), ...(result.retainFor ?? [])];
  await retainSubjectEvidence(client, tenantId, retained, event);
  const findingId = await updateFinding(client, tenantId, record, event.received_at);
  // The module that owns the subject's kind shows the evaluation and its finding on the subject itself.
  if (task.subject.scope === 'ledger')
    await subjectFindingView(task.subject.kind)?.recorded(client, principal, task.subject.id, record, event, findingId);
  if (provisionChanged) await queueRelievedRules(client, tenantId, task.subject, leaf, event.id);
  if (record.nextBoundary)
    await queueWork(client, tenantId, task.subject, pack.packId, leaf.id, {
      kind: 'deadline',
      eventId: event.id,
      dueAt: record.nextBoundary,
    });
  // The evaluation is its own projection; it commits with its stream position under the worker fence.
  await client.query(
    `INSERT INTO projection_offsets(tenant_id,stream_id,sequence,projector_version) VALUES($1,$2,$3,'rule-evaluations.1')
     ON CONFLICT(tenant_id,stream_id) DO UPDATE SET sequence=EXCLUDED.sequence,projector_version=EXCLUDED.projector_version`,
    [tenantId, event.stream_id, event.stream_sequence],
  );
  await client.query(
    "UPDATE work_items SET state='completed',completed_at=clock_timestamp() WHERE event_id=$1 AND state='pending' AND generation=0",
    [event.id],
  );
  await client.query('INSERT INTO view_changes(tenant_id,event_id) VALUES($1,$2)', [tenantId, event.id]);
  return record;
}

/**
 * Evaluates one adopted rule for one subject reference at the subject's current evidence cut, records the result
 * as a journal event and an evaluation record, opens or updates the finding, and schedules the next boundary. A rule
 * that declares related subjects records a result per related subject (related-subject-evaluation.ts).
 * Returns null when no adoption in effect holds the rule, or when the latest evaluation read the same inputs and its
 * answer cannot have changed since.
 */
export async function evaluateAdoptedRule(
  client: PoolClient,
  principal: AuthContext,
  task: RuleEvaluationTask,
): Promise<RuleEvaluationRecord | null> {
  const tenantId = principal.tenantId;
  const subjectKey = subjectReferenceKey(task.subject);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `rule-evaluation:${canonicalDigest({ tenantId, subjectKey, packId: task.packId, leafId: task.leafId })}`,
  ]);
  const evaluatedAt = await now(client);
  const organizationId = organizationIdOf(tenantId);
  const inEffect = await adoptionsInEffect(client, tenantId, evaluatedAt);
  const adoption = inEffect.find((row) => row.record.pack.packId === task.packId);
  const leaf = adoption?.record.pack.leaves.filter(isCheckedRuleLeaf).find((candidate) => candidate.id === task.leafId);
  if (!adoption || !leaf || leaf.target.subjectKind !== task.subject.kind) return null;
  const relieved = { packId: task.packId, ruleId: task.leafId, subjectKind: leaf.target.subjectKind };
  const provisions = coveringProvisions(inEffect, relieved);
  const relief = reliefFor(
    inEffect,
    relieved,
    provisions.length ? await readProvisionResults(client, tenantId, subjectKey, provisions) : undefined,
  );
  // The module that owns the subject's kind locks its record first, in the order its own commands lock, so the
  // evaluation and a concurrent command on the subject cannot deadlock.
  if (task.subject.scope === 'ledger')
    await subjectFindingView(task.subject.kind)?.lockSubject?.(client, task.subject.id);
  const cut = await subjectCut(client, principal, task.subject, organizationId);
  const context: EvaluationContext = {
    principal,
    task,
    subjectKey,
    organizationId,
    evaluatedAt,
    adoption,
    leaf,
    parameters: checkParameters(leaf, adoption.record.parameters),
    ...(relief ? { relief } : {}),
  };
  if (leaf.related || leaf.reads.some(referencingField)) return evaluateWithRelatedSubjects(client, context, cut);
  if (leaf.reads.some((read) => sessionReadOf(read) !== undefined))
    return recordEvaluation(client, context, await gatherWithSessions(client, context, cut));
  const gathered = await gatherInputs(client, principal, leaf, task.subject, organizationId, evaluatedAt, cut.inputCut);
  return recordEvaluation(client, context, { gathered, cut });
}

// A cut widened by the capture sessions read is read again at most this many times; each round only adds positions.
const SESSION_CUT_ROUNDS = 3;

/**
 * Reads at the subject's cut, then again at a cut widened by the streams of the capture sessions read, until the
 * cut holds them. Every read of the result is taken at the one cut it records.
 */
async function gatherWithSessions(
  client: PoolClient,
  context: EvaluationContext,
  targetCut: SubjectCut,
): Promise<{ gathered: Gathered; cut: SubjectCut }> {
  const { principal, leaf, task, organizationId, evaluatedAt } = context;
  let cut = targetCut;
  let gathered = await gatherInputs(client, principal, leaf, task.subject, organizationId, evaluatedAt, cut.inputCut);
  for (let round = 0; round < SESSION_CUT_ROUNDS; round++) {
    const wider = await widenedBySessions(client, principal.tenantId, leaf, sessionsRead(leaf, gathered.reads), cut);
    if (!wider) break;
    cut = wider;
    gathered = await gatherInputs(client, principal, leaf, task.subject, organizationId, evaluatedAt, cut.inputCut);
  }
  return { gathered, cut };
}

/**
 * Queues, for each rule in effect that reads the type by capture session, the other subjects of its target kind the
 * session reported about: which report of a session came first can change for them.
 */
async function queueSessionSubjects(
  client: PoolClient,
  tenantId: string,
  adoptions: AdoptionRow[],
  session: CaptureSession,
  observation: QueuedObservation,
  trigger: RuleEvaluationTrigger,
): Promise<number> {
  let queued = 0;
  for (const adoption of adoptions)
    for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
      const reads = leaf.reads.filter((read) => sessionReadOf(read) !== undefined && readTakes(read, observation));
      if (!reads.length) continue;
      for (const subject of await subjectsInSession(
        client,
        tenantId,
        session,
        observation.type,
        leaf.target.subjectKind,
      )) {
        await queueWork(client, tenantId, subject, adoption.record.pack.packId, leaf.id, trigger);
        queued++;
      }
    }
  return queued;
}

/**
 * Queues the checked rule of the given id about the subject's kind, in the adoption in effect for each pack that holds
 * it. Used for retained evaluation work that names a rule; where no adoption in effect holds it, nothing is queued.
 */
export async function queueAdoptedRuleEvaluations(
  client: PoolClient,
  tenantId: string,
  subject: SubjectReference,
  trigger: RuleEvaluationTrigger,
  leafId: string,
): Promise<number> {
  let queued = 0;
  for (const adoption of await adoptionsForQueueing(client, tenantId))
    for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
      if (leaf.target.subjectKind !== subject.kind || leaf.id !== leafId) continue;
      await queueWork(client, tenantId, subject, adoption.record.pack.packId, leaf.id, trigger);
      queued++;
    }
  return queued;
}
