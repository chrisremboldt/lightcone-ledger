import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID, PART108_NPRM_SOURCE_ID, part108NprmRulePack } from '../src/index.js';
import { checkedEntries, uncheckedEntries } from '../src/part108-nprm-v2.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 2)!;

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
  // The engine gives a check the envelope as the observation, so its times are readable as fields too.
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
  return {
    id: `period-${++sequence}`,
    type: 'crew.duty-period',
    version: 1,
    occurredAt: start,
    interval: { start, ...(end ? { end } : {}) },
    observation: { occurredAt: start, interval: { start, ...(end ? { end } : {}) }, values: { period: kind } },
  };
}

/** A record of an unrelated type, so each case also shows the read keeps it out. */
const unrelated = () => record('aircraft.identity', { aircraftMakeModel: 'Fictional Quad 4' });

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/** Gathers each read as the engine does (type, conditions, selection), then runs the rule. */
function run(id: string, observations: CheckObservation[]) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      [...observations, unrelated()].filter((item) => item.type === read.type).sort(newestFirst),
      inputs,
    );
  return runCheckedRule(rule, rule.check.params, inputs, clock);
}

function expectResult(
  id: string,
  observations: CheckObservation[],
  evidenceState: string,
  outcome: string,
  reasonCode: string,
) {
  const result = run(id, observations);
  expect(result, id).toMatchObject({ evidenceState, outcome, reasonCode });
  return result;
}

/** A pass that cites the record it read. */
function expectPass(id: string, observations: CheckObservation[], reasonCode: string, cited = observations) {
  const result = expectResult(id, observations, 'supported', 'pass', reasonCode);
  expect(result.evidence, id).toEqual(expect.arrayContaining(cited.map((item) => item.id)));
  return result;
}

const person = (id: string) => ({ id, scope: 'source' });

describe('Part 108 NPRM version 2', () => {
  it('is registered with its digest, schema-valid, and keeps version 1 as it was', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    const built = part108NprmRulePack().versions;
    // Later versions are pinned in their own tests.
    expect(built.slice(0, 2).map(({ version, digest }) => ({ version, digest }))).toEqual([
      { version: 1, digest: '2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584' },
      { version: 2, digest: pack.digest },
    ]);
    expect(pack).toMatchObject({ packId: PART108_NPRM_PACK_ID, version: 2, status: 'draft', bindings: [] });
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
    const versionOne = getRulePackVersion(PART108_NPRM_PACK_ID, 1)!;
    for (const kept of versionOne.leaves) expect(pack.leaves.find((item) => item.id === kept.id)).toEqual(kept);
  });

  it('states coverage for every rule: automated where a check serves it, otherwise unsupported or manual', () => {
    expect(pack.leaves.map(({ id, coverage }) => ({ id, coverage }))).toEqual([
      ...checkedEntries.map(({ id }) => ({ id, coverage: 'automated' })),
      ...uncheckedEntries.map(({ id, coverage }) => ({ id, coverage })),
      { id: 'ledger.nprm.108.550.a', coverage: 'manual' },
      { id: 'ledger.nprm.108.560.a', coverage: 'unsupported' },
    ]);
    expect(checkedEntries).toHaveLength(21);
    for (const entry of uncheckedEntries) expect(entry.waitingFor, entry.id).toMatch(/^(?!A person: ).+\.$/);
  });

  it('quotes every rule from the retained notice by pinned byte span, as proposed text', async () => {
    const source = (await getRuleSource(PART108_NPRM_SOURCE_ID))!;
    for (const item of pack.leaves) {
      if (item.source.kind !== 'proposed_regulation') throw new Error(`${item.id} must quote proposed text`);
      const span = item.source.textSpan;
      const snippet = source.bytes.subarray(span.start, span.end);
      expect(snippet.toString('utf8'), item.id).toBe(item.source.text);
      expect(sha256(snippet), item.id).toBe(item.source.sha256);
      expect(span).toMatchObject({ unit: 'utf8_byte', sourceId: PART108_NPRM_SOURCE_ID });
      expect(item.source.document).toMatchObject({ sourceId: source.sourceId, sha256: source.sha256 });
      expect(item.source.reference, item.id).toMatch(/^Proposed 14 CFR 108\.\d+\(/);
      expect(item.source.text, item.id).toMatch(/^ {4}\(/);
      // The paragraph is whole: it ends at a line end and the next line starts a new paragraph or section.
      expect(item.source.text.endsWith('\n'), item.id).toBe(true);
      expect(source.bytes.subarray(span.end, span.end + 5).toString('utf8'), item.id).toMatch(/^( {4}\(|\n|\[\[)/);
      const { digest, ...content } = item;
      expect(canonicalDigest(content)).toBe(digest);
    }
  });

  it('words nothing as a verdict and nothing as current law', () => {
    for (const item of pack.leaves) {
      const own = JSON.stringify({ title: item.title, wording: isCheckedRuleLeaf(item) ? item.wording : undefined });
      expect(own, item.id).not.toMatch(/\b(compliant|compliance|authori[sz]ed|go|no-go|current law|in force)\b/i);
    }
  });
});

describe('Part 108 NPRM version 2 checks', () => {
  it('108.40(a)(3)(iv): flight path, origin, destination and height recorded', () => {
    const id = 'ledger.nprm.108.40.a.3.iv';
    const full = {
      takeoffAt: '2026-10-20T09:00:00Z',
      landingAt: '2026-10-20T09:40:00Z',
      takeoffLocation: 'North pad',
      landingLocations: 'North pad',
      maxHeightFlownAboveGroundMeters: 90,
      flightPathReference: 'PATH-0001',
    };
    expectPass(id, [record('flight.record', full)], 'record_complete');
    expectResult(
      id,
      [record('flight.record', { ...full, flightPathReference: undefined })],
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.40(b)(1)-(3): personnel name, qualifications and duties recorded', () => {
    const id = 'ledger.nprm.108.40.b.1-3';
    const full = {
      fullName: 'Fictional Person One',
      qualificationSummary: 'Coordinator course',
      duties: 'Coordinator',
    };
    expectPass(id, [record('person.standing', full)], 'record_complete');
    expectResult(
      id,
      [record('person.standing', { ...full, duties: ' ' })],
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.40(b)(4): a release for cause is recorded with its details, and does not apply without one', () => {
    const id = 'ledger.nprm.108.40.b.4';
    const separated = {
      employmentStatus: 'separated',
      functionStartedOn: '2024-01-02',
      separatedOn: '2026-05-01',
      separationForCause: 'yes',
    };
    expectPass(id, [record('person.employment', { ...separated, separationDetails: 'File 12.' })], 'record_complete');
    expectResult(id, [record('person.employment', separated)], 'insufficient', 'attention', 'record_incomplete');
    expectResult(
      id,
      [record('person.employment', { employmentStatus: 'employed', functionStartedOn: '2024-01-02' })],
      'not_applicable',
      'not_applicable',
      'record_not_present',
    );
  });

  it('108.40(b)(5): shift, prior rest and daily duty hours recorded', () => {
    const id = 'ledger.nprm.108.40.b.5';
    const full = {
      assessedAt: '2026-10-19T05:00:00Z',
      dutyPeriodId: person('DUTY-1'),
      restPeriodId: person('REST-1'),
      weeklyRestPeriodId: person('REST-2'),
      calendarDayDutyHours: 10,
      weekStartsAt: '2026-10-19T00:00:00Z',
      weekDutyHours: 30,
      timeZone: 'America/Denver',
      scheduleReference: 'SCHED-42',
    };
    expectPass(id, [record('person.rest-assessment', full)], 'record_complete');
    expectResult(
      id,
      [record('person.rest-assessment', { ...full, scheduleReference: undefined })],
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.40(c): each mechanical irregularity is logged with the action taken', () => {
    const id = 'ledger.nprm.108.40.c';
    const entry = (correctiveAction?: string) =>
      record('occurrence.mechanical-irregularity', {
        occurredAt: '2026-10-18T10:00:00Z',
        irregularityDescription: 'Gimbal drift',
        ...(correctiveAction ? { correctiveAction } : {}),
      });
    expectPass(id, [entry('Recalibrated'), entry('Replaced gimbal')], 'record_complete');
    expectResult(id, [entry('Recalibrated'), entry()], 'insufficient', 'attention', 'record_incomplete');
    expectResult(id, [], 'not_applicable', 'not_applicable', 'record_not_present');
  });

  it('108.40(d)(1): maintenance entries hold work, date, person and return to service', () => {
    const id = 'ledger.nprm.108.40.d.1';
    const full = {
      actionDescription: 'Replaced arm 2',
      performedAt: '2026-10-18T09:00:00Z',
      performedByName: 'Fictional Technician',
      returnedToService: true,
      returnToServiceByName: 'Fictional Inspector',
    };
    expectPass(id, [record('maintenance.action', full)], 'record_complete');
    expectResult(
      id,
      [record('maintenance.action', { ...full, returnToServiceByName: undefined })],
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectResult(id, [], 'not_applicable', 'not_applicable', 'record_not_present');
  });

  it('108.40(e)(1)(iii)-(vi): the latest training record holds date, materials, provider and evidence', () => {
    const id = 'ledger.nprm.108.40.e.1';
    const full = {
      trainingKind: 'recurrent',
      courseTitle: 'Recurrent coordinator course',
      completedOn: '2026-09-01',
      evidenceReference: 'CERT-0042',
      materialsReference: 'Course book rev 3',
      providerName: 'Fictional Training Provider',
      providerAddress: '1 Example Road, Exampletown',
    };
    expectPass(id, [record('person.training', full)], 'record_complete');
    expectResult(
      id,
      [record('person.training', { ...full, providerAddress: undefined })],
      'insufficient',
      'attention',
      'record_incomplete',
    );
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.120(a): a known unsafe condition needs attention, an undetermined one is insufficient', () => {
    const id = 'ledger.nprm.108.120.a';
    const condition = (recordedCondition: string) =>
      record('aircraft.condition', { determinedAt: '2026-10-20T07:00:00Z', recordedCondition });
    expectPass(id, [condition('no_unsafe_condition_known')], 'value_expected');
    expectResult(id, [condition('unsafe_condition_known')], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [condition('not_determined')], 'insufficient', 'attention', 'value_undetermined');
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.170(a), (b), (d), (h): each preflight determination is recorded', () => {
    const full = {
      assessedAt: '2026-10-20T07:00:00Z',
      weatherDetermination: 'Wind 4 m/s, no precipitation',
      airspaceDetermination: 'No restrictions on the route',
      groundHazardsDetermination: 'Mast at the north edge',
      participantsBriefing: 'Crew briefed',
      linkEnergyLoadDetermination: 'Link checked, battery 100%, no payload',
    };
    for (const [id, field] of [
      ['ledger.nprm.108.170.a', 'weatherDetermination'],
      ['ledger.nprm.108.170.b', 'airspaceDetermination'],
      ['ledger.nprm.108.170.d', 'groundHazardsDetermination'],
      ['ledger.nprm.108.170.h', 'linkEnergyLoadDetermination'],
    ] as const) {
      expectPass(id, [record('flight.preflight-assessment', full)], 'record_complete');
      expectResult(
        id,
        [record('flight.preflight-assessment', { ...full, [field]: undefined })],
        'insufficient',
        'attention',
        'record_incomplete',
      );
      expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
    }
  });

  it('108.210(b) and (c): aircraft per coordinator within the method and manufacturer limits', () => {
    const multiple = (body: Record<string, unknown>) =>
      record('operation.multiple-aircraft', {
        simultaneousAircraftCount: 2,
        manufacturerLimitCount: 3,
        methodLimitCount: 2,
        methodReference: 'Method M-1',
        ...body,
      });
    const method = 'ledger.nprm.108.210.b';
    expectPass(method, [multiple({})], 'value_within_limit');
    expectResult(method, [multiple({ simultaneousAircraftCount: 3 })], 'supported', 'attention', 'value_outside_limit');
    expectResult(method, [multiple({ methodLimitCount: undefined })], 'insufficient', 'attention', 'limit_missing');
    const manufacturer = 'ledger.nprm.108.210.c';
    expectPass(manufacturer, [multiple({ simultaneousAircraftCount: 3 })], 'value_within_limit');
    expectResult(
      manufacturer,
      [multiple({ simultaneousAircraftCount: 3, manufacturerLimitCount: 2 })],
      'supported',
      'attention',
      'value_outside_limit',
    );
    expectResult(manufacturer, [], 'insufficient', 'attention', 'limit_missing');
  });

  it('108.305(a): a person is in the operations supervisor role at the evaluation time', () => {
    const id = 'ledger.nprm.108.305.a';
    const assignment = (end?: string, role = 'operations_supervisor') =>
      record(
        'operation.role-assignment',
        { personId: person('PER-1'), role, startsAt: '2026-01-05T00:00:00Z', ...(end ? { endsAt: end } : {}) },
        { start: '2026-01-05T00:00:00.000Z', end },
      );
    const passed = expectPass(id, [assignment()], 'window_covered');
    expect(passed.summary).toMatch(/is for a person to review/);
    expectResult(id, [assignment('2026-06-30T00:00:00.000Z')], 'insufficient', 'attention', 'window_not_covered');
    expectResult(id, [assignment(undefined, 'pilot_in_command')], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.310(a): a coordinator covers the planned window when one is required, and only then', () => {
    const id = 'ledger.nprm.108.310.a';
    const requirement = (coordinatorRequired: boolean) =>
      record('organization.coordinator-requirement', { coordinatorRequired, basis: 'manufacturer_instructions' });
    const plan = record(
      'flight.plan',
      { windowStartsAt: '2026-10-20T09:00:00Z', windowEndsAt: '2026-10-20T10:00:00Z', operationKind: 'aerial_survey' },
      { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' },
    );
    const coordinator = (start: string) =>
      record(
        'operation.role-assignment',
        { personId: person('PER-1'), role: 'flight_coordinator', startsAt: start, endsAt: '2026-10-20T11:00:00Z' },
        { start, end: '2026-10-20T11:00:00.000Z' },
      );
    const required = requirement(true);
    const covering = coordinator('2026-10-20T08:30:00.000Z');
    expectPass(id, [required, plan, covering], 'window_covered', [plan, covering]);
    expectResult(
      id,
      [required, plan, coordinator('2026-10-20T09:30:00.000Z')],
      'insufficient',
      'attention',
      'window_not_covered',
    );
    expectResult(id, [plan, covering], 'insufficient', 'pending', 'applicability_input_missing');
    expectResult(id, [requirement(false), plan], 'not_applicable', 'not_applicable', 'condition_not_met');
  });

  it('108.310(c): a coordinator handover names its handover procedure', () => {
    const id = 'ledger.nprm.108.310.c';
    const handover = (procedure?: string) =>
      record(
        'operation.role-assignment',
        {
          personId: person('PER-2'),
          role: 'flight_coordinator',
          startsAt: '2026-10-20T09:30:00Z',
          handoverFromPersonId: person('PER-1'),
          ...(procedure ? { handoverProcedureReference: procedure } : {}),
        },
        { start: '2026-10-20T09:30:00.000Z' },
      );
    expectPass(id, [handover('Operations manual 4.7')], 'record_complete');
    expectResult(id, [handover()], 'insufficient', 'attention', 'record_incomplete');
    const plain = record(
      'operation.role-assignment',
      { personId: person('PER-1'), role: 'flight_coordinator', startsAt: '2026-10-20T08:30:00Z' },
      { start: '2026-10-20T08:30:00.000Z' },
    );
    expectResult(id, [plain], 'not_applicable', 'not_applicable', 'record_not_present');
  });

  it('108.330(a): a duty period of at most 14 hours', () => {
    const id = 'ledger.nprm.108.330.a.duty-period';
    const duty = period('duty', '2026-10-19T06:00:00.000Z', '2026-10-19T18:00:00.000Z');
    expectPass(id, [duty], 'duty_within_limits');
    expectResult(
      id,
      [period('duty', '2026-10-19T06:00:00.000Z', '2026-10-19T21:00:00.000Z')],
      'supported',
      'attention',
      'duty_limit_exceeded',
    );
    expectResult(
      id,
      [period('duty', '2026-10-19T06:00:00.000Z')],
      'insufficient',
      'attention',
      'duty_record_insufficient',
    );
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('108.330(a): a recorded duty week of at most 50 hours', () => {
    const id = 'ledger.nprm.108.330.a.duty-week';
    const week = (weekDutyHours?: number) =>
      record('person.rest-assessment', { assessedAt: '2026-10-19T05:00:00Z', weekDutyHours });
    expectPass(id, [week(44)], 'value_within_limit');
    expectResult(id, [week(52)], 'supported', 'attention', 'value_outside_limit');
    expectResult(id, [week()], 'insufficient', 'pending', 'value_missing');
  });

  it('108.330(b): ten hours of continuous rest in the 24 hours before duty', () => {
    const id = 'ledger.nprm.108.330.b';
    const duty = period('duty', '2026-10-19T06:00:00.000Z', '2026-10-19T16:00:00.000Z');
    const rest = period('rest', '2026-10-18T18:00:00.000Z', '2026-10-19T05:00:00.000Z');
    expectPass(id, [duty, rest], 'duty_within_limits');
    expectResult(
      id,
      [duty, period('rest', '2026-10-18T20:00:00.000Z', '2026-10-19T05:00:00.000Z')],
      'supported',
      'attention',
      'duty_limit_exceeded',
    );
    const earlier = period('duty', '2026-10-18T06:00:00.000Z', '2026-10-18T16:00:00.000Z');
    expectResult(id, [duty, earlier], 'insufficient', 'attention', 'duty_record_insufficient');
    // A first duty period on record has no earlier period to count rest from.
    expectPass(id, [duty], 'duty_within_limits');
  });

  it('108.630(a): the latest maintenance on the aircraft is recorded as returned to service', () => {
    const id = 'ledger.nprm.108.630.a';
    const action = (returnedToService?: boolean) =>
      record('maintenance.action', {
        actionDescription: 'Firmware 4.2',
        performedAt: '2026-10-18T09:00:00Z',
        performedByName: 'Fictional Technician',
        ...(returnedToService === undefined ? {} : { returnedToService }),
      });
    const passed = expectPass(id, [action(true)], 'value_expected');
    expect(passed.summary).toMatch(/is for a person to review/);
    expectResult(id, [action(false)], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [action()], 'insufficient', 'pending', 'value_missing');
    expectResult(id, [], 'not_applicable', 'not_applicable', 'applicability_input_absent');
  });
});
