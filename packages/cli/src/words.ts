import type { CoverageCheckedBy, CoverageResult, CoverageSection, RuleCoverage, RulePackLeaf } from '@ledger/contracts';

// The Rules screen's words, so a person reading the command line reads what the screen says. A unit test keeps them
// equal to apps/web/src/rule-coverage.ts.

/** What each count of a rule's coverage says. None of them is a verdict. */
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

/** What a rule's count covers: everyone, or why not. */
export function completeness(rule: RuleCoverage, limit: number): string | null {
  if (rule.incomplete === 'population_limit')
    return `More than ${limit.toLocaleString('en-US')} subjects are on record; the first ${limit.toLocaleString('en-US')} are counted.`;
  if (rule.incomplete === 'evaluating') return 'Still being evaluated; the counts will change.';
  return null;
}

/** "No X on file." for each record a subject lacks. */
export function missingWords(missing: readonly string[]): string {
  return missing.map((record) => `No ${record} on file.`).join(' ');
}

/**
 * A result as a person may type it: the API's code (`pending`, `no_record` or `no-record`), the words coverage prints
 * (`Waiting for a record or a time`), or their first words when only one result starts so (`waiting`, `no record`).
 */
export function parseCoverageResult(text: string): CoverageResult | undefined {
  const wanted = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!wanted) return undefined;
  const exact = coverageResultOrder.find(
    (result) =>
      result === wanted || result.replace('_', '-') === wanted || coverageResultLabels[result].toLowerCase() === wanted,
  );
  if (exact) return exact;
  const starting = coverageResultOrder.filter((result) =>
    `${coverageResultLabels[result].toLowerCase()} `.startsWith(`${wanted} `),
  );
  return starting.length === 1 ? starting[0] : undefined;
}

/** What --result takes, for a sentence that refuses one. */
export function coverageResultChoices(): string {
  return coverageResultOrder.map((result) => `${result} (${coverageResultLabels[result]})`).join(', ');
}

export const modeWords = {
  active: 'active: its findings count',
  shadow: 'shadow: its results are recorded and labelled, and never counted in what a person attests to',
} as const;
