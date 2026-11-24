import Ajv from 'ajv';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { PART107_EDITION_DATE, PART107_PACK_ID, PART107_SOURCE_ID, part107RulePack } from '../src/index.js';
import { checkedEntries, uncheckedEntries } from '../src/part107-v1.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(PART107_PACK_ID, 1)!;

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

/** A record of an unrelated type, so each case also shows the read keeps it out. */
const unrelated = () =>
  record('aircraft.payload', { hazardousMaterial: 'hazardous' }, { at: '2026-10-20T11:00:00.000Z' });

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

/** A pass that cites the record it read, and says what remains for a person when the rule has wording. */
function expectPass(id: string, observations: CheckObservation[], reasonCode: string, cited = observations) {
  const result = expectResult(id, observations, 'supported', 'pass', reasonCode);
  expect(result.evidence, id).toEqual(expect.arrayContaining(cited.map((item) => item.id)));
  if (leaf(id).wording?.pass) expect(result.summary, id).toMatch(/for a person to review/);
  return result;
}

describe('retained Part 107 text', () => {
  it('serves the unchanged original document through source and built package loaders', async () => {
    const original = await readFile(new URL('../resources/govinfo-cfr-2026-title14-vol2-part107.xml', import.meta.url));
    const source = (await getRuleSource(PART107_SOURCE_ID))!;
    expect(source.bytes).toEqual(original);
    expect(source).toMatchObject({
      sourceId: PART107_SOURCE_ID,
      url: 'https://www.govinfo.gov/content/pkg/CFR-2026-title14-vol2/xml/CFR-2026-title14-vol2-part107.xml',
      byteLength: 86803,
      sha256: '0c07b393796351d4a6b2fef98b330d16d1318d79a5b2bb608894a93443eed70f',
      contentType: 'application/xml; charset=utf-8',
      filename: 'govinfo-cfr-2026-title14-vol2-part107.xml',
      readPath: `/v1/rule-sources/${PART107_SOURCE_ID}/content`,
    });
    expect(sha256(source.bytes)).toBe(source.sha256);
    // The edition the pack states is the one the document itself declares.
    expect(original.toString('utf8')).toContain(`<DATE>${PART107_EDITION_DATE}</DATE>`);
    const packaged = await import('../dist/index.js');
    expect(packaged.part107RulePack().sources[0].bytes).toEqual(original);
  });

  it('refuses to assemble when the retained document no longer matches its pinned bytes', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs')>();
      const readFileSync = (path: URL) => {
        const bytes = original.readFileSync(path);
        bytes[0] ^= 1;
        return bytes;
      };
      return { ...original, readFileSync, default: { ...original, readFileSync } };
    });
    try {
      const reloaded = await import('../src/part107-v1.js');
      expect(() => reloaded.part107RulePack()).toThrow(
        'Retained Part 107 source does not match its pinned original bytes',
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('Part 107 version 1', () => {
  it('is registered with its digest, schema-valid, and states the edition it reflects', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    // Later versions are pinned in their own tests.
    expect(
      part107RulePack()
        .versions.slice(0, 1)
        .map(({ version, digest }) => ({ version, digest })),
    ).toEqual([{ version: 1, digest: '0daefd9d75ae430ccf9d6499f0c9104eeb4668752b250b81193ad6e412bbc3d9' }]);
    expect(pack).toMatchObject({ packId: PART107_PACK_ID, version: 1, status: 'draft', bindings: [] });
    expect(pack.title).toContain(PART107_EDITION_DATE);
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('states coverage for every rule: automated where a check serves it, otherwise manual or unsupported', () => {
    expect(pack.leaves.map(({ id, coverage }) => ({ id, coverage }))).toEqual([
      ...checkedEntries.map(({ id }) => ({ id, coverage: 'automated' })),
      ...uncheckedEntries.map(({ id, coverage }) => ({ id, coverage })),
    ]);
    expect(checkedEntries).toHaveLength(18);
    for (const entry of uncheckedEntries)
      expect(entry.waitingFor, entry.id).toMatch(entry.coverage === 'manual' ? /^A person: / : /^(?!A person: ).+\.$/);
  });

  it('quotes every rule as in-force text from the retained document by pinned byte span', async () => {
    const source = (await getRuleSource(PART107_SOURCE_ID))!;
    for (const item of pack.leaves) {
      if (item.source.kind !== 'regulation') throw new Error(`${item.id} must quote in-force text`);
      const span = item.source.textSpan;
      const snippet = source.bytes.subarray(span.start, span.end);
      expect(snippet.toString('utf8'), item.id).toBe(item.source.text);
      expect(sha256(snippet), item.id).toBe(item.source.sha256);
      expect(span).toMatchObject({ unit: 'utf8_byte', sourceId: PART107_SOURCE_ID });
      expect(item.source.document).toMatchObject({ sourceId: source.sourceId, sha256: source.sha256 });
      expect(item.source.reference, item.id).toMatch(
        new RegExp(`^14 CFR 107\\.\\d+.* \\(edition of ${PART107_EDITION_DATE}\\)$`),
      );
      // The quote is whole paragraphs of the section the reference names.
      expect(item.source.text, item.id).toMatch(/^<P>[\s\S]*<\/P>$/);
      const section = item.source.reference.match(/^14 CFR (107\.\d+)/)![1]!;
      const before = source.bytes.subarray(0, span.start).toString('utf8');
      expect(before.slice(before.lastIndexOf('<SECTNO>')), item.id).toMatch(new RegExp(`^<SECTNO>§\\s${section}<`));
      const { digest, ...content } = item;
      expect(canonicalDigest(content)).toBe(digest);
    }
  });

  it('words nothing as a verdict and nothing as proposed text', () => {
    for (const item of pack.leaves) {
      const own = JSON.stringify({ title: item.title, wording: isCheckedRuleLeaf(item) ? item.wording : undefined });
      expect(own, item.id).not.toMatch(/\b(compliant|compliance|authori[sz]ed|go|no-go|proposed)\b/i);
    }
  });
});

describe('Part 107 version 1 checks', () => {
  it('107.12(b): a remote pilot certificate is recorded as held', () => {
    const id = 'ledger.part107.107.12.b';
    const certificate = (recordedStatus: string, credentialKind = 'remote_pilot_certificate') =>
      record('person.certificate', { credentialKind, credentialNumber: 'RP-0001', recordedStatus });
    expectPass(id, [certificate('held')], 'value_expected');
    expectResult(id, [certificate('suspended')], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [certificate('held', 'operator_qualification')], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('107.65: a knowledge test or recurrent training within the previous 24 calendar months', () => {
    const id = 'ledger.part107.107.65';
    const training = (completedOn: string, trainingKind = 'recurrent', program = 'remote_pilot_certificate') =>
      record('person.training', {
        trainingKind,
        courseTitle: program === 'remote_pilot_certificate' ? 'Recurrent course' : 'Company BVLOS recurrent',
        completedOn,
        program,
        evidenceReference: 'C-1',
      });
    expectPass(id, [training('2025-03-14')], 'date_within_months');
    expectResult(id, [training('2024-09-30', 'knowledge_test')], 'supported', 'attention', 'date_outside_months');
    expectResult(id, [training('2026-09-01', 'aircraft_specific')], 'insufficient', 'pending', 'record_not_on_file');
    // A company recurrent course recorded at the same time is another program: never a second date for this one.
    const own = training('2025-03-14');
    expectPass(id, [own, training('2023-01-10', 'recurrent', 'operator_program')], 'date_within_months', [own]);
    expectResult(
      id,
      [training('2026-01-10', 'recurrent', 'operator_program')],
      'insufficient',
      'pending',
      'record_not_on_file',
    );
    // Two records of its own program that disagree are named, with what to correct.
    const disagree = expectResult(
      id,
      [training('2025-03-14'), { ...training('2024-02-01'), id: 'second' }],
      'conflicting',
      'attention',
      'dates_disagree',
    );
    expect(disagree.summary).toContain('2024-02-01 (Recurrent course), 2025-03-14 (Recurrent course)');
  });

  it('107.19(a): a remote pilot in command is assigned across the planned window', () => {
    const id = 'ledger.part107.107.19.a';
    const plan = record(
      'flight.plan',
      { windowStartsAt: '2026-10-20T09:00:00Z', windowEndsAt: '2026-10-20T10:00:00Z', operationKind: 'inspection' },
      { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' },
    );
    const pilot = (start: string, role = 'pilot_in_command') =>
      record(
        'operation.role-assignment',
        { personId: { id: 'PER-1', scope: 'source' }, role, startsAt: start, endsAt: '2026-10-20T11:00:00Z' },
        { start, end: '2026-10-20T11:00:00.000Z' },
      );
    const covering = pilot('2026-10-20T08:30:00.000Z');
    expectPass(id, [plan, covering], 'window_covered');
    expectResult(id, [plan, pilot('2026-10-20T09:30:00.000Z')], 'insufficient', 'attention', 'window_not_covered');
    expectResult(
      id,
      [plan, pilot('2026-10-20T08:30:00.000Z', 'visual_observer')],
      'insufficient',
      'attention',
      'window_not_covered',
    );
  });

  it('107.13: a registration number is recorded for the aircraft', () => {
    const id = 'ledger.part107.107.13';
    const identity = (registrationNumber?: string) =>
      record('aircraft.identity', { aircraftMakeModel: 'Fictional Quad 4', serialNumber: 'SN-1', registrationNumber });
    expectPass(id, [identity('FA00000001')], 'record_complete');
    expectResult(id, [identity()], 'insufficient', 'attention', 'record_incomplete');
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('107.15(a): a known unsafe condition needs attention, an undetermined one is insufficient', () => {
    const id = 'ledger.part107.107.15.a';
    const condition = (recordedCondition: string) =>
      record('aircraft.condition', { determinedAt: '2026-10-20T07:00:00Z', recordedCondition });
    expectPass(id, [condition('no_unsafe_condition_known')], 'value_expected');
    expectResult(id, [condition('unsafe_condition_known')], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [condition('not_determined')], 'insufficient', 'attention', 'value_undetermined');
    expectResult(id, [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('107.17 and 107.27: the latest readiness declaration states no known condition or disqualification', () => {
    const declaration = (medicalStatement: string, substanceStatement: string) =>
      record('person.readiness-declaration', {
        declaredAt: '2026-10-20T06:00:00Z',
        medicalStatement,
        substanceStatement,
      });
    const clear = declaration('no_known_condition', 'no_known_disqualification');
    expectPass('ledger.part107.107.17', [clear], 'value_expected');
    expectResult(
      'ledger.part107.107.17',
      [declaration('condition_reported', 'no_known_disqualification')],
      'supported',
      'attention',
      'value_unexpected',
    );
    expectResult('ledger.part107.107.17', [], 'insufficient', 'pending', 'record_not_on_file');
    expectPass('ledger.part107.107.27', [clear], 'value_expected');
    expectResult(
      'ledger.part107.107.27',
      [declaration('no_known_condition', 'removed_from_duty')],
      'supported',
      'attention',
      'value_unexpected',
    );
    expectResult('ledger.part107.107.27', [], 'insufficient', 'pending', 'record_not_on_file');
  });

  it('107.31(a): the flight is planned within visual line of sight', () => {
    const id = 'ledger.part107.107.31.a';
    const plan = (visualMode?: string) =>
      record('flight.plan', {
        windowStartsAt: '2026-10-20T09:00:00Z',
        windowEndsAt: '2026-10-20T10:00:00Z',
        visualMode,
      });
    expectPass(id, [plan('visual_line_of_sight')], 'value_expected');
    expectResult(id, [plan('beyond_visual_line_of_sight')], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [plan()], 'insufficient', 'pending', 'value_missing');
  });

  it('107.36: the payload is recorded as not hazardous material', () => {
    const id = 'ledger.part107.107.36';
    // The unrelated record each case adds is a hazardous payload at an earlier time, so the latest one decides.
    const payload = (hazardousMaterial?: string) =>
      record('aircraft.payload', { hazardousMaterial, payloadDescription: 'Camera' }, { at: '2026-10-20T11:30:00Z' });
    expectPass(id, [payload('not_hazardous')], 'value_expected');
    expectResult(id, [payload('hazardous')], 'supported', 'attention', 'value_unexpected');
    expectResult(id, [payload()], 'insufficient', 'pending', 'value_missing');
  });

  it('107.49(a), (b) and (c)-(e): each preflight determination is recorded', () => {
    const full = {
      assessedAt: '2026-10-20T07:00:00Z',
      weatherDetermination: 'Wind 4 m/s, no precipitation',
      airspaceDetermination: 'Class G, no restrictions',
      groundHazardsDetermination: 'Road to the east, closed during flight',
      participantsBriefing: 'Crew briefed on roles and contingencies',
      linkEnergyLoadDetermination: 'Link checked, battery 100%, camera secured',
    };
    for (const [id, field] of [
      ['ledger.part107.107.49.a', 'groundHazardsDetermination'],
      ['ledger.part107.107.49.b', 'participantsBriefing'],
      ['ledger.part107.107.49.c-e', 'linkEnergyLoadDetermination'],
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

  describe('107.51(a) and (b): ground speed and height, flown when the aircraft reported them, planned otherwise', () => {
    const plan = (body: Record<string, unknown> = {}) =>
      record('flight.plan', {
        windowStartsAt: '2026-10-20T09:00:00Z',
        windowEndsAt: '2026-10-20T10:00:00Z',
        plannedMaxGroundSpeedMetersPerSecond: 15,
        plannedMaxHeightAboveGroundMeters: 120,
        ...body,
      });
    /** A position the aircraft reported, with its height and datum and its ground speed. */
    const flown = (minute: number, meters: number, datum: string, groundSpeedMetersPerSecond = 12) => {
      const occurredAt = `2026-10-20T09:${String(minute).padStart(2, '0')}:00.000Z`;
      return {
        id: `position-${++sequence}`,
        type: 'position.fix',
        version: 1,
        occurredAt,
        observation: {
          occurredAt,
          position: { latitudeDegrees: 41.88, longitudeDegrees: -87.63, altitude: { meters, datum } },
          values: { fix: 'unknown', groundSpeedMetersPerSecond },
        },
      } satisfies CheckObservation;
    };
    const speed = 'ledger.part107.107.51.a';
    const height = 'ledger.part107.107.51.b';

    it('reads the plan when no flown value is on record, and says so', () => {
      const result = expectPass(height, [plan({ plannedMaxHeightAboveGroundMeters: 121.92 })], 'planned_within_limit');
      expect(result.summary).toMatch(
        /^No flown height is reported for this flight; the result rests on the plan\. No record of the flight as flown states a maximum height flown above ground level in the operator’s flight record\. The planned maximum height above ground level is 400 ft \(121\.92 m\), within the limit \(at most 400 feet above ground level, 121\.92 m\)\./,
      );
      expect(result.details).toMatchObject({ basis: 'planned', measured: 'planned maximum height above ground level' });
      expectResult(
        height,
        [plan({ plannedMaxHeightAboveGroundMeters: 122 })],
        'supported',
        'attention',
        'planned_beyond_limit',
      );
      expectResult(
        height,
        [plan({ plannedMaxHeightAboveGroundMeters: undefined })],
        'insufficient',
        'pending',
        'planned_value_missing',
      );
      expectResult(height, [], 'insufficient', 'pending', 'record_not_on_file');
      expectPass(speed, [plan()], 'planned_within_limit');
      expectResult(
        speed,
        [plan({ plannedMaxGroundSpeedMetersPerSecond: 45 })],
        'supported',
        'attention',
        'planned_beyond_limit',
      );
    });

    it('reads the flown value once the aircraft reported it, within the limit', () => {
      const positions = [flown(10, 95, 'takeoff_point'), flown(20, 110, 'takeoff_point', 20)];
      const result = expectPass(height, [plan(), ...positions], 'flown_within_limit', [positions[1]!]);
      expect(result.summary).toMatch(
        /^Read the flown height above the takeoff point: of 2 value\(s\) on record for this flight, the highest is 360\.89 ft \(110 m\) at 2026-10-20T09:20:00\.000Z, within the limit/,
      );
      expect(result.summary).toMatch(/A height above the takeoff point is not a height above ground level/);
      expect(result.details).toMatchObject({
        basis: 'flown',
        measured: 'flown height above the takeoff point',
        value: 110,
      });
      expect(expectPass(speed, [plan(), ...positions], 'flown_within_limit', [positions[1]!]).details).toMatchObject({
        basis: 'flown',
        measured: 'flown ground speed the aircraft reported',
        value: 20,
      });
    });

    it('needs attention when the flown value is beyond the limit after a plan within it', () => {
      const positions = [flown(10, 100, 'ground_level', 30), flown(11, 131, 'ground_level', 46)];
      const result = expectResult(height, [plan(), ...positions], 'supported', 'attention', 'flown_beyond_limit');
      expect(result.summary).toMatch(
        /^Read the flown height above ground level: .* the highest is 429\.79 ft \(131 m\) at .*, beyond the limit/,
      );
      expect(result.summary).toMatch(
        /The planned maximum height above ground level is 393\.7 ft \(120 m\), within the limit\./,
      );
      expect(result.summary).toMatch(/structure/);
      expect(result.evidence).toEqual(expect.arrayContaining([positions[1]!.id]));
      expectResult(speed, [plan(), ...positions], 'supported', 'attention', 'flown_beyond_limit');
    });

    it('never reads a height above the ellipsoid as a height above ground: it names it and rests on the plan', () => {
      const positions = [flown(10, 300, 'wgs84_ellipsoid'), flown(11, 305, 'wgs84_ellipsoid')];
      const result = expectPass(height, [plan(), ...positions], 'planned_within_limit', []);
      expect(result.summary).toMatch(
        /^2 flown value\(s\) are reported for this flight, but they state height above the WGS84 ellipsoid, which this rule does not compare with its limit; the result rests on the plan\./,
      );
      expect(result.details).toMatchObject({ basis: 'planned', flownNotCompared: 2 });
      // The same positions' ground speed is a flown value the speed rule reads.
      expect(expectPass(speed, [plan(), ...positions], 'flown_within_limit', []).details).toMatchObject({
        basis: 'flown',
      });
    });

    it('reads only positions in the planned window', () => {
      const late = { ...flown(10, 500, 'ground_level'), occurredAt: '2026-10-20T11:00:00.000Z' };
      (late.observation as { occurredAt: string }).occurredAt = late.occurredAt;
      expectPass(height, [plan(), late], 'planned_within_limit', []);
    });
  });

  it('107.51(c) and (d): recorded visibility and cloud clearances at least the minimums', () => {
    const assessment = (body: Record<string, unknown>) =>
      record('flight.preflight-assessment', {
        assessedAt: '2026-10-20T07:00:00Z',
        visibilityMeters: 10000,
        cloudVerticalClearanceMeters: 300,
        cloudHorizontalClearanceMeters: 1000,
        ...body,
      });
    for (const [id, field, below] of [
      ['ledger.part107.107.51.c', 'visibilityMeters', 4828],
      ['ledger.part107.107.51.d.1', 'cloudVerticalClearanceMeters', 152],
      ['ledger.part107.107.51.d.2', 'cloudHorizontalClearanceMeters', 609],
    ] as const) {
      expectPass(id, [assessment({})], 'value_within_limit');
      expectResult(id, [assessment({ [field]: below })], 'supported', 'attention', 'value_outside_limit');
      expectResult(id, [assessment({ [field]: undefined })], 'insufficient', 'pending', 'value_missing');
    }
  });

  it('107.9(a): each recorded serious injury or loss of consciousness has its report recorded', () => {
    const id = 'ledger.part107.107.9.a';
    const accident = (accidentKind: string, reportedToAuthorityAt?: string) =>
      record('occurrence.accident', {
        occurredAt: '2026-10-10T10:00:00Z',
        accidentKind,
        summary: 'Fictional event',
        ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}),
      });
    expectPass(id, [accident('serious_injury', '2026-10-12T09:00:00Z')], 'record_complete');
    expectResult(id, [accident('loss_of_consciousness')], 'insufficient', 'attention', 'record_incomplete');
    expectResult(id, [accident('property_damage')], 'not_applicable', 'not_applicable', 'record_not_present');
  });
});
