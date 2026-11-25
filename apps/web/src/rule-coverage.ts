import { isOperatorRecordDefinition, standardObservationRegistry } from '@ledger/contracts';
import type {
  AdoptionRuleCoverageResponse,
  CoverageCheckedBy,
  CoverageCounts,
  CoverageResult,
  CoverageSection,
  ObservationSubjectKind,
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

/**
 * What a section heading says of its rules: how many, how they are checked, how many ask something of a person, and
 * how many count nothing yet and are listed apart.
 */
export function sectionWords(section: CoverageSection, nothingYet = 0): string {
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
  const apart = nothingYet ? `${nothingYet} counting nothing yet, listed under ${nothingYetTitle}` : '';
  const rules = count(section.leafIds.length, 'rule', 'rules');
  return `${rules}: ${[checked.join(', '), asking.join(', '), apart].filter(Boolean).join('; ')}.`;
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

/** A subject of a kind, with the article a sentence starts with: "An organization", "A flight". */
export function oneSubject(kind: ObservationSubjectKind | undefined): string {
  const noun = kind ?? 'subject';
  return `${/^[aeiou]/.test(noun) ? 'An' : 'A'} ${noun}`;
}

/** A record type by the name a person picks it by under Records, from the same definitions; its id if none. */
export function recordTypeName(recordType: string): string {
  const definitions = Object.values(standardObservationRegistry.recordTypes).filter(isOperatorRecordDefinition);
  const named = definitions
    .filter((definition) => definition.recordType === recordType)
    .sort((one, other) => other.recordVersion - one.recordVersion)[0];
  return named?.title ?? recordType;
}

/**
 * What to tell a person when a rule covers no one yet: a subject is on record once a record is about it, which is not
 * the same as a person who may sign in.
 */
export function emptyPopulationHint(rule: RuleCoverage): string | null {
  if (rule.populationSize !== 0) return null;
  const one = oneSubject(rule.subjectKind);
  const them = rule.subjectKind === 'person' ? 'them' : 'it';
  if (rule.population?.of === 'designated') {
    // The record types whose records name the rule's subjects, as the rule itself declares them.
    const types = (rule.population.by.where ?? []).flatMap((condition) =>
      condition.field === 'values.recordType' && 'oneOf' in condition
        ? condition.oneOf.map((value) => recordTypeName(String(value)))
        : [],
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

/** The counts an adopted pack opens with, each a filter of its rules. */
export const coverageFilterValues = [
  'attention',
  'no_record',
  'supported',
  'relieved',
  'person',
  'not_applicable',
  'nothing_yet',
] as const;
export type CoverageFilter = (typeof coverageFilterValues)[number];

export const nothingYetTitle = 'Nothing counted yet';

/** Each filter in the words the rows already use. */
export const coverageFilterLabels: Record<CoverageFilter, string> = {
  attention: coverageResultLabels.attention,
  no_record: coverageResultLabels.no_record,
  supported: coverageResultLabels.supported,
  relieved: coverageResultLabels.relieved,
  person: checkedByLabels.person,
  not_applicable: coverageResultLabels.not_applicable,
  nothing_yet: nothingYetTitle,
};

/** A checked rule that covers no subject yet; it is listed apart, with what record would make it count. */
export function countsNothingYet(rule: RuleCoverage): boolean {
  return rule.counts !== null && rule.populationSize === 0;
}

/** Whether a rule belongs to a filter's count: a rule with several results belongs to each it has a subject in. */
export function ruleMatches(rule: RuleCoverage, filter: CoverageFilter): boolean {
  if (filter === 'person') return rule.checkedBy === 'person';
  if (filter === 'nothing_yet') return countsNothingYet(rule);
  return (rule.counts?.[filter] ?? 0) > 0;
}

/** How many of the rules each filter holds, in the order the summary shows them, the empty ones included. */
export function filterCounts(rules: readonly RuleCoverage[]): { filter: CoverageFilter; count: number }[] {
  return coverageFilterValues.map((filter) => ({
    filter,
    count: rules.filter((rule) => ruleMatches(rule, filter)).length,
  }));
}

/** A rule with a subject needing attention or a record not on file: its section opens by itself. */
export function asksSomething(rule: RuleCoverage): boolean {
  return (rule.counts?.attention ?? 0) > 0 || (rule.counts?.no_record ?? 0) > 0;
}

export interface CoverageGroup {
  /** A section's id, or null for the rules that count nothing yet. */
  section: CoverageSection | null;
  rules: RuleCoverage[];
  /** Open unless a person chose otherwise. */
  opens: boolean;
}

/**
 * The groups a pack's coverage shows, in reading order: each section with the rules it shows, then the rules that
 * count nothing yet. With no filter a section opens when a rule in it asks something of a person, and the rules that
 * count nothing yet stay folded; with a filter only groups with a matching rule are shown, open, with those rules.
 */
export function coverageGroups(
  coverage: Pick<AdoptionRuleCoverageResponse, 'sections' | 'rules'>,
  filter: CoverageFilter | null,
): CoverageGroup[] {
  const shown = (rule: RuleCoverage) => filter === null || ruleMatches(rule, filter);
  const sections = coverage.sections.map((section) => {
    const rules = coverage.rules.filter(
      (rule) => section.leafIds.includes(rule.leafId) && !countsNothingYet(rule) && shown(rule),
    );
    return { section, rules, opens: filter !== null || rules.some(asksSomething) };
  });
  const nothingYet = coverage.rules.filter((rule) => countsNothingYet(rule) && shown(rule));
  return [...sections, { section: null, rules: nothingYet, opens: filter !== null }].filter(
    (group) => group.rules.length > 0,
  );
}

/** How many of a section's rules count nothing yet. */
export function nothingYetIn(section: CoverageSection, rules: readonly RuleCoverage[]): number {
  return rules.filter((rule) => section.leafIds.includes(rule.leafId) && countsNothingYet(rule)).length;
}
