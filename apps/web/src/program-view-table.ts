import type { CoverageResult, ProgramViewDocument } from '@ledger/contracts';
import { coverageResultLabels, coverageResultOrder } from './rule-coverage.js';

type Pack = NonNullable<ProgramViewDocument['packs']>[number];
type Rule = Pack['rules'][number];

/**
 * The columns of an operator's coverage table: each result some subject is in. When every count is zero there is
 * one column, so a rule's row still says how many subjects it counted instead of showing no number at all.
 */
export function coverageColumns(pack: Pack): { result: CoverageResult | null; label: string }[] {
  const present = new Set<CoverageResult>();
  for (const rule of pack.rules)
    for (const result of coverageResultOrder) if ((rule.counts?.[result] ?? 0) > 0) present.add(result);
  const results = coverageResultOrder.filter((result) => present.has(result));
  if (results.length === 0) return [{ result: null, label: 'Subjects' }];
  return results.map((result) => ({ result, label: coverageResultLabels[result] }));
}

/** A rule's cells under those columns; a rule Ledger does not check spans them all with words. */
export function coverageCells(
  rule: Rule,
  columns: ReturnType<typeof coverageColumns>,
): { text: string; span: number }[] {
  if (!rule.counts) return [{ text: 'Not checked by Ledger', span: columns.length }];
  return columns.map(({ result }) => ({ text: String(result ? rule.counts![result] : 0), span: 1 }));
}
