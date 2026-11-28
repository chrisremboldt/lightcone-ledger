import 'dotenv/config';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  OperatorRecordPreviewResponse,
  OperatorRecordTypesResponse,
  RuleCoverageSubjectsResponse,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { buildPackFolder, registerPackFolder, registerStandardPacks } from '../../packages/standard-packs/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// The worked example of a checklist as a record type a pack declares (examples/preflight-checklist, and "A checklist
// of your own" in docs/guides/write-a-rule-pack.md): built, loaded from a pack folder and adopted by an invented
// organization, with five flights: no checklist, one completed after the takeoff, one with an item unanswered, one
// with a defect found, and one complete. If this test and those documents disagree, this test is right.
const example = new URL('../../examples/preflight-checklist/', import.meta.url);
const TYPE = 'example-ridge-checklist.preflight-checklist';
const BEFORE = 'example-ridge-checklist.completed-before-takeoff';
const ANSWERED = 'example-ridge-checklist.every-item-answered';
const NO_DEFECT = 'example-ridge-checklist.no-defect-found';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const csv = (name: string) => readFileSync(new URL(`records/${name}`, example));
const ITEMS = [
  'airframe',
  'propellers',
  'motors',
  'payload',
  'flightBatteries',
  'batteryCondition',
  'controllerBattery',
  'controllerLink',
  'returnHeight',
  'launchArea',
  'obstacles',
  'weather',
];

describe('A preflight checklist a pack declares, adopted by one organization', () => {
  let tenant: CoverageTenant;
  let pack: RulePackVersion;
  let adoptionId: string;
  const started = Date.now();
  const at = (days: number, hours = 0) => new Date(started + days * DAY + hours * HOUR).toISOString();
  const allDone = Object.fromEntries(ITEMS.map((item) => [item, 'done']));
  /** Each flight took off two hours before this time of its day; its checklist, when it has one, and when made. */
  const flights: { flight: string; day: number; checklist?: Record<string, unknown>; madeAt?: number }[] = [
    { flight: 'RIDGE-F-NONE', day: -6 },
    { flight: 'RIDGE-F-AFTER', day: -5, checklist: allDone, madeAt: -1 },
    { flight: 'RIDGE-F-GAP', day: -4, checklist: { ...allDone, batteryCondition: null, returnHeight: null } },
    {
      flight: 'RIDGE-F-DEFECT',
      day: -3,
      checklist: { ...allDone, propellers: 'defect-found', payload: 'not-applicable' },
    },
    {
      flight: 'RIDGE-F-COMPLETE',
      day: -2,
      checklist: { ...allDone, payload: 'not-applicable', weather: 'not-applicable' },
    },
  ];

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
    const folder = mkdtempSync(join(process.cwd(), '.local', 'preflight-checklist-'));
    const built = buildPackFolder(new URL('.', example).pathname);
    writeFileSync(join(folder, 'example-ridge-checklist-v1.pack.json'), JSON.stringify(built.file));
    pack = registerPackFolder(folder)[0]!.version;
    tenant = await coverageTenant('preflight-checklist');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('gives the organization the checklist as a record type, with its sections, and takes the example’s files', async () => {
    adoptionId = await tenant.adopt(pack, 'active', { effectiveInterval: { start: at(-30), end: at(1) } });
    const read = await tenant.call(tenant.operator, 'GET', '/v1/operator-records/types');
    expect(read.statusCode, read.body).toBe(200);
    const declared = (read.json() as OperatorRecordTypesResponse).types.find((type) => type.recordType === TYPE)!;
    expect(declared.title).toBe('Preflight checklist');
    // The headings reach the form as data, in the order of the manual; the fields that place and sign have none.
    expect([...new Set(declared.fields.map((field) => field.heading))]).toEqual([
      undefined,
      'Airframe',
      'Batteries',
      'Control station',
      'Site',
      'Notes',
    ]);
    expect(declared.fields.filter((field) => field.heading === 'Batteries').map((field) => field.label)).toEqual([
      'Flight batteries charged and latched',
      'No battery swollen or damaged',
      'Controller battery charged',
    ]);
    // A heading is the form's alone: the import columns and the template are the fields, as for any type.
    expect(declared.columns.map((column) => column.key)).toEqual([
      'subjectId',
      'completedAt',
      'completedById',
      ...ITEMS,
      'note',
      'replaces',
    ]);
    expect(declared.columns.some((column) => 'heading' in column)).toBe(false);
    const template = await tenant.call(
      tenant.operator,
      'GET',
      `/v1/operator-records/types/${TYPE}/versions/1/template`,
    );
    expect(template.body.trim()).toBe(csv(`${TYPE}.csv`).toString().split(/\r?\n/)[0]);
    for (const [recordType, rows, incomplete] of [
      ['flight.record', 5, 0],
      [TYPE, 4, 1],
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
        incomplete,
      });
    }
  });

  it('reports a flight with no checklist, one completed late, one with an item unanswered, one with a defect, and one complete', async () => {
    await tenant.importRecords(
      'flight.record',
      flights.map((item) => ({
        subjectId: item.flight,
        secondarySubjectId: 'RIDGE-AC-1',
        takeoffAt: at(item.day, -2),
        landingAt: at(item.day, -1.5),
        takeoffLocation: 'Pad',
        landingLocations: 'Pad',
        maxHeightFlownAboveGroundMeters: 90,
      })),
    );
    await tenant.importRecords(
      TYPE,
      flights.flatMap((item) =>
        item.checklist
          ? [
              {
                subjectId: item.flight,
                completedAt: at(item.day, item.madeAt ?? -2.5),
                completedById: 'RIDGE-P-01',
                ...item.checklist,
              },
            ]
          : [],
      ),
    );
    await tenant.settle();
    const summaries = async (ruleId: string, result: string) =>
      Object.fromEntries(
        Object.entries(await behind(ruleId, result)).map(([flight, evaluation]) => [flight, evaluation?.summary]),
      );

    // A flight with no checklist: every rule says none is on file, and none of them passes it.
    for (const ruleId of [BEFORE, ANSWERED, NO_DEFECT])
      expect(await summaries(ruleId, 'no_record'), ruleId).toEqual({
        'RIDGE-F-NONE': 'No preflight checklist on file.',
      });

    // 5.1: completed before the takeoff. One written up an hour after it needs attention and says both times.
    const late = await summaries(BEFORE, 'attention');
    expect(Object.keys(late)).toEqual(['RIDGE-F-AFTER']);
    expect(late['RIDGE-F-AFTER']).toMatch(
      /^The earliest preflight checklist on file was completed at .+, after the takeoff at .+\.$/,
    );
    const inTime = await summaries(BEFORE, 'supported');
    expect(Object.keys(inTime).sort()).toEqual(['RIDGE-F-COMPLETE', 'RIDGE-F-DEFECT', 'RIDGE-F-GAP']);
    expect(inTime['RIDGE-F-COMPLETE']).toMatch(
      /^The preflight checklist was completed at .+, before the takeoff at .+\.$/,
    );

    // 5.2: every item answered. The unanswered items are named in the manual's own words.
    expect(await summaries(ANSWERED, 'attention')).toEqual({
      'RIDGE-F-GAP':
        'The latest preflight checklist is missing: No battery swollen or damaged, Return-to-home height set for the site.',
    });
    expect(Object.keys(await summaries(ANSWERED, 'supported')).sort()).toEqual([
      'RIDGE-F-AFTER',
      'RIDGE-F-COMPLETE',
      'RIDGE-F-DEFECT',
    ]);

    // 5.3: no item answered defect found. One rule reads all twelve items and names the one that fails; an item
    // marked not applicable is an answer, counted and not found.
    expect(await summaries(NO_DEFECT, 'attention')).toEqual({
      'RIDGE-F-DEFECT':
        '1 of the 12 items read in the latest preflight checklist holds a value other than Done or Not applicable: Propellers undamaged and tight: Defect found. The others that hold a value: 10 Done, 1 Not applicable.',
    });
    const clear = await summaries(NO_DEFECT, 'supported');
    expect(clear).toEqual({
      'RIDGE-F-AFTER': 'All 12 items read in the latest preflight checklist hold Done or Not applicable: 12 Done.',
      'RIDGE-F-COMPLETE':
        'All 12 items read in the latest preflight checklist hold Done or Not applicable: 10 Done, 2 Not applicable.',
    });
    // With items unanswered, nothing says whether one of them is a defect: the result waits and names them.
    expect(await summaries(NO_DEFECT, 'pending')).toEqual({
      'RIDGE-F-GAP':
        'No value is recorded for 2 of the 12 items read in the latest preflight checklist: No battery swollen or damaged, Return-to-home height set for the site. The others that hold a value: 10 Done.',
    });
  });
});
