import { describe, expect, it } from 'vitest';
import {
  observationSubjectKindValues,
  type CoverageSection,
  type RuleCoverage,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import {
  answered,
  fieldKey,
  offeredPacks,
  packReliefs,
  parameterFields,
  parameterQuestions,
  parameterValues,
  startingEntries,
  statedDatesSentence,
  adoptionDays,
  adoptionDaysSentence,
  startingDays,
} from '../../apps/web/src/rule-adoption.js';
import {
  completeness,
  coverageFilterLabels,
  coverageGroups,
  coverageResultLabels,
  emptyPopulationHint,
  filterCounts,
  leafCheckedBy,
  missingWords,
  nothingYetIn,
  oneSubject,
  recordTypeName,
  ruleMatches,
  sectionWords,
  shownCounts,
} from '../../apps/web/src/rule-coverage.js';

describe('a waiver’s stated dates', () => {
  const waiver = {
    certificateNumber: 'EXW-0417',
    conditionsCover: 'flights_citing_certificate' as const,
    effective: { from: '2026-06-01', through: '2028-05-31' },
  };
  const at = (instant: string) => Date.parse(instant);

  it('says when the certificate states its dates end, and how many days remain, never whether it is in effect', () => {
    expect(statedDatesSentence(waiver, at('2026-11-22T15:00:00Z'), 'America/Denver')).toBe(
      'The certificate states it is effective through May 31, 2028, 556 days from today.',
    );
    expect(statedDatesSentence(waiver, at('2028-05-30T12:00:00Z'), 'UTC')).toBe(
      'The certificate states it is effective through May 31, 2028, 1 day from today.',
    );
    expect(statedDatesSentence(waiver, at('2028-05-31T12:00:00Z'), 'UTC')).toBe(
      'The certificate states it is effective through May 31, 2028, today is the last day it states.',
    );
    // Late on its last day in Denver, already the next day in UTC.
    expect(statedDatesSentence(waiver, at('2028-06-01T03:00:00Z'), 'America/Denver')).toMatch(/today is the last day/);
    expect(statedDatesSentence(waiver, at('2028-06-01T12:00:00Z'), 'UTC')).toBe(
      'The certificate states it is effective through May 31, 2028. That date has passed.',
    );
    expect(statedDatesSentence(waiver, at('2026-05-01T12:00:00Z'), 'UTC')).toBe(
      'The certificate states it is effective from June 1, 2026 through May 31, 2028, 761 days from today.',
    );
    for (const sentence of [statedDatesSentence(waiver, at('2027-01-01T00:00:00Z'), 'UTC')])
      expect(sentence).not.toMatch(/\b(valid|expired|in force|compliant|authori[sz]ed)\b/i);
  });

  it('starts the adopt form at a waiver’s stated dates, else today and a year on, in the organization’s zone', () => {
    expect(startingDays(waiver, at('2026-11-22T15:00:00Z'), 'America/Denver')).toEqual({
      from: '2026-06-01',
      through: '2028-05-31',
    });
    // Late on November 22 in Denver is already November 23 in UTC.
    expect(startingDays(undefined, at('2026-11-23T03:00:00Z'), 'America/Denver')).toEqual({
      from: '2026-11-22',
      through: '2027-11-21',
    });
  });

  it('reads the chosen days as the command-line client does: from the start of the first to the end of the last', () => {
    expect(adoptionDays('2026-06-01', '2028-05-31', 'America/Denver')).toEqual({
      interval: { start: '2026-06-01T06:00:00.000Z', end: '2028-06-01T06:00:00.000Z' },
    });
    // A start before today is kept: records and flights already on file fall inside the dates.
    expect(adoptionDays('2025-01-01', '2025-01-01', 'UTC')).toEqual({
      interval: { start: '2025-01-01T00:00:00.000Z', end: '2025-01-02T00:00:00.000Z' },
    });
    expect(adoptionDays('2026-06-02', '2026-06-01', 'UTC')).toEqual({
      problem: 'The last day is before the first day.',
    });
    expect(adoptionDays('', '2026-06-01', 'UTC')).toEqual({ problem: 'Choose the day the adoption starts.' });
    expect(adoptionDays('2026-02-30', '2026-06-01', 'UTC')).toEqual({ problem: 'Choose the day the adoption starts.' });
    expect(adoptionDaysSentence('2026-06-01', '2028-05-31', 'America/Denver')).toBe(
      'The rules cover flights and records inside these dates: from the start of June 1, 2026 to the end of May 31, 2028, in America/Denver. Anything recorded about a time before or after them is not counted under this adoption.',
    );
  });
});

describe('the adopt form', () => {
  it('asks once for a time zone several rules declare alike, and gives the answer to each', () => {
    const pack = getRulePackVersion('ledger.part108-nprm', 3)!;
    const fields = parameterFields(pack);
    const timeZones = fields.filter((field) => field.parameter.name === 'timeZone');
    expect(timeZones.length).toBe(10);
    const questions = parameterQuestions(fields);
    expect(questions.filter((question) => question.parameter.name === 'timeZone')).toHaveLength(1);
    let entries: Record<string, string> = {};
    for (const question of questions)
      entries = answered(entries, question, question.parameter.name === 'timeZone' ? 'UTC' : '1');
    expect(new Set(timeZones.map((field) => entries[fieldKey(field)]))).toEqual(new Set(['UTC']));
    expect(parameterValues(fields, entries).invalid).toBeUndefined();
  });

  it('says how each rule of a pack is checked', () => {
    const pack = getRulePackVersion('ledger.part107', 2)!;
    expect(new Set(pack.leaves.map(leafCheckedBy))).toEqual(new Set(['automatic', 'person']));
  });
});

describe('coverage words', () => {
  const rule: RuleCoverage = {
    leafId: 'test.rule',
    title: 'Fictional rule',
    checkedBy: 'automatic',
    section: 'all',
    subjectKind: 'person',
    population: { of: 'on_record' },
    populationSize: 4,
    counts: {
      supported: 1,
      attention: 0,
      no_record: 3,
      pending: 0,
      not_applicable: 0,
      relieved: 0,
      other: 0,
      not_evaluated: 0,
    },
    complete: true,
  };

  it('shows the counts that are not empty, what asks most of a person first', () => {
    expect(shownCounts(rule.counts!)).toEqual([
      { result: 'no_record', count: 3 },
      { result: 'supported', count: 1 },
    ]);
    expect(completeness(rule, 2000)).toBeNull();
    expect(completeness({ ...rule, complete: false, incomplete: 'population_limit' }, 2000)).toBe(
      'More than 2,000 subjects are on record; the first 2,000 are counted.',
    );
    expect(missingWords(['remote pilot certificate'])).toBe('No remote pilot certificate on file.');
  });

  it('words no count as a verdict', () => {
    for (const label of Object.values(coverageResultLabels))
      expect(label).not.toMatch(/\b(compliant|compliance|ready|passed|authori[sz]ed|go|no-go)\b/i);
  });
});

describe('what the adopt form offers and starts with', () => {
  const summary = (packId: string, version: number, own = false) => ({
    packId,
    version,
    title: packId,
    digest: 'a'.repeat(64),
    origin: own
      ? ({ kind: 'organization_file', file: `${packId}-v${version}.pack.json` } as const)
      : ({ kind: 'built_in' } as const),
  });

  it('offers the latest version of each pack, own files first, with earlier versions apart', () => {
    const offered = offeredPacks([
      summary('ledger.part107', 1),
      summary('ledger.part107', 2),
      summary('example.waiver', 1, true),
      summary('ledger.part108-nprm', 3),
    ]);
    expect(
      offered.latest.map((group) => [group.label, group.packs.map((pack) => `${pack.packId}@${pack.version}`)]),
    ).toEqual([
      ['Your organization’s files', ['example.waiver@1']],
      ['Built into Ledger', ['ledger.part107@2', 'ledger.part108-nprm@3']],
    ]);
    expect(offered.earlier.map((pack) => `${pack.packId}@${pack.version}`)).toEqual(['ledger.part107@1']);
    expect(offeredPacks([summary('ledger.part107', 2)])).toEqual({
      latest: [{ label: 'Built into Ledger', packs: [summary('ledger.part107', 2)] }],
      earlier: [],
    });
  });

  it('starts a time zone value as the organization’s own zone and leaves other values empty', () => {
    const pack = getRulePackVersion('ledger.part108-nprm', 3)!;
    const fields = parameterFields(pack);
    const entries = startingEntries(fields, 'America/Denver');
    const zones = fields.filter((field) => field.parameter.name === 'timeZone');
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.map((field) => entries[fieldKey(field)])).toEqual(zones.map(() => 'America/Denver'));
    expect(Object.keys(entries)).toHaveLength(zones.length);
  });

  it('lists the rules of another pack a waiver relieves', () => {
    const waiver = getRulePackVersion('ledger.example-bvlos-waiver', 1)!;
    expect(packReliefs(waiver)).toEqual([
      {
        leafId: 'ledger.example-bvlos-waiver.provision-1',
        packId: 'ledger.part107',
        ruleIds: ['ledger.part107.107.31.a'],
      },
    ]);
    expect(packReliefs(getRulePackVersion('ledger.part107', 2)!)).toEqual([]);
  });

  it('says how a subject comes to be on record when a rule covers none yet', () => {
    const rule = { subjectKind: 'person', populationSize: 0 } as RuleCoverage;
    expect(emptyPopulationHint(rule)).toBe(
      'A person is on record once a record about them is imported or entered under Records.',
    );
    // A rule about the people a record names says which record names them, not that no one is on record.
    const designated = {
      ...rule,
      population: {
        of: 'designated',
        by: {
          type: 'operator.record',
          versions: [1],
          field: 'values.record.personId',
          where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
        },
      },
    } as RuleCoverage;
    expect(emptyPopulationHint(designated)).toBe(
      'A person is counted here once a record of type Role assignment names them. Import or enter it under Records.',
    );
    expect(emptyPopulationHint({ ...rule, populationSize: 2 })).toBeNull();
    expect(emptyPopulationHint({ ...rule, populationSize: null })).toBeNull();
  });
});

describe('a rule that counts nothing yet', () => {
  it('starts its sentence with the article its subject kind takes, for every kind', () => {
    const expected: Record<(typeof observationSubjectKindValues)[number], string> = {
      flight: 'A flight',
      aircraft: 'An aircraft',
      person: 'A person',
      site: 'A site',
      organization: 'An organization',
      component: 'A component',
    };
    for (const kind of observationSubjectKindValues) expect(oneSubject(kind)).toBe(expected[kind]);
    expect(oneSubject(undefined)).toBe('A subject');
  });

  it('names the record type as a person picks it under Records', () => {
    expect(recordTypeName('occurrence.security')).toBe('Security occurrence');
    expect(recordTypeName('fictional.unknown-type')).toBe('fictional.unknown-type');
    // A type a pack declares is named by the organization's catalog, which lists it.
    const catalog = [{ recordType: 'fictional.dock-check', recordVersion: 1, title: 'Dock check' }];
    expect(recordTypeName('fictional.dock-check', catalog)).toBe('Dock check');
    expect(recordTypeName('occurrence.security', catalog)).toBe('Security occurrence');
    const rule = {
      subjectKind: 'organization',
      populationSize: 0,
      population: {
        of: 'designated',
        by: {
          type: 'operator.record',
          versions: [1],
          field: 'subject',
          where: [{ field: 'values.recordType', oneOf: ['occurrence.security'] }],
        },
      },
    } as RuleCoverage;
    expect(emptyPopulationHint(rule)).toBe(
      'An organization is counted here once a record of type Security occurrence names it. Import or enter it under Records.',
    );
    expect(emptyPopulationHint({ subjectKind: 'aircraft', populationSize: 0 } as RuleCoverage)).toBe(
      'An aircraft is on record once a record about it is imported or entered under Records.',
    );
  });
});

describe('the counts a pack’s coverage opens with', () => {
  const none = {
    supported: 0,
    attention: 0,
    no_record: 0,
    pending: 0,
    not_applicable: 0,
    relieved: 0,
    other: 0,
    not_evaluated: 0,
  };
  const rule = (
    leafId: string,
    section: string,
    counts: Partial<typeof none> | null,
    more: Partial<RuleCoverage> = {},
  ) =>
    ({
      leafId,
      title: leafId,
      checkedBy: 'automatic',
      section,
      subjectKind: 'flight',
      populationSize: counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null,
      counts: counts && { ...none, ...counts },
      complete: true,
      ...more,
    }) as RuleCoverage;
  const rules = [
    rule('a.attention', 'a', { attention: 1, supported: 2 }),
    rule('a.supported', 'a', { supported: 3 }),
    rule('a.nothing', 'a', {}),
    rule('b.supported', 'b', { supported: 1, not_applicable: 4 }),
    rule('b.reviewed', 'b', null, { checkedBy: 'person' }),
    rule('c.nothing', 'c', {}),
  ];
  const section = (id: string): CoverageSection => {
    const leafIds = rules.filter((item) => item.section === id).map((item) => item.leafId);
    return {
      id,
      title: `Section ${id}`,
      leafIds,
      checkedBy: { automatic: leafIds.length, person: 0, not_supported: 0 },
      needingAttention: 0,
      withNoRecord: 0,
    };
  };
  const coverage = { sections: [section('a'), section('b'), section('c')], rules };

  it('counts rules, each in every count it has a subject in, the empty counts included', () => {
    expect(filterCounts(rules)).toEqual([
      { filter: 'attention', count: 1 },
      { filter: 'no_record', count: 0 },
      { filter: 'supported', count: 3 },
      { filter: 'relieved', count: 0 },
      { filter: 'person', count: 1 },
      { filter: 'not_applicable', count: 1 },
      { filter: 'nothing_yet', count: 2 },
    ]);
    expect(ruleMatches(rules[0]!, 'supported')).toBe(true);
    expect(ruleMatches(rules[2]!, 'supported')).toBe(false);
  });

  it('uses the words the rows use, none of them a verdict', () => {
    expect(coverageFilterLabels).toEqual({
      attention: 'Needs attention',
      no_record: 'No record on file',
      supported: 'Supported by the record',
      relieved: 'Relieved by a waiver',
      person: 'A person reviews it',
      not_applicable: 'Does not apply',
      nothing_yet: 'Nothing counted yet',
    });
    for (const label of Object.values(coverageFilterLabels))
      expect(label).not.toMatch(/\b(compliant|compliance|ready|passed|authori[sz]ed|go|no-go)\b/i);
  });

  it('opens a section with something to do, folds the others, and lists the rules counting nothing yet last', () => {
    const groups = coverageGroups(coverage, null);
    expect(
      groups.map((group) => [group.section?.id ?? 'nothing yet', group.rules.map((item) => item.leafId), group.opens]),
    ).toEqual([
      ['a', ['a.attention', 'a.supported'], true],
      ['b', ['b.supported', 'b.reviewed'], false],
      ['nothing yet', ['a.nothing', 'c.nothing'], false],
    ]);
    expect(nothingYetIn(section('a'), rules)).toBe(1);
    expect(sectionWords(section('a'), 1)).toBe(
      '3 rules: 3 checked automatically; 1 counting nothing yet, listed under Nothing counted yet.',
    );
    expect(sectionWords(section('b'))).toBe('2 rules: 2 checked automatically.');
  });

  it('with a filter, shows only the sections with a matching rule, open, with those rules', () => {
    const shown = (filter: Parameters<typeof coverageGroups>[1]) =>
      coverageGroups(coverage, filter).map((group) => [
        group.section?.id ?? 'nothing yet',
        group.rules.map((item) => item.leafId),
        group.opens,
      ]);
    expect(shown('supported')).toEqual([
      ['a', ['a.attention', 'a.supported'], true],
      ['b', ['b.supported'], true],
    ]);
    expect(shown('person')).toEqual([['b', ['b.reviewed'], true]]);
    expect(shown('nothing_yet')).toEqual([['nothing yet', ['a.nothing', 'c.nothing'], true]]);
    expect(shown('relieved')).toEqual([]);
  });
});
