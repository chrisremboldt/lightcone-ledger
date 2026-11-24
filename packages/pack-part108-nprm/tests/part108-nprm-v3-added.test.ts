import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import { addedCheckedEntries, addedUncheckedEntries } from '../src/part108-nprm-v3.js';

// The rules version 3 adds: reporting clocks, certificate records and the record types no pack read before.

const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
const adoption = { start: '2026-08-01T06:00:00.000Z', end: '2027-08-01T06:00:00.000Z' };
const denver = { timeZone: 'America/Denver' };
const utc = { timeZone: 'UTC' };
const longer = { start: adoption.start, end: '2029-01-01T00:00:00.000Z' };

function leaf(id: string): CheckedRuleLeaf {
  const found = pack.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
function record(recordType: string, body: Record<string, unknown>, at: string, end?: string): CheckObservation {
  const interval = end === undefined ? undefined : { start: at, ...(end ? { end } : {}) };
  const values = { recordType, recordVersion: 1, record: body };
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt: at,
    ...(interval ? { interval } : {}),
    observation: { occurredAt: at, ...(interval ? { interval } : {}), values },
  };
}

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/** Gathers each read as the engine does: reads about the organization from `organization`, the rest from the target. */
function run(
  id: string,
  target: CheckObservation[],
  evaluatedAt: string,
  parameters: Record<string, unknown> = {},
  organization: CheckObservation[] = [],
  dates = adoption,
) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads) {
    const about = read.about === 'organization' ? organization : target;
    inputs[read.name] = narrowRead(read, about.filter((item) => item.type === read.type).sort(newestFirst), inputs);
  }
  return runCheckedRule(rule, { ...rule.check.params, ...parameters }, inputs, {
    mode: 'wall',
    evaluatedAt,
    adoption: dates,
  });
}

function expectOutcome(result: ReturnType<typeof run>, evidenceState: string, outcome: string, reasonCode: string) {
  expect(result).toMatchObject({ evidenceState, outcome, reasonCode });
  return result;
}

function expectPass(result: ReturnType<typeof run>, reasonCode: string) {
  expectOutcome(result, 'supported', 'pass', reasonCode);
  expect(result.summary).toMatch(/for a person to (review|confirm)/);
  return result;
}

function expectNotOnFile(result: ReturnType<typeof run>, words: string) {
  expectOutcome(result, 'insufficient', 'pending', 'record_not_on_file');
  expect(result.summary).toBe(`No ${words} on file.`);
}

const at = (time: string, millis: number) => new Date(Date.parse(time) + millis).toISOString();
const HOUR = 3_600_000;

describe('Part 108 NPRM version 3 additions', () => {
  it('quote each added paragraph once per rule, and declare a population and the record a member needs', () => {
    for (const entry of addedCheckedEntries) {
      const rule = leaf(entry.id);
      expect(rule.version, entry.id).toBe(1);
      expect(rule.population, entry.id).toBeDefined();
      expect(
        rule.reads.some((read) => read.required && read.onFile),
        entry.id,
      ).toBe(true);
      expect(rule.source.reference, entry.id).toBe(entry.paragraph.reference);
      expect(entry.answers, entry.id).toMatch(/^Per (organization|site|aircraft|person|flight)/);
      expect(entry.forAPerson.length, entry.id).toBeGreaterThan(0);
      expect(rule.wording?.pass, entry.id).toMatch(/for a person to (review|confirm)/);
    }
    for (const entry of addedUncheckedEntries) {
      const unchecked = pack.leaves.find((item) => item.id === entry.id)!;
      expect(unchecked).toMatchObject({ coverage: 'manual', waitingFor: entry.waitingFor });
      expect(entry.waitingFor).toMatch(/^Confirm /);
    }
  });

  it('cover the organization for periodic reports, and the subjects of the events for event clocks', () => {
    expect(leaf('ledger.nprm.108.45.h.1.flight-hours').population).toEqual({ of: 'on_record' });
    expect(leaf('ledger.nprm.108.45.h.5').population).toEqual({
      of: 'designated',
      by: {
        type: 'operator.record',
        versions: [1],
        where: [
          { field: 'values.recordType', oneOf: ['occurrence.security'] },
          { field: 'values.record.breachKind', oneOf: ['loss_of_control', 'physical_access', 'network_access'] },
        ],
        field: 'subject',
      },
    });
    expect(leaf('ledger.nprm.108.335.a').population).toMatchObject({
      of: 'designated',
      by: { field: 'values.record.personId' },
    });
  });
});

describe('108.45(h): reporting clocks', () => {
  const report = (reportKind: string, providedAt: string, period?: [string, string]) =>
    record(
      'organization.report',
      {
        reportKind,
        recipient: 'Civil aviation authority',
        providedAt,
        ...(period ? { periodStartsOn: period[0], periodEndsOn: period[1] } : {}),
      },
      providedAt,
    );

  it('(h)(1): a flight-hours report in each calendar month inside the adoption dates, counted in local time', () => {
    const id = 'ledger.nprm.108.45.h.1.flight-hours';
    const august = report('flight_hours', '2026-08-20T16:00:00.000Z');
    // The last instant of September in Denver, and the first instant of October there.
    const lastOfSeptember = report('flight_hours', '2026-10-01T05:59:59.999Z');
    const firstOfOctober = report('flight_hours', '2026-10-01T06:00:00.000Z');
    const passed = expectPass(
      run(id, [august, lastOfSeptember], '2026-10-15T00:00:00.000Z', denver),
      'periods_recorded',
    );
    expect(passed.summary).toMatch(
      /^A flight-hours report is recorded as provided in each calendar month in America\/Denver/,
    );
    const missed = expectOutcome(
      run(id, [august, firstOfOctober], '2026-10-15T00:00:00.000Z', denver),
      'supported',
      'attention',
      'periods_missing',
    );
    expect(missed.issues).toEqual(['period:2026-09-01']);
    expect(missed.summary).toMatch(/2026-09-01 to 2026-09-30/);
    // One instant before September ends, it is still open and the rule waits for it.
    expect(run(id, [august], '2026-10-01T05:59:59.999Z', denver)).toMatchObject({
      outcome: 'pass',
      nextBoundary: '2026-10-01T06:00:00.000Z',
    });
    expectNotOnFile(
      run(id, [report('aircraft_list', '2026-08-20T16:00:00.000Z')], '2026-10-15T00:00:00.000Z', denver),
      'flight-hours report',
    );
  });

  it('(h)(1): reliability data in each calendar month, a record of its own kind', () => {
    const id = 'ledger.nprm.108.45.h.1.reliability-data';
    expectPass(
      run(id, [report('reliability_data', '2026-08-03T16:00:00.000Z')], '2026-08-20T00:00:00.000Z', denver),
      'periods_recorded',
    );
    expectNotOnFile(
      run(id, [report('flight_hours', '2026-09-03T16:00:00.000Z')], '2026-09-20T00:00:00.000Z', denver),
      'reliability data record',
    );
    expect(
      run(id, [report('reliability_data', '2026-08-03T16:00:00.000Z')], '2026-10-01T06:00:00.000Z', denver).issues,
    ).toEqual(['period:2026-09-01']);
  });

  it('(h)(2): a list of aircraft at least once each 12 calendar months', () => {
    const id = 'ledger.nprm.108.45.h.2';
    const list = report('aircraft_list', '2026-09-10T00:00:00.000Z');
    expectPass(run(id, [list], '2027-09-30T23:59:59.999Z', utc, [], longer), 'periods_recorded');
    const missed = expectOutcome(
      run(id, [list], '2027-10-01T00:00:00.000Z', utc, [], longer),
      'supported',
      'attention',
      'periods_missing',
    );
    expect(missed.details).toMatchObject({ missingPeriods: '2026-09-10 to 2027-09-30' });
    expectNotOnFile(run(id, [], '2026-09-01T00:00:00.000Z', utc), 'aircraft list report');
  });

  it('(h)(3): each interruption in a summary provided by the end of the 10th day of the following month', () => {
    const id = 'ledger.nprm.108.45.h.3';
    const anomaly = (interruptionKind: string, includedInSummaryAt?: string) =>
      record(
        'occurrence.operation-anomaly',
        {
          occurredAt: '2026-10-31T23:00:00Z',
          summary: 'Landed at the alternate area.',
          interruptionKind,
          ...(includedInSummaryAt ? { includedInSummaryAt } : {}),
        },
        '2026-10-31T23:00:00.000Z',
      );
    const landing = anomaly('landing_away');
    const passed = expectPass(
      run(id, [anomaly('landing_away', '2026-11-10T23:59:59.999Z')], '2026-12-01T00:00:00.000Z', utc),
      'answered_within',
    );
    expect(passed.summary).toMatch(/^Each of the 1 recorded landing/);
    expectOutcome(
      run(id, [anomaly('landing_away', '2026-11-11T00:00:00.000Z')], '2026-12-01T00:00:00.000Z', utc),
      'supported',
      'attention',
      'answer_late',
    );
    expectOutcome(run(id, [landing], '2026-11-11T00:00:00.000Z', utc), 'insufficient', 'attention', 'answer_overdue');
    const awaited = expectOutcome(
      run(id, [landing], '2026-11-10T23:59:59.999Z', utc),
      'insufficient',
      'pending',
      'answer_awaited',
    );
    expect(awaited.summary).toMatch(/due by the end of 2026-11-10 in UTC/);
    expect(awaited.nextBoundary).toBe('2026-11-11T00:00:00.000Z');
    expectNotOnFile(run(id, [anomaly('none')], '2026-11-01T00:00:00.000Z', utc), 'interruption record');
  });

  it('(h)(4): each loss of control or communication reported to the manufacturer within 7 calendar days', () => {
    const id = 'ledger.nprm.108.45.h.4';
    // 16:30 on 2026-11-05 in Denver: the 7th day after ends at 07:00 UTC on 11-13.
    const failure = (reportedToManufacturerAt?: string, lossOfControlOrCommunication = 'yes') =>
      record(
        'occurrence.mechanical-irregularity',
        {
          occurredAt: '2026-11-05T23:30:00Z',
          irregularityDescription: 'Control link lost for 40 seconds.',
          correctiveAction: 'Link module replaced.',
          lossOfControlOrCommunication,
          ...(reportedToManufacturerAt ? { reportedToManufacturerAt } : {}),
        },
        '2026-11-05T23:30:00.000Z',
      );
    expectPass(run(id, [failure('2026-11-13T06:59:59.999Z')], '2026-12-01T00:00:00.000Z', denver), 'answered_within');
    expectOutcome(
      run(id, [failure('2026-11-13T07:00:00.000Z')], '2026-12-01T00:00:00.000Z', denver),
      'supported',
      'attention',
      'answer_late',
    );
    const awaited = run(id, [failure()], '2026-11-13T06:59:59.999Z', denver);
    expect(awaited).toMatchObject({ outcome: 'pending', reasonCode: 'answer_awaited' });
    expect(awaited.summary).toMatch(/due by the end of 2026-11-12 in America\/Denver/);
    expectOutcome(
      run(id, [failure()], '2026-11-13T07:00:00.000Z', denver),
      'insufficient',
      'attention',
      'answer_overdue',
    );
    expectNotOnFile(run(id, [failure(undefined, 'no')], '2026-11-13T07:00:00.000Z', denver), 'failure record');
  });

  it('(h)(5): each security breach reported to the authority within 96 hours', () => {
    const id = 'ledger.nprm.108.45.h.5';
    const occurredAt = '2026-10-15T14:10:00.000Z';
    const breach = (reportedToAuthorityAt?: string, breachKind = 'physical_access') =>
      record(
        'occurrence.security',
        {
          occurredAt,
          summary: 'Dock enclosure opened by someone not on the access list.',
          breachKind,
          ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}),
        },
        occurredAt,
      );
    expectPass(run(id, [breach(at(occurredAt, 96 * HOUR))], '2026-11-01T00:00:00.000Z'), 'answered_within');
    const late = expectOutcome(
      run(id, [breach(at(occurredAt, 96 * HOUR + 1))], '2026-11-01T00:00:00.000Z'),
      'supported',
      'attention',
      'answer_late',
    );
    expect(late.issues).toEqual([`event-at:${occurredAt}`]);
    expect(run(id, [breach()], at(occurredAt, 96 * HOUR))).toMatchObject({
      outcome: 'pending',
      summary: `No report to the authority is recorded yet for a recorded security breach; the earliest is due by ${at(occurredAt, 96 * HOUR)}, 96 hours after it occurred.`,
    });
    expectOutcome(run(id, [breach()], at(occurredAt, 96 * HOUR + 1)), 'insufficient', 'attention', 'answer_overdue');
    expectNotOnFile(run(id, [breach(undefined, 'other')], '2026-11-01T00:00:00.000Z'), 'security breach record');
    // A breach the operator recorded as not reportable is not counted, and the result says who decided.
    const notReportable = record(
      'occurrence.security',
      {
        occurredAt,
        summary: 'A gate left open, closed within a minute.',
        breachKind: 'physical_access',
        notReportable: true,
        notReportableDecidedById: { id: 'RIDGE-P-2', scope: 'source' },
      },
      occurredAt,
    );
    expect(run(id, [notReportable], at(occurredAt, 96 * HOUR + 1))).toMatchObject({
      outcome: 'not_applicable',
      summary: `The event at ${occurredAt} is recorded as not reportable by RIDGE-P-2, so it is not counted.`,
    });
    const both = run(id, [breach(at(occurredAt, HOUR)), { ...notReportable, id: 'other' }], '2026-11-01T00:00:00.000Z');
    expect(both.outcome).toBe('pass');
    expect(both.summary).toMatch(
      /^Each of the 1 recorded security breach.* is recorded as not reportable by RIDGE-P-2, so it is not counted\.$/,
    );
    // A breach before the adoption's start is not counted.
    const earlier = record(
      'occurrence.security',
      { occurredAt: '2026-07-01T00:00:00Z', summary: 'Earlier breach.', breachKind: 'network_access' },
      '2026-07-01T00:00:00.000Z',
    );
    expectOutcome(run(id, [earlier], '2026-11-01T00:00:00.000Z'), 'not_applicable', 'not_applicable', 'no_events');
  });

  it('(h)(7): each reportable event reported to the authority within 10 calendar days', () => {
    const id = 'ledger.nprm.108.45.h.7';
    const event = (reportedToAuthorityAt?: string, meetsReportingCriteria = 'yes') =>
      record(
        'occurrence.property-or-area',
        {
          occurredAt: '2026-11-05T15:00:00Z',
          summary: 'Hard landing damaged a fence.',
          eventKind: 'property_damage',
          meetsReportingCriteria,
          ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}),
        },
        '2026-11-05T15:00:00.000Z',
      );
    // Ten calendar days after Thursday 2026-11-05, weekends and Veterans Day counted: through Sunday 11-15.
    expectPass(run(id, [event('2026-11-15T23:59:59.999Z')], '2026-12-01T00:00:00.000Z', utc), 'answered_within');
    expectOutcome(
      run(id, [event('2026-11-16T00:00:00.000Z')], '2026-12-01T00:00:00.000Z', utc),
      'supported',
      'attention',
      'answer_late',
    );
    expect(run(id, [event(undefined, 'not_determined')], '2026-11-15T23:59:59.999Z', utc)).toMatchObject({
      reasonCode: 'answer_awaited',
      nextBoundary: '2026-11-16T00:00:00.000Z',
    });
    expectNotOnFile(
      run(id, [event(undefined, 'no')], '2026-12-01T00:00:00.000Z', utc),
      'property or unauthorized-area event record',
    );
  });
});

describe('108.165: area of operations', () => {
  const area = (areaId: string, fields: Record<string, unknown>, from = '2026-09-01T06:00:00Z', until = '') =>
    record(
      'organization.operating-area',
      {
        areaId,
        shape: 'circle',
        center: '39.5000, -105.2000',
        radiusMeters: 5000,
        startsAt: from,
        ...(until ? { endsAt: until } : {}),
        ...fields,
      },
      from.replace('Z', '.000Z'),
      until ? until.replace('Z', '.000Z') : '',
    );
  const cases: [string, string, string][] = [
    ['ledger.nprm.108.165.a', 'areaApprovalReference', 'approval for the area'],
    ['ledger.nprm.108.165.b', 'alternateLandingAreas', 'alternate landing areas'],
    ['ledger.nprm.108.165.c', 'takeoffLandingAreas', 'takeoff, landing and loading areas'],
  ];
  const now = '2026-10-02T00:00:00.000Z';
  for (const [id, field, words] of cases)
    it(`${id}: each current operating area of the organization states its ${words}, named by its own id`, () => {
      const stated = { [field]: 'Recorded for the fictional area.' };
      const passed = expectPass(
        run(id, [area('RIDGE-AREA-1', stated), area('RIDGE-AREA-2', { ...stated, shape: 'corridor' })], now),
        'values_on_file',
      );
      expect(passed.summary).toMatch(/^Each current operating area \(RIDGE-AREA-1, RIDGE-AREA-2\)/);
      const lacking = expectOutcome(
        run(id, [area('RIDGE-AREA-1', stated), area('RIDGE-AREA-2', {})], now),
        'insufficient',
        'attention',
        'value_not_on_file',
      );
      expect(lacking.summary).toBe(
        `2 operating areas in force: RIDGE-AREA-1, RIDGE-AREA-2. Operating area RIDGE-AREA-2 states no ${words}.`,
      );
      // An area that has ended, or starts later, is not current; with none current nothing is on file.
      const ended = area('RIDGE-AREA-3', {}, '2026-06-01T06:00:00Z', '2026-09-01T06:00:00Z');
      const later = area('RIDGE-AREA-4', {}, '2026-12-01T07:00:00Z');
      const none = expectOutcome(run(id, [ended, later], now), 'insufficient', 'pending', 'record_not_on_file');
      expect(none.summary).toBe(
        'No operating area in force is on file. The latest, RIDGE-AREA-3, was in force from 2026-06-01 until 2026-09-01. RIDGE-AREA-4 is in force from 2026-12-01.',
      );
      expect(none.nextBoundary).toBe('2026-12-01T07:00:00.000Z');
      expectNotOnFile(run(id, [], now), 'operating area');
      expect(leaf(id).target.subjectKind).toBe('organization');
    });

  it('108.165(d): a lost link procedure on file', () => {
    const id = 'ledger.nprm.108.165.d';
    const procedure = (procedureKind: string, revision?: string) =>
      record(
        'organization.procedure',
        {
          procedureKind,
          title: 'Procedure',
          documentReference: 'Operations manual chapter 7',
          effectiveAt: '2026-09-01T00:00:00Z',
          ...(revision ? { revision } : {}),
        },
        '2026-09-01T00:00:00.000Z',
      );
    expectPass(run(id, [procedure('lost_link', 'C')], '2026-10-02T00:00:00.000Z'), 'record_complete');
    expectOutcome(
      run(id, [procedure('lost_link')], '2026-10-02T00:00:00.000Z'),
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectNotOnFile(run(id, [procedure('emergency', 'C')], '2026-10-02T00:00:00.000Z'), 'lost link procedure');
  });
});

describe('Certificate items: training, security threat assessment, cybersecurity', () => {
  const procedure = (procedureKind: string) =>
    record(
      'organization.procedure',
      {
        procedureKind,
        title: 'Program',
        documentReference: 'Manual part 3',
        revision: 'B',
        effectiveAt: '2026-09-01T00:00:00Z',
      },
      '2026-09-01T00:00:00.000Z',
    );

  it('108.535(a) and 108.540(a): the policies and the program on file', () => {
    expectPass(
      run('ledger.nprm.108.535.a', [procedure('cybersecurity')], '2026-10-02T00:00:00.000Z'),
      'record_complete',
    );
    expectNotOnFile(
      run('ledger.nprm.108.535.a', [procedure('training_program')], '2026-10-02T00:00:00.000Z'),
      'cybersecurity policy',
    );
    expectPass(
      run('ledger.nprm.108.540.a', [procedure('training_program')], '2026-10-02T00:00:00.000Z'),
      'record_complete',
    );
    expectNotOnFile(run('ledger.nprm.108.540.a', [], '2026-10-02T00:00:00.000Z'), 'training program');
  });

  it('108.535(c): a review of the cybersecurity policies at least once each 12 calendar months', () => {
    const id = 'ledger.nprm.108.535.c';
    const review = (reviewedAt: string, reviewKind = 'cybersecurity_policy') =>
      record(
        'organization.review',
        {
          reviewKind,
          documentReference: 'Information security policy',
          reviewedAt,
          reviewedByName: 'Robin Vale',
          recordedOutcome: 'no_change',
        },
        reviewedAt,
      );
    // A review before the adoption counts: the next is due by the end of the 12th month after it.
    const before = review('2026-02-10T00:00:00.000Z');
    expectPass(run(id, [before], '2027-02-28T23:59:59.999Z', utc, [], longer), 'periods_recorded');
    expect(run(id, [before], '2027-03-01T00:00:00.000Z', utc, [], longer)).toMatchObject({
      outcome: 'attention',
      issues: ['period:2026-08-01'],
    });
    expectNotOnFile(
      run(id, [review('2026-09-01T00:00:00.000Z', 'training_program')], '2026-10-01T00:00:00.000Z', utc),
      'review of the cybersecurity policies',
    );
  });

  it('108.540(d): a person designated as responsible for training', () => {
    const id = 'ledger.nprm.108.540.d';
    const designee = (role: string, endsAt?: string) =>
      record(
        'operation.role-assignment',
        {
          personId: { id: 'PER-7', scope: 'source' },
          role,
          startsAt: '2026-08-01T00:00:00Z',
          ...(endsAt ? { endsAt } : {}),
        },
        '2026-08-01T00:00:00.000Z',
        endsAt ?? '',
      );
    expectPass(run(id, [designee('training_designee')], '2026-10-02T00:00:00.000Z'), 'window_covered');
    expectOutcome(
      run(id, [designee('training_designee', '2026-09-30T00:00:00Z')], '2026-10-02T00:00:00.000Z'),
      'insufficient',
      'attention',
      'window_not_covered',
    );
    expectNotOnFile(
      run(id, [designee('operations_supervisor')], '2026-10-02T00:00:00.000Z'),
      'training designee role assignment',
    );
  });

  it('108.315(d): initial or recurrent training within the previous 24 calendar months', () => {
    const id = 'ledger.nprm.108.315.d';
    const training = (completedOn: string, trainingKind = 'recurrent') =>
      record(
        'person.training',
        { trainingKind, courseTitle: 'Recurrent operations', completedOn, evidenceReference: 'TRN-1' },
        `${completedOn}T00:00:00.000Z`,
      );
    // Completed in October 2024: within through the last day of October 2026.
    expectPass(run(id, [training('2024-10-15')], '2026-10-31T23:59:59.999Z'), 'date_within_months');
    expectOutcome(
      run(id, [training('2024-10-15')], '2026-11-01T00:00:00.000Z'),
      'supported',
      'attention',
      'date_outside_months',
    );
    expectNotOnFile(
      run(id, [training('2026-01-15', 'aircraft_specific')], '2026-10-02T00:00:00.000Z'),
      'initial or recurrent training record',
    );
  });

  it('108.315(d): three courses imported in one file are read as three courses, the latest standing', () => {
    const id = 'ledger.nprm.108.315.d';
    const imported = '2026-11-22T18:00:00.000Z';
    const course = (trainingKind: string, courseTitle: string, completedOn: string) =>
      record(
        'person.training',
        { trainingKind, courseTitle, completedOn, evidenceReference: `TRN-${completedOn}` },
        imported,
      );
    const courses = [
      course('initial', 'BVLOS initial', '2025-03-12'),
      course('recurrent', 'Part 107 recurrent', '2025-11-04'),
      course('recurrent', 'BVLOS recurrent', '2026-07-22'),
    ];
    const result = expectPass(run(id, courses, '2026-11-23T00:00:00.000Z'), 'date_within_months');
    expect(result.evidence).toEqual([courses[2]!.id]);
  });

  it('108.335(a): a security threat assessment recorded as held', () => {
    const id = 'ledger.nprm.108.335.a';
    const assessment = (recordedStatus: string, credentialKind = 'security_threat_assessment') =>
      record(
        'person.certificate',
        { credentialKind, credentialNumber: 'STA-0042', recordedStatus },
        '2026-09-01T00:00:00.000Z',
      );
    expectPass(run(id, [assessment('held')], '2026-10-02T00:00:00.000Z'), 'value_expected');
    expectOutcome(
      run(id, [assessment('revoked')], '2026-10-02T00:00:00.000Z'),
      'supported',
      'attention',
      'value_unexpected',
    );
    expectNotOnFile(
      run(id, [assessment('held', 'remote_pilot_certificate')], '2026-10-02T00:00:00.000Z'),
      'security threat assessment',
    );
  });
});

describe('108.610: inspections and equipment', () => {
  it('108.610(b): the aircraft is within its latest inspection’s next due time, now', () => {
    const id = 'ledger.nprm.108.610.b';
    const inspection = record(
      'aircraft.inspection',
      {
        inspectionKind: 'manufacturer_interval',
        inspectedAt: '2026-09-01T10:00:00Z',
        nextDueAt: '2026-12-01T10:00:00Z',
        recordedResult: 'serviceable',
        inspectorName: 'Sam Reed',
      },
      '2026-09-01T10:00:00.000Z',
      '2026-12-01T10:00:00.000Z',
    );
    expectPass(run(id, [inspection], '2026-12-01T09:59:59.999Z'), 'within_due');
    expectOutcome(run(id, [inspection], '2026-12-01T10:00:00.001Z'), 'supported', 'attention', 'due_passed');
    expectNotOnFile(run(id, [], '2026-10-02T00:00:00.000Z'), 'inspection record');
  });

  it('108.610(b): an inspection due by hours in service, or whichever comes first, is read against the hours flown', () => {
    const id = 'ledger.nprm.108.610.b';
    const inspection = (body: Record<string, unknown>) =>
      record(
        'aircraft.inspection',
        {
          inspectionKind: 'manufacturer_interval',
          inspectedAt: '2026-09-01T10:00:00Z',
          recordedResult: 'serviceable',
          inspectorName: 'Sam Reed',
          ...body,
        },
        '2026-09-01T10:00:00.000Z',
        typeof body.nextDueAt === 'string' ? body.nextDueAt : '',
      );
    const opening = record(
      'aircraft.time-in-service',
      {
        entryKind: 'opening_balance',
        totalTimeHours: 314,
        coveredThroughAt: '2026-09-01T10:00:00Z',
        sourceReference: 'Logbook 3',
        coverage: 'complete',
        coverageNotes: 'Every flight since delivery.',
      },
      '2026-09-01T10:00:00.000Z',
    );
    const flight = (takeoffAt: string, landingAt: string) =>
      record('flight.record', { takeoffAt, landingAt }, takeoffAt, landingAt);
    const flights = [
      flight('2026-10-01T15:00:00.000Z', '2026-10-01T15:30:00.000Z'),
      flight('2026-10-02T15:00:00.000Z', '2026-10-02T15:36:00.000Z'),
    ];
    const byHours = inspection({ nextDueTimeInServiceHours: 315 });
    const over = expectOutcome(
      run(id, [byHours, opening, ...flights], '2026-10-05T00:00:00.000Z'),
      'supported',
      'attention',
      'due_passed',
    );
    expect(over.summary).toContain(
      'had 315.1 h in service now; the inspection recorded at 2026-09-01T10:00:00.000Z was due at 315 h.',
    );
    expectPass(run(id, [byHours, opening, flights[0]!], '2026-10-05T00:00:00.000Z'), 'within_due');
    // Whichever comes first: within the hours, past the date.
    const both = inspection({ nextDueAt: '2026-10-03T00:00:00Z', nextDueTimeInServiceHours: 400 });
    const late = expectOutcome(
      run(id, [both, opening, ...flights], '2026-10-05T00:00:00.000Z'),
      'supported',
      'attention',
      'due_passed',
    );
    expect(late.summary).toContain('was due by 2026-10-03T00:00:00.000Z, before now.');
    expect(late.summary).toContain('is next due at 400 h');
    // An inspection due by hours with no total time in service on file says so.
    expectOutcome(
      run(id, [byHours, ...flights], '2026-10-05T00:00:00.000Z'),
      'insufficient',
      'attention',
      'opening_balance_missing',
    );
  });

  const elements: [string, string][] = [
    ['dock', 'dockStatus'],
    ['control-link', 'controlLinkStatus'],
    ['battery', 'batteryStatus'],
    ['sensors', 'sensorStatus'],
  ];
  const availability = (field: string, status: string) =>
    record(
      'aircraft.system-availability',
      {
        assessedAt: '2026-10-01T06:00:00Z',
        dockId: { id: 'DOCK-1', scope: 'source' },
        dockStatus: 'available',
        controlLinkStatus: 'available',
        batteryId: { id: 'BAT-1', scope: 'source' },
        batteryStatus: 'available',
        sensorStatus: 'available',
        firmwareVersion: '4.2.0',
        configurationReference: 'CFG-12',
        [field]: status,
      },
      '2026-10-01T06:00:00.000Z',
    );
  for (const [element, field] of elements)
    it(`108.610(c): the latest availability record has the ${element} available`, () => {
      const id = `ledger.nprm.108.610.c.${element}`;
      expectPass(run(id, [availability(field, 'available')], '2026-10-02T00:00:00.000Z'), 'value_expected');
      expectOutcome(
        run(id, [availability(field, 'unavailable')], '2026-10-02T00:00:00.000Z'),
        'supported',
        'attention',
        'value_unexpected',
      );
      expectOutcome(
        run(id, [availability(field, 'unknown')], '2026-10-02T00:00:00.000Z'),
        'insufficient',
        'attention',
        'value_undetermined',
      );
      expectNotOnFile(run(id, [], '2026-10-02T00:00:00.000Z'), 'availability record');
    });
});
