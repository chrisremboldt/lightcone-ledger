import { describe, expect, test } from 'vitest';
import { coverageCells, coverageColumns } from '../../apps/web/src/program-view-table.js';

const zero = {
  supported: 0,
  attention: 0,
  no_record: 0,
  pending: 0,
  not_applicable: 0,
  relieved: 0,
  other: 0,
  not_evaluated: 0,
};
const pack = (rules: { counts: typeof zero | null }[]) => ({
  packId: 'example.pack',
  title: 'Example procedures',
  version: 1,
  mode: 'active' as const,
  rules: rules.map((rule, index) => ({
    ruleId: `rule-${index}`,
    title: `Rule ${index}`,
    citation: `Example ${index}`,
    checkedBy: 'ledger' as const,
    ...rule,
  })),
});

describe('an operator’s coverage table', () => {
  test('a pack whose counts are all zero still shows a number for each rule', () => {
    const shown = pack([{ counts: zero }, { counts: null }]) as never;
    const columns = coverageColumns(shown);
    expect(columns.map((column) => column.label)).toEqual(['Subjects']);
    expect(coverageCells((shown as ReturnType<typeof pack>).rules[0] as never, columns)).toEqual([
      { text: '0', span: 1 },
    ]);
    expect(coverageCells((shown as ReturnType<typeof pack>).rules[1] as never, columns)).toEqual([
      { text: 'Not checked by Ledger', span: 1 },
    ]);
  });

  test('only the results some subject is in are columns, in the Rules screen’s order', () => {
    const shown = pack([{ counts: { ...zero, attention: 2 } }, { counts: { ...zero, supported: 5 } }]) as never;
    const columns = coverageColumns(shown);
    expect(columns.map((column) => column.result)).toEqual(['attention', 'supported']);
    expect(
      coverageCells((shown as ReturnType<typeof pack>).rules[0] as never, columns).map((cell) => cell.text),
    ).toEqual(['2', '0']);
  });
});
