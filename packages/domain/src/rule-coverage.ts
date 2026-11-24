import {
  adoptionMode,
  COVERAGE_PAGE_LIMIT,
  coverageCheckedByValues,
  coverageResultValues,
  isCheckedRuleLeaf,
  POPULATION_LIMIT,
  RECORD_NOT_ON_FILE,
  subjectReferenceKey,
  type AdoptionRuleCoverageResponse,
  type CheckedRuleLeaf,
  type CoverageCheckedBy,
  type CoverageCounts,
  type CoverageResult,
  type CoverageSection,
  type PackAdoptionAcceptance,
  type RuleCoverage,
  type RuleCoverageSubject,
  type RuleCoverageSubjectsQuery,
  type RuleCoverageSubjectsResponse,
  type RulePackLeaf,
  type RulePackSection,
  type SubjectReference,
  type SubjectsOnRecordQuery,
  type SubjectsOnRecordResponse,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { findingIdFor } from './rule-evaluations.js';
import { sectionsOf } from './rule-pack-sections.js';
import { populationMembers, populationPosition, type PopulationMember } from './rule-populations.js';
import { subjectNames } from './subject-names.js';

/**
 * Coverage by rule and subject (docs/design/rule-coverage.md): for each rule of an adoption, its members counted by
 * their latest evaluation under that adoption, and the members behind each count. Reads only: no row or advisory
 * locks, so a read at REPEATABLE READ never conflicts with the work it reports on.
 */

/** The latest evaluation of one result of a rule for one member: the target's, or one related subject's. */
export interface LatestResult {
  id: string;
  related: boolean;
  outcome: string;
  evidenceState: string;
  reasonCode: string;
  summary: string;
  recordedAt: string;
  inputs: { name: string; observationIds: string[] }[];
  relatedKey: string;
}

// The order in which results of related subjects stand for their target: the one asking most of a person first.
const PRECEDENCE: readonly CoverageResult[] = [
  'attention',
  'no_record',
  'pending',
  'other',
  'relieved',
  'supported',
  'not_applicable',
];

/** What one latest evaluation counts as; a result this code does not know is counted as other. */
export function resultOf(result: Pick<LatestResult, 'outcome' | 'reasonCode'>): CoverageResult {
  if (result.outcome === 'pass') return 'supported';
  if (result.outcome === 'attention') return 'attention';
  if (result.outcome === 'pending') return result.reasonCode === RECORD_NOT_ON_FILE ? 'no_record' : 'pending';
  if (result.outcome === 'not_applicable') return 'not_applicable';
  if (result.outcome === 'relieved') return 'relieved';
  return 'other';
}

/**
 * The latest result that stands for a member: the target's own, or, for a rule that evaluated it per related subject,
 * the related result asking most of a person. Undefined when the member has no evaluation.
 */
export function standingResult(results: readonly LatestResult[]): LatestResult | undefined {
  const target = results.find((result) => !result.related);
  const related = results.filter((result) => result.related && result.reasonCode !== 'related_subject_not_named');
  if (target && (target.reasonCode !== 'evaluated_per_related_subject' || !related.length)) return target;
  return [...related].sort(
    (a, b) =>
      PRECEDENCE.indexOf(resultOf(a)) - PRECEDENCE.indexOf(resultOf(b)) || (a.relatedKey < b.relatedKey ? -1 : 1),
  )[0];
}

/** The records a rule requires that a result found not on file, in the words the rule gives them. */
export function missingRecords(leaf: CheckedRuleLeaf, result: LatestResult | undefined): string[] {
  if (!result || result.reasonCode !== RECORD_NOT_ON_FILE) return [];
  return leaf.reads.flatMap((read) => {
    const input = result.inputs.find((item) => item.name === read.name);
    return read.required && read.onFile && input && !input.observationIds.length ? [read.onFile] : [];
  });
}

export function emptyCounts(): CoverageCounts {
  return Object.fromEntries(coverageResultValues.map((value) => [value, 0])) as CoverageCounts;
}

/** Counts members by the result that stands for each. */
export function countResults(results: readonly (LatestResult | undefined)[]): CoverageCounts {
  const counts = emptyCounts();
  for (const result of results) counts[result ? resultOf(result) : 'not_evaluated'] += 1;
  return counts;
}

export function checkedBy(leaf: RulePackLeaf): CoverageCheckedBy {
  return leaf.coverage === 'automated' ? 'automatic' : leaf.coverage === 'manual' ? 'person' : 'not_supported';
}

/** A section's heading counts: its rules by how they are checked, and how many need attention or lack a record. */
export function sectionCounts(section: RulePackSection, rules: readonly RuleCoverage[]): CoverageSection {
  const checked = Object.fromEntries(
    coverageCheckedByValues.map((value) => [value, 0]),
  ) as CoverageSection['checkedBy'];
  for (const rule of rules) checked[rule.checkedBy] += 1;
  return {
    id: section.id,
    title: section.title,
    leafIds: rules.map((rule) => rule.leafId),
    checkedBy: checked,
    needingAttention: rules.filter((rule) => (rule.counts?.attention ?? 0) > 0).length,
    withNoRecord: rules.filter((rule) => (rule.counts?.no_record ?? 0) > 0).length,
  };
}

interface AdoptionRow {
  id: string;
  record: PackAdoptionAcceptance;
}

async function adoptionOf(client: PoolClient, principal: AuthContext, adoptionId: string): Promise<AdoptionRow> {
  const row = (
    await client.query<AdoptionRow>('SELECT id,record FROM organization_pack_adoptions WHERE tenant_id=$1 AND id=$2', [
      principal.tenantId,
      adoptionId,
    ])
  ).rows[0];
  if (!row) throw new DomainError(404, 'adoption_not_found', 'The adoption was not found within your scope');
  return row;
}

function requireEvidenceRead(principal: AuthContext): void {
  if (!principal.capabilities.includes('evidence:read'))
    throw new DomainError(403, 'forbidden', 'Coverage requires evidence:read');
}

/**
 * The members a rule is counted over, at most one more than the limit: its declared population, or without one the
 * subjects it has evaluated under the adoption.
 */
async function membersOf(
  client: PoolClient,
  tenantId: string,
  adoption: AdoptionRow,
  leaf: CheckedRuleLeaf,
  bound: number,
): Promise<PopulationMember[]> {
  if (leaf.population)
    return populationMembers(
      client,
      {
        tenantId,
        kind: leaf.target.subjectKind,
        population: leaf.population,
        interval: adoption.record.effectiveInterval,
      },
      bound + 1,
    );
  const rows = await client.query<{
    subject_scope: SubjectReference['scope'];
    subject_id: string;
    subject_source_id: string | null;
  }>(
    `SELECT DISTINCT subject_scope,subject_id,subject_source_id FROM rule_evaluations
     WHERE tenant_id=$1 AND adoption_id=$2 AND pack_id=$3 AND leaf_id=$4`,
    [tenantId, adoption.id, adoption.record.pack.packId, leaf.id],
  );
  return rows.rows
    .map((row): PopulationMember => {
      const subject: SubjectReference =
        row.subject_scope === 'source'
          ? { scope: 'source', kind: leaf.target.subjectKind, id: row.subject_id, sourceId: row.subject_source_id! }
          : { scope: 'ledger', kind: leaf.target.subjectKind, id: row.subject_id };
      return { subject, position: populationPosition(subject) };
    })
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .slice(0, bound + 1);
}

/** The latest results of a rule under the adoption for each member, by subject key. */
async function latestResults(
  client: PoolClient,
  tenantId: string,
  adoption: AdoptionRow,
  leafId: string,
  members: readonly PopulationMember[],
): Promise<Map<string, LatestResult[]>> {
  const keys = members.map((member) => subjectReferenceKey(member.subject));
  const byKey = new Map<string, LatestResult[]>();
  if (!keys.length) return byKey;
  const rows = await client.query<{
    subject_key: string;
    related_key: string;
    id: string;
    outcome: string;
    evidence_state: string;
    reason_code: string;
    summary: string;
    inputs: { name: string; observationIds: string[] }[];
    recorded_at: Date;
  }>(
    `SELECT DISTINCT ON(subject_key,related_key) subject_key,related_key,id,outcome,evidence_state,
       record->>'reasonCode' AS reason_code,record->>'summary' AS summary,record->'inputs' AS inputs,recorded_at
     FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=ANY($2::text[]) AND pack_id=$3 AND leaf_id=$4
       AND adoption_id=$5
     ORDER BY subject_key,related_key,recorded_at DESC,id DESC`,
    [tenantId, keys, adoption.record.pack.packId, leafId, adoption.id],
  );
  for (const row of rows.rows) {
    const result: LatestResult = {
      id: row.id,
      related: row.related_key !== '',
      relatedKey: row.related_key,
      outcome: row.outcome,
      evidenceState: row.evidence_state,
      reasonCode: row.reason_code,
      summary: row.summary,
      recordedAt: row.recorded_at.toISOString(),
      inputs: row.inputs ?? [],
    };
    byKey.set(row.subject_key, [...(byKey.get(row.subject_key) ?? []), result]);
  }
  return byKey;
}

/** Rules of the adoption with evaluation work due or held, which a count waits for. */
async function rulesWithWork(client: PoolClient, tenantId: string, packId: string): Promise<Set<string>> {
  const rows = await client.query<{ leaf_id: string }>(
    `SELECT DISTINCT leaf_id FROM rule_evaluation_work WHERE tenant_id=$1 AND pack_id=$2
       AND (state='leased' OR (state='pending' AND due_at<=clock_timestamp()))`,
    [tenantId, packId],
  );
  return new Set(rows.rows.map((row) => row.leaf_id));
}

async function ruleCoverage(
  client: PoolClient,
  tenantId: string,
  adoption: AdoptionRow,
  leaf: RulePackLeaf,
  section: string,
  working: ReadonlySet<string>,
  bound: number,
): Promise<RuleCoverage> {
  const base = {
    leafId: leaf.id,
    title: leaf.title,
    checkedBy: checkedBy(leaf),
    section,
    ...(leaf.paragraph ? { paragraph: leaf.paragraph } : {}),
  };
  if (!isCheckedRuleLeaf(leaf)) return { ...base, populationSize: null, counts: null, complete: false };
  const found = await membersOf(client, tenantId, adoption, leaf, bound);
  const members = found.slice(0, bound);
  const latest = await latestResults(client, tenantId, adoption, leaf.id, members);
  const counts = countResults(
    members.map((member) => standingResult(latest.get(subjectReferenceKey(member.subject)) ?? [])),
  );
  const incomplete =
    found.length > bound
      ? 'population_limit'
      : counts.not_evaluated > 0 || working.has(leaf.id)
        ? 'evaluating'
        : undefined;
  return {
    ...base,
    subjectKind: leaf.target.subjectKind,
    ...(leaf.population ? { population: leaf.population } : {}),
    populationSize: found.length,
    counts,
    complete: incomplete === undefined,
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * GET /v1/organization/coverage/adoptions/:adoptionId: each rule of the adoption with its counts, over at most
 * `bound` members per rule (POPULATION_LIMIT, as adoption queues them).
 */
export async function getAdoptionRuleCoverage(
  client: PoolClient,
  principal: AuthContext,
  adoptionId: string,
  bound = POPULATION_LIMIT,
): Promise<AdoptionRuleCoverageResponse> {
  requireEvidenceRead(principal);
  const adoption = await adoptionOf(client, principal, adoptionId);
  const asOf = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
  const pack = adoption.record.pack;
  const working = await rulesWithWork(client, principal.tenantId, pack.packId);
  const rules: RuleCoverage[] = [];
  const sections: CoverageSection[] = [];
  for (const { section, leaves } of sectionsOf(pack)) {
    const read: RuleCoverage[] = [];
    for (const leaf of leaves)
      read.push(await ruleCoverage(client, principal.tenantId, adoption, leaf, section.id, working, bound));
    rules.push(...read);
    sections.push(sectionCounts(section, read));
  }
  return {
    adoptionId: adoption.id,
    packId: pack.packId,
    version: pack.version,
    title: pack.title,
    mode: adoptionMode(adoption.record),
    asOf,
    populationLimit: bound,
    sections,
    rules,
  };
}

function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), COVERAGE_PAGE_LIMIT);
}

/** GET …/rules/:leafId/subjects: the members behind one count, in member order, a page at a time. */
export async function listRuleCoverageSubjects(
  client: PoolClient,
  principal: AuthContext,
  adoptionId: string,
  leafId: string,
  query: RuleCoverageSubjectsQuery,
): Promise<RuleCoverageSubjectsResponse> {
  requireEvidenceRead(principal);
  const adoption = await adoptionOf(client, principal, adoptionId);
  const leaf = adoption.record.pack.leaves.filter(isCheckedRuleLeaf).find((item) => item.id === leafId);
  if (!leaf) throw new DomainError(404, 'rule_not_found', 'The adoption holds no checked rule of that id');
  const limit = pageLimit(query.limit);
  const members = (await membersOf(client, principal.tenantId, adoption, leaf, POPULATION_LIMIT)).slice(
    0,
    POPULATION_LIMIT,
  );
  const latest = await latestResults(client, principal.tenantId, adoption, leaf.id, members);
  const matching = members
    .filter((member) => query.cursor === undefined || member.position > query.cursor)
    .map((member) => ({ member, result: standingResult(latest.get(subjectReferenceKey(member.subject)) ?? []) }))
    .filter(({ result }) => !query.result || (result ? resultOf(result) : 'not_evaluated') === query.result);
  const shown = matching.slice(0, limit);
  const names = await subjectNames(
    client,
    principal.tenantId,
    shown.map(({ member }) => member.subject),
  );
  const findingIds = shown.map(({ member, result }) =>
    findingIdFor(
      principal.tenantId,
      subjectReferenceKey(member.subject),
      adoption.record.pack.packId,
      leaf.id,
      result?.relatedKey ?? '',
    ),
  );
  const findings = new Map(
    (
      await client.query<{ id: string; status: string }>(
        'SELECT id,status FROM finding_views WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [principal.tenantId, findingIds],
      )
    ).rows.map((row) => [row.id, row.status]),
  );
  const subjects: RuleCoverageSubject[] = shown.map(({ member, result }, index) => {
    const status = findings.get(findingIds[index]!);
    return {
      subject: names.get(subjectReferenceKey(member.subject))!,
      result: result ? resultOf(result) : 'not_evaluated',
      evaluation: result
        ? {
            id: result.id,
            outcome: result.outcome,
            evidenceState: result.evidenceState,
            reasonCode: result.reasonCode,
            summary: result.summary,
            recordedAt: result.recordedAt,
          }
        : null,
      finding: status ? { id: findingIds[index]!, status } : null,
      missing: missingRecords(leaf, result),
    };
  });
  const hasMore = matching.length > limit;
  return {
    adoptionId: adoption.id,
    leafId: leaf.id,
    result: query.result ?? null,
    subjects,
    page: { limit, hasMore, nextCursor: hasMore ? shown.at(-1)!.member.position : null },
  };
}

/** GET /v1/organization/subjects: subjects of one kind on record, with names, for picking one. */
export async function listSubjectsOnRecord(
  client: PoolClient,
  principal: AuthContext,
  query: SubjectsOnRecordQuery,
): Promise<SubjectsOnRecordResponse> {
  requireEvidenceRead(principal);
  const limit = pageLimit(query.limit);
  const found = await populationMembers(
    client,
    {
      tenantId: principal.tenantId,
      kind: query.kind,
      population: { of: 'on_record' },
      interval: { start: '1970-01-01T00:00:00.000Z', end: '9999-12-31T23:59:59.998Z' },
    },
    POPULATION_LIMIT + 1,
  );
  const members = found.slice(0, POPULATION_LIMIT);
  const names = await subjectNames(
    client,
    principal.tenantId,
    members.map((member) => member.subject),
  );
  const search = query.search?.trim().toLowerCase();
  const matching = members
    .filter((member) => query.cursor === undefined || member.position > query.cursor)
    .map((member) => ({ member, named: names.get(subjectReferenceKey(member.subject))! }))
    .filter(
      ({ named }) => !search || named.name.toLowerCase().includes(search) || named.id.toLowerCase().includes(search),
    );
  const shown = matching.slice(0, limit);
  const hasMore = matching.length > limit;
  return {
    kind: query.kind,
    subjects: shown.map(({ named }) => named),
    page: { limit, hasMore, nextCursor: hasMore ? shown.at(-1)!.member.position : null },
    truncated: found.length > POPULATION_LIMIT,
  };
}
