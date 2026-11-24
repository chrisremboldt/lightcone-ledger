import type {
  CoverageCheckedBy,
  CoverageCounts,
  CoverageResult,
  CoverageSection,
  RuleCoverage,
  RulePackLeaf,
} from '@ledger/contracts';

/** What each count of a rule's coverage says, in a dispatcher's words. None of them is a verdict. */
export const coverageResultLabels: Record<CoverageResult, string> = {
  supported: 'Supported by the record',
  attention: 'Needs attention',
  no_record: 'No record on file',
  pending: 'Waiting for a record or a time',
  not_applicable: 'Does not apply',
  relieved: 'Relieved by a waiver',
  other: 'Other result',
  not_evaluated: 'Not yet evaluated',
};

/** The order counts are shown in: what asks most of a person first. */
export const coverageResultOrder: readonly CoverageResult[] = [
  'attention',
  'no_record',
  'pending',
  'not_evaluated',
  'other',
  'relieved',
  'supported',
  'not_applicable',
];

export const checkedByLabels: Record<CoverageCheckedBy, string> = {
  automatic: 'Checked automatically',
  person: 'A person reviews it',
  not_supported: 'Not checked yet',
};

/** What a section heading says of its rules: how many, how they are checked, and how many ask something of a person. */
export function sectionWords(section: CoverageSection): string {
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const checked = [
    section.checkedBy.automatic ? `${section.checkedBy.automatic} checked automatically` : '',
    section.checkedBy.person ? `${section.checkedBy.person} a person reviews` : '',
    section.checkedBy.not_supported ? `${section.checkedBy.not_supported} not checked yet` : '',
  ].filter(Boolean);
  const asking = [
    section.needingAttention ? `${section.needingAttention} with a subject needing attention` : '',
    section.withNoRecord ? `${section.withNoRecord} with a record not on file` : '',
  ].filter(Boolean);
  const rules = count(section.leafIds.length, 'rule', 'rules');
  return `${rules}: ${[checked.join(', '), asking.join(', ')].filter(Boolean).join('; ')}.`;
}

/** How a rule of a pack is checked, from the pack itself, before it is adopted. */
export function leafCheckedBy(leaf: Pick<RulePackLeaf, 'coverage'>): CoverageCheckedBy {
  return leaf.coverage === 'automated' ? 'automatic' : leaf.coverage === 'manual' ? 'person' : 'not_supported';
}

/** The counts worth showing for a rule, in order, without the empty ones. */
export function shownCounts(counts: CoverageCounts): { result: CoverageResult; count: number }[] {
  return coverageResultOrder.flatMap((result) => (counts[result] ? [{ result, count: counts[result] }] : []));
}

/** What a rule's count covers: everyone, or why not. */
export function completeness(rule: RuleCoverage, limit: number): string | null {
  if (rule.incomplete === 'population_limit')
    return `More than ${limit.toLocaleString('en-US')} subjects are on record; the first ${limit.toLocaleString('en-US')} are counted.`;
  if (rule.incomplete === 'evaluating') return 'Still being evaluated; the counts will change.';
  return null;
}

/** Who a rule is counted over, in a sentence. */
export function populationWords(rule: RuleCoverage): string {
  const kind = rule.subjectKind ?? 'subject';
  const plural = kind === 'person' ? 'people' : kind === 'aircraft' ? 'aircraft' : `${kind}s`;
  switch (rule.population?.of) {
    case 'on_record':
      return `Every ${kind} on record`;
    case 'in_adoption_dates':
      return `The ${plural} with records in the adoption’s dates`;
    case 'designated':
      return `The ${plural} a record names for this rule`;
    default:
      return `The ${plural} whose records it has read`;
  }
}

/**
 * What to tell a person when a rule covers no one yet: a subject is on record once a record is about it, which is not
 * the same as a person who may sign in.
 */
export function emptyPopulationHint(rule: RuleCoverage): string | null {
  if (rule.populationSize !== 0) return null;
  const kind = rule.subjectKind ?? 'subject';
  const one = kind === 'aircraft' ? 'An aircraft' : `A ${kind}`;
  const them = kind === 'person' ? 'them' : 'it';
  if (rule.population?.of === 'designated') {
    // The record types whose records name the rule's subjects, as the rule itself declares them.
    const types = (rule.population.by.where ?? []).flatMap((condition) =>
      condition.field === 'values.recordType' && 'oneOf' in condition ? condition.oneOf.map(String) : [],
    );
    const named = types.length ? `a record of type ${types.join(' or ')}` : 'a record this rule reads for it';
    return `${one} is counted here once ${named} names ${them}. Import or enter it under Records.`;
  }
  return `${one} is on record once a record about ${them} is imported or entered under Records.`;
}

/** "No X on file." for each record a subject lacks. */
export function missingWords(missing: readonly string[]): string {
  return missing.map((record) => `No ${record} on file.`).join(' ');
}
