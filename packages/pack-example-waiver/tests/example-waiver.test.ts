import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf, type RulePackVersion } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, registerRulePack } from '../../domain/src/rule-pack-registry.js';
import {
  EXAMPLE_WAIVER_PACK_ID,
  exampleWaiverRulePack,
  exampleWaiverV1,
  exampleWaiverV2,
  obligationTypes,
  readExampleWaiverAmendment,
  readExampleWaiverCertificate,
  waiverRulePack,
  type WaiverDefinition,
} from '../src/index.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(EXAMPLE_WAIVER_PACK_ID, 1)!;
const certificate = readExampleWaiverCertificate();
/** A second invented waiver, given only as data: its definition and its certificate text. */
const secondWaiver = JSON.parse(readFileSync(new URL('./second-waiver.json', import.meta.url), 'utf8')) as {
  waiver: WaiverDefinition;
  certificate: string;
};
const leafId = (number: string) => `${EXAMPLE_WAIVER_PACK_ID}.provision-${number}`;

function leafOf(version: RulePackVersion, id: string): CheckedRuleLeaf {
  const found = version.leaves.find((item) => item.id === id);
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

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/** Gathers each read as the engine does (type, conditions, selection), then runs the rule. */
function run(rule: CheckedRuleLeaf, observations: CheckObservation[]) {
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads)
    inputs[read.name] = narrowRead(
      read,
      observations.filter((item) => item.type === read.type).sort(newestFirst),
      inputs,
    );
  return runCheckedRule(rule, rule.check.params, inputs, clock);
}

function expectResult(number: string, observations: CheckObservation[], outcome: string, reasonCode: string) {
  const result = run(leafOf(pack, leafId(number)), observations);
  expect(result, number).toMatchObject({ outcome, reasonCode });
  if (outcome === 'pass') {
    expect(result.evidence.length, number).toBeGreaterThan(0);
    expect(
      observations.map((item) => item.id),
      number,
    ).toEqual(expect.arrayContaining(result.evidence));
    expect(result.summary, number).toMatch(/for a person to review/);
  }
  return result;
}

describe('obligation catalogue', () => {
  it('covers the obligation types a waiver needs, each stating how it is evidenced', () => {
    expect(obligationTypes.map(({ id, evidence }) => [id, evidence])).toEqual([
      ['eligibility.listed-pilot', 'computed'],
      ['eligibility.listed-aircraft', 'computed'],
      ['equipment.anti-collision-lighting', 'field_check'],
      ['condition.max-height', 'computed'],
      ['condition.max-distance', 'computed'],
      ['condition.pilot-in-operating-area', 'computed'],
      ['condition.visual-observer-assigned', 'computed'],
      ['notification.before-operations', 'computed'],
      ['notification.not-more-than-before-operations', 'computed'],
      ['authority.flight-cites-certificate', 'computed'],
      ['condition.operating-area', 'computed'],
      ['condition.site-listed', 'computed'],
      ['equipment.detect-and-avoid', 'computed'],
      ['procedure.on-file', 'record_complete'],
      ['weather.wind-at-takeoff', 'computed'],
      ['weather.visibility-at-takeoff', 'computed'],
      ['weather.gust-at-takeoff', 'computed'],
      ['condition.battery-at-landing', 'computed'],
      ['maintenance.inspection-due', 'computed'],
      ['maintenance.inspected-within-days', 'computed'],
      ['maintenance.dock-inspected-within-days', 'computed'],
      ['operation.aircraft-per-pilot', 'computed'],
      ['qualification.recent-flights', 'computed'],
      ['condition.no-hazardous-carriage', 'computed'],
      ['qualification.named-training-current', 'computed'],
      ['equipment.remote-id-method', 'computed'],
      ['record.preflight-content', 'record_complete'],
      ['report.occurrence-within', 'computed'],
      ['record.maintenance-complete', 'record_complete'],
      ['authority.certificate-at-hand', 'attested'],
    ]);
  });

  it('runs each checked obligation on the library check kind it names, and says what stands in for the others', () => {
    for (const type of obligationTypes) {
      const checked = type.evidence === 'computed' || type.evidence === 'record_complete';
      expect(Boolean(type.check), type.id).toBe(checked);
      expect(Boolean(type.checkKind), type.id).toBe(checked);
      expect(Boolean(type.waitingFor), type.id).toBe(!checked);
    }
    for (const provision of exampleWaiverV1.provisions) {
      const type = obligationTypes.find(({ id }) => id === provision.obligation)!;
      if (!type.checkKind) continue;
      expect(leafOf(pack, leafId(provision.number)).check, provision.number).toMatchObject({
        kind: type.checkKind.id,
        version: type.checkKind.version,
      });
    }
  });
});

describe('example waiver version 1', () => {
  it('is registered with its pinned digest and is schema-valid', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(exampleWaiverRulePack().versions.map(({ digest }) => digest)).toEqual([
      '2391a4bf35c864f294595420a71fe93712ed494bae252a177c07887c0528dd3c',
      '821114f93f9db2fbb53eeb06137ed397d58fed6ba91dd8b4a6eb9ea5f7dafea0',
    ]);
    expect(pack.digest).toBe(exampleWaiverRulePack().versions[0]!.digest);
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
  });

  it('is a fictional certificate held by a seeded fictional organization', async () => {
    const text = certificate.toString('utf8');
    expect(text).toContain(
      'Fictional certificate, written for this repository. It is not a real waiver and authorizes nothing.',
    );
    const { holder, responsiblePerson, number } = exampleWaiverV1.certificate;
    expect(text).toContain(`Holder: ${holder}, a fictional organization seeded in this repository`);
    expect(text).toContain(`Responsible person: ${responsiblePerson}, a fictional person seeded in this repository`);
    expect(text).toContain(`Certificate number: ${number} (invented)`);
    // Both names come from the repository's seed, not from any real certificate.
    const seed = await readFile(new URL('../../persistence/src/index.ts', import.meta.url), 'utf8');
    const labels = await readFile(
      new URL('../../../apps/web/src/demo/fictional-organizations.ts', import.meta.url),
      'utf8',
    );
    expect(seed).toContain(`'${responsiblePerson}'`);
    expect(labels).toContain(`name: '${holder}'`);
  });

  it('quotes each checked provision whole, from its pinned span in the retained certificate', () => {
    const covered = waiverRulePack(exampleWaiverV1, certificate).provisions;
    expect(covered.map(({ number, evidence }) => [number, evidence])).toEqual(
      exampleWaiverV1.provisions.map(({ number, obligation }) => [
        number,
        obligationTypes.find(({ id }) => id === obligation)!.evidence,
      ]),
    );
    expect(pack.leaves.map(({ id }) => id)).toEqual(covered.flatMap(({ ruleId }) => (ruleId ? [ruleId] : [])));
    expect(pack.leaves).toHaveLength(11);
    for (const provision of exampleWaiverV1.provisions) {
      const ruleId = covered.find(({ number }) => number === provision.number)!.ruleId;
      if (!ruleId) continue;
      const { source } = leafOf(pack, ruleId);
      const quoted = certificate.subarray(provision.start, provision.end);
      expect(source, ruleId).toMatchObject({
        kind: 'waiver_or_exemption',
        text: quoted.toString('utf8'),
        sha256: sha256(quoted),
        reference: `Certificate EXW-0001, special provision ${provision.number}: ${provision.title} (fictional)`,
      });
      expect(source.text, ruleId).toMatch(new RegExp(`^${provision.number}\\. ${provision.title}\\.`));
    }
  });

  it('words nothing as a verdict or as something the waiver grants', () => {
    for (const item of pack.leaves) {
      const own = JSON.stringify({ title: item.title, wording: isCheckedRuleLeaf(item) ? item.wording : undefined });
      expect(own, item.id).not.toMatch(/\b(compliant|compliance|authori[sz]\w*|permit\w*|go|no-go)\b/i);
    }
  });
});

describe('example waiver version 1 checks', () => {
  const plan = (body: Record<string, unknown>) =>
    record(
      'flight.plan',
      {
        windowStartsAt: '2026-10-20T09:00:00Z',
        windowEndsAt: '2026-10-20T10:00:00Z',
        plannedMaxHeightAboveGroundMeters: 80,
        plannedMaxDistanceFromControlStationMeters: 1200,
        pilotInOperatingArea: 'yes',
        ...body,
      },
      { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' },
    );
  const assignment = (role: string, personId: string, start = '2026-10-20T08:30:00.000Z') =>
    record(
      'operation.role-assignment',
      { personId: { id: personId, scope: 'source' }, role, startsAt: start, endsAt: '2026-10-20T11:00:00Z' },
      { start, end: '2026-10-20T11:00:00.000Z' },
    );
  const identity = (body: Record<string, unknown>) =>
    record('aircraft.identity', {
      aircraftMakeModel: 'Fictional Quad 4',
      serialNumber: 'SN-1',
      registrationNumber: 'FICT-0101',
      remoteIdentificationMethod: 'standard_broadcast',
      ...body,
    });

  it('1: the remote pilot in command is a listed pilot', () => {
    expectResult('1', [assignment('pilot_in_command', 'PER-0202')], 'pass', 'value_expected');
    expectResult('1', [assignment('pilot_in_command', 'PER-0999')], 'attention', 'value_unexpected');
    // An observer on the list is not a pilot in command.
    expectResult('1', [assignment('visual_observer', 'PER-0201')], 'pending', 'record_not_on_file');
  });

  it('2 and 11: the aircraft is listed and broadcasts by a stated method', () => {
    // Each reads the identity of the aircraft the flight's plan names.
    expectResult('2', [plan({}), identity({})], 'pass', 'value_expected');
    expectResult('2', [plan({}), identity({ registrationNumber: 'FICT-0999' })], 'attention', 'value_unexpected');
    expectResult(
      '11',
      [plan({}), identity({ remoteIdentificationMethod: 'broadcast_module' })],
      'pass',
      'value_expected',
    );
    expectResult('11', [plan({}), identity({ remoteIdentificationMethod: 'none' })], 'attention', 'value_unexpected');
    expect(expectResult('11', [plan({})], 'pending', 'record_not_on_file').summary).toBe(
      'No aircraft identity record on file.',
    );
    expect(expectResult('11', [], 'pending', 'record_not_on_file').summary).toBe(
      'No flight plan on file. No aircraft identity record on file.',
    );
  });

  it('4 and 5: height flown, else planned, and planned distance within the stated maximums', () => {
    expectResult('4', [plan({ plannedMaxHeightAboveGroundMeters: 91.44 })], 'pass', 'planned_within_limit');
    expectResult('4', [plan({ plannedMaxHeightAboveGroundMeters: 92 })], 'attention', 'planned_beyond_limit');
    const flown = (meters: number, datum: string) => ({
      id: `position-${++sequence}`,
      type: 'position.fix',
      version: 1,
      occurredAt: '2026-10-20T09:30:00.000Z',
      observation: {
        occurredAt: '2026-10-20T09:30:00.000Z',
        position: { latitudeDegrees: 41.88, longitudeDegrees: -87.63, altitude: { meters, datum } },
        values: { fix: 'unknown' },
      },
    });
    const within = run(leafOf(pack, leafId('4')), [
      plan({ plannedMaxHeightAboveGroundMeters: 80 }),
      flown(85, 'takeoff_point'),
    ]);
    expect(within).toMatchObject({ outcome: 'pass', reasonCode: 'flown_within_limit', details: { basis: 'flown' } });
    expect(within.summary).toMatch(/^Read the flown height above the takeoff point/);
    const beyond = run(leafOf(pack, leafId('4')), [
      plan({ plannedMaxHeightAboveGroundMeters: 80 }),
      flown(95, 'ground_level'),
    ]);
    expect(beyond).toMatchObject({ outcome: 'attention', reasonCode: 'flown_beyond_limit' });
    expect(beyond.summary).toMatch(
      /The planned maximum height above ground level is 262\.47 ft \(80 m\), within the limit\./,
    );
    // The operator's own flight record states its flown height: read before the plan and a takeoff-point height,
    // after a height above ground level.
    const logged = (meters: number) =>
      record(
        'flight.record',
        {
          takeoffAt: '2026-10-20T09:00:00Z',
          landingAt: '2026-10-20T09:40:00Z',
          maxHeightFlownAboveGroundMeters: meters,
        },
        { start: '2026-10-20T09:00:00Z', end: '2026-10-20T09:40:00Z' },
      );
    const recorded = run(leafOf(pack, leafId('4')), [
      plan({ plannedMaxHeightAboveGroundMeters: 80 }),
      logged(95),
      flown(85, 'takeoff_point'),
    ]);
    expect(recorded).toMatchObject({
      outcome: 'attention',
      reasonCode: 'recorded_beyond_limit',
      details: { basis: 'recorded', value: 95, recordedValue: 95 },
    });
    expect(recorded.summary).toMatch(
      /Read the maximum height flown above ground level in the operator’s flight record: 311\.68 ft \(95 m\)/,
    );
    expect(
      run(leafOf(pack, leafId('4')), [
        plan({ plannedMaxHeightAboveGroundMeters: 80 }),
        logged(95),
        flown(70, 'ground_level'),
      ]),
    ).toMatchObject({
      outcome: 'pass',
      reasonCode: 'flown_within_limit',
      details: { basis: 'flown', recordedValue: 95 },
    });
    expectResult('5', [plan({})], 'pass', 'planned_within_limit');
    expectResult(
      '5',
      [plan({ plannedMaxDistanceFromControlStationMeters: 1700 })],
      'attention',
      'planned_beyond_limit',
    );
    expectResult(
      '5',
      [plan({ plannedMaxDistanceFromControlStationMeters: undefined })],
      'pending',
      'planned_value_missing',
    );
    expect(run(leafOf(pack, leafId('5')), [plan({})]).summary).toMatch(
      /^This rule reads no flown distance from the control station; the result rests on the plan\..*No observation states where the control station was/,
    );
  });

  it('6 and 7: pilot planned in the operating area, and an observer assigned across the window', () => {
    expectResult('6', [plan({})], 'pass', 'value_expected');
    expectResult('6', [plan({ pilotInOperatingArea: 'no' })], 'attention', 'value_unexpected');
    expectResult('7', [plan({}), assignment('visual_observer', 'PER-0201')], 'pass', 'window_covered');
    expectResult(
      '7',
      [plan({}), assignment('visual_observer', 'PER-0201', '2026-10-20T09:30:00.000Z')],
      'attention',
      'window_not_covered',
    );
  });

  it('8: the named party notified at least the stated hours before the planned start', () => {
    const notice = (recipient: string, notifiedAt: string) =>
      record('operation.notification', { notifiedAt, recipient, means: 'email' }, { at: notifiedAt });
    const party = 'Canal District harbor office';
    expectResult('8', [plan({}), notice(party, '2026-10-19T08:00:00.000Z')], 'pass', 'made_in_time');
    expectResult('8', [plan({}), notice(party, '2026-10-19T10:00:00.000Z')], 'attention', 'made_late');
    expectResult('8', [plan({}), notice('Somebody else', '2026-10-18T08:00:00.000Z')], 'attention', 'not_made');
  });

  it('9: no hazardous material carried', () => {
    const payload = (hazardousMaterial: string) => record('aircraft.payload', { hazardousMaterial });
    expectResult('9', [payload('not_hazardous')], 'pass', 'value_expected');
    expectResult('9', [payload('hazardous')], 'attention', 'value_unexpected');
  });

  it('10: the named course completed within the stated months', () => {
    const training = (courseTitle: string, completedOn: string) =>
      record('person.training', { trainingKind: 'other', courseTitle, completedOn, evidenceReference: 'C-1' });
    // Read for each remote pilot in command the flight's assignments name.
    const pilot = assignment('pilot_in_command', 'PER-0201');
    expectResult('10', [pilot, training('Night delivery operations', '2026-01-15')], 'pass', 'date_within_months');
    expectResult(
      '10',
      [pilot, training('Night delivery operations', '2025-09-30')],
      'attention',
      'date_outside_months',
    );
    expectResult('10', [pilot, training('Day delivery operations', '2026-09-01')], 'pending', 'record_not_on_file');
    expect(leafOf(pack, leafId('10')).related).toEqual([
      {
        name: 'pilot',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'insufficient',
        from: { read: 'assignments', field: 'values.record.personId' },
      },
    ]);
  });

  it('12: the crew briefing is recorded in the preflight assessment', () => {
    const assessment = (participantsBriefing?: string) =>
      record('flight.preflight-assessment', { assessedAt: '2026-10-20T07:00:00Z', participantsBriefing });
    expectResult('12', [assessment('Crew briefed on the night route')], 'pass', 'record_complete');
    expectResult('12', [assessment()], 'attention', 'record_incomplete');
  });
});

describe('example waiver version 2', () => {
  const amended = getRulePackVersion(EXAMPLE_WAIVER_PACK_ID, 2)!;
  const fixtures = new URL('../../contracts/fixtures/', import.meta.url);
  const fixture = (path: string) => readFileSync(new URL(path, fixtures), 'utf8');
  /** The sample crew assignments, one operator record per row, grouped by the flight they are about. */
  function sampleAssignmentsByFlight(): Map<string, CheckObservation[]> {
    const [, ...rows] = fixture('operator-records/alpha-crew-assignments.csv').trim().split('\n');
    const flights = new Map<string, CheckObservation[]>();
    for (const row of rows) {
      const [flightId, , personId, role, startsAt, endsAt] = row.split(',');
      const assigned = record(
        'operation.role-assignment',
        { personId: { id: personId, scope: 'source' }, role, startsAt, endsAt },
        { start: startsAt!, end: endsAt! },
      );
      flights.set(flightId!, [...(flights.get(flightId!) ?? []), assigned]);
    }
    return flights;
  }

  it('changes only the listed-pilot rule, its quote and pilots, and leaves version 1 as released', () => {
    expect(pack.digest).toBe('2391a4bf35c864f294595420a71fe93712ed494bae252a177c07887c0528dd3c');
    expect(amended.digest).toBe(exampleWaiverRulePack().versions[1]!.digest);
    const before = new Map(pack.leaves.map((leaf) => [leaf.id, leaf]));
    const changed = amended.leaves.filter((leaf) => before.get(leaf.id)?.digest !== leaf.digest);
    expect(changed.map(({ id, version }) => [id, version])).toEqual([[leafId('1'), 2]]);
    // Both read a pilot assignment for a flight planned for later as soon as it is recorded.
    expect(leafOf(amended, leafId('1')).reads.map((read) => read.plans)).toEqual([true]);
    expect(leafOf(pack, leafId('1')).reads.map((read) => read.plans)).toEqual([true]);
    expect(amended.leaves.map(({ id }) => id)).toEqual(pack.leaves.map(({ id }) => id));
    const text = readExampleWaiverAmendment().toString('utf8');
    expect(text).toContain('It is not a real waiver and authorizes nothing.');
    expect(leafOf(amended, leafId('1')).source.text).toBe(
      "1. Listed pilots. Only a person listed in Attachment A acts as remote pilot in command. Attachment A lists the holder's source identifiers ALPHA-PILOT-01 and ALPHA-PILOT-03.",
    );
  });

  it('lists every pilot in the sample data but one, by the identifiers the sample data uses', () => {
    const files = [
      'crew-roster/alpha-crew-roster.json',
      'operator-records/alpha-crew-assignments.csv',
      'operator-records/alpha-training-records.csv',
    ];
    const sample = files.flatMap((path) => fixture(path).match(/ALPHA-PILOT-\d+/g) ?? []);
    const listed = exampleWaiverV2.provisions[0]!.parameters!.personIds;
    expect([...new Set(sample)].sort().filter((id) => !(listed as string[]).includes(id))).toEqual(['ALPHA-PILOT-02']);
  });

  it('finds an unlisted pilot in command on the sample flights of one pilot only', () => {
    const rule = leafOf(amended, leafId('1'));
    const outcomes = [...sampleAssignmentsByFlight()].map(([flight, assignments]) => [
      flight,
      run(rule, assignments).outcome,
    ]);
    expect(outcomes).toEqual([
      ['ALPHA-FLT-1001', 'pass'],
      ['ALPHA-FLT-1002', 'attention'],
      ['ALPHA-FLT-1003', 'pass'],
      ['ALPHA-FLT-1004', 'pass'],
      ['ALPHA-FLT-1005', 'attention'],
      ['ALPHA-FLT-1006', 'attention'],
    ]);
  });
});

describe('waiver builder', () => {
  const tampered = (change: (definition: WaiverDefinition) => WaiverDefinition) =>
    waiverRulePack(change(structuredClone(exampleWaiverV1)), certificate);

  it('refuses a certificate, span, obligation type or parameter that does not match', () => {
    const changed = Buffer.from(certificate);
    changed[0] ^= 1;
    expect(() => waiverRulePack(exampleWaiverV1, changed)).toThrow('does not match its pinned bytes');
    const first = (definition: WaiverDefinition, provision: object) => ({
      ...definition,
      provisions: [{ ...definition.provisions[0]!, ...provision }, ...definition.provisions.slice(1)],
    });
    expect(() => tampered((d) => first(d, { end: 854 }))).toThrow('does not match its pinned span');
    expect(() => tampered((d) => first(d, { obligation: 'eligibility.unknown' }))).toThrow('unknown obligation type');
    expect(() => tampered((d) => first(d, { parameters: { personIds: [] } }))).toThrow(
      'parameter personIds must be a non-empty list of text',
    );
    expect(() => tampered((d) => first(d, { parameters: { personIds: ['PER-1'], extra: 1 } }))).toThrow(
      'parameter extra is not one it takes',
    );
  });

  it('builds, registers and evaluates a second waiver from a data file alone', () => {
    const built = waiverRulePack(secondWaiver.waiver, Buffer.from(secondWaiver.certificate, 'utf8'));
    registerRulePack(built);
    const registered = getRulePackVersion(secondWaiver.waiver.packId, 1)!;
    expect(registered.digest).toBe(built.versions[0]!.digest);
    expect(built.provisions.map(({ number, evidence }) => [number, evidence])).toEqual([
      ['A1', 'computed'],
      ['A2', 'computed'],
      ['A3', 'field_check'],
      ['A4', 'computed'],
    ]);
    const height = leafOf(registered, `${secondWaiver.waiver.packId}.provision-A2`);
    expect(height.source).toMatchObject({
      kind: 'waiver_or_exemption',
      reference: expect.stringContaining('EXW-0002'),
    });
    expect(registered.waiver).toEqual({
      certificateNumber: 'EXW-0002',
      conditionsCover: 'flights_citing_certificate',
      effective: { from: '2026-10-01', through: '2027-09-30' },
    });
    const flight = (meters: number, operatingAuthorityReference?: string) =>
      record('flight.plan', {
        windowStartsAt: '2026-10-20T09:00:00Z',
        windowEndsAt: '2026-10-20T10:00:00Z',
        plannedMaxHeightAboveGroundMeters: meters,
        ...(operatingAuthorityReference ? { operatingAuthorityReference } : {}),
      });
    expect(run(height, [flight(60, 'EXW-0002')])).toMatchObject({
      outcome: 'pass',
      reasonCode: 'planned_within_limit',
    });
    expect(run(height, [flight(61, 'EXW-0002')])).toMatchObject({
      outcome: 'attention',
      reasonCode: 'planned_beyond_limit',
    });
    // The conditions cover only the flights whose plan cites the certificate.
    const ordinary = flight(150);
    expect(run(height, [ordinary])).toEqual({
      applicability: 'not_applicable',
      evidenceState: 'not_applicable',
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
      summary:
        'The latest flight plan does not cite EXW-0002 as its operating authority, so the waiver’s conditions do not cover this flight.',
      evidence: [ordinary.id],
    });
    expect(run(height, [])).toMatchObject({ reasonCode: 'record_not_on_file', summary: 'No flight plan on file.' });
    const pilot = leafOf(registered, `${secondWaiver.waiver.packId}.provision-A1`);
    const assigned = record('operation.role-assignment', {
      personId: { id: 'PER-0301', scope: 'source' },
      role: 'pilot_in_command',
      startsAt: '2026-10-20T08:00:00Z',
    });
    const cited = flight(60, 'EXW-0002');
    expect(run(pilot, [cited, assigned])).toMatchObject({ outcome: 'pass', evidence: [assigned.id] });
    expect(run(pilot, [ordinary, assigned])).toMatchObject({ outcome: 'not_applicable' });
    expect(pilot.population).toEqual({ of: 'in_adoption_dates' });
  });
});

describe('which reads read plans', () => {
  it('reads every record made for a planned window as soon as it is recorded, and nothing that happened', () => {
    const plans = (version: RulePackVersion) =>
      Object.fromEntries(
        version.leaves
          .filter(isCheckedRuleLeaf)
          .map((leaf) => [leaf.id.split('.').at(-1), leaf.reads.filter((read) => read.plans).map((read) => read.name)]),
      );
    expect(plans(pack)).toEqual({
      'provision-1': ['subject'],
      'provision-2': ['plan'],
      'provision-4': ['plan'],
      'provision-5': ['plan'],
      'provision-6': ['subject'],
      'provision-7': ['interval', 'window'],
      'provision-8': ['record', 'window'],
      'provision-9': ['subject'],
      'provision-10': ['assignments'],
      'provision-11': ['plan'],
      'provision-12': ['record'],
    });
  });
});
