import {
  subjectReferenceKey,
  type AcceptedObservation,
  type CheckedRuleLeaf,
  type InputCut,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { PoolClient } from '@ledger/persistence';
import { lockSubjects } from './cuts.js';
import { referenceValue, valueAt } from './observation-references.js';
import {
  notNamedProblem,
  referencingField,
  relatedReferencingField,
  RELATED_SUBJECT_LIMIT,
  relatedPlan,
  resolveRelatedSet,
  unresolvedCandidateProblem,
  type RelatedCandidate,
  type RelatedLookup,
  type RelatedProblem,
  type RelatedSet,
} from './related-subjects.js';
import { evaluatedSubjectDecision } from './checked-rules.js';
import { observationStreamsSql } from './observation-streams.js';
import {
  checkInputs,
  gatherInputs,
  laterRecords,
  mergeStreams,
  queueWork,
  recordEvaluation,
  subjectCut,
  type EvaluationContext,
  type Gathered,
  type SubjectCut,
} from './rule-evaluations.js';

/**
 * The generic evaluator for a leaf that declares related subjects (docs/design/fan-out-and-related-reads.md,
 * sections 2 to 4). One task is still one subject, pack and leaf: it reads at one cut merged across the subject and
 * the related subjects its records name, resolves them, and records one result per fanned-out subject.
 */

// The related set is read again at a widened cut at most this many times before the result says it is unstable.
const CUT_ROUNDS = 3;
const EVALUATED_PER_RELATED_SUBJECT = 'evaluated_per_related_subject';
const ROLES = new Set(['subject', 'secondarySubject']);

type Relation = NonNullable<CheckedRuleLeaf['related']>[number];

/** The observations a relation takes its subjects from: an earlier read, or the subject state as one observation. */
function fromObservations(relation: Relation, gathered: Gathered, evaluatedAt: string): AcceptedObservation[] {
  const read = gathered.reads.find((input) => input.read.name === relation.from.read);
  if (read) return read.observations;
  const state = gathered.state?.state;
  if (gathered.state?.name !== relation.from.read || !state) return [];
  return [
    {
      id: `subject-state:${gathered.state.kind}:${state.revision}`,
      sourceId: 'ledger',
      occurredAt: evaluatedAt,
      observation: structuredClone(state.state),
    } as unknown as AcceptedObservation,
  ];
}

const inCut = (event: string, cut: string) =>
  `((${cut}::jsonb)->>${event}.stream_id)::bigint>=${event}.stream_sequence`;

/** Answers the lookups resolution needs from the subjects table and the alias resolutions inside the cut. */
async function relatedLookup(
  client: PoolClient,
  tenantId: string,
  leaf: CheckedRuleLeaf,
  gathered: Gathered,
  evaluatedAt: string,
  cut: InputCut,
): Promise<RelatedLookup> {
  const ledgerIds = new Set<string>();
  const identities = new Map<string, [string, string, string, string]>();
  for (const relation of leaf.related ?? []) {
    if (ROLES.has(relation.from.field)) continue;
    for (const observation of fromObservations(relation, gathered, evaluatedAt)) {
      const reference = referenceValue(valueAt(observation.observation, relation.from.field));
      if (reference?.scope === 'ledger') ledgerIds.add(reference.id);
      if (reference?.scope === 'source') {
        const identity: [string, string, string, string] = [
          observation.sourceId,
          relation.subjectKind,
          reference.id,
          observation.occurredAt,
        ];
        identities.set(JSON.stringify(identity), identity);
      }
    }
  }
  const kinds = new Map(
    (
      await client.query<{ id: string; kind: string }>(
        'SELECT id,kind FROM subjects WHERE tenant_id=$1 AND id=ANY($2::text[])',
        [tenantId, [...ledgerIds]],
      )
    ).rows.map((row) => [row.id, row.kind]),
  );
  const aliases = new Map<string, string>();
  for (const [key, [sourceId, kind, id, at]] of identities) {
    const row = (
      await client.query<{ ledger_subject_id: string }>(
        `SELECT r.ledger_subject_id FROM observation_subject_resolutions r
         JOIN journal_events re ON re.tenant_id=r.tenant_id AND re.id=r.event_id
         WHERE r.tenant_id=$1 AND r.observation_id IS NULL AND r.source_id=$2 AND r.subject_kind=$3 AND r.external_id=$4
           AND (r.valid_from IS NULL OR r.valid_from<=$5::timestamptz) AND (r.valid_to IS NULL OR r.valid_to>$5::timestamptz)
           AND ${inCut('re', '$6')}
         ORDER BY re.received_at DESC,r.id DESC LIMIT 1`,
        [tenantId, sourceId, kind, id, at, JSON.stringify(cut.streams)],
      )
    ).rows[0];
    if (row) aliases.set(key, row.ledger_subject_id);
  }
  return {
    ledgerKind: (id) => kinds.get(id),
    alias: (sourceId, kind, id, at) => aliases.get(JSON.stringify([sourceId, kind, id, at])),
  };
}

async function resolveSets(
  client: PoolClient,
  context: EvaluationContext,
  gathered: Gathered,
  cut: InputCut,
): Promise<RelatedSet[]> {
  const { leaf, evaluatedAt } = context;
  const lookup = await relatedLookup(client, context.principal.tenantId, leaf, gathered, evaluatedAt, cut);
  return (leaf.related ?? []).map((relation) =>
    resolveRelatedSet(relation, fromObservations(relation, gathered, evaluatedAt), lookup),
  );
}

/**
 * The evidence cut of one related subject: a Ledger subject's own, locked for the evaluation's retention so two
 * evaluations naming it take turns; a source identity's observation streams and its alias stream, so an alias
 * recorded since is seen in the next round.
 */
async function relatedCut(
  client: PoolClient,
  context: EvaluationContext,
  subject: SubjectReference,
): Promise<SubjectCut> {
  const { principal, organizationId } = context;
  if (subject.scope === 'ledger') await lockSubjects(client, principal.tenantId, [subject.id], 'UPDATE');
  const own = await subjectCut(client, principal, subject, organizationId);
  // Records that name the related subject in a reference, about any subject, are read for it.
  const fields = context.leaf.reads.flatMap((read) => relatedReferencingField(read) ?? []);
  const cut = await withReferencingStreams(client, context, own, subject, fields);
  if (subject.scope === 'ledger') return cut;
  const alias = (
    await client.query<{ id: string; sequence: string }>(
      'SELECT id,sequence::text FROM streams WHERE tenant_id=$1 AND id=$2',
      [principal.tenantId, `subject-alias:${subject.sourceId}:${subject.kind}:${subject.id}`],
    )
  ).rows[0];
  if (!alias) return cut;
  const streams = { ...cut.inputCut.streams };
  mergeStreams(streams, { [alias.id]: Number(alias.sequence) });
  const inputCut: InputCut = { ...cut.inputCut, streams };
  return { inputCut, dependencyBasis: canonicalDigest({ basis: cut.dependencyBasis, inputCut }) };
}

/**
 * A cut widened by the streams of the current records whose reference at one of the fields names the subject (as
 * written, or through an alias resolution): a reference in a record's body retains nothing on the subject it names, so
 * the subject's own cut does not hold them.
 */
async function withReferencingStreams(
  client: PoolClient,
  context: EvaluationContext,
  cut: SubjectCut,
  subject: SubjectReference,
  fields: string[],
): Promise<SubjectCut> {
  if (!fields.length) return cut;
  const rows = await client.query<{ stream_id: string; sequence: string }>(
    observationStreamsSql(`SELECT DISTINCT o.tenant_id,o.id,o.event_id FROM observation_references ref
     JOIN observations o ON o.tenant_id=ref.tenant_id AND o.id=ref.observation_id
     WHERE ref.tenant_id=$1 AND ref.field=ANY($2::text[]) AND (ref.reference_key=$3 OR ($4::text IS NOT NULL
       AND ref.reference_scope='source' AND ref.reference_kind=$5 AND EXISTS(SELECT 1 FROM observation_subject_resolutions a
         WHERE a.tenant_id=ref.tenant_id AND a.observation_id IS NULL AND a.source_id=ref.reference_source_id
           AND a.subject_kind=ref.reference_kind AND a.external_id=ref.reference_id AND a.ledger_subject_id=$4)))`),
    [
      context.principal.tenantId,
      fields,
      subjectReferenceKey(subject),
      subject.scope === 'ledger' ? subject.id : null,
      subject.kind,
    ],
  );
  if (!rows.rows.length) return cut;
  const streams = { ...cut.inputCut.streams };
  mergeStreams(streams, Object.fromEntries(rows.rows.map((row) => [row.stream_id, Number(row.sequence)])));
  const inputCut: InputCut = { ...cut.inputCut, streams };
  return { inputCut, dependencyBasis: canonicalDigest({ basis: cut.dependencyBasis, referencing: inputCut }) };
}

/** The target's cut widened by every related subject's, with a basis naming each. */
function mergedCut(context: EvaluationContext, target: SubjectCut, related: Map<string, SubjectCut>): SubjectCut {
  const streams: Record<string, number> = {};
  mergeStreams(streams, target.inputCut.streams);
  const keys = [...related.keys()].sort();
  for (const key of keys) mergeStreams(streams, related.get(key)!.inputCut.streams);
  const inputCut: InputCut = { streams, principalRevision: context.principal.revision };
  return {
    inputCut,
    dependencyBasis: canonicalDigest({
      format: 'ledger.rule-evaluation-basis.1',
      subjectKey: context.subjectKey,
      bases: [
        target.dependencyBasis,
        ...keys.map((key) => ({ relatedKey: key, basis: related.get(key)!.dependencyBasis })),
      ],
      inputCut,
    }),
  };
}

/** A candidate whose evidence can be read: a resolved subject, or a source identity. */
function readable(candidate: RelatedCandidate): boolean {
  return candidate.resolved || candidate.subject.scope === 'source';
}

/** Ledger subjects among the candidates that exist, whose evidence retains the evaluation. */
function ledgerIdsOf(candidates: RelatedCandidate[]): string[] {
  return candidates.filter((item) => item.resolved && item.subject.scope === 'ledger').map((item) => item.subject.id);
}

interface Settled {
  base: Gathered;
  sets: RelatedSet[];
  cut: SubjectCut;
  stable: boolean;
}

/** Reads at the target's cut, then again at a cut widened by each newly named related subject, until none is new. */
async function settleRelatedSet(
  client: PoolClient,
  context: EvaluationContext,
  targetCut: SubjectCut,
): Promise<Settled> {
  const { principal, leaf, task, organizationId, evaluatedAt } = context;
  const merged = new Map<string, SubjectCut>();
  let cut = targetCut;
  let settled: Settled | undefined;
  for (let round = 0; round < CUT_ROUNDS; round++) {
    const base = await gatherInputs(client, principal, leaf, task.subject, organizationId, evaluatedAt, cut.inputCut, {
      related: {},
    });
    const sets = await resolveSets(client, context, base, cut.inputCut);
    const missing = sets
      .filter((set) => set.candidates.length <= RELATED_SUBJECT_LIMIT)
      .flatMap((set) => set.candidates)
      .filter((candidate) => readable(candidate) && !merged.has(candidate.subjectKey))
      .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : 1));
    settled = { base, sets, cut, stable: !missing.length };
    if (!missing.length) return settled;
    for (const candidate of missing)
      if (!merged.has(candidate.subjectKey))
        merged.set(candidate.subjectKey, await relatedCut(client, context, candidate.subject));
    cut = mergedCut(context, targetCut, merged);
  }
  return settled!;
}

interface RelatedRow {
  related_key: string;
  related_name: string;
  related_scope: SubjectReference['scope'];
  related_kind: SubjectReference['kind'];
  related_id: string;
  related_source_id: string | null;
  reason: string;
}

/** The latest record of each related subject this rule has recorded for the target. */
async function latestRelated(client: PoolClient, context: EvaluationContext): Promise<RelatedRow[]> {
  const rows = await client.query<RelatedRow>(
    `SELECT DISTINCT ON(related_key) related_key,related_name,related_scope,related_kind,related_id,related_source_id,
       record->>'reasonCode' AS reason
     FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3 AND leaf_id=$4 AND related_key<>''
     ORDER BY related_key,recorded_at DESC,id DESC`,
    [context.principal.tenantId, context.subjectKey, context.adoption.record.pack.packId, context.leaf.id],
  );
  return rows.rows;
}

async function latestTargetReason(client: PoolClient, context: EvaluationContext): Promise<string | undefined> {
  const row = (
    await client.query<{ reason: string }>(
      `SELECT record->>'reasonCode' AS reason FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3
         AND leaf_id=$4 AND related_key='' ORDER BY recorded_at DESC,id DESC LIMIT 1`,
      [context.principal.tenantId, context.subjectKey, context.adoption.record.pack.packId, context.leaf.id],
    )
  ).rows[0];
  return row?.reason;
}

/**
 * Records not applicable, once, for each related subject the records no longer name. Its finding keeps its status:
 * Ledger does not close a finding because a name was removed.
 */
async function recordDropped(
  client: PoolClient,
  context: EvaluationContext,
  settled: Settled,
  relation: Relation,
  named: ReadonlySet<string>,
): Promise<RuleEvaluationRecord[]> {
  const recorded: RuleEvaluationRecord[] = [];
  for (const row of await latestRelated(client, context)) {
    if (named.has(row.related_key) || row.reason === 'related_subject_not_named') continue;
    const subject: SubjectReference =
      row.related_scope === 'source'
        ? { scope: 'source', kind: row.related_kind, id: row.related_id, sourceId: row.related_source_id! }
        : { scope: 'ledger', kind: row.related_kind, id: row.related_id };
    const gathered = await gatherInputs(
      client,
      context.principal,
      context.leaf,
      context.task.subject,
      context.organizationId,
      context.evaluatedAt,
      settled.cut.inputCut,
      { related: {}, base: settled.base, narrow: { read: relation.from.read, ids: new Set() } },
    );
    const record = await recordEvaluation(client, context, {
      gathered,
      cut: settled.cut,
      related: { name: row.related_name, subject, subjectKey: row.related_key, namedBy: [] },
      outcome: notNamedProblem({ name: row.related_name }),
    });
    if (record) recorded.push(record);
  }
  return recorded;
}

async function recordForTarget(
  client: PoolClient,
  context: EvaluationContext,
  settled: Settled,
  problem: RelatedProblem,
): Promise<RuleEvaluationRecord | null> {
  return recordEvaluation(client, context, { gathered: settled.base, cut: settled.cut, outcome: problem });
}

/** Evaluates a leaf with related subjects for one target and records every result. Returns the first recorded. */
export async function evaluateWithRelatedSubjects(
  client: PoolClient,
  context: EvaluationContext,
  targetCut: SubjectCut,
): Promise<RuleEvaluationRecord | null> {
  const { principal, leaf, task, organizationId, evaluatedAt } = context;
  const settled = await settleRelatedSet(
    client,
    context,
    await withReferencingStreams(
      client,
      context,
      targetCut,
      context.task.subject,
      leaf.reads.flatMap((read) => referencingField(read) ?? []),
    ),
  );
  const recorded: (RuleEvaluationRecord | null)[] = [];
  if (!settled.stable) {
    recorded.push(
      await recordForTarget(client, context, settled, {
        applicability: 'applicable',
        evidenceState: 'insufficient',
        outcome: 'pending',
        reasonCode: 'related_set_unstable',
        summary: `The related subjects changed while they were read ${CUT_ROUNDS} times; the evaluation runs again.`,
        evidence: [],
      }),
    );
    // Nothing is guessed: the subject is evaluated again once the records settle.
    await queueWork(client, principal.tenantId, task.subject, context.adoption.record.pack.packId, leaf.id, {
      kind: 'deadline',
      eventId: task.trigger.eventId,
      dueAt: new Date(Date.parse(evaluatedAt) + 1000).toISOString(),
    });
    return recorded.find(Boolean) ?? null;
  }
  const fanned = settled.sets.find((set) => set.relation.fanOut);
  // A condition on the subject's own records that is not met, or its own record not on file, is decided once for the
  // subject: no related subject is reported, and one reported before is no longer named.
  const decided = evaluatedSubjectDecision(
    leaf,
    checkInputs(settled.base, evaluatedAt),
    { mode: 'wall', evaluatedAt },
    laterRecords(settled.base),
  );
  if (decided) {
    if (fanned) recorded.push(...(await recordDropped(client, context, settled, fanned.relation, new Set())));
    recorded.unshift(await recordForTarget(client, context, settled, decided));
    return recorded.find(Boolean) ?? null;
  }
  const plan = relatedPlan(settled.sets);
  if (fanned && fanned.candidates.length <= RELATED_SUBJECT_LIMIT)
    recorded.push(
      ...(await recordDropped(
        client,
        context,
        settled,
        fanned.relation,
        new Set(fanned.candidates.map((item) => item.subjectKey)),
      )),
    );
  if (plan.kind === 'target_only') {
    recorded.unshift(await recordForTarget(client, context, settled, plan.problem));
    return recorded.find(Boolean) ?? null;
  }
  const fixed = Object.entries(plan.fixed).sort(([a], [b]) => (a < b ? -1 : 1));
  const fixedSubjects = Object.fromEntries(fixed.map(([name, candidate]) => [name, candidate.subject]));
  const relatedSubjects = fixed.map(([name, candidate]) => ({ name, subjectKey: candidate.subjectKey }));
  const shared = {
    cut: settled.cut,
    ...(relatedSubjects.length ? { relatedSubjects } : {}),
  };
  const gather = (related: Record<string, SubjectReference>, narrow?: { read: string; ids: Set<string> }) =>
    gatherInputs(client, principal, leaf, task.subject, organizationId, evaluatedAt, settled.cut.inputCut, {
      related,
      base: settled.base,
      ...(narrow ? { narrow } : {}),
    });
  if (!plan.fanOut) {
    recorded.unshift(
      await recordEvaluation(client, context, {
        ...shared,
        gathered: await gather(fixedSubjects),
        retainFor: ledgerIdsOf(fixed.map(([, candidate]) => candidate)),
      }),
    );
    return recorded.find(Boolean) ?? null;
  }
  const { relation, candidates } = plan.fanOut;
  const results: (RuleEvaluationRecord | null)[] = [];
  for (const candidate of candidates) {
    const gathered = await gather(
      { ...fixedSubjects, [relation.name]: candidate.subject },
      { read: relation.from.read, ids: new Set(candidate.namedBy.map((item) => item.observationId)) },
    );
    results.push(
      await recordEvaluation(client, context, {
        ...shared,
        gathered,
        related: {
          name: relation.name,
          subject: candidate.subject,
          subjectKey: candidate.subjectKey,
          namedBy: candidate.namedBy.slice(0, 500),
        },
        ...(candidate.resolved ? {} : { outcome: unresolvedCandidateProblem(relation, candidate) }),
        retainFor: ledgerIdsOf([...fixed.map(([, item]) => item), candidate]),
      }),
    );
  }
  // A target-level record reports a problem of the fan-out itself, and once it clears, says so once.
  if (plan.targetProblem) results.push(await recordForTarget(client, context, settled, plan.targetProblem));
  else {
    const previous = await latestTargetReason(client, context);
    if (previous !== undefined && previous !== EVALUATED_PER_RELATED_SUBJECT)
      results.push(
        await recordForTarget(client, context, settled, {
          applicability: 'not_applicable',
          evidenceState: 'not_applicable',
          outcome: 'not_applicable',
          reasonCode: EVALUATED_PER_RELATED_SUBJECT,
          summary: `The rule is evaluated for each ${relation.name}: ${candidates.length} named.`,
          evidence: [],
        }),
      );
  }
  return [...results, ...recorded].find(Boolean) ?? null;
}
