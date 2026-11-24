import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf, type RulePackLeaf } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { RulePackVersionSchema } from '../../contracts/src/rule-packs.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { adoptionParameterProblem, narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { PART107_EDITION_DATE, PART107_PACK_ID, PART107_SOURCE_ID, part107RulePack } from '../src/index.js';
import { checkedEntries, uncheckedEntries } from '../src/part107-v1.js';
import { newlyCheckedEntries, quotedInVersionOne, readerGuide } from '../src/part107-v2.js';

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(PART107_PACK_ID, 2)!;
const versionOne = getRulePackVersion(PART107_PACK_ID, 1)!;
const newIds = newlyCheckedEntries.map(({ id }) => id);

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

/** A record of an unrelated type, so each case also shows the read keeps it out. */
const unrelated = () =>
  record('aircraft.payload', { hazardousMaterial: 'hazardous' }, { at: '2026-10-20T11:00:00.000Z' });

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

/** A leaf without what placing it in a section adds, for comparing it with the version 1 leaf it carries on. */
function unplaced(item: RulePackLeaf) {
  const { section: _section, paragraph: _paragraph, digest: _digest, ...rest } = item;
  return rest;
}

describe('Part 107 version 2', () => {
  it('is registered with its digest, schema-valid, and keeps version 1 as it was', () => {
    const validate = new Ajv({ allErrors: true }).compile(RulePackVersionSchema);
    expect(validate(pack), JSON.stringify(validate.errors)).toBe(true);
    expect(part107RulePack().versions.map(({ version, digest }) => ({ version, digest }))).toEqual([
      { version: 1, digest: '0daefd9d75ae430ccf9d6499f0c9104eeb4668752b250b81193ad6e412bbc3d9' },
      { version: 2, digest: pack.digest },
    ]);
    expect(pack.digest).toBe('701c04fe1e9c8ad0e330b9826fe864391d0583cb706387f248d24c40e4b0a1c8');
    expect(pack).toMatchObject({ packId: PART107_PACK_ID, version: 2, status: 'draft', bindings: [] });
    expect(pack.title).toContain(PART107_EDITION_DATE);
    const { digest, ...content } = pack;
    expect(canonicalDigest(content)).toBe(digest);
    for (const kept of versionOne.leaves.filter((item) => !newIds.includes(item.id)))
      expect(unplaced(pack.leaves.find((item) => item.id === kept.id)!)).toEqual(unplaced(kept));
  });

  it('places every rule in the section of Part 107 it quotes, with its paragraph, ordered by section', () => {
    expect(pack.sections!.map(({ id }) => id)).toEqual([
      '107.9',
      '107.12',
      '107.13',
      '107.15',
      '107.17',
      '107.19',
      '107.21',
      '107.27',
      '107.31',
      '107.36',
      '107.41',
      '107.49',
      '107.51',
      '107.65',
    ]);
    expect(pack.sections![0]).toEqual({ id: '107.9', title: '§ 107.9 Safety event reporting' });
    expect(leaf('ledger.part107.107.49.c-e')).toMatchObject({ section: '107.49', paragraph: '§ 107.49(c)-(e)' });
    expect(leaf('ledger.part107.107.9.a')).toMatchObject({ section: '107.9', paragraph: '§ 107.9 and § 107.9(a)' });
    const order = pack.leaves.map((item) => pack.sections!.findIndex(({ id }) => id === item.section));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
  });

  it('checks the two paragraphs version 1 left unsupported, as version 2 of each rule, on the same quote', () => {
    expect(newIds.sort()).toEqual(
      uncheckedEntries
        .filter(({ coverage }) => coverage === 'unsupported')
        .map(({ id }) => id)
        .sort(),
    );
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(pack.leaves.map(({ id, version, coverage }) => ({ id, version, coverage })).sort(byId)).toEqual(
      [
        ...checkedEntries.map(({ id }) => ({ id, version: 1, coverage: 'automated' })),
        ...newlyCheckedEntries.map(({ id }) => ({ id, version: 2, coverage: 'automated' })),
        { id: 'ledger.part107.107.41', version: 1, coverage: 'automated' },
        ...uncheckedEntries
          .filter(({ coverage }) => coverage === 'manual')
          .map(({ id }) => ({ id, version: 1, coverage: 'manual' })),
      ].sort(byId),
    );
    for (const { id } of newlyCheckedEntries) {
      const before = versionOne.leaves.find((item) => item.id === id)!;
      expect(before).toMatchObject({ version: 1, coverage: 'unsupported' });
      expect(leaf(id).source, id).toEqual(before.source);
      expect(quotedInVersionOne(id).sha256).toBe(before.source.sha256);
    }
  });

  it('says which rule answers which question where a paragraph is asked twice', () => {
    const ids = pack.leaves.map(({ id }) => id);
    for (const { ruleId } of readerGuide) expect(ids, ruleId).toContain(ruleId);
    expect(new Set(readerGuide.map(({ question }) => question)).size).toBe(readerGuide.length);
    expect(leaf('ledger.part107.107.12.b').target.subjectKind).toBe('person');
    expect(leaf('ledger.part107.107.12.b.assigned').target.subjectKind).toBe('flight');
  });

  it('quotes every rule from the retained edition by pinned byte span, and words nothing as a verdict', async () => {
    const source = (await getRuleSource(PART107_SOURCE_ID))!;
    for (const item of pack.leaves) {
      if (item.source.kind !== 'regulation') throw new Error(`${item.id} must quote in-force text`);
      const span = item.source.textSpan;
      const snippet = source.bytes.subarray(span.start, span.end);
      expect(snippet.toString('utf8'), item.id).toBe(item.source.text);
      expect(sha256(snippet), item.id).toBe(item.source.sha256);
      expect(span).toMatchObject({ unit: 'utf8_byte', sourceId: PART107_SOURCE_ID });
      const own = JSON.stringify({ title: item.title, wording: isCheckedRuleLeaf(item) ? item.wording : undefined });
      expect(own, item.id).not.toMatch(/\b(compliant|compliance|authori[sz]ed|go|no-go|proposed)\b/i);
      const { digest, ...content } = item;
      expect(canonicalDigest(content)).toBe(digest);
    }
  });

  it('covers, in each rule about a person, the people its paragraph is about, as role assignments name them', () => {
    const roles = (id: string) => {
      const population = leaf(id).population;
      expect(population, id).toMatchObject({
        of: 'designated',
        by: {
          type: 'operator.record',
          field: 'values.record.personId',
          where: [
            { field: 'values.recordType', oneOf: ['operation.role-assignment'] },
            { field: 'values.record.role' },
          ],
        },
      });
      return population!.of === 'designated' ? population!.by.where![1]!.oneOf : [];
    };
    expect(roles('ledger.part107.107.12.b')).toEqual(['pilot_in_command']);
    expect(roles('ledger.part107.107.65')).toEqual(['pilot_in_command']);
    expect(roles('ledger.part107.107.27')).toEqual([
      'pilot_in_command',
      'person_manipulating_controls',
      'visual_observer',
    ]);
    expect(roles('ledger.part107.107.17')).toEqual([
      'pilot_in_command',
      'person_manipulating_controls',
      'visual_observer',
      'payload_operator',
      'operations_supervisor',
      'flight_coordinator',
      'other',
    ]);
    // No rule of the pack covers every person on record.
    for (const item of pack.leaves)
      if (isCheckedRuleLeaf(item) && item.target.subjectKind === 'person')
        expect(item.population?.of, item.id).toBe('designated');
  });

  it('asks the organization for the time zone it counts days in', () => {
    expect(adoptionParameterProblem(pack, { 'ledger.part107.107.9.timing': { timeZone: 'UTC' } })).toBeUndefined();
    expect(adoptionParameterProblem(pack, undefined)).toBe('Leaf ledger.part107.107.9.timing needs parameter timeZone');
    expect(adoptionParameterProblem(pack, { 'ledger.part107.107.9.timing': { timeZone: '-07:00' } })).toMatch(
      /^Leaf ledger.part107.107.9.timing: /,
    );
  });
});

describe('Part 107 version 2 checks', () => {
  it('107.12(b), per flight: each assigned remote pilot in command’s certificate is recorded as held', () => {
    const id = 'ledger.part107.107.12.b.assigned';
    expect(leaf(id).related).toEqual([
      {
        name: 'pilot',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'insufficient',
        from: { read: 'assignments', field: 'values.record.personId' },
      },
    ]);
    const assignment = (role: string) =>
      record(
        'operation.role-assignment',
        { personId: { id: 'PER-1', scope: 'source' }, role, startsAt: '2026-10-20T08:30:00Z' },
        { start: '2026-10-20T08:30:00.000Z' },
      );
    const pilot = assignment('pilot_in_command');
    const certificate = (recordedStatus: string, credentialKind = 'remote_pilot_certificate') =>
      record('person.certificate', { credentialKind, credentialNumber: 'RP-0001', recordedStatus });
    const held = certificate('held');
    const passed = expectPass([id, [pilot, assignment('visual_observer')], { pilot: [held] }], 'value_expected', [
      held,
    ]);
    expect(passed.summary).toMatch(/assigned as remote pilot in command of the flight/);
    // Only the pilot-in-command assignment is read; the observer's names no one this rule fans out over.
    expect(passed.evidence).not.toContain(expect.stringMatching(/^operation\.role-assignment/));
    expectResult([id, [pilot], { pilot: [certificate('revoked')] }], 'supported', 'attention', 'value_unexpected');
    expectResult(
      [id, [pilot], { pilot: [certificate('held', 'operator_qualification')] }],
      'insufficient',
      'pending',
      'value_missing',
    );
  });

  it('107.9: a serious injury or loss of consciousness reported within 10 calendar days', () => {
    const id = 'ledger.part107.107.9.timing';
    const utc = { timeZone: 'UTC' };
    const accident = (accidentKind: string, occurredAt: string, reportedToAuthorityAt?: string) =>
      record(
        'occurrence.accident',
        {
          occurredAt,
          accidentKind,
          summary: 'Fictional event',
          ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}),
        },
        { at: occurredAt },
      );
    // Saturday 2026-10-03: calendar days count weekends, so the 10th day is Tuesday 10-13.
    const onTime = accident('serious_injury', '2026-10-03T15:00:00.000Z', '2026-10-13T23:30:00.000Z');
    const passed = expectPass([id, [onTime], {}, utc], 'within_business_days', [onTime]);
    expect(passed.details).toMatchObject({ startDay: '2026-10-03', dueThrough: '2026-10-13' });
    expectResult(
      [id, [accident('loss_of_consciousness', '2026-10-03T15:00:00.000Z', '2026-10-14T00:00:00.000Z')], {}, utc],
      'supported',
      'attention',
      'after_business_days',
    );
    expectResult(
      [id, [accident('serious_injury', '2026-10-03T15:00:00.000Z')], {}, utc],
      'insufficient',
      'attention',
      'end_overdue',
    );
    // In Denver the same instant is still Friday 10-02, so the report is due a day earlier.
    expectResult(
      [id, [accident('serious_injury', '2026-10-03T03:00:00.000Z', '2026-10-13T12:00:00.000Z')], {}, utc],
      'supported',
      'pass',
      'within_business_days',
    );
    expectResult(
      [
        id,
        [accident('serious_injury', '2026-10-03T03:00:00.000Z', '2026-10-13T12:00:00.000Z')],
        {},
        { timeZone: 'America/Denver' },
      ],
      'supported',
      'attention',
      'after_business_days',
    );
    const awaited = expectResult(
      [id, [accident('serious_injury', '2026-10-15T15:00:00.000Z')], {}, utc],
      'insufficient',
      'pending',
      'end_awaited',
    );
    expect(awaited.summary).toMatch(/due by the end of 2026-10-25/);
    // An accident the operator recorded as not reportable is not counted, and the result says who decided.
    const notReportable = record(
      'occurrence.accident',
      {
        occurredAt: '2026-10-03T15:00:00.000Z',
        accidentKind: 'loss_of_consciousness',
        summary: 'Fictional event',
        notReportable: true,
        notReportableDecidedById: { id: 'RIDGE-P-2', scope: 'source' },
      },
      { at: '2026-10-03T15:00:00.000Z' },
    );
    const exempt = expectResult([id, [notReportable], {}, utc], 'not_applicable', 'not_applicable', 'not_due');
    expect(exempt.summary).toMatch(/is recorded as not reportable by RIDGE-P-2, so it is not counted\.$/);
    // Property damage is not timed here: whether a report is due is a judgment.
    expectResult(
      [id, [accident('property_damage', '2026-10-03T15:00:00.000Z')], {}, utc],
      'not_applicable',
      'not_applicable',
      'start_not_recorded',
    );
  });

  it('reads every record made for a planned window as soon as it is recorded, and nothing that happened', () => {
    const plans = Object.fromEntries(
      pack.leaves
        .filter(isCheckedRuleLeaf)
        .map((item) => [
          item.id.replace('ledger.part107.', ''),
          item.reads.filter((read) => read.plans).map((read) => read.name),
        ]),
    );
    expect(plans).toEqual({
      '107.12.b': [],
      '107.65': [],
      '107.19.a': ['interval', 'window'],
      '107.13': [],
      '107.15.a': [],
      '107.17': [],
      '107.27': [],
      '107.31.a': ['subject'],
      '107.36': ['subject'],
      '107.49.a': ['record'],
      '107.49.b': ['record'],
      '107.49.c-e': ['record'],
      '107.51.a': ['plan'],
      '107.51.b': ['plan'],
      '107.51.c': ['quantity'],
      '107.51.d.1': ['quantity'],
      '107.51.d.2': ['quantity'],
      '107.9.a': [],
      '107.12.b.assigned': ['assignments'],
      '107.9.timing': [],
      '107.41': ['plan', 'authorizations'],
    });
  });

  describe('107.41: the airspace authorizations the airspace service reported about the flight', () => {
    const id = 'ledger.part107.107.41';
    const plan = () =>
      record('flight.plan', {
        windowStartsAt: '2026-10-20T09:00:00Z',
        windowEndsAt: '2026-10-20T10:00:00Z',
        plannedMaxHeightAboveGroundMeters: 90,
      });
    const square = [
      { latitudeDegrees: 41.87, longitudeDegrees: -87.64 },
      { latitudeDegrees: 41.89, longitudeDegrees: -87.64 },
      { latitudeDegrees: 41.89, longitudeDegrees: -87.62 },
      { latitudeDegrees: 41.87, longitudeDegrees: -87.62 },
    ];
    const authorization = (values: Record<string, unknown> = {}, end = '2026-10-20T11:00:00.000Z') => {
      const interval = { start: '2026-10-20T08:30:00.000Z', end };
      const occurredAt = '2026-10-20T08:00:00.000Z';
      return {
        id: `authorization-${++sequence}`,
        type: 'airspace.authorization',
        version: 1,
        occurredAt,
        interval,
        observation: {
          occurredAt,
          interval,
          values: {
            authorizationId: 'SIM-0001',
            reportedStatus: 'approved',
            ceiling: { meters: 121.92, datum: 'ground_level' },
            area: { boundary: square },
            ...values,
          },
        },
      } satisfies CheckObservation;
    };
    const position = (latitudeDegrees: number) => ({
      id: `position-${++sequence}`,
      type: 'position.fix',
      version: 1,
      occurredAt: '2026-10-20T09:15:00.000Z',
      observation: {
        occurredAt: '2026-10-20T09:15:00.000Z',
        position: { latitudeDegrees, longitudeDegrees: -87.63, altitude: { meters: 100, datum: 'takeoff_point' } },
        values: { fix: 'unknown' },
      },
    });

    it('is supported by one covering the planned window under its ceiling, and names it', () => {
      const result = run(id, [plan(), authorization()]);
      expect(result).toMatchObject({ outcome: 'pass', reasonCode: 'authorization_covers' });
      expect(result.summary).toMatch(
        /^Authorization SIM-0001, reported approved .* covers the flight’s planned window/,
      );
      expect(result.summary).toMatch(/whether the flight entered airspace that needs prior authorization/i);
    });

    it('reports none on record as not on file, never as a finding', () => {
      expect(run(id, [plan()])).toMatchObject({
        outcome: 'pending',
        evidenceState: 'insufficient',
        reasonCode: 'record_not_on_file',
        summary: 'No airspace authorization on file.',
      });
    });

    it('needs attention for one that expired before the flight ended', () => {
      const result = run(id, [plan(), authorization({}, '2026-10-20T09:30:00.000Z')]);
      expect(result).toMatchObject({ outcome: 'attention', details: { problem: 'expired' } });
      expect(result.summary).toMatch(/SIM-0001: ended at 2026-10-20T09:30:00\.000Z, before the flight’s/);
    });

    it('needs attention for one covering another place than the aircraft flew', () => {
      const result = run(id, [plan(), authorization()], { aircraft: [position(41.95)] });
      expect(result).toMatchObject({ outcome: 'attention', details: { basis: 'flown', problem: 'other_place' } });
    });

    it('needs attention for one whose ceiling is below the flown height', () => {
      const low = authorization({ ceiling: { meters: 60.96, datum: 'ground_level' } });
      const result = run(id, [plan(), low], { aircraft: [position(41.88)] });
      expect(result).toMatchObject({ outcome: 'attention', details: { problem: 'ceiling_below', heightRead: 100 } });
      // The rule's text states heights in feet: the summary does, with the stored meters beside them.
      expect(result.summary).toContain(
        'its ceiling, 200 ft (60.96 m) above ground level, is below the flown height above the takeoff point, 328.08 ft (100 m)',
      );
    });
  });
});

describe('Part 107 version 2 for a flight that has flown', () => {
  const plan = record(
    'flight.plan',
    {
      windowStartsAt: '2026-10-01T10:00:00Z',
      windowEndsAt: '2026-10-01T11:00:00Z',
      operationKind: 'inspection',
      visualMode: 'visual_line_of_sight',
    },
    { start: '2026-10-01T10:00:00.000Z', end: '2026-10-01T11:00:00.000Z' },
  );
  const landed = record(
    'flight.record',
    { takeoffAt: '2026-10-01T10:05:00Z', landingAt: '2026-10-01T10:40:00Z' },
    { start: '2026-10-01T10:05:00.000Z', end: '2026-10-01T10:40:00.000Z' },
  );
  const assessment = record(
    'flight.preflight-assessment',
    {
      assessedAt: '2026-10-01T09:50:00Z',
      weatherDetermination: 'Clear.',
      airspaceDetermination: 'Class G.',
      groundHazardsDetermination: 'None.',
      participantsBriefing: 'Crew briefed.',
      linkEnergyLoadDetermination: 'Checked.',
      visibilityMeters: 8000,
    },
    { at: '2026-10-01T09:50:00.000Z' },
  );
  const flightRules = pack.leaves.filter(
    (item): item is CheckedRuleLeaf => isCheckedRuleLeaf(item) && item.target.subjectKind === 'flight',
  );
  const runAt = (id: string, evaluatedAt: string) => {
    const rule = leaf(id);
    const inputs: Record<string, CheckObservation[]> = {};
    for (const read of rule.reads)
      inputs[read.name] = narrowRead(
        read,
        read.about === 'target' ? [plan, landed, assessment].filter((item) => item.type === read.type) : [],
        inputs,
      );
    const parameters = Object.fromEntries(rule.adoptionParameters.map((parameter) => [parameter.name, 'UTC']));
    return runCheckedRule(rule, { ...rule.check.params, ...parameters }, inputs, { mode: 'wall', evaluatedAt });
  };

  it('waits for no record once a week has passed since the flight landed on record: the record is not on file', () => {
    for (const rule of flightRules) {
      const result = runAt(rule.id, '2026-10-08T10:40:00.000Z');
      if (result.outcome === 'pending') expect(result.reasonCode, rule.id).toBe('record_not_on_file');
    }
    expect(runAt('ledger.part107.107.51.d.1', '2026-10-08T10:40:00.000Z').summary).toBe(
      'No preflight assessment stating the distance below cloud on file 7 days after the flight landed at 2026-10-01T10:40:00.000Z. No value is reported for the preflight assessment’s Distance below cloud.',
    );
  });

  it('waits until then, and is evaluated again when the week ends', () => {
    const waiting = runAt('ledger.part107.107.51.a', '2026-10-08T10:39:59.999Z');
    expect(waiting).toMatchObject({
      outcome: 'pending',
      reasonCode: 'planned_value_missing',
      nextBoundary: '2026-10-08T10:40:00.000Z',
    });
  });
});
