import { randomUUID } from 'node:crypto';
import {
  isCheckedRuleLeaf,
  POPULATION_LIMIT,
  subjectReferenceKey,
  type CheckedRuleLeaf,
  type PackAdoptionAcceptance,
  type RuleRead,
  type SubjectReference,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import { observationMatches } from './check-kinds.js';
import { currentRole, referencedSubjects } from './related-subject-queueing.js';
import { referencingField } from './related-subjects.js';
import { populationPage, populationScope } from './rule-populations.js';

/**
 * Queueing when an adoption takes effect. Each checked rule of the adoption is queued for the subjects already on
 * record that it would evaluate: for a revision, the subjects it evaluated; for a successor, the subjects of its kind
 * that the pack's earlier version evaluated; and for every adoption, the subjects of current observations it reads
 * whose time falls within the adoption's effective interval; and for a rule that declares a population, its members,
 * at most POPULATION_LIMIT of them (docs/design/rule-coverage.md). The work is taken a page at a time in a fixed
 * order: an 'adoption-page' work row names the step and position from which a worker queues the next page.
 *
 * An adoption whose rules relieve rules of another pack (docs/design/waiver-relief.md) also queues each relieved rule,
 * under the relieved pack, for the subjects that rule has evaluated: relief starting, changing mode or moving to a
 * later version changes their answer although no record about them changed.
 *
 * What is queued depends only on what is recorded, never on the order in which the queued evaluations run: each one
 * reads everything recorded about its subject at its own cut, so the same records give the same evaluations.
 */

/** Subjects one transaction queues for one rule; the rest continue in a later one. */
export const ADOPTION_QUEUE_PAGE = 500;

/** Where queueing for one rule of an adoption stands: the step, and the last key queued within it. */
export interface AdoptionPagePosition {
  step: number;
  after: string;
  /** Members of the population queued so far, for the population step. */
  queued?: number;
}

type Step =
  | { kind: 'evaluated'; leafId: string }
  | { kind: 'evaluated'; subjectKind: SubjectReference['kind'] }
  | { kind: 'recorded'; read: RuleRead; version: number }
  | { kind: 'population' };

/** Queues one evaluation of the rule for one subject under the adoption's trigger; a subject is queued once. */
type Queue = (subject: SubjectReference) => Promise<void>;

/** A read whose observations name the subjects the rule evaluates: about the target, or by a reference to it. */
function namesTargets(leaf: CheckedRuleLeaf, read: RuleRead): boolean {
  if (referencingField(read) !== undefined) return true;
  return read.about === 'target' || (read.about === 'organization' && leaf.target.subjectKind === 'organization');
}

/** The steps queueing takes for one rule of an adoption, in a fixed order. */
export function adoptionSteps(adoption: PackAdoptionAcceptance, leaf: CheckedRuleLeaf): Step[] {
  const evaluated: Step[] = adoption.revises
    ? [{ kind: 'evaluated', leafId: leaf.id }]
    : adoption.succeeds
      ? [{ kind: 'evaluated', subjectKind: leaf.target.subjectKind }]
      : [];
  const recorded = leaf.reads
    .filter((read) => namesTargets(leaf, read))
    .flatMap((read) => read.versions.map((version): Step => ({ kind: 'recorded', read, version })));
  return [...evaluated, ...recorded, ...(leaf.population ? [{ kind: 'population' } as const] : [])];
}

/** One entry of a page: its position key and the subjects it names. */
interface PageEntry {
  key: string;
  subjects: SubjectReference[];
}

interface EvaluatedRow {
  subject_key: string;
  subject_scope: SubjectReference['scope'];
  subject_kind: SubjectReference['kind'];
  subject_id: string;
  subject_source_id: string | null;
}

async function evaluatedPage(
  client: PoolClient,
  tenantId: string,
  packId: string,
  step: Extract<Step, { kind: 'evaluated' }>,
  after: string,
  limit: number,
): Promise<PageEntry[]> {
  const rows = await client.query<EvaluatedRow>(
    `SELECT DISTINCT ON(subject_key) subject_key,subject_scope,subject_kind,subject_id,subject_source_id
     FROM rule_evaluations WHERE tenant_id=$1 AND pack_id=$2
       AND (CASE WHEN $3::text IS NULL THEN subject_kind=$4 ELSE leaf_id=$3 END) AND subject_key>$5
     ORDER BY subject_key LIMIT $6`,
    [
      tenantId,
      packId,
      'leafId' in step ? step.leafId : null,
      'subjectKind' in step ? step.subjectKind : null,
      after,
      limit,
    ],
  );
  return rows.rows.map((row) => ({
    key: row.subject_key,
    subjects: [
      row.subject_scope === 'source'
        ? { scope: 'source', kind: row.subject_kind, id: row.subject_id, sourceId: row.subject_source_id! }
        : { scope: 'ledger', kind: row.subject_kind, id: row.subject_id },
    ],
  }));
}

interface RecordedRow {
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
}

/** The subjects of the target's kind an observation is about, after subject resolutions. */
function targetsOf(row: RecordedRow, kind: SubjectReference['kind']): SubjectReference[] {
  const roles = [
    [row.subject_kind, row.subject_id, row.subject_current],
    [row.secondary_subject_kind, row.secondary_subject_id, row.secondary_current],
  ] as const;
  return roles
    .filter(([roleKind]) => roleKind === kind)
    .map(([, id, current]) =>
      current ? { scope: 'ledger', kind, id: current } : { scope: 'source', kind, id: id!, sourceId: row.source_id },
    );
}

/**
 * One page of current observations of the step's type and version whose time overlaps the adoption's effective
 * interval, ordered by id, and the subjects of the rule's target kind they name.
 */
async function recordedPage(
  client: PoolClient,
  tenantId: string,
  adoption: PackAdoptionAcceptance,
  leaf: CheckedRuleLeaf,
  step: Extract<Step, { kind: 'recorded' }>,
  after: string,
  limit: number,
): Promise<PageEntry[]> {
  const rows = await client.query<RecordedRow>(
    `SELECT o.id,o.observation_type,o.observation_version,o.occurred_at,o.observation,o.source_id,o.subject_kind,
       o.subject_id,${currentRole('subject', 'subject')} AS subject_current,o.secondary_subject_kind,
       o.secondary_subject_id,${currentRole('secondary_subject', 'secondarySubject')} AS secondary_current
     FROM observations o
     WHERE o.tenant_id=$1 AND o.observation_type=$2 AND o.observation_version=$3 AND o.id>$4
       AND COALESCE(o.interval_start,o.occurred_at)<$6::timestamptz
       AND COALESCE(o.interval_end,o.interval_start,o.occurred_at)>=$5::timestamptz
       AND NOT EXISTS(SELECT 1 FROM observations rep WHERE rep.tenant_id=o.tenant_id AND rep.replaces_observation_id=o.id)
       AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)
     ORDER BY o.id LIMIT $7`,
    [
      tenantId,
      step.read.type,
      step.version,
      after,
      adoption.effectiveInterval.start,
      adoption.effectiveInterval.end,
      limit,
    ],
  );
  const kind = leaf.target.subjectKind;
  const field = referencingField(step.read);
  const entries: PageEntry[] = [];
  for (const row of rows.rows) {
    const content = {
      id: row.id,
      type: row.observation_type,
      version: row.observation_version,
      occurredAt: row.occurred_at.toISOString(),
      observation: row.observation,
    };
    const subjects = !observationMatches(content, step.read.where)
      ? []
      : field === undefined
        ? targetsOf(row, kind)
        : await referencedSubjects(client, tenantId, row.id, field, kind);
    entries.push({ key: row.id, subjects });
  }
  return entries;
}

/** The rules of other packs an adoption's rules relieve, each once, as pack id and rule id. */
function relievedRules(adoption: PackAdoptionAcceptance): { packId: string; leafId: string }[] {
  const keys = new Set<string>();
  return adoption.pack.leaves.filter(isCheckedRuleLeaf).flatMap((leaf) =>
    (leaf.relieves ?? []).flatMap((relief) =>
      relief.ruleIds.flatMap((leafId) => {
        const key = JSON.stringify([relief.packId, leafId]);
        if (keys.has(key)) return [];
        keys.add(key);
        return [{ packId: relief.packId, leafId }];
      }),
    ),
  );
}

/** Inserts the work row from which a worker queues the page at the position, once. */
async function queuePage(
  client: PoolClient,
  tenantId: string,
  adoption: { id: string; record: PackAdoptionAcceptance },
  leafId: string,
  position: AdoptionPagePosition,
  packId = adoption.record.pack.packId,
): Promise<void> {
  const organizationId = adoption.record.organizationId;
  await client.query(
    `INSERT INTO rule_evaluation_work(id,tenant_id,subject_key,subject_scope,subject_kind,subject_id,subject_source_id,
       pack_id,leaf_id,trigger_kind,trigger_event_id,due_at,available_at,continuation)
     VALUES($1,$2,$3,'ledger','organization',$4,NULL,$5,$6,'adoption-page',$7,
       GREATEST(clock_timestamp(),$8::timestamptz),GREATEST(clock_timestamp(),$8::timestamptz),$9) ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      tenantId,
      subjectReferenceKey({ scope: 'ledger', kind: 'organization', id: organizationId }),
      organizationId,
      packId,
      leafId,
      adoption.id,
      adoption.record.effectiveInterval.start,
      position,
    ],
  );
}

/**
 * Starts queueing for an adoption that takes effect: one work row per checked rule with anything to queue, due when
 * the adoption starts. Called when the adoption is projected.
 */
export async function startAdoptionQueueing(
  client: PoolClient,
  tenantId: string,
  adoption: { id: string; record: PackAdoptionAcceptance },
): Promise<number> {
  let started = 0;
  for (const leaf of adoption.record.pack.leaves.filter(isCheckedRuleLeaf)) {
    if (!adoptionSteps(adoption.record, leaf).length) continue;
    await queuePage(client, tenantId, adoption, leaf.id, { step: 0, after: '' });
    started++;
  }
  for (const relieved of relievedRules(adoption.record)) {
    await queuePage(client, tenantId, adoption, relieved.leafId, { step: 0, after: '' }, relieved.packId);
    started++;
  }
  return started;
}

/**
 * Queues one page of subjects for one rule of an adoption from the position an 'adoption-page' work row carries, and
 * the row for the next page when more remain. Returns the number of subjects queued.
 */
export async function continueAdoptionQueueing(
  client: PoolClient,
  tenantId: string,
  adoption: { id: string; record: PackAdoptionAcceptance },
  rule: { packId: string; leafId: string },
  position: AdoptionPagePosition,
  queue: Queue,
  limit = ADOPTION_QUEUE_PAGE,
  bound = POPULATION_LIMIT,
): Promise<number> {
  const { packId, leafId } = rule;
  const own = packId === adoption.record.pack.packId;
  const leaf = own
    ? adoption.record.pack.leaves.filter(isCheckedRuleLeaf).find((candidate) => candidate.id === leafId)
    : undefined;
  const relieved =
    !own && relievedRules(adoption.record).some((item) => item.packId === packId && item.leafId === leafId);
  // A relieved rule of another pack is queued for the subjects it has evaluated.
  const steps: Step[] = leaf ? adoptionSteps(adoption.record, leaf) : relieved ? [{ kind: 'evaluated', leafId }] : [];
  const step = steps[position.step];
  if (!step) return 0;
  if (step.kind === 'population')
    return leaf ? continuePopulation(client, tenantId, adoption, leaf, position, queue, limit, bound) : 0;
  const page =
    step.kind === 'evaluated'
      ? await evaluatedPage(client, tenantId, packId, step, position.after, limit + 1)
      : await recordedPage(client, tenantId, adoption.record, leaf!, step, position.after, limit + 1);
  const entries = page.slice(0, limit);
  const unique = new Map(
    entries.flatMap((entry) => entry.subjects).map((subject) => [subjectReferenceKey(subject), subject]),
  );
  for (const subject of unique.values()) await queue(subject);
  if (page.length > limit)
    await queuePage(client, tenantId, adoption, leafId, { step: position.step, after: entries.at(-1)!.key }, packId);
  else if (position.step + 1 < steps.length)
    await queuePage(client, tenantId, adoption, leafId, { step: position.step + 1, after: '' }, packId);
  return unique.size;
}

/**
 * Queues one page of a rule's population members, and the row for the next page while more remain and fewer than
 * the bound (POPULATION_LIMIT) are queued. Above it nothing more is queued; the coverage read says the count is
 * incomplete.
 */
async function continuePopulation(
  client: PoolClient,
  tenantId: string,
  adoption: { id: string; record: PackAdoptionAcceptance },
  leaf: CheckedRuleLeaf,
  position: AdoptionPagePosition,
  queue: Queue,
  limit: number,
  bound: number,
): Promise<number> {
  const scope = populationScope(tenantId, adoption.record, leaf)!;
  const before = position.queued ?? 0;
  const wanted = Math.min(limit, bound - before);
  if (wanted <= 0) return 0;
  const page = await populationPage(client, scope, position.after, wanted + 1);
  const members = page.slice(0, wanted);
  for (const member of members) await queue(member.subject);
  if (page.length > wanted && before + members.length < bound)
    await queuePage(client, tenantId, adoption, leaf.id, {
      step: position.step,
      after: members.at(-1)!.position,
      queued: before + members.length,
    });
  return members.length;
}
