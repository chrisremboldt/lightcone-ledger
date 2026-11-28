import { describe, expect, it } from 'vitest';
import { declaredRecordDefinition, type DeclaredRecordType } from '../../contracts/src/index.js';
import { checkParameterProblem, type CheckObservation, type CheckParameterContext } from '../src/check-kinds.js';
import '../src/check-kind-library.js';
import { recordPointsTotalV1, type RecordPointsTotalParams } from '../src/check-kind-library-points.js';
import { registerObservationRecordTypes } from '../src/observation-registry.js';

// The points of a record's answers, totalled against a level: an invented assessment a pack might declare.

const TYPE = 'points-test.assessment';
const declared: DeclaredRecordType = {
  id: TYPE,
  version: 1,
  title: 'Flight risk assessment',
  description: 'An invented scored assessment made for a flight.',
  subjectKinds: ['flight'],
  time: { meaning: 'event', atField: 'assessedAt' },
  fields: [
    { name: 'assessedAt', label: 'Assessed at', kind: 'date_time', required: true },
    {
      name: 'site',
      label: 'Site',
      kind: 'select',
      required: true,
      options: [
        { value: 'flown-before', label: 'Flown before' },
        { value: 'new-site', label: 'New to the operator' },
      ],
    },
    {
      name: 'windMetersPerSecond',
      label: 'Wind at launch',
      kind: 'number',
      unit: 'MetersPerSecond',
      maximum: 40,
      required: true,
    },
    { name: 'recentFlightsCount', label: 'Pilot’s flights in the last 90 days', kind: 'number', unit: 'Count' },
    { name: 'overPeople', label: 'Over people', kind: 'boolean', required: true },
    { name: 'notes', label: 'Notes', kind: 'long_text' },
  ],
};
const definition = declaredRecordDefinition('points-test', { ...declared, digest: '0'.repeat(64) });
registerObservationRecordTypes(definition);

const clock = (evaluatedAt: string) => ({ mode: 'wall' as const, evaluatedAt, timeZone: 'America/Denver' });
let sequence = 0;

function record(recordType: string, body: Record<string, unknown>, occurredAt: string, flight = 'RIDGE-F-1') {
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt,
    observation: {
      type: 'operator.record',
      version: 1,
      occurredAt,
      subject: { kind: 'flight', id: flight, scope: 'source' },
      values: { recordType, recordVersion: 1, record: body },
    },
  } satisfies CheckObservation;
}

const TAKEOFF = '2026-11-10T15:00:00.000Z';
const flown = record('flight.record', { takeoffAt: TAKEOFF, landingAt: '2026-11-10T15:30:00.000Z' }, TAKEOFF);
const assessment = (body: Record<string, unknown>, assessedAt = '2026-11-10T14:00:00.000Z') =>
  record(TYPE, { assessedAt, ...body }, assessedAt);
const answers = { site: 'flown-before', windMetersPerSecond: 4, recentFlightsCount: 12, overPeople: false };

const params: RecordPointsTotalParams = {
  recordDescribes: 'flight risk assessment',
  fields: [
    {
      field: 'values.record.site',
      options: [
        { value: 'flown-before', points: 0 },
        { value: 'new-site', points: 3 },
      ],
    },
    {
      field: 'values.record.windMetersPerSecond',
      bands: [
        { to: 5, points: 0 },
        { from: 5, to: 8, points: 2 },
        { from: 8, points: 4 },
      ],
    },
    {
      field: 'values.record.recentFlightsCount',
      bands: [
        { to: 3, points: 3 },
        { from: 3, points: 0 },
      ],
    },
    { field: 'values.record.overPeople', yes: 2, no: 0 },
  ],
  comparison: 'below',
  level: 5,
  whenOver: 'a second remote pilot reviews the assessment before the flight',
  recordedStartField: 'values.record.takeoffAt',
  plannedStartField: 'values.record.windowStartsAt',
};
const now = clock('2026-11-20T00:00:00.000Z');
const run = (records: CheckObservation[], overrides: Partial<RecordPointsTotalParams> = {}, flight = [flown]) =>
  recordPointsTotalV1.evaluate({ ...params, ...overrides }, { record: records, recorded: flight }, now);

describe('record.points-total', () => {
  it('accepts the parameters, and a level left to the organization is the only one missing', () => {
    expect(checkParameterProblem('record.points-total', 1, params)).toBeUndefined();
    const { level: _level, ...withoutLevel } = params;
    expect(checkParameterProblem('record.points-total', 1, withoutLevel)).toMatch(/level/);
    expect(checkParameterProblem('record.points-total', 1, { ...params, level: 5.5 })).toMatch(/integer/);
    const both = { ...params, fields: [{ field: 'values.record.overPeople', yes: 1, no: 0, bands: [{ points: 1 }] }] };
    expect(checkParameterProblem('record.points-total', 1, both)).toBeDefined();
    const half = {
      ...params,
      fields: [{ field: 'values.record.site', options: [{ value: 'new-site', points: 1.5 }] }],
    };
    expect(checkParameterProblem('record.points-total', 1, half)).toMatch(/integer/);
  });

  it('scores every kind of field and states each answer, its points, the total and the level', () => {
    const made = assessment({ ...answers, site: 'new-site', windMetersPerSecond: 6, overPeople: true });
    const result = run([made], { level: 8 });
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'total_within_level' });
    expect(result.summary).toBe(
      'The flight risk assessment made at 2026-11-10T14:00:00.000Z, before takeoff at 2026-11-10T15:00:00.000Z in the operator’s flight record, scores Site: New to the operator (3); Wind at launch: 6 m/s (2); Pilot’s flights in the last 90 days: 12 (0); Over people: Yes (2). Total: 7 points, below the level of 8 points. At 8 points or more: a second remote pilot reviews the assessment before the flight.',
    );
    expect(result.details).toMatchObject({
      total: 7,
      level: 8,
      points: 'site=3; windMetersPerSecond=2; recentFlightsCount=0; overPeople=2',
      answers: 'site=new-site; windMetersPerSecond=6; recentFlightsCount=12; overPeople=true',
      missing: null,
      basis: 'recorded',
      flightStart: TAKEOFF,
      recordAt: '2026-11-10T14:00:00.000Z',
      reading: result.summary,
    });
    expect(result.evidence).toEqual([flown.id, made.id]);
  });

  it('places a number in its band at each edge: from is included, to is not', () => {
    const total = (windMetersPerSecond: number, recentFlightsCount = 12) =>
      run([assessment({ ...answers, windMetersPerSecond, recentFlightsCount })]).details!.total;
    expect([0, 4.99, 5, 7.99, 8, 40].map((wind) => total(wind))).toEqual([0, 0, 2, 2, 4, 4]);
    expect([0, 2, 3, 4].map((flights) => total(0, flights))).toEqual([3, 3, 0, 0]);
  });

  it('compares the total below, at and above the level, by either comparison', () => {
    const two = assessment({ ...answers, windMetersPerSecond: 5 });
    const outcomes = (comparison: 'below' | 'at_most') =>
      [1, 2, 3].map((level) => run([two], { comparison, level }).outcome);
    expect(outcomes('below')).toEqual(['attention', 'attention', 'pass']);
    expect(outcomes('at_most')).toEqual(['attention', 'pass', 'pass']);
    const over = run([two], { level: 2 });
    expect(over).toMatchObject({ evidenceState: 'supported', reasonCode: 'total_over_level' });
    expect(over.summary).toContain(
      'Total: 2 points; the level is below 2 points. At 2 points or more: a second remote pilot reviews the assessment before the flight.',
    );
    expect(run([two], { comparison: 'at_most', level: 1, whenOver: 'The chief pilot signs.' }).summary).toContain(
      'Total: 2 points; the level is at most 1 point. Above 1 point: The chief pilot signs.',
    );
    expect(run([two], { comparison: 'at_most', level: 2 }).summary).toContain(
      'Total: 2 points, at most the level of 2 points. Above 2 points:',
    );
  });

  it('takes the level an organization sets on adoption, merged into the parameters', () => {
    const { level: _level, ...fixed } = params;
    const merged = { ...fixed, level: 3 } as RecordPointsTotalParams;
    expect(checkParameterProblem('record.points-total', 1, merged)).toBeUndefined();
    const result = recordPointsTotalV1.evaluate(
      merged,
      { record: [assessment({ ...answers, site: 'new-site' })], recorded: [flown] },
      now,
    );
    expect(result).toMatchObject({ outcome: 'attention', details: { total: 3, level: 3 } });
  });

  it('never scores a missing answer as zero: it names it and states no total', () => {
    const { windMetersPerSecond: _wind, ...rest } = answers;
    const result = run([assessment({ ...rest, recentFlightsCount: null })]);
    expect(result).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      reasonCode: 'answer_missing',
      details: { total: null, points: null, missing: 'windMetersPerSecond; recentFlightsCount' },
    });
    expect(result.summary).toBe(
      'The flight risk assessment made at 2026-11-10T14:00:00.000Z, before takeoff at 2026-11-10T15:00:00.000Z in the operator’s flight record, records no answer for: Wind at launch, Pilot’s flights in the last 90 days. An answer that is missing or not scored counts no points, so no total is stated.',
    );
  });

  it('counts no as an answer, and names an answer the rule states no points for', () => {
    expect(run([assessment(answers)]).details).toMatchObject({
      total: 0,
      points: expect.stringContaining('overPeople=0'),
    });
    const result = run([assessment({ ...answers, site: 'offshore', windMetersPerSecond: -1 })]);
    expect(result).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'answer_not_scored' });
    expect(result.summary).toContain('holds an answer the rule states no points for: Site: offshore');
    expect(result.summary).not.toContain('Wind at launch');
    const overlapping = run([assessment(answers)], {
      fields: [
        {
          field: 'values.record.windMetersPerSecond',
          bands: [
            { to: 5, points: 0 },
            { from: 4, points: 2 },
          ],
        },
      ],
    });
    expect(overlapping).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'answer_not_scored' });
  });

  it('reads the latest record made at or before the takeoff, never one made after it', () => {
    const early = assessment({ ...answers, site: 'new-site' }, '2026-11-10T13:00:00.000Z');
    const latest = assessment(answers, '2026-11-10T14:30:00.000Z');
    const after = assessment({ ...answers, windMetersPerSecond: 20 }, '2026-11-10T15:00:00.001Z');
    const result = run([after, latest, early]);
    expect(result.details).toMatchObject({ total: 0, recordAt: '2026-11-10T14:30:00.000Z' });
    expect(result.evidence).toEqual([flown.id, latest.id]);
    expect(run([assessment(answers, TAKEOFF)]).outcome).toBe('pass');

    const none = run([after]);
    expect(none).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(none.summary).toBe(
      'No flight risk assessment is on file at or before takeoff at 2026-11-10T15:00:00.000Z in the operator’s flight record. The earliest on file was made at 2026-11-10T15:00:00.001Z, after it, and is not read for it.',
    );
    expect(run([]).summary).toBe(
      'No flight risk assessment is on file at or before takeoff at 2026-11-10T15:00:00.000Z in the operator’s flight record.',
    );
    expect(run([latest], {}, [])).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'record_not_on_file',
      summary:
        'No takeoff or planned start is on file for this flight, so the flight risk assessment cannot be placed against it.',
    });
  });

  it('reads the latest record at the evaluation time when the rule names no flight time', () => {
    const { recordedStartField: _recorded, plannedStartField: _planned, ...standing } = params;
    const first = assessment({ ...answers, site: 'new-site' }, '2026-11-01T10:00:00.000Z');
    const second = assessment(answers, '2026-11-15T10:00:00.000Z');
    const later = assessment({ ...answers, overPeople: true }, '2026-11-25T10:00:00.000Z');
    const result = recordPointsTotalV1.evaluate(standing, { record: [later, second, first] }, now);
    expect(result.details).toMatchObject({ total: 0, basis: null, recordAt: '2026-11-15T10:00:00.000Z' });
    expect(result.summary).toMatch(/^The flight risk assessment made at 2026-11-15T10:00:00.000Z scores Site: /);
  });

  it('conflicts when records made together give different answers', () => {
    const result = run([assessment(answers), assessment({ ...answers, site: 'new-site' })]);
    expect(result).toMatchObject({ evidenceState: 'conflicting', outcome: 'attention', reasonCode: 'values_disagree' });
    expect(result.summary).toContain('give different answers for: Site.');
  });

  it('stays readable with a dozen fields, and its details stay within what a detail holds', () => {
    const fields = Array.from({ length: 12 }, (_unused, index) => ({ field: `values.item${index}`, yes: 1, no: 0 }));
    const values = Object.fromEntries(fields.map((_field, index) => [`item${index}`, index % 2 === 0]));
    const observed: CheckObservation = {
      id: 'plain-1',
      type: 'example.answers',
      version: 1,
      occurredAt: '2026-11-10T14:00:00.000Z',
      observation: { type: 'example.answers', version: 1, occurredAt: '2026-11-10T14:00:00.000Z', values },
    };
    const result = run([observed], { fields, level: 7, comparison: 'at_most' });
    expect(result.details).toMatchObject({ total: 6 });
    expect(result.summary.length).toBeLessThan(600);
    expect(result.summary).toContain('scores Item0: Yes (1); Item1: No (0); ');
    for (const value of Object.values(result.details!)) expect(String(value).length).toBeLessThanOrEqual(1000);
  });
});

describe('record.points-total, what a pack build is told about the points', () => {
  const context: CheckParameterContext = { recordTypes: (input) => (input === 'record' ? [definition] : []) };
  const problems = (fields: unknown[], with_ = context) =>
    recordPointsTotalV1.parameterProblems!({ ...params, fields }, with_);
  const wind = (bands: unknown[]) => [{ field: 'values.record.windMetersPerSecond', bands }];

  it('accepts points that give every answer of every field one number', () => {
    expect(problems(params.fields)).toEqual([]);
  });

  it('refuses bands that overlap, leave a gap or stop short of the field’s bounds, naming the field', () => {
    expect(
      problems(
        wind([
          { to: 5, points: 0 },
          { from: 4, points: 2 },
        ]),
      ),
    ).toEqual([
      'The bands of “Wind at launch” (windMetersPerSecond) overlap: "below 5" and "4 and above" both hold 4. A band\'s from is included and its to is not, so one band ends where the next starts.',
    ]);
    expect(
      problems(
        wind([
          { to: 5, points: 0 },
          { from: 6, points: 2 },
        ]),
      )[0],
    ).toMatch(/^The bands of “Wind at launch” \(windMetersPerSecond\) leave values from 5 to under 6 with no points/);
    expect(
      problems(
        wind([
          { from: 1, to: 5, points: 0 },
          { from: 5, to: 40, points: 2 },
        ]),
      ),
    ).toEqual([
      'The bands of “Wind at launch” (windMetersPerSecond) leave values below 1 with no points; the field takes values from 0. Start the lowest band there, or leave out its from.',
      "The bands of “Wind at launch” (windMetersPerSecond) leave values of 40 and above with no points; the field takes values up to 40. Leave out the highest band's to.",
    ]);
    expect(
      problems(
        wind([
          { from: 0, to: 5, points: 0 },
          { from: 5, to: 40.5, points: 2 },
        ]),
      ),
    ).toEqual([]);
    expect(problems(wind([{ from: 5, to: 5, points: 0 }]))[0]).toMatch(/holds no value/);
  });

  it('asks for open ends where nothing states the field’s bounds', () => {
    const plain = { recordTypes: () => [] };
    expect(problems([{ field: 'values.speed', bands: [{ from: 0, points: 1 }] }], plain)[0]).toMatch(
      /must be open at both ends/,
    );
    expect(
      problems(
        [
          {
            field: 'values.speed',
            bands: [
              { to: 3, points: 0 },
              { from: 3, points: 1 },
            ],
          },
        ],
        plain,
      ),
    ).toEqual([]);
  });

  it('refuses options the field does not offer, an option with no points, and the wrong shape for the field', () => {
    expect(problems([{ field: 'values.record.site', options: [{ value: 'flown-before', points: 0 }] }])).toEqual([
      '“Site” (site) has no points for new-site. Every answer the form offers scores a stated number of points, 0 included.',
    ]);
    const extra = [
      { value: 'flown-before', points: 0 },
      { value: 'new-site', points: 3 },
      { value: 'offshore', points: 5 },
      { value: 'new-site', points: 4 },
    ];
    expect(problems([{ field: 'values.record.site', options: extra }])).toEqual([
      '“Site” (site) gives points for new-site twice.',
      '“Site” (site) gives points for offshore, which the field does not offer; its options are flown-before, new-site.',
    ]);
    expect(problems([{ field: 'values.record.overPeople', bands: [{ points: 1 }] }])[0]).toMatch(
      /^“Over people” \(overPeople\) is a yes-or-no field, but the rule gives it bands\./,
    );
    expect(problems([params.fields[0], params.fields[0]])[0]).toBe('site is scored twice; list each field once.');
  });
});
