import {
  adoptionMode,
  isCheckedRuleLeaf,
  reliefStatement,
  type CheckedRuleLeaf,
  type EvaluationRelief,
  type PackAdoptionAcceptance,
  type RuleEvaluationRecord,
} from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';
import type { CheckedRuleOutcome } from './checked-rules.js';

// Relief a waiver or exemption grants from another pack's rules: see docs/design/waiver-relief.md. Nothing here names
// a pack or a rule; the relieving rule declares what it relieves as data.

/** The relief that applies to one evaluation, before the evaluation adds what the rule would otherwise report. */
export type ReliefGrant = Omit<EvaluationRelief, 'otherwise'>;

interface Candidate {
  grant: ReliefGrant;
  order: [number, number, string, string];
}

/** What a provision last recorded for one subject under its waiver adoption. */
export type ProvisionResult = NonNullable<NonNullable<EvaluationRelief['coverage']>['provisionResult']>;

/** The provision results read for one evaluation, by provisionKey; a provision with none read maps to undefined. */
export type ProvisionResults = ReadonlyMap<string, ProvisionResult | undefined>;

/** The rule an evaluation is for: its pack, its id and the kind of subject it is about. */
export interface RelievedRule {
  packId: string;
  ruleId: string;
  subjectKind: CheckedRuleLeaf['target']['subjectKind'];
}

/** A provision under one waiver adoption whose result decides relief for a subject. */
export interface CoveringProvision {
  adoptionId: string;
  packId: string;
  ruleId: string;
}

export function provisionKey(provision: Pick<CoveringProvision, 'adoptionId' | 'ruleId'>): string {
  return JSON.stringify([provision.adoptionId, provision.ruleId]);
}

/** A provision covers a subject while its own latest result for it is supported. */
export function covers(result: ProvisionResult | undefined): boolean {
  return result?.outcome === 'pass' && result.evidenceState === 'supported';
}

function relieves(leaf: CheckedRuleLeaf, packId: string, ruleId: string): boolean {
  return (leaf.relieves ?? []).some((relief) => relief.packId === packId && relief.ruleIds.includes(ruleId));
}

function relievingLeaves(
  adoptions: readonly { id: string; record: PackAdoptionAcceptance }[],
  rule: Pick<RelievedRule, 'packId' | 'ruleId'>,
) {
  return adoptions.flatMap((adoption) =>
    adoption.record.pack.leaves
      .filter(isCheckedRuleLeaf)
      .filter((leaf) => adoption.record.pack.packId !== rule.packId && relieves(leaf, rule.packId, rule.ruleId))
      .map((leaf) => ({ adoption, leaf })),
  );
}

/**
 * The provisions relieving the rule whose results decide relief: those about the same kind of subject as the rule.
 * A provision about another kind of subject relieves the rule for every subject while its waiver is adopted.
 */
export function coveringProvisions(
  adoptions: readonly { id: string; record: PackAdoptionAcceptance }[],
  rule: RelievedRule,
): CoveringProvision[] {
  return relievingLeaves(adoptions, rule)
    .filter(({ leaf }) => leaf.target.subjectKind === rule.subjectKind)
    .map(({ adoption, leaf }) => ({ adoptionId: adoption.id, packId: adoption.record.pack.packId, ruleId: leaf.id }));
}

function grantOf(
  adoption: { id: string; record: PackAdoptionAcceptance },
  leaf: CheckedRuleLeaf,
  coverage: EvaluationRelief['coverage'],
): ReliefGrant {
  const { record } = adoption;
  return {
    mode: adoptionMode(record),
    waiver: {
      adoptionId: adoption.id,
      acceptedRevision: record.acceptedRevision,
      effectiveInterval: { ...record.effectiveInterval },
      pack: {
        id: record.pack.packId,
        version: record.pack.version,
        digest: record.pack.digest,
        title: record.pack.title,
      },
      adoptedBy: { id: record.actor.id, name: record.actor.name },
    },
    provision: {
      ruleId: leaf.id,
      ruleVersion: leaf.version,
      ruleDigest: leaf.digest,
      title: leaf.title,
      source: {
        kind: leaf.source.kind,
        reference: leaf.source.reference,
        text: leaf.source.text,
        sha256: leaf.source.sha256,
      },
    },
    ...(coverage ? { coverage } : {}),
  };
}

/**
 * The relief for a rule among the adoptions in effect at the evaluated instant: an active adoption before a shadow
 * one, then a provision that covers the subject before one that does not, then the lowest pack id, then the lowest
 * provision rule id. A provision about the same kind of subject as the rule covers the subject only while its
 * result among `results` is supported. Undefined when no adoption in effect relieves the rule.
 */
export function reliefFor(
  adoptions: readonly { id: string; record: PackAdoptionAcceptance }[],
  rule: RelievedRule,
  results: ProvisionResults = new Map(),
): ReliefGrant | undefined {
  const candidates: Candidate[] = relievingLeaves(adoptions, rule).map(({ adoption, leaf }) => {
    const result = results.get(provisionKey({ adoptionId: adoption.id, ruleId: leaf.id }));
    const coverage =
      leaf.target.subjectKind === rule.subjectKind
        ? { covered: covers(result), ...(result ? { provisionResult: result } : {}) }
        : undefined;
    const grant = grantOf(adoption, leaf, coverage);
    return {
      grant,
      order: [grant.mode === 'active' ? 0 : 1, coverage?.covered === false ? 1 : 0, grant.waiver.pack.id, leaf.id],
    };
  });
  const text = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  const compare = (left: Candidate, right: Candidate) =>
    left.order[0] - right.order[0] ||
    left.order[1] - right.order[1] ||
    text(left.order[2], right.order[2]) ||
    text(left.order[3], right.order[3]);
  return candidates.sort(compare)[0]?.grant;
}

interface ProvisionResultRow {
  id: string;
  outcome: ProvisionResult['outcome'];
  evidence_state: ProvisionResult['evidenceState'];
  reason_code: string;
  summary: string;
}

/**
 * The latest result of each provision for the subject under its waiver adoption. A provision that fans out to related
 * subjects has one latest result per related subject; the first that does not cover the subject is its result, so
 * the provision covers it only when every one does.
 */
export async function readProvisionResults(
  client: PoolClient,
  tenantId: string,
  subjectKey: string,
  provisions: readonly CoveringProvision[],
): Promise<Map<string, ProvisionResult | undefined>> {
  const results = new Map<string, ProvisionResult | undefined>();
  for (const provision of provisions) {
    const rows = await client.query<ProvisionResultRow>(
      `SELECT DISTINCT ON(related_key) id,outcome,evidence_state,record->>'reasonCode' AS reason_code,
         record->>'summary' AS summary
       FROM rule_evaluations WHERE tenant_id=$1 AND subject_key=$2 AND pack_id=$3 AND leaf_id=$4 AND adoption_id=$5
       ORDER BY related_key,recorded_at DESC,id DESC`,
      [tenantId, subjectKey, provision.packId, provision.ruleId, provision.adoptionId],
    );
    const latest = rows.rows.map((row): ProvisionResult => ({
      evaluationId: row.id,
      outcome: row.outcome,
      evidenceState: row.evidence_state,
      reasonCode: row.reason_code,
      summary: row.summary,
    }));
    results.set(provisionKey(provision), latest.find((result) => !covers(result)) ?? latest[0]);
  }
  return results;
}

/** The part of a provision's result that relief depends on and states. */
export function provisionResultPart(
  result: Pick<ProvisionResult, 'outcome' | 'evidenceState' | 'reasonCode' | 'summary'>,
) {
  return {
    outcome: result.outcome,
    evidenceState: result.evidenceState,
    reasonCode: result.reasonCode,
    summary: result.summary,
  };
}

/** The part of an evaluation's observation digest that names its relief, so relief starting or stopping is recorded. */
export function reliefDigestPart(grant: ReliefGrant) {
  return {
    adoptionId: grant.waiver.adoptionId,
    acceptedRevision: grant.waiver.acceptedRevision,
    mode: grant.mode,
    provision: { id: grant.provision.ruleId, version: grant.provision.ruleVersion, digest: grant.provision.ruleDigest },
    ...(grant.coverage
      ? {
          coverage: {
            covered: grant.coverage.covered,
            result: grant.coverage.provisionResult ? provisionResultPart(grant.coverage.provisionResult) : null,
          },
        }
      : {}),
  };
}

type RecordedAnswer = Pick<RuleEvaluationRecord, 'outcome' | 'reasonCode' | 'summary' | 'issues' | 'issueTimes'> & {
  relief?: EvaluationRelief;
  nextBoundary?: string;
};

/**
 * The answer an evaluation records under a relief. Active, with a provision that covers the subject: the result is
 * relieved, and what the rule found is kept under relief.otherwise. Shadow, or a provision that does not cover the
 * subject: the rule's own answer stands, with the relief beside it saying what the waiver would relieve or why it does
 * not. Either way the evaluation is due again when the waiver adoption's interval ends, if the check names no earlier
 * boundary.
 */
export function relievedAnswer(outcome: CheckedRuleOutcome, grant: ReliefGrant | undefined): RecordedAnswer {
  const own: RecordedAnswer = {
    outcome: outcome.outcome,
    reasonCode: outcome.reasonCode,
    summary: outcome.summary,
    ...(outcome.issues ? { issues: outcome.issues } : {}),
    ...(outcome.issueTimes ? { issueTimes: outcome.issueTimes } : {}),
    ...(outcome.nextBoundary ? { nextBoundary: outcome.nextBoundary } : {}),
  };
  if (!grant) return own;
  const ends = grant.waiver.effectiveInterval.end;
  const nextBoundary =
    outcome.nextBoundary && Date.parse(outcome.nextBoundary) < Date.parse(ends) ? outcome.nextBoundary : ends;
  if (grant.mode === 'shadow' || grant.coverage?.covered === false)
    return { ...own, relief: { ...grant }, nextBoundary };
  return {
    outcome: 'relieved',
    reasonCode: 'relieved_by_waiver',
    summary: reliefStatement(grant),
    relief: {
      ...grant,
      otherwise: {
        outcome: outcome.outcome,
        reasonCode: outcome.reasonCode,
        summary: outcome.summary,
        ...(outcome.issues ? { issues: outcome.issues } : {}),
        ...(outcome.issueTimes ? { issueTimes: outcome.issueTimes } : {}),
      },
    },
    nextBoundary,
  };
}
