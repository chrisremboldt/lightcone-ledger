import 'dotenv/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OperatorRecordPreviewResponse,
  RuleCoverageSubjectsResponse,
  RuleEvaluationResponse,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { buildPackFolder, registerPackFolder, registerStandardPacks } from '../../packages/standard-packs/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// The worked example of a scored assessment (examples/flight-risk-assessment, and "A scored assessment" in
// docs/guides/write-a-rule-pack.md): the pack is built, loaded from a pack folder and adopted with the chief pilot's
// level set to 8, and flights are assessed below, at and above each of its two levels. If this test and those
// documents disagree, this test is right.
const example = new URL('../../examples/flight-risk-assessment/', import.meta.url);
const TYPE = 'example-ridge-risk.flight-risk-assessment';
const SECOND = 'example-ridge-risk.second-pilot-review';
const CHIEF = 'example-ridge-risk.chief-pilot-review';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const csv = (name: string) => readFileSync(new URL(`records/${name}`, example));

describe('A scored flight risk assessment, adopted by one organization', () => {
  let tenant: CoverageTenant;
  let pack: RulePackVersion;
  let adoptionId: string;
  const started = Date.now();
  const at = (days: number, hours = 0) => new Date(started + days * DAY + hours * HOUR).toISOString();

  // The answers that score nothing; each flight changes some. Points as the manual's 7.2 states them.
  const calm = {
    assessedById: 'RIDGE-P-01',
    windAtLaunchMetersPerSecond: 3,
    siteFamiliarity: 'flown-by-pilot',
    pilotFlightsLast90DaysCount: 12,
    peopleNearPath: false,
    dutyAtTakeoffHours: 2,
  };
  const windy = { windAtLaunchMetersPerSecond: 6 }; // 2
  const gusty = { windAtLaunchMetersPerSecond: 8 }; // 4
  const newSite = { siteFamiliarity: 'new-site' }; // 3
  const operatorSite = { siteFamiliarity: 'flown-by-operator' }; // 1
  const fewFlights = { pilotFlightsLast90DaysCount: 5 }; // 1
  const people = { peopleNearPath: true }; // 2
  /** Each flight: the day it took off, and the answers of the assessment made half an hour before, if one was. */
  const flights: { flight: string; day: number; answers?: Record<string, unknown> }[] = [
    { flight: 'RIDGE-F-4', day: -9, answers: { ...windy, ...operatorSite, ...fewFlights } },
    { flight: 'RIDGE-F-5', day: -8, answers: { ...windy, ...newSite } },
    { flight: 'RIDGE-F-6', day: -7, answers: { ...windy, ...newSite, ...fewFlights } },
    { flight: 'RIDGE-F-7', day: -6, answers: { ...gusty, ...newSite } },
    { flight: 'RIDGE-F-8', day: -5, answers: { ...gusty, ...newSite, ...fewFlights } },
    { flight: 'RIDGE-F-9', day: -4, answers: { ...gusty, ...newSite, ...people } },
    { flight: 'RIDGE-F-NONE', day: -3 },
    { flight: 'RIDGE-F-LATE', day: -2 },
    { flight: 'RIDGE-F-GAP', day: -1, answers: { ...windy, dutyAtTakeoffHours: null } },
  ];
  const takeoff = (flight: string) => at(flights.find((item) => item.flight === flight)!.day, -2);

  async function behind(ruleId: string, result: string) {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${ruleId}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return Object.fromEntries(
      (read.json() as RuleCoverageSubjectsResponse).subjects.map((item) => [item.subject.id, item.evaluation]),
    );
  }

  beforeAll(async () => {
    registerStandardPacks();
    const folder = mkdtempSync(join(process.cwd(), '.local', 'flight-risk-assessment-'));
    const built = buildPackFolder(new URL('.', example).pathname);
    writeFileSync(join(folder, 'example-ridge-risk-v1.pack.json'), JSON.stringify(built.file));
    pack = registerPackFolder(folder)[0]!.version;
    tenant = await coverageTenant('flight-risk');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('is adopted with the chief pilot’s level, and takes the example’s own files', async () => {
    adoptionId = await tenant.adopt(pack, 'active', {
      effectiveInterval: { start: at(-30), end: at(1) },
      parameters: { [CHIEF]: { level: 8 } },
    });
    const template = await tenant.call(
      tenant.operator,
      'GET',
      `/v1/operator-records/types/${TYPE}/versions/1/template`,
    );
    expect(template.statusCode, template.body).toBe(200);
    expect(template.body.trim()).toBe(csv(`${TYPE}.csv`).toString().split(/\r?\n/)[0]);
    for (const [recordType, rows] of [
      ['flight.record', 4],
      [TYPE, 3],
    ] as const) {
      const artifactId = await tenant.upload(csv(`${recordType}.csv`), 'text/csv');
      const preview = await tenant.call(tenant.operator, 'POST', '/v1/operator-records/imports/preview', {
        artifactId,
        recordType,
        recordVersion: 1,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect((preview.json() as OperatorRecordPreviewResponse).summary, preview.body).toMatchObject({
        rows,
        acceptable: rows,
        refused: 0,
        incomplete: 0,
      });
    }
  });

  it('totals each flight’s assessment as of its takeoff, below, at and above each level', async () => {
    await tenant.importRecords(
      'flight.record',
      flights.map((item) => ({
        subjectId: item.flight,
        secondarySubjectId: 'RIDGE-AC-1',
        takeoffAt: takeoff(item.flight),
        landingAt: at(item.day, -1.5),
        takeoffLocation: 'Pad',
        landingLocations: 'Pad',
        maxHeightFlownAboveGroundMeters: 90,
      })),
    );
    await tenant.importRecords(TYPE, [
      ...flights.flatMap((item) =>
        item.answers ? [{ subjectId: item.flight, assessedAt: at(item.day, -2.5), ...calm, ...item.answers }] : [],
      ),
      // An earlier draft of RIDGE-F-4's assessment scored 9; the one made later, still before the takeoff, is read.
      { subjectId: 'RIDGE-F-4', assessedAt: at(-9, -4), ...calm, ...gusty, ...newSite, ...people },
      // Made an hour after the takeoff: never read for the flight.
      { subjectId: 'RIDGE-F-LATE', assessedAt: at(-2, -1), ...calm },
    ]);
    await tenant.settle();

    /** The total each flight's sentence states, or null where it states none. */
    const totals = async (ruleId: string, result: string) =>
      Object.fromEntries(
        Object.entries(await behind(ruleId, result)).map(([flight, evaluation]) => {
          const stated = / Total: (-?\d+) points?[;,]/u.exec(evaluation?.summary ?? '')?.[1];
          return [flight, stated === undefined ? null : Number(stated)];
        }),
      );
    const recorded = async (evaluationId: string) => {
      const read = await tenant.call(tenant.actor, 'GET', `/v1/evaluations/${evaluationId}`);
      expect(read.statusCode, read.body).toBe(200);
      return (read.json() as RuleEvaluationResponse).evaluation;
    };
    // 7.2, first level: 5 points or more is reviewed by a second remote pilot.
    expect(await totals(SECOND, 'supported')).toEqual({ 'RIDGE-F-4': 4 });
    expect(await totals(SECOND, 'attention')).toEqual({
      'RIDGE-F-5': 5,
      'RIDGE-F-6': 6,
      'RIDGE-F-7': 7,
      'RIDGE-F-8': 8,
      'RIDGE-F-9': 9,
      'RIDGE-F-GAP': null,
    });
    // 7.2, second level: above the 8 points this organization set is reviewed by the chief pilot.
    expect(await totals(CHIEF, 'supported')).toEqual({
      'RIDGE-F-4': 4,
      'RIDGE-F-5': 5,
      'RIDGE-F-6': 6,
      'RIDGE-F-7': 7,
      'RIDGE-F-8': 8,
    });
    expect(await totals(CHIEF, 'attention')).toEqual({ 'RIDGE-F-9': 9, 'RIDGE-F-GAP': null });

    // The sentence states every answer with its points, the total, the level and what the manual asks over it, with
    // each time in the organization's time zone.
    const five = (await behind(SECOND, 'attention'))['RIDGE-F-5']!;
    expect(five.reasonCode).toBe('total_over_level');
    expect(five.summary).toMatch(
      /^The flight risk assessment made at .+, before takeoff at .+ in the operator’s flight record, scores Wind at launch: 6 m\/s \(2\); The site: New to the operator \(3\); Pilot's flights in the last 90 days: 12 \(0\); People within 30 m of the planned path: No \(0\); Pilot's hours on duty at takeoff: 2 h \(0\)\. Total: 5 points; the level is below 5 points\. At 5 points or more: a second remote pilot reviews the assessment before the flight\.$/,
    );
    expect((await recorded(five.id)).details).toMatchObject({
      total: 5,
      level: 5,
      basis: 'recorded',
      points:
        'windAtLaunchMetersPerSecond=2; siteFamiliarity=3; pilotFlightsLast90DaysCount=0; peopleNearPath=0; dutyAtTakeoffHours=0',
    });
    const eight = (await behind(CHIEF, 'supported'))['RIDGE-F-8']!;
    expect(eight.summary).toMatch(
      / Total: 8 points, at most the level of 8 points\. Above 8 points: the chief pilot reviews the assessment before the flight\.$/,
    );
    expect((await behind(CHIEF, 'attention'))['RIDGE-F-9']!.summary).toMatch(
      / Total: 9 points; the level is at most 8 points\. Above 8 points: the chief pilot reviews the assessment before the flight\.$/,
    );

    // A missing answer never scores zero: the flight needs attention and no total is stated.
    const gap = (await behind(SECOND, 'attention'))['RIDGE-F-GAP']!;
    expect(gap).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'answer_missing' });
    expect(gap.summary).toMatch(
      / records no answer for: Pilot's hours on duty at takeoff\. An answer that is missing or not scored counts no points, so no total is stated\.$/,
    );

    // No assessment at all, and one made only after the takeoff: neither is on file for the flight.
    for (const ruleId of [SECOND, CHIEF]) {
      const none = await behind(ruleId, 'no_record');
      expect(Object.keys(none).sort()).toEqual(['RIDGE-F-LATE', 'RIDGE-F-NONE']);
      expect(none['RIDGE-F-NONE']!.summary).toBe('No flight risk assessment on file.');
      expect(none['RIDGE-F-LATE']!.summary).toMatch(
        /^No flight risk assessment is on file at or before takeoff at .+ in the operator’s flight record\. The earliest on file was made at .+, after it, and is not read for it\.$/,
      );
    }
  });
});
