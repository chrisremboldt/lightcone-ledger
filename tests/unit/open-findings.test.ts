import { describe, expect, test } from 'vitest';
import {
  groupOpenFindings,
  selectOpenFindings,
  type OpenFindingEntry,
} from '../../packages/domain/src/open-findings.js';
import { closureSentence, actionSentence } from '../../apps/web/src/finding-work.js';

const sourceId = 'operator-records';
let sequence = 0;

function entry(overrides: Partial<OpenFindingEntry> & Pick<OpenFindingEntry, 'openedAt'>): OpenFindingEntry {
  sequence += 1;
  return {
    id: `finding:${String(sequence).padStart(3, '0')}`,
    subject: { scope: 'source', kind: 'person', id: `RIDGE-P-0${sequence}`, sourceId },
    packId: 'ledger.part107',
    packTitle: 'Part 107',
    ruleId: 'ledger.part107.107.12.b',
    ruleTitle: 'Remote pilot certificate',
    paragraph: '14 CFR 107.12(b)',
    summary: 'The certificate on file is suspended.',
    cleared: false,
    mode: 'active',
    status: 'open',
    owner: null,
    ageDays: 0,
    relieved: false,
    evaluationId: `evaluation:${sequence}`,
    aboutAt: overrides.openedAt,
    ...overrides,
  };
}

const avery = { id: 'person-avery', name: 'Avery Example' };
const entries: OpenFindingEntry[] = [
  entry({ openedAt: '2026-11-20T10:00:00.000Z', owner: avery, status: 'acknowledged' }),
  entry({
    openedAt: '2026-11-01T10:00:00.000Z',
    subject: { scope: 'source', kind: 'aircraft', id: 'RIDGE-AC-1', sourceId },
    packId: 'ledger.example-bvlos-waiver',
    packTitle: 'Example Ridge Survey waiver',
    owner: avery,
    status: 'acknowledged',
    action: { note: 'Inspect the airframe', dueOn: '2026-11-10', overdue: true },
  }),
  entry({ openedAt: '2026-11-10T10:00:00.000Z', cleared: true }),
  entry({ openedAt: '2026-11-05T10:00:00.000Z', mode: 'shadow', packId: 'ledger.part108-nprm', packTitle: 'Part 108' }),
  entry({ openedAt: '2026-11-02T10:00:00.000Z', relieved: true }),
  entry({ openedAt: '2026-11-10T10:00:00.000Z' }),
];

describe('the list of open findings', () => {
  test('shows counted findings oldest first, ties by id, and counts every tab', () => {
    const shown = selectOpenFindings(entries, {});
    expect(shown.shown).toBe('counted');
    expect(shown.findings.map((item) => item.openedAt)).toEqual([
      '2026-11-01T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-10T10:00:00.000Z',
      '2026-11-20T10:00:00.000Z',
    ]);
    const tied = shown.findings.filter((item) => item.openedAt === '2026-11-10T10:00:00.000Z').map((item) => item.id);
    expect(tied).toEqual([...tied].sort());
    expect(shown.counts).toEqual({ counted: 4, proposed: 1, relieved: 1 });
    expect(shown.attention).toEqual({ unowned: 2, overdue: 1 });
  });

  test('keeps shadow findings on their own tab, never counted in what needs attention', () => {
    const proposed = selectOpenFindings(entries, { shown: 'proposed' });
    expect(proposed.findings.map((item) => item.mode)).toEqual(['shadow']);
    expect(proposed.filters.packs).toEqual([{ id: 'ledger.part108-nprm', title: 'Part 108' }]);
    expect(proposed.attention).toEqual({ unowned: 2, overdue: 1 });
  });

  test('filters by subject kind, pack and owner, and by nobody', () => {
    expect(selectOpenFindings(entries, { subjectKind: 'aircraft' }).findings.map((item) => item.subject.id)).toEqual([
      'RIDGE-AC-1',
    ]);
    expect(selectOpenFindings(entries, { packId: 'ledger.part107' }).findings).toHaveLength(3);
    expect(selectOpenFindings(entries, { owner: avery.id }).findings.every((item) => item.owner?.id === avery.id)).toBe(
      true,
    );
    expect(selectOpenFindings(entries, { owner: 'none' }).findings.every((item) => item.owner === null)).toBe(true);
    expect(selectOpenFindings(entries, { owner: 'none', subjectKind: 'aircraft' }).findings).toEqual([]);
    const cleared = selectOpenFindings(entries, { result: 'cleared' }).findings;
    expect(cleared.map((item) => item.cleared)).toEqual([true]);
    expect(selectOpenFindings(entries, { result: 'attention' }).findings).toHaveLength(3);
    const counted = selectOpenFindings(entries, {});
    expect(counted.filters.subjectKinds).toEqual(['aircraft', 'person']);
    expect(counted.filters.owners).toEqual([avery]);
  });

  test('pages with a cursor that continues after the last finding shown', () => {
    const first = selectOpenFindings(entries, { limit: 3 });
    expect(first.findings).toHaveLength(3);
    expect(first.page).toMatchObject({ limit: 3, hasMore: true });
    const rest = selectOpenFindings(entries, { limit: 3, cursor: first.page.nextCursor! });
    expect(rest.findings.map((item) => item.openedAt)).toEqual(['2026-11-20T10:00:00.000Z']);
    expect(rest.page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(() => selectOpenFindings(entries, { cursor: 'not-a-cursor' })).toThrow('page cursor');
  });
});

describe('the open findings grouped by rule', () => {
  const flight = (day: number, overrides: Partial<OpenFindingEntry> = {}) =>
    entry({
      openedAt: '2026-11-22T10:00:00.000Z',
      aboutAt: `2026-10-${String(day).padStart(2, '0')}T15:00:00.000Z`,
      subject: { scope: 'source', kind: 'flight', id: `RIDGE-F-${day}`, sourceId },
      ruleId: 'ledger.part107.107.49.preflight',
      ruleTitle: 'Preflight assessment on record',
      paragraph: '§ 107.49',
      ...overrides,
    });
  const history: OpenFindingEntry[] = [
    ...Array.from({ length: 12 }, (_, index) => flight(index + 1)),
    flight(13, { owner: avery, status: 'acknowledged' }),
    flight(14, { cleared: true }),
    // A rule that fans out names one flight twice, once for each related pilot.
    flight(3, { ruleId: 'ledger.example-crew.assigned', packId: 'ledger.example-crew', packTitle: 'Crew' }),
    flight(3, { ruleId: 'ledger.example-crew.assigned', packId: 'ledger.example-crew', packTitle: 'Crew' }),
    entry({ openedAt: '2026-11-20T10:00:00.000Z', aboutAt: '2025-09-10T00:00:00.000Z' }),
    entry({ openedAt: '2026-11-21T10:00:00.000Z', mode: 'shadow', packId: 'ledger.part108-nprm' }),
    entry({ openedAt: '2026-11-21T10:00:00.000Z', relieved: true }),
  ];

  test('counts each rule’s open findings, subjects, owners and the oldest, fewest first', () => {
    const read = groupOpenFindings(history, {});
    expect(read.order).toBe('fewest');
    expect(read.groups.map((group) => [group.ruleId, group.open])).toEqual([
      ['ledger.part107.107.12.b', 1],
      ['ledger.example-crew.assigned', 2],
      ['ledger.part107.107.49.preflight', 14],
    ]);
    expect(read.total).toEqual({ findings: 17, rules: 3 });
    expect(read.counts).toEqual({ counted: 17, proposed: 1, relieved: 1 });
    const [, crew, preflight] = read.groups;
    expect(crew).toMatchObject({ open: 2, subjects: 1, owned: 0 });
    expect(preflight).toMatchObject({
      packId: 'ledger.part107',
      ruleTitle: 'Preflight assessment on record',
      paragraph: '§ 107.49',
      open: 14,
      subjects: 14,
      owned: 1,
      cleared: 1,
      oldestOpenedAt: '2026-11-22T10:00:00.000Z',
      aboutFrom: '2026-10-01T15:00:00.000Z',
      aboutUntil: '2026-10-14T15:00:00.000Z',
    });
    expect(groupOpenFindings(history, { order: 'most' }).groups.map((group) => group.open)).toEqual([14, 2, 1]);
  });

  test('groups only the shown tab and what the filters and the days select', () => {
    expect(groupOpenFindings(history, { shown: 'proposed' }).groups.map((group) => group.packId)).toEqual([
      'ledger.part108-nprm',
    ]);
    expect(groupOpenFindings(history, { subjectKind: 'person' }).total).toEqual({ findings: 1, rules: 1 });
    expect(groupOpenFindings(history, { owner: 'none', packId: 'ledger.part107' }).total.findings).toBe(14);
    const october = groupOpenFindings(
      history,
      {},
      { from: '2026-10-05T06:00:00.000Z', before: '2026-10-08T06:00:00.000Z' },
    );
    expect(october.groups).toEqual([expect.objectContaining({ open: 3, aboutFrom: '2026-10-05T15:00:00.000Z' })]);
    const listed = selectOpenFindings(history, { ruleId: 'ledger.part107.107.49.preflight', limit: 5 });
    expect(listed.matching).toBe(14);
    expect(listed.findings).toHaveLength(5);
  });
});

describe('a finding in plain words', () => {
  test('says what was done about the action and how the finding closed', () => {
    expect(actionSentence({ note: 'Ask for the certificate', dueOn: '2026-12-01', overdue: true })).toBe(
      'Ask for the certificate · due 2026-12-01 · overdue',
    );
    expect(
      closureSentence({
        by: 'record',
        closedAt: '2026-11-21T10:00:00.000Z',
        evaluationId: 'evaluation-2',
        summary: 'The certificate on file is held.',
        records: [{ observationId: 'obs-9', title: 'Credential', occurredAt: '2026-11-21T09:00:00.000Z' }],
      }),
    ).toBe('Closed by itself: a later record answered it. Record: Credential (obs-9).');
    expect(
      closureSentence({
        by: 'person',
        closedAt: '2026-11-21T10:00:00.000Z',
        reason: 'recorded_in_error',
        actorName: 'Avery Example',
        note: 'Entered against the wrong pilot.',
      }),
    ).toBe('Closed by Avery Example: Recorded in error. Entered against the wrong pilot.');
  });
});
