import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf, type RulePackVersion } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { defineCheckedRule, narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { findCheckKind } from '../../domain/src/check-kinds.js';
import { getRulePackVersion, registerRulePack } from '../../domain/src/rule-pack-registry.js';
import { waiverRulePack, type WaiverDefinition } from '../../pack-example-waiver/src/index.js';
import {
  EXAMPLE_BVLOS_WAIVER_PACK_ID,
  exampleBvlosWaiverRulePack,
  exampleBvlosWaiverV1,
  readExampleBvlosWaiverCertificate,
  RELIEVED_PACK_ID,
  RELIEVED_RULE_IDS,
} from '../src/index.js';

const pack = getRulePackVersion(EXAMPLE_BVLOS_WAIVER_PACK_ID, 1)!;
const certificate = readExampleBvlosWaiverCertificate();
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const leafId = (number: string) => `${EXAMPLE_BVLOS_WAIVER_PACK_ID}.provision-${number}`;

function leafOf(version: RulePackVersion, id: string): CheckedRuleLeaf {
  const found = version.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
function observation(type: string, content: Record<string, unknown>, at: string, interval?: object): CheckObservation {
  return {
    id: `${type}-${++sequence}`,
    type,
    version: 1,
    occurredAt: at,
    ...(interval ? { interval: interval as CheckObservation['interval'] } : {}),
    observation: { type, version: 1, occurredAt: at, ...(interval ? { interval } : {}), ...content },
  };
}

function record(recordType: string, body: Record<string, unknown>, at = '2026-10-19T08:00:00.000Z') {
  return observation('operator.record', { values: { recordType, recordVersion: 1, record: body } }, at);
}

const window = { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' };
const plan = (body: Record<string, unknown> = {}) =>
  observation(
    'operator.record',
    {
      values: {
        recordType: 'flight.plan',
        recordVersion: 1,
        record: {
          windowStartsAt: window.start,
          windowEndsAt: window.end,
          visualMode: 'beyond_visual_line_of_sight',
          operatingAuthorityReference: 'BVW-0001',
          siteId: { id: 'ALPHA-SITE-07', scope: 'source' },
          ...body,
        },
      },
    },
    window.start,
    window,
  );

/**
 * Gathers each read by type, conditions and selection, as the engine does once the related subject is resolved; this
 * test gives each read only observations about the subject it reads.
 */
function run(rule: CheckedRuleLeaf, observations: CheckObservation[]) {
  const inputs: Record<string, CheckObservation[]> = {};
  const newestFirst = (a: CheckObservation, b: CheckObservation) =>
    Date.parse(b.interval?.start ?? b.occurredAt) - Date.parse(a.interval?.start ?? a.occurredAt);
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      observations.filter((item) => item.type === read.type).sort(newestFirst),
      inputs,
    );
  return runCheckedRule(rule, rule.check.params, inputs, clock);
}

const expectRun = (number: string, observations: CheckObservation[], outcome: string, reasonCode: string) =>
  expect(run(leafOf(pack, leafId(number)), observations), number).toMatchObject({ outcome, reasonCode });

describe('example BVLOS waiver', () => {
  it('is registered with its pinned digest and is schema-valid', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(pack.digest).toBe(exampleBvlosWaiverRulePack().versions[0]!.digest);
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('says first that it is invented, grants nothing and is modelled on no real waiver', () => {
    const [, , notice] = certificate.toString('utf8').split('\n');
    expect(notice).toBe(
      'Invented for this repository. It grants nothing, authorizes nothing and is modelled on no real waiver or exemption.',
    );
  });

  it('quotes every provision as a rule of a waiver, and only the first relieves', () => {
    expect(pack.leaves.map(({ id }) => id)).toEqual(
      exampleBvlosWaiverV1.provisions.map(({ number }) => leafId(number)),
    );
    for (const provision of exampleBvlosWaiverV1.provisions) {
      const leaf = leafOf(pack, leafId(provision.number));
      expect(leaf.source.kind, provision.number).toBe('waiver_or_exemption');
      expect(leaf.source.text, provision.number).toBe(
        certificate.subarray(provision.start, provision.end).toString('utf8'),
      );
    }
    const relief = leafOf(pack, leafId('1'));
    expect(relief.title).toBe('Special provision 1: Relief from visual line of sight');
    expect(relief.relieves).toEqual([{ packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS }]);
    expect(pack.leaves.filter((leaf) => isCheckedRuleLeaf(leaf) && leaf.relieves)).toHaveLength(1);
  });

  it('relieves a rule the registered Part 107 pack holds', () => {
    const relieved = getRulePackVersion(RELIEVED_PACK_ID, 2)!;
    expect(relieved.leaves.some((leaf) => leaf.id === RELIEVED_RULE_IDS[0] && isCheckedRuleLeaf(leaf))).toBe(true);
  });
});

describe('example BVLOS waiver provisions', () => {
  it('1: the flight plan cites the certificate', () => {
    expectRun('1', [plan()], 'pass', 'within_dates');
    // A flight that cites the certificate before the dates it states needs attention, so it is not relieved.
    const before = run(leafOf(pack, leafId('1')), [
      plan({ windowStartsAt: '2026-08-20T09:00:00Z', windowEndsAt: '2026-08-20T10:00:00Z' }),
    ]);
    expect(before).toMatchObject({ outcome: 'attention', reasonCode: 'before_dates' });
    expect(before.summary).toContain('from 2026-09-01 through 2028-08-31');
    // A flight whose plan cites another authority is not one the waiver covers, under this provision as under any.
    expectRun('1', [plan({ operatingAuthorityReference: 'EXW-0001' })], 'not_applicable', 'condition_not_met');
  });

  it('covers only the flights whose plan cites the certificate, and reports a flight with no plan', () => {
    expect(pack.waiver).toEqual({
      certificateNumber: 'BVW-0001',
      conditionsCover: 'flights_citing_certificate',
      effective: { from: '2026-09-01', through: '2028-08-31' },
    });
    const ordinary = plan({ operatingAuthorityReference: undefined, visualMode: 'visual_line_of_sight' });
    // Every flight citing the certificate is listed under provision 1, whatever its date.
    expect(leafOf(pack, leafId('1')).population).toMatchObject({ of: 'designated', by: { field: 'subject' } });
    for (const number of ['1', '2', '3', '5', '6', '7', '8']) {
      const rule = leafOf(pack, leafId(number));
      expect(rule.target.subjectKind, number).toBe('flight');
      if (number !== '1') expect(rule.population, number).toEqual({ of: 'in_adoption_dates' });
      expect(run(rule, [ordinary]), number).toMatchObject({
        outcome: 'not_applicable',
        reasonCode: 'condition_not_met',
        summary:
          'The latest flight plan does not cite BVW-0001 as its operating authority, so the waiver’s conditions do not cover this flight.',
      });
      expect(run(rule, []), number).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
      expect(run(rule, []).summary, number).toMatch(/^No flight plan on file\./);
    }
    // The lost-link procedure is the organization's, evaluated once for it.
    expect(leafOf(pack, leafId('4')).target).toEqual({ subjectKind: 'organization' });
    expect(leafOf(pack, leafId('4')).applicability).toEqual([]);
  });

  it('2: positions planned or reported in the window keep inside the area and margin', () => {
    const fix = (at: string, latitudeDegrees: number) =>
      observation(
        'position.fix',
        { position: { latitudeDegrees, longitudeDegrees: -87.6274 }, values: { fix: 'three_dimensional' } },
        at,
      );
    const inside = [fix('2026-10-20T09:10:00.000Z', 41.88), fix('2026-10-20T09:11:00.000Z', 41.89)];
    expectRun('2', [plan(), ...inside], 'pass', 'positions_inside');
    // About 3.3 km north of the centre: outside 3000 m and the 100 m margin.
    const outside = [fix('2026-10-20T09:20:00.000Z', 41.91), fix('2026-10-20T09:21:00.000Z', 41.911)];
    expect(run(leafOf(pack, leafId('2')), [plan(), ...inside, ...outside])).toMatchObject({ outcome: 'attention' });
  });

  it('3: detect-and-avoid equipment recorded as serviceable', () => {
    const equipment = (equipmentState: string) =>
      record('aircraft.detect-and-avoid', {
        checkedAt: '2026-10-20T08:00:00Z',
        equipmentReference: 'Traffic receiver, configuration 3',
        equipmentState,
      });
    expectRun('3', [plan(), equipment('serviceable')], 'pass', 'value_expected');
    expectRun('3', [plan(), equipment('inoperative')], 'attention', 'value_unexpected');
  });

  it('4: a lost-link procedure is on file', () => {
    const procedure = (procedureKind: string) =>
      record('organization.procedure', {
        procedureKind,
        title: 'Lost control link',
        documentReference: 'Operations manual chapter 7',
        revision: 'C',
        effectiveAt: '2026-09-01T00:00:00Z',
      });
    const issued = (purposes: string[], interval: { start: string; end?: string }) =>
      observation(
        'organization.record-in-force',
        {
          values: {
            recordKind: 'document',
            recordId: 'document-1',
            decisionId: 'issue-1',
            title: 'Lost link procedure',
            revision: 'D',
            purposes,
          },
        },
        '2026-10-01T00:00:00.000Z',
        interval,
      );
    expect(pack.purposes).toEqual([
      expect.objectContaining({ id: 'procedure.lost-link', title: 'Lost link procedure' }),
    ]);
    // The operator record stands when no controlled document serving the purpose is in effect, and the result says so.
    const recorded = run(leafOf(pack, leafId('4')), [procedure('lost_link')]);
    expect(recorded).toMatchObject({ outcome: 'pass', reasonCode: 'operator_record_on_file' });
    expect(recorded.summary).toMatch(/read the operator record instead: “Lost control link”, revision C/);
    expect(run(leafOf(pack, leafId('4')), [procedure('emergency')]).outcome).not.toBe('pass');
    // A document in effect serving the purpose is read first, and named.
    const document = run(leafOf(pack, leafId('4')), [
      procedure('lost_link'),
      issued(['procedure.lost-link'], { start: '2026-10-01T00:00:00.000Z' }),
    ]);
    expect(document).toMatchObject({ outcome: 'pass', reasonCode: 'record_in_force' });
    expect(document.summary).toMatch(
      /^In force: “Lost link procedure”, revision D, since 2026-10-01, ticked as serving it\./,
    );
    // A document serving another purpose, or no longer in effect, does not count.
    for (const other of [
      issued(['procedure.emergency'], { start: '2026-10-01T00:00:00.000Z' }),
      issued(['procedure.lost-link'], { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' }),
    ])
      expect(run(leafOf(pack, leafId('4')), [other])).toMatchObject({
        outcome: 'pending',
        reasonCode: 'record_not_on_file',
      });
  });

  it('5: measured wind at the site at takeoff within the maximum', () => {
    const report = observation(
      'flight.report',
      { values: { activity: 'active', takeoffAt: '2026-10-20T09:05:00.000Z' } },
      '2026-10-20T09:05:00.000Z',
    );
    const wind = (speedMetersPerSecond: number) =>
      observation('weather.wind', { values: { method: 'measured', speedMetersPerSecond } }, '2026-10-20T09:04:00.000Z');
    expectRun('5', [plan(), report, wind(8)], 'pass', 'values_within_limit');
    expect(run(leafOf(pack, leafId('5')), [plan(), report, wind(12)])).toMatchObject({ outcome: 'attention' });
    // With no report, the wind at takeoff in the operator's own flight record is read, and the result says so.
    const logged = record('flight.record', {
      takeoffAt: '2026-10-20T09:05:00Z',
      landingAt: '2026-10-20T09:40:00Z',
      windAtTakeoffMetersPerSecond: 12,
    });
    const fromLog = run(leafOf(pack, leafId('5')), [plan(), logged]);
    expect(fromLog).toMatchObject({ outcome: 'attention', reasonCode: 'recorded_outside_limit' });
    expect(fromLog.summary).toContain('the result rests on the operator’s own record.');
    // With a report and a measured wind, the measured wind is read and the logged one named beside it.
    const both = run(leafOf(pack, leafId('5')), [plan(), report, wind(8), logged]);
    expect(both).toMatchObject({ outcome: 'pass', reasonCode: 'values_within_limit' });
    expect(both.summary).toContain('the reported value is read, not the recorded one');
  });

  it('6: recorded visibility at least 3 statute miles', () => {
    const assessment = (visibilityMeters: number) =>
      record('flight.preflight-assessment', { assessedAt: '2026-10-20T08:30:00Z', visibilityMeters });
    expectRun('6', [plan(), assessment(9000)], 'pass', 'planned_within_limit');
    expectRun('6', [plan(), assessment(4000)], 'attention', 'planned_beyond_limit');
    // The visibility in the operator's flight record, when it states one, is read before the assessment.
    const flown = record('flight.record', {
      takeoffAt: '2026-10-20T09:05:00Z',
      landingAt: '2026-10-20T09:40:00Z',
      visibilityAtTakeoffMeters: 4000,
    });
    expectRun('6', [plan(), assessment(9000), flown], 'attention', 'recorded_beyond_limit');
  });

  it('7: the remote pilot in command is a named pilot', () => {
    const assigned = (personId: string) =>
      observation(
        'operator.record',
        {
          values: {
            recordType: 'operation.role-assignment',
            recordVersion: 1,
            record: { personId: { id: personId, scope: 'source' }, role: 'pilot_in_command', startsAt: window.start },
          },
        },
        window.start,
        { start: window.start },
      );
    expectRun('7', [plan(), assigned('ALPHA-PILOT-01')], 'pass', 'value_expected');
    expectRun('7', [plan(), assigned('ALPHA-PILOT-02')], 'attention', 'value_unexpected');
  });

  it('8: the harbor office notified at least 24 hours before the planned start', () => {
    const notice = (notifiedAt: string) =>
      record(
        'operation.notification',
        { notifiedAt, recipient: 'Canal District harbor office', means: 'email' },
        notifiedAt,
      );
    expectRun('8', [plan(), notice('2026-10-19T08:00:00.000Z')], 'pass', 'made_in_time');
    expectRun('8', [plan(), notice('2026-10-20T08:00:00.000Z')], 'attention', 'made_late');
    expectRun('8', [plan()], 'attention', 'not_made');
  });
});

describe('relief declarations', () => {
  const kind = findCheckKind('value.one-of', 1)!;
  const spec = (relieves: { packId: string; ruleIds: string[] }[], sourceKind = 'waiver_or_exemption' as const) => ({
    id: 'test.relief.rule',
    version: 1,
    title: 'Relief',
    source: { kind: sourceKind, reference: 'Invented test waiver', text: 'Relief from an invented rule.' },
    target: { subjectKind: 'flight' as const },
    reads: [
      {
        name: 'subject',
        type: 'flight.report',
        versions: [1],
        about: 'target' as const,
        required: true,
        select: 'latest' as const,
      },
    ],
    check: { kind, params: { field: 'values.activity', expected: ['landed'] } },
    relieves,
  });
  const registration = (packId: string, relieves: { packId: string; ruleIds: string[] }[]) => {
    const content = {
      packId,
      version: 1,
      title: 'Invented relief test pack',
      status: 'draft' as const,
      review: 'ai_drafted' as const,
      adopted: false as const,
      bindings: [],
      leaves: [defineCheckedRule(spec(relieves))],
    };
    return { packId, versions: [{ ...content, digest: canonicalDigest(content) }] };
  };

  it('is data on the rule and part of its digest', () => {
    const relieving = defineCheckedRule(spec([{ packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS }]));
    const { relieves: _relieves, ...plain } = spec([]);
    expect(relieving.relieves).toEqual([{ packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS }]);
    expect(relieving.digest).not.toBe(defineCheckedRule(plain).digest);
  });

  it('is refused on a rule that does not quote a waiver or exemption', () => {
    expect(() =>
      defineCheckedRule(
        spec([{ packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS }], 'operator_procedure' as 'waiver_or_exemption'),
      ),
    ).toThrow('declares relief but does not quote a waiver or exemption');
  });

  it('is refused at registration when it names its own pack, an unregistered pack or an unknown rule', () => {
    expect(() =>
      registerRulePack(registration('test.relief-own', [{ packId: 'test.relief-own', ruleIds: ['test.relief.rule'] }])),
    ).toThrow('cannot relieve a rule of its own pack');
    expect(() =>
      registerRulePack(registration('test.relief-unregistered', [{ packId: 'test.nowhere', ruleIds: ['x'] }])),
    ).toThrow('relieves rules of test.nowhere, which is not registered');
    expect(() =>
      registerRulePack(
        registration('test.relief-unknown', [{ packId: RELIEVED_PACK_ID, ruleIds: ['ledger.part107.107.99'] }]),
      ),
    ).toThrow('relieves ledger.part107.107.99, which no version of ledger.part107 holds');
  });

  it('is built by the waiver builder from a provision that declares it', () => {
    const definition: WaiverDefinition = structuredClone(exampleBvlosWaiverV1);
    definition.packId = 'test.bvlos-copy';
    const built = waiverRulePack(definition, certificate);
    expect(leafOf(built.versions[0]!, 'test.bvlos-copy.provision-1').relieves).toEqual([
      { packId: RELIEVED_PACK_ID, ruleIds: RELIEVED_RULE_IDS },
    ]);
  });
});
