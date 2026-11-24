import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf, type RulePackLeaf } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { adoptionParameterProblem, narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID, PART108_NPRM_SOURCE_ID, part108NprmRulePack } from '../src/index.js';
import { federalHolidayCalendar } from '../src/federal-holidays.js';
import { checkedEntries, uncheckedEntries } from '../src/part108-nprm-v2.js';
import {
  addedCheckedEntries,
  addedUncheckedEntries,
  depthCheckedEntries,
  depthUncheckedEntries,
  flightRecordCheckedEntries,
  flownCheckedEntries,
  newlyCheckedEntries,
  onFileCheckedEntries,
  onFileUncheckedEntries,
  planReadingIds,
  quotedInVersionTwo,
} from '../src/part108-nprm-v3.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
const versionTwo = getRulePackVersion(PART108_NPRM_PACK_ID, 2)!;

function leaf(id: string): CheckedRuleLeaf {
  const found = pack.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
/** One operator record. Time: an instant, or an interval with an optional end. */
function record(
  recordType: string,
  body: Record<string, unknown>,
  time: { at?: string; start?: string; end?: string } = {},
): CheckObservation {
  const occurredAt = time.at ?? time.start ?? '2026-10-19T08:00:00.000Z';
  const interval = time.start ? { start: time.start, ...(time.end ? { end: time.end } : {}) } : undefined;
  const values = { recordType, recordVersion: 1, record: body };
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt,
    ...(interval ? { interval } : {}),
    observation: { occurredAt, ...(interval ? { interval } : {}), values },
  };
}

function period(kind: 'duty' | 'rest', start: string, end?: string): CheckObservation {
  const interval = { start, ...(end ? { end } : {}) };
  return {
    id: `period-${++sequence}`,
    type: 'crew.duty-period',
    version: 1,
    occurredAt: start,
    interval,
    observation: { occurredAt: start, interval, values: { period: kind } },
  };
}

function flightReport(values: Record<string, unknown>, at: string): CheckObservation {
  return {
    id: `report-${++sequence}`,
    type: 'flight.report',
    version: 1,
    occurredAt: at,
    observation: { occurredAt: at, values },
  };
}

/** A record of an unrelated type, so each case also shows the read keeps it out. */
const unrelated = () => record('aircraft.condition', { recordedCondition: 'not_determined' });

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/**
 * Gathers each read as the engine does for one result: reads about the target from the target's observations, reads
 * about a related subject from that subject's (for a fanned-out rule, the one subject of this result).
 */
function run(
  id: string,
  target: CheckObservation[],
  related: Record<string, CheckObservation[]> = {},
  parameters: Record<string, unknown> = {},
) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads) {
    const about = typeof read.about === 'object' && 'related' in read.about ? related[read.about.related] : target;
    inputs[read.name] = narrowRead(
      read,
      [...(about ?? []), unrelated()].filter((item) => item.type === read.type).sort(newestFirst),
      inputs,
    );
  }
  return runCheckedRule(rule, { ...rule.check.params, ...parameters }, inputs, clock);
}

type Gathered = Parameters<typeof run>;
function expectResult(
  [id, target, related, parameters]: Gathered,
  evidenceState: string,
  outcome: string,
  reasonCode: string,
) {
  const result = run(id, target, related, parameters);
  expect(result, id).toMatchObject({ evidenceState, outcome, reasonCode });
  return result;
}

/** A pass that cites what it read and says what remains for a person. */
function expectPass(gathered: Gathered, reasonCode: string, cited: CheckObservation[]) {
  const result = expectResult(gathered, 'supported', 'pass', reasonCode);
  expect(result.evidence, gathered[0]).toEqual(expect.arrayContaining(cited.map((item) => item.id)));
  expect(result.summary, gathered[0]).toMatch(/for a person to (review|confirm)/);
  return result;
}

const source = (id: string) => ({ id, scope: 'source' });
const newIds = newlyCheckedEntries.map(({ id }) => id);

/** A leaf without what placing it in a section adds, for comparing it with the version 2 leaf it carries on. */
function unplaced(item: RulePackLeaf) {
  const { section: _section, paragraph: _paragraph, digest: _digest, ...rest } = item;
  return rest;
}

describe('Part 108 NPRM version 3', () => {
  it('is registered with its digest, schema-valid, and keeps versions 1 and 2 as they were', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(part108NprmRulePack().versions.map(({ version, digest }) => ({ version, digest }))).toEqual([
      { version: 1, digest: '2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584' },
      { version: 2, digest: '27244ddf8f60502a791a8c8c6144a08cd092e8ffba6915a388c80da27ce7e6e2' },
      { version: 3, digest: pack.digest },
    ]);
    expect(pack.digest).toBe('e95017f405bd0a007cc636a3dd487685f59da94b4146d24c6af3b7b2e93f4dab');
    expect(pack).toMatchObject({ packId: PART108_NPRM_PACK_ID, version: 3, status: 'draft', bindings: [] });
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
    // Every rule version 2 checked is carried unchanged, but for those about a plan, and so is version 1's
    // communication assessment. Its safety management system entry is now a person's check beside the rules on file.
    const changed = [...newIds, ...planReadingIds, 'ledger.nprm.108.560.a'];
    for (const kept of versionTwo.leaves.filter((item) => !changed.includes(item.id)))
      expect(unplaced(pack.leaves.find((item) => item.id === kept.id)!)).toEqual(unplaced(kept));
  });

  it('places every rule in the section of the proposed part it quotes, with its paragraph, ordered by section', () => {
    const ids = pack.sections!.map(({ id }) => id);
    expect(ids[0]).toBe('108.40');
    expect(ids).toEqual([...ids].sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1])));
    expect(pack.sections!.find(({ id }) => id === '108.165')).toEqual({
      id: '108.165',
      title: '§ 108.165 Area of operations',
    });
    expect(leaf('ledger.nprm.108.40.a.3.i')).toMatchObject({ section: '108.40', paragraph: '§ 108.40(a)(3)(i)' });
    for (const item of pack.leaves) {
      expect(ids, item.id).toContain(item.section);
      expect(item.paragraph, item.id).toBe(`§ ${item.source.reference.replace(/^Proposed 14 CFR /, '')}`);
    }
    const order = pack.leaves.map((item) => ids.indexOf(item.section!));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('checks every paragraph version 2 quoted without a check, as version 2 of that rule, on the same quote', () => {
    expect(newIds.sort()).toEqual(uncheckedEntries.map(({ id }) => id).sort());
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(pack.leaves.map(({ id, version, coverage }) => ({ id, version, coverage })).sort(byId)).toEqual(
      [
        ...checkedEntries.map(({ id }) => ({
          id,
          version: planReadingIds.includes(id) ? 2 : 1,
          coverage: 'automated',
        })),
        ...newlyCheckedEntries.map(({ id }) => ({
          id,
          version: planReadingIds.includes(id) ? 3 : 2,
          coverage: 'automated',
        })),
        ...[
          ...addedCheckedEntries,
          ...flightRecordCheckedEntries,
          ...onFileCheckedEntries,
          ...flownCheckedEntries,
          ...depthCheckedEntries,
        ].map(({ id }) => ({
          id,
          version: 1,
          coverage: 'automated',
        })),
        ...[...addedUncheckedEntries, ...onFileUncheckedEntries, ...depthUncheckedEntries].map(({ id, coverage }) => ({
          id,
          version: 1,
          coverage,
        })),
        { id: 'ledger.nprm.108.550.a', version: 1, coverage: 'manual' },
        { id: 'ledger.nprm.108.560.a', version: 2, coverage: 'manual' },
      ].sort(byId),
    );
    for (const { id } of newlyCheckedEntries) {
      const before = versionTwo.leaves.find((item) => item.id === id)!;
      expect(before).toMatchObject({ version: 1, coverage: 'unsupported' });
      expect(leaf(id).source, id).toEqual(before.source);
      expect(quotedInVersionTwo(id).sha256).toBe(before.source.sha256);
    }
    for (const entry of newlyCheckedEntries) {
      expect(entry.answers, entry.id).toMatch(/^Per (aircraft|person|flight|component)/);
      expect(entry.forAPerson.length, entry.id).toBeGreaterThan(0);
    }
  });

  it('quotes every rule from the retained notice by pinned byte span, as proposed text', async () => {
    const retained = (await getRuleSource(PART108_NPRM_SOURCE_ID))!;
    for (const item of pack.leaves) {
      if (item.source.kind !== 'proposed_regulation') throw new Error(`${item.id} must quote proposed text`);
      const span = item.source.textSpan;
      const snippet = retained.bytes.subarray(span.start, span.end);
      expect(snippet.toString('utf8'), item.id).toBe(item.source.text);
      expect(sha256(snippet), item.id).toBe(item.source.sha256);
      expect(span).toMatchObject({ unit: 'utf8_byte', sourceId: PART108_NPRM_SOURCE_ID });
      expect(item.source.reference, item.id).toMatch(/^Proposed 14 CFR 108\.\d+\(/);
      const { digest, ...content } = item;
      expect(canonicalDigest(content)).toBe(digest);
    }
  });

  it('words nothing as a verdict and nothing as current law, and states each reading for a person', () => {
    for (const item of pack.leaves) {
      const own = JSON.stringify({ title: item.title, wording: isCheckedRuleLeaf(item) ? item.wording : undefined });
      expect(own, item.id).not.toMatch(/\b(compliant|compliance|authori[sz]ed|go|no-go|current law|in force)\b/i);
    }
    for (const id of newIds) expect(leaf(id).wording?.pass, id).toMatch(/for a person to (review|confirm)/);
    expect(leaf('ledger.nprm.108.330.c').wording?.pass).toMatch(/local calendar day, midnight to midnight/);
    expect(leaf('ledger.nprm.108.45.f').wording?.pass).toMatch(/5 U\.S\.C\. 6103 for 2025 through 2027/);
  });

  it('asks the organization for the time zone and week it counts days in', () => {
    const zoned = pack.leaves.filter(
      (item) => isCheckedRuleLeaf(item) && item.adoptionParameters.some(({ name }) => name === 'timeZone'),
    );
    const parameters: Record<string, Record<string, unknown>> = Object.fromEntries(
      zoned.map(({ id }) => [id, { timeZone: 'America/Denver' }]),
    );
    parameters['ledger.nprm.108.330.c'] = { timeZone: 'America/Denver', weekStartsOn: 1 };
    expect(adoptionParameterProblem(pack, parameters)).toBeUndefined();
    expect(adoptionParameterProblem(pack, undefined)).toMatch(/^Leaf ledger\.nprm\.[\w.-]+ needs parameter timeZone$/);
    expect(adoptionParameterProblem(pack, { ...parameters, 'ledger.nprm.108.45.f': { timeZone: 'MST' } })).toMatch(
      /^Leaf ledger.nprm.108.45.f: /,
    );
    expect(
      adoptionParameterProblem(pack, {
        ...parameters,
        'ledger.nprm.108.330.c': { timeZone: 'UTC', weekStartsOn: 8 },
      }),
    ).toBe('Leaf ledger.nprm.108.330.c: Parameter weekStartsOn is not a valid integer');
  });

  it('lists the observed Federal holidays of each covered year, on weekdays only', () => {
    const { dates, from, through } = federalHolidayCalendar;
    expect([from, through]).toEqual(['2025-01-01', '2027-12-31']);
    expect([...dates].sort()).toEqual([...dates]);
    for (const year of ['2025', '2026']) expect(dates.filter((date) => date.startsWith(year))).toHaveLength(11);
    // 2027 also holds New Year's Day 2028, a Saturday observed on the Friday before.
    expect(dates.filter((date) => date.startsWith('2027'))).toHaveLength(12);
    for (const date of dates) {
      expect(date >= from && date <= through, date).toBe(true);
      expect([0, 6], date).not.toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
    }
    expect(leaf('ledger.nprm.108.45.f').check.params).toMatchObject({
      excludedWeekdays: [6, 7],
      excludedDates: [...dates],
      calendarFrom: from,
      calendarThrough: through,
    });
  });
});

describe('Part 108 NPRM version 3 checks', () => {
  it('108.40(a)(1): total time in service from the latest complete total and later landed flights', () => {
    const id = 'ledger.nprm.108.40.a.1';
    const total = (totalTimeHours: number, coveredThroughAt: string, coverage = 'complete') =>
      record(
        'aircraft.time-in-service',
        { entryKind: 'opening_balance', totalTimeHours, coveredThroughAt, sourceReference: 'Log 1', coverage },
        { at: coveredThroughAt },
      );
    const landed = (takeoffAt: string | undefined, landingAt: string) =>
      flightReport({ activity: 'landed', ...(takeoffAt ? { takeoffAt } : {}), landingAt }, landingAt);
    const opening = total(120, '2026-10-01T00:00:00.000Z');
    const before = landed('2026-09-30T10:00:00.000Z', '2026-09-30T11:00:00.000Z');
    const first = landed('2026-10-05T10:00:00.000Z', '2026-10-05T11:30:00.000Z');
    const second = landed('2026-10-06T10:00:00.000Z', '2026-10-06T10:30:00.000Z');
    const active = flightReport({ activity: 'active', takeoffAt: '2026-10-07T10:00:00.000Z' }, '2026-10-07T10:00:00Z');
    const passed = expectPass([id, [opening, before, first, second, active]], 'total_derived', [
      opening,
      first,
      second,
    ]);
    expect(passed.details).toMatchObject({ openingValue: 120, additionCount: 2, total: 122 });
    expect(passed.evidence).not.toContain(before.id);
    expect(passed.summary).toMatch(/^A total time in service of 122 hours is derived/);
    // The same flight reported twice would be counted twice.
    expectResult(
      [id, [opening, first, landed('2026-10-05T10:00:00.000Z', '2026-10-05T11:30:00.000Z')]],
      'conflicting',
      'attention',
      'additions_overlap',
    );
    expectResult(
      [id, [opening, landed(undefined, '2026-10-05T11:30:00.000Z')]],
      'insufficient',
      'attention',
      'addition_value_missing',
    );
    // A total with partial coverage understates time in service, so it is not an opening balance.
    expectResult(
      [id, [total(80, '2026-10-01T00:00:00.000Z', 'partial'), first]],
      'insufficient',
      'pending',
      'record_not_on_file',
    );
  });

  it('108.330(c): a whole local calendar day of recorded rest in the week the organization counts', () => {
    const id = 'ledger.nprm.108.330.c';
    // The evaluation is Tuesday 2026-10-20, 06:00 in Denver; the week starts on Monday 2026-10-19 there.
    const denver = { timeZone: 'America/Denver', weekStartsOn: 1 };
    const wholeMonday = period('rest', '2026-10-19T06:00:00.000Z', '2026-10-20T06:00:00.000Z');
    expectPass([id, [wholeMonday], {}, denver], 'days_within_limit', [wholeMonday]);
    // The same rest is not a whole day in UTC, and a week from Sunday counts Sunday too.
    const short = period('rest', '2026-10-19T07:00:00.000Z', '2026-10-20T06:00:00.000Z');
    const pending = expectResult([id, [short], {}, denver], 'insufficient', 'pending', 'days_remaining');
    expect(pending.summary).toMatch(/^No whole local calendar day of the week 2026-10-19 to 2026-10-25/);
    expectResult(
      [id, [short, period('duty', '2026-10-19T06:00:00.000Z', '2026-10-19T07:00:00.000Z')], {}, { ...denver }],
      'insufficient',
      'pending',
      'days_remaining',
    );
    // Evaluated on the week's last day with no whole day of rest, it needs attention.
    const sunday = { mode: 'wall' as const, evaluatedAt: '2026-10-26T05:00:00.000Z' };
    const rule = leaf(id);
    const outside = runCheckedRule(rule, { ...rule.check.params, ...denver }, { subject: [short] }, sunday);
    expect(outside).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      reasonCode: 'days_outside_limit',
    });
    expectResult([id, [], {}, denver], 'insufficient', 'pending', 'record_not_on_file');
    expectResult(
      [id, [period('rest', '2026-10-19T06:00:00.000Z')], {}, denver],
      'insufficient',
      'attention',
      'interval_end_missing',
    );
  });

  it('108.45(f): a deviation reported within 10 days, excluding Saturdays, Sundays and Federal holidays', () => {
    const id = 'ledger.nprm.108.45.f';
    const utc = { timeZone: 'UTC' };
    const deviation = (occurredAt: string, reportedToAuthorityAt?: string) =>
      record(
        'occurrence.emergency-deviation',
        { occurredAt, summary: 'Fictional deviation', ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}) },
        { at: occurredAt },
      );
    // Thursday 2026-11-05: ten days later, skipping two weekends, Veterans Day and nothing else, is Friday 11-20.
    const reported = deviation('2026-11-05T15:00:00.000Z', '2026-11-20T23:00:00.000Z');
    const passed = expectPass([id, [reported], {}, utc], 'within_business_days', [reported]);
    expect(passed.details).toMatchObject({ startDay: '2026-11-05', dueThrough: '2026-11-20' });
    expectResult(
      [id, [deviation('2026-11-05T15:00:00.000Z', '2026-11-21T00:00:00.000Z')], {}, utc],
      'supported',
      'attention',
      'after_business_days',
    );
    expectResult([id, [deviation('2026-09-01T15:00:00.000Z')], {}, utc], 'insufficient', 'attention', 'end_overdue');
    const awaited = expectResult(
      [id, [deviation('2026-10-19T15:00:00.000Z')], {}, utc],
      'insufficient',
      'pending',
      'end_awaited',
    );
    expect(awaited.summary).toMatch(/due by the end of 2026-11-02/);
    // Past the years the holiday list covers, the count is not guessed.
    expectResult(
      [id, [deviation('2027-12-24T15:00:00.000Z', '2027-12-28T15:00:00.000Z')], {}, utc],
      'insufficient',
      'pending',
      'calendar_not_covered',
    );
    expectResult([id, [], {}, utc], 'not_applicable', 'not_applicable', 'start_not_recorded');
  });

  it('108.615(a): a part within its life on the aircraft its life-limit record names', () => {
    const id = 'ledger.nprm.108.615.a';
    expect(leaf(id).related).toEqual([
      {
        name: 'aircraft',
        subjectKind: 'aircraft',
        fanOut: false,
        whenNone: 'insufficient',
        from: { read: 'limit', field: 'values.record.aircraftId' },
      },
    ]);
    const limit = (partTimeAtInstallHours?: number, removedAt?: string) =>
      record(
        'component.life-limit',
        {
          partName: 'Rotor arm',
          aircraftId: source('AC-1'),
          installedAt: '2026-06-01T00:00:00Z',
          lifeLimitHours: 300,
          ...(partTimeAtInstallHours === undefined ? {} : { partTimeAtInstallHours }),
          ...(removedAt ? { removedAt } : {}),
        },
        { start: '2026-06-01T00:00:00.000Z', end: removedAt },
      );
    const total = (totalTimeHours: number, coveredThroughAt: string, coverage = 'complete') =>
      record(
        'aircraft.time-in-service',
        { entryKind: 'running_total', totalTimeHours, coveredThroughAt, sourceReference: 'Log 1', coverage },
        { at: coveredThroughAt },
      );
    const atInstall = total(500, '2026-05-31T00:00:00.000Z');
    const latest = total(720, '2026-10-19T00:00:00.000Z');
    const installed = limit(60);
    const passed = expectPass([id, [installed], { aircraft: [atInstall, latest] }], 'value_within_limit', [
      installed,
      atInstall,
      latest,
    ]);
    expect(passed.summary).toMatch(/within the recorded life limit/);
    // 60 hours at installation plus 250 on the aircraft since is past 300.
    expectResult(
      [id, [installed], { aircraft: [atInstall, total(750, '2026-10-19T00:00:00.000Z')] }],
      'supported',
      'attention',
      'value_outside_limit',
    );
    expectResult([id, [installed], { aircraft: [latest] }], 'insufficient', 'attention', 'baseline_missing');
    expectResult([id, [limit()], { aircraft: [atInstall, latest] }], 'insufficient', 'attention', 'offset_missing');
    expectResult(
      [id, [installed], { aircraft: [total(500, '2026-05-31T00:00:00.000Z', 'partial'), latest] }],
      'insufficient',
      'attention',
      'baseline_missing',
    );
    expectResult(
      [id, [limit(60, '2026-09-01T00:00:00Z')], { aircraft: [atInstall, latest] }],
      'not_applicable',
      'not_applicable',
      'limit_ended',
    );
  });

  it('108.310(e): each assigned coordinator has 5 supervised hours in the planned make and model', () => {
    const id = 'ledger.nprm.108.310.e';
    expect(leaf(id).related).toEqual([
      {
        name: 'aircraft',
        subjectKind: 'aircraft',
        fanOut: false,
        whenNone: 'insufficient',
        from: { read: 'plan', field: 'secondarySubject' },
      },
      {
        name: 'coordinator',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'not_applicable',
        from: { read: 'assignments', field: 'values.record.personId' },
      },
    ]);
    const plan = record(
      'flight.plan',
      { windowStartsAt: '2026-10-20T09:00:00Z', windowEndsAt: '2026-10-20T10:00:00Z', operationKind: 'inspection' },
      { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' },
    );
    const assignment = record(
      'operation.role-assignment',
      { personId: source('PER-1'), role: 'flight_coordinator', startsAt: '2026-10-20T08:30:00Z' },
      { start: '2026-10-20T08:30:00.000Z' },
    );
    const identity = record('aircraft.identity', {
      aircraftMakeModel: 'Fictional Hex 6',
      serialNumber: 'SN-1',
      registrationNumber: 'FA0000001',
    });
    const experience = (aircraftMakeModel: string, supervisedHours: number) =>
      record('person.aircraft-experience', {
        role: 'flight_coordinator',
        aircraftMakeModel,
        supervisedHours,
        supervisorReference: 'Sign-off 7',
        recentHours: 3,
        recentPeriodStartsOn: '2026-07-01',
        recentPeriodEndsOn: '2026-09-30',
        qualificationReference: 'Q-1',
      });
    const matching = experience('  fictional hex 6 ', 6);
    const passed = expectPass(
      [id, [plan, assignment], { aircraft: [identity], coordinator: [experience('Fictional Quad 4', 40), matching] }],
      'values_match',
      [identity, matching],
    );
    expect(passed.summary).toMatch(
      /^The aircraft planned for the flight is recorded as fictional hex 6 .* holds 6 hours/,
    );
    expectResult(
      [id, [plan, assignment], { aircraft: [identity], coordinator: [experience('Fictional Hex 6', 4.5)] }],
      'supported',
      'attention',
      'matched_value_outside_limit',
    );
    expectResult(
      [id, [plan, assignment], { aircraft: [identity], coordinator: [experience('Fictional Quad 4', 40)] }],
      'supported',
      'attention',
      'values_do_not_match',
    );
    expectResult(
      [id, [plan, assignment], { aircraft: [identity], coordinator: [] }],
      'insufficient',
      'pending',
      'candidate_value_missing',
    );
    expectResult(
      [id, [plan, assignment], { aircraft: [], coordinator: [matching] }],
      'insufficient',
      'pending',
      'reference_value_missing',
    );
  });
});

describe('Part 108 NPRM version 3 rules about a plan', () => {
  it('read plans in every read, as the next version of each rule, and read nothing else that way', () => {
    for (const item of pack.leaves.filter(isCheckedRuleLeaf)) {
      const planReads = item.reads.filter((read) => read.plans);
      if (item.id === 'ledger.nprm.108.310.f') expect(planReads, item.id).toHaveLength(item.reads.length);
      else if (planReadingIds.includes(item.id)) {
        expect(planReads, item.id).toHaveLength(item.reads.length);
        const earlier = versionTwo.leaves.find((other) => other.id === item.id)!;
        expect(item.version, item.id).toBe(earlier.version + (earlier.coverage === 'automated' ? 1 : 2));
      } else if (onFileCheckedEntries.some(({ id }) => id === item.id)) {
        // A document issued to take effect later is read as soon as it is recorded, so its start is a boundary.
        expect(
          planReads.map(({ type }) => type),
          item.id,
        ).toEqual(item.reads.filter(({ type }) => type === 'organization.record-in-force').map(({ type }) => type));
      } else if (flownCheckedEntries.some(({ id }) => id === item.id)) {
        // The plan and authorizations are read as plans; what was flown is read as reported or recorded.
        expect(
          planReads.map(({ name }) => name),
          item.id,
        ).toEqual(
          item.reads
            .filter(({ type, name }) => type !== 'position.fix' && name !== 'recorded' && name !== 'area')
            .map(({ name }) => name),
        );
      } else if (['ledger.nprm.108.555.a', 'ledger.nprm.108.630.a.flight'].includes(item.id)) {
        // The plan is read as soon as it is recorded; the aircraft's records are read up to the plan's start.
        expect(
          planReads.map(({ name }) => name),
          item.id,
        ).toEqual(['plan']);
      } else expect(planReads, item.id).toEqual([]);
    }
  });

  it('give a result on a plan for a window that has not started', () => {
    // The evaluation clock is 2026-10-20T12:00Z; the planned window starts three days later.
    const start = '2026-10-23T09:00:00.000Z';
    const plan = record(
      'flight.plan',
      { windowStartsAt: '2026-10-23T09:00:00Z', windowEndsAt: '2026-10-23T10:00:00Z', operationKind: 'inspection' },
      { start, end: '2026-10-23T10:00:00.000Z' },
    );
    const assignment = record(
      'operation.role-assignment',
      {
        personId: source('PER-1'),
        role: 'flight_coordinator',
        startsAt: '2026-10-23T08:30:00Z',
        endsAt: '2026-10-23T10:30:00Z',
      },
      { start: '2026-10-23T08:30:00.000Z', end: '2026-10-23T10:30:00.000Z' },
    );
    const requirement = record('organization.coordinator-requirement', {
      coordinatorRequired: true,
      basis: 'operations_manual',
    });
    expectResult(['ledger.nprm.108.310.a', [requirement, assignment, plan]], 'supported', 'pass', 'window_covered');
    const assessment = record(
      'flight.preflight-assessment',
      { assessedAt: '2026-10-22T18:00:00Z', weatherDetermination: 'Forecast within limits for the window.' },
      { at: '2026-10-22T18:00:00.000Z' },
    );
    expectResult(['ledger.nprm.108.170.a', [assessment]], 'supported', 'pass', 'record_complete');
    const multiple = record(
      'operation.multiple-aircraft',
      { simultaneousAircraftCount: 2, manufacturerLimitCount: 3, methodLimitCount: 2, methodReference: 'Method 4' },
      { at: start },
    );
    expectResult(['ledger.nprm.108.210.b', [multiple]], 'supported', 'pass', 'value_within_limit');
  });
});
