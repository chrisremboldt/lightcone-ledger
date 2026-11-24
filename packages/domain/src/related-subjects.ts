import {
  RELATED_SUBJECT_LIMIT,
  subjectReferenceKey,
  type AcceptedObservation,
  type CheckedRuleLeaf,
  type RuleRead,
  type RuleRelatedSubject,
  type SubjectReference,
} from '@ledger/contracts';
import type { CheckDetails } from '@ledger/contracts';
import type { CheckedRuleOutcome } from './checked-rules.js';
import { declaredReferenceKinds, referenceValue, valueAt } from './observation-references.js';

/**
 * Related subjects of a checked rule (docs/design/fan-out-and-related-reads.md): validation of the declaration and
 * the pure resolution of the subjects a leaf's reads name. Nothing here reads the database or names a type.
 */

type Relation = RuleRelatedSubject;
const ROLES = ['subject', 'secondarySubject'] as const;

/** The relation a read is about, or undefined for a read about the target, the organization or a referencing field. */
export function relationOf(read: RuleRead): string | undefined {
  return typeof read.about === 'object' && 'related' in read.about ? read.about.related : undefined;
}

/** The referencing field a read about records naming the evaluated subject is about, or undefined. */
export function referencingField(read: RuleRead): string | undefined {
  return typeof read.about === 'object' && 'referencing' in read.about && !('related' in read.about)
    ? read.about.referencing
    : undefined;
}

/** The reference field of a read about the records that name a related subject there, or undefined. */
export function relatedReferencingField(read: RuleRead): string | undefined {
  return typeof read.about === 'object' && 'related' in read.about ? read.about.referencing : undefined;
}

function isRole(field: string): field is (typeof ROLES)[number] {
  return (ROLES as readonly string[]).includes(field);
}

/** Describes the first problem with a leaf's related subjects and the reads about them, or returns undefined. */
export function relatedSubjectProblem(leaf: CheckedRuleLeaf): string | undefined {
  const relations = leaf.related ?? [];
  const names = relations.map((relation) => relation.name);
  if (new Set(names).size !== names.length) return 'names a related subject twice';
  if (relations.filter((relation) => relation.fanOut).length > 1) return 'fans out over more than one related subject';
  const emptyFanOut = relations.find((relation) => relation.fanOut && relation.whenNone === 'empty');
  if (emptyFanOut) return `fans out over ${emptyFanOut.name}, which cannot read as empty when none is named`;
  for (const read of leaf.reads) {
    const relation = relationOf(read);
    if (relation !== undefined && !names.includes(relation))
      return `reads ${read.name} about ${relation}, which is not a declared related subject`;
    const field = relatedReferencingField(read);
    const kind = relations.find((item) => item.name === relation)?.subjectKind;
    const other = field === undefined ? undefined : declaredReferenceKinds(read, field).find((item) => item !== kind);
    if (other) return `reads ${read.name} by ${field}, which names a ${other}, not the ${kind} ${relation}`;
  }
  for (const relation of relations) {
    const problem = relationProblem(leaf, relation);
    if (problem) return problem;
  }
  return undefined;
}

function relationProblem(leaf: CheckedRuleLeaf, relation: Relation): string | undefined {
  const index = leaf.reads.findIndex((read) => read.name === relation.from.read);
  const fromState = leaf.subjectState?.name === relation.from.read;
  if (index < 0 && !fromState)
    return `takes ${relation.name} from ${relation.from.read}, which is not a read or the subject state`;
  const firstAbout = leaf.reads.findIndex((read) => relationOf(read) === relation.name);
  if (index >= 0 && firstAbout >= 0 && firstAbout < index)
    return `reads about ${relation.name} before ${relation.from.read}, which names it`;
  const requeue = requeueProblem(leaf, relation);
  if (requeue) return requeue;
  if (index < 0) return undefined;
  const from = leaf.reads[index]!;
  if (relationOf(from) !== undefined)
    return `takes ${relation.name} from ${from.name}, a read about another related subject`;
  if (isRole(relation.from.field)) return undefined;
  const declared = declaredReferenceKinds(from, relation.from.field);
  const other = declared.find((kind) => kind !== relation.subjectKind);
  if (other)
    return `takes ${relation.name} (${relation.subjectKind}) from ${from.name} ${relation.from.field}, which names a ${other}`;
  return undefined;
}

/** A relation's re-queue window must be read from the subject state or a read about the evaluated subject. */
function requeueProblem(leaf: CheckedRuleLeaf, relation: Relation): string | undefined {
  if (!relation.requeue) return undefined;
  const { read } = relation.requeue.windowEnd;
  if (leaf.subjectState?.name === read) return undefined;
  const window = leaf.reads.find((candidate) => candidate.name === read);
  if (!window || window.about !== 'target')
    return `re-queues ${relation.name} by the window of ${read}, which is not the subject state or a read about the evaluated subject`;
  return undefined;
}

// Resolution --------------------------------------------------------------------------------------------------------

/** Lookups resolution needs, answered at the evaluation's evidence cut. */
export interface RelatedLookup {
  /** The kind of a Ledger subject, or undefined when there is none. */
  ledgerKind(id: string): string | undefined;
  /** The Ledger subject an alias resolution inside the cut gives a source's own id at an instant, or undefined. */
  alias(sourceId: string, kind: string, id: string, at: string): string | undefined;
}

export interface NamedBy {
  observationId: string;
  field: string;
}

export interface RelatedCandidate {
  subject: SubjectReference;
  subjectKey: string;
  /** False for a reference that names something but does not resolve; its key is the reference as written. */
  resolved: boolean;
  namedBy: NamedBy[];
  /** For an unresolved reference: what was written, for the result's summary and details. */
  written?: string;
}

export interface RelatedSet {
  relation: Relation;
  candidates: RelatedCandidate[];
  /** References with no usable value at all (absent, blank or malformed): reported for the target. */
  blank: (NamedBy & { value: string })[];
}

interface Named {
  subject?: SubjectReference;
  resolved: boolean;
  written?: string;
}

function described(value: unknown): string {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function namedByRole(observation: AcceptedObservation, role: (typeof ROLES)[number], kind: string): Named | undefined {
  const named = observation[role];
  if (!named) return undefined;
  const written = `${named.scope} ${named.kind} ${named.id}`;
  if (named.kind !== kind) return { resolved: false, written };
  const subjectKind = named.kind as SubjectReference['kind'];
  if (named.ledgerId) return { subject: { scope: 'ledger', kind: subjectKind, id: named.ledgerId }, resolved: true };
  const identity: SubjectReference = {
    scope: 'source',
    kind: subjectKind,
    id: named.id,
    sourceId: observation.sourceId,
  };
  if (named.scope === 'ledger' || named.resolution === 'ambiguous')
    return { subject: identity, resolved: false, written };
  return { subject: identity, resolved: true };
}

function namedByField(
  observation: AcceptedObservation,
  field: string,
  kind: string,
  lookup: RelatedLookup,
): Named | undefined {
  const value = valueAt(observation.observation, field);
  const reference = referenceValue(value);
  if (!reference) return undefined;
  const subjectKind = kind as SubjectReference['kind'];
  const written = `${reference.scope} ${kind} ${reference.id}`;
  if (reference.scope === 'ledger') {
    const subject: SubjectReference = { scope: 'ledger', kind: subjectKind, id: reference.id };
    return lookup.ledgerKind(reference.id) === kind
      ? { subject, resolved: true }
      : { subject, resolved: false, written };
  }
  const ledgerId = lookup.alias(observation.sourceId, kind, reference.id, observation.occurredAt);
  return ledgerId
    ? { subject: { scope: 'ledger', kind: subjectKind, id: ledgerId }, resolved: true }
    : {
        subject: { scope: 'source', kind: subjectKind, id: reference.id, sourceId: observation.sourceId },
        resolved: true,
      };
}

/**
 * The related subjects one relation's from-read names, in subject-key order. A reference that resolves through no
 * Ledger subject and no alias is the source identity, which can be read; one that names something unusable keeps the
 * key of what was written so a correction moves its result; one with no value is reported for the target.
 */
export function resolveRelatedSet(
  relation: Relation,
  observations: readonly AcceptedObservation[],
  lookup: RelatedLookup,
): RelatedSet {
  const byKey = new Map<string, RelatedCandidate>();
  const blank: RelatedSet['blank'] = [];
  for (const observation of observations) {
    const field = relation.from.field;
    const named = isRole(field)
      ? namedByRole(observation, field, relation.subjectKind)
      : namedByField(observation, field, relation.subjectKind, lookup);
    const namedBy = { observationId: observation.id, field };
    if (!named?.subject) {
      blank.push({
        ...namedBy,
        value: named?.written ?? described(isRole(field) ? undefined : valueAt(observation.observation, field)),
      });
      continue;
    }
    const subjectKey = subjectReferenceKey(named.subject);
    const existing = byKey.get(subjectKey);
    if (existing) existing.namedBy.push(namedBy);
    else
      byKey.set(subjectKey, {
        subject: named.subject,
        subjectKey,
        resolved: named.resolved,
        namedBy: [namedBy],
        ...(named.written ? { written: named.written } : {}),
      });
  }
  const candidates = [...byKey.values()].sort((a, b) =>
    a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0,
  );
  return { relation, candidates, blank };
}

/** The keys of a related set, for comparing one round of the cut with the next. */
export function relatedSetKeys(sets: readonly RelatedSet[]): string {
  return JSON.stringify(sets.map((set) => [set.relation.name, set.candidates.map((item) => item.subjectKey)]));
}

// What to evaluate ---------------------------------------------------------------------------------------------

/** A result the engine records without running the check. */
export type RelatedProblem = CheckedRuleOutcome;

/**
 * What one evaluation records once the related sets are known: a target-level problem alone, or one result per
 * fanned-out subject (or one result for the target without fan-out) with the single subject of each other relation,
 * and possibly a target-level problem beside them.
 */
export type RelatedPlan =
  | { kind: 'target_only'; problem: RelatedProblem }
  | {
      kind: 'results';
      fanOut?: { relation: Relation; candidates: RelatedCandidate[] };
      fixed: Record<string, RelatedCandidate>;
      targetProblem?: RelatedProblem;
    };

function insufficient(reasonCode: string, summary: string, details?: CheckDetails): RelatedProblem {
  return {
    applicability: 'applicable',
    evidenceState: 'insufficient',
    outcome: 'pending',
    reasonCode,
    summary,
    evidence: [],
    ...(details ? { details } : {}),
  };
}

function unresolvedProblem(relation: Relation, items: { observationId: string; field: string; value: string }[]) {
  const first = items[0]!;
  const more = items.length > 1 ? ` and ${items.length - 1} more` : '';
  return insufficient(
    'related_reference_unresolved',
    `The ${relation.name} named by observation ${first.observationId} ${first.field} (${first.value}) does not resolve${more}.`,
    { observationId: first.observationId, field: first.field, value: first.value.slice(0, 1000), count: items.length },
  );
}

function noneProblem(relation: Relation): RelatedProblem {
  const summary = relation.whenNoneSummary ?? `${relation.from.read} names no ${relation.name}.`;
  return relation.whenNone === 'not_applicable'
    ? {
        applicability: 'not_applicable',
        evidenceState: 'not_applicable',
        outcome: 'not_applicable',
        reasonCode: 'related_subject_none',
        summary,
        evidence: [],
      }
    : insufficient('related_subject_missing', summary);
}

/** The unresolved references of a set, as written. */
function unresolvedOf(set: RelatedSet) {
  return [
    ...set.candidates
      .filter((item) => !item.resolved)
      .flatMap((item) => item.namedBy.map((named) => ({ ...named, value: item.written ?? item.subjectKey }))),
    ...set.blank,
  ];
}

/** Decides what one evaluation records from the related sets resolved at its cut. */
export function relatedPlan(sets: readonly RelatedSet[]): RelatedPlan {
  const fixed: Record<string, RelatedCandidate> = {};
  for (const set of sets.filter((item) => !item.relation.fanOut)) {
    // A record that names no subject at all is not a reference that failed to resolve: it names none.
    const unresolved = unresolvedOf(set).filter((item) => item.value !== 'absent');
    if (unresolved.length) return { kind: 'target_only', problem: unresolvedProblem(set.relation, unresolved) };
    if (!set.candidates.length) {
      // A relation read as empty adds nothing: the reads about it stay empty and the check runs.
      if (set.relation.whenNone === 'empty') continue;
      return { kind: 'target_only', problem: noneProblem(set.relation) };
    }
    if (set.candidates.length > 1)
      return {
        kind: 'target_only',
        problem: {
          applicability: 'applicable',
          evidenceState: 'conflicting',
          outcome: 'attention',
          reasonCode: 'related_subject_conflicting',
          summary: `${set.relation.from.read} names ${set.candidates.length} different ${set.relation.name} subjects where the rule reads one: ${set.candidates.map((item) => item.subjectKey).join(', ')}.`,
          evidence: set.candidates.flatMap((item) => item.namedBy.map((named) => named.observationId)),
        },
      };
    fixed[set.relation.name] = set.candidates[0]!;
  }
  const fanned = sets.find((item) => item.relation.fanOut);
  if (!fanned) return { kind: 'results', fixed };
  if (fanned.candidates.length > RELATED_SUBJECT_LIMIT)
    return {
      kind: 'target_only',
      problem: insufficient(
        'related_subject_limit',
        `${fanned.candidates.length} related subjects are named; one evaluation reads at most ${RELATED_SUBJECT_LIMIT}.`,
        { count: fanned.candidates.length, limit: RELATED_SUBJECT_LIMIT },
      ),
    };
  if (!fanned.candidates.length)
    return {
      kind: 'target_only',
      problem: fanned.blank.length ? unresolvedProblem(fanned.relation, fanned.blank) : noneProblem(fanned.relation),
    };
  return {
    kind: 'results',
    fanOut: { relation: fanned.relation, candidates: fanned.candidates },
    fixed,
    ...(fanned.blank.length ? { targetProblem: unresolvedProblem(fanned.relation, fanned.blank) } : {}),
  };
}

/** The result for a fanned-out subject whose reference names something that does not resolve. */
export function unresolvedCandidateProblem(relation: Relation, candidate: RelatedCandidate): RelatedProblem {
  return unresolvedProblem(
    relation,
    candidate.namedBy.map((named) => ({ ...named, value: candidate.written ?? candidate.subjectKey })),
  );
}

/** The result a related subject gets when nothing names it any more. */
export function notNamedProblem(relation: { name: string }): RelatedProblem {
  return {
    applicability: 'not_applicable',
    evidenceState: 'not_applicable',
    outcome: 'not_applicable',
    reasonCode: 'related_subject_not_named',
    summary: `The records no longer name this ${relation.name}.`,
    evidence: [],
  };
}

export { RELATED_SUBJECT_LIMIT };
