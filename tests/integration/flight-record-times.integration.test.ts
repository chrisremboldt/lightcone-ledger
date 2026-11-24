import 'dotenv/config';
// The test organization keeps UTC: a summary states its times in it, with the zone's name.
const inZone = (instant: string) => localizeInstants(instant, 'UTC').replace(/[.]/g, '\\.');
import { localizeInstants } from '../../packages/contracts/src/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuleEvaluationRecord, SubjectReference } from '../../packages/contracts/src/index.js';
import {
  calculateIndicator,
  defineIndicator,
  gatherIndicatorInputs,
  registerIndicatorDefinition,
} from '../../packages/domain/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { createPool, withScope } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

// A fictional survey operator with no source at all: everything it holds is imported from its own files. Its flight
// times and flown height come from its own flight records, and the rules, the aircraft's total time in service and the
// flight hours all read them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')(
  'Flight times and flown height from the operator’s records',
  () => {
    const pool = createPool();
    const part107 = getRulePackVersion('ledger.part107', 2)!;
    const part108 = getRulePackVersion('ledger.part108-nprm', 3)!;
    const started = Date.now();
    /** A UTC time this many hours before the test started, in the form record files use. */
    const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
    let t: CoverageTenant;
    let ids: { aircraft: string; flown: string; unlogged: string; pilot: string; observer: string };

    const flightHours = defineIndicator({
      id: 'test.flight-record-hours',
      version: 1,
      title: 'Fictional anomalies per flight hour',
      description: 'Anomalies the fictional operator recorded, per flight hour from its own flight records.',
      scope: { kind: 'subject_kind', subjectKind: 'aircraft' },
      events: {
        kind: 'observations',
        type: 'operator.record',
        versions: [1],
        condition: { field: 'values.recordType', operator: 'equals', value: 'occurrence.operation-anomaly' },
      },
      exposure: { kind: 'exposure.flight-hours', version: 1, params: {} },
      window: { maxMilliseconds: 2 * 24 * 60 * 60 * 1000 },
      completeness: { exposureMustExceed: '0', populationDeclaredComplete: true, coverageWithoutGaps: true },
      unit: { per: 1, label: 'per flight hour', fractionDigits: 2 },
    });

    async function evaluations(kind: string, subjectId: string): Promise<RuleEvaluationRecord[]> {
      const query = new URLSearchParams({
        subjectKind: kind,
        subjectId,
        subjectScope: 'source',
        sourceId: t.sourceId,
        limit: '100',
      });
      const response = await t.call(t.actor, 'GET', `/v1/evaluations?${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().evaluations;
    }
    const latest = (list: RuleEvaluationRecord[], ruleId: string) => {
      const found = list.find((evaluation) => evaluation.rule.id === ruleId && !evaluation.related);
      expect(found, ruleId).toBeDefined();
      return found!;
    };

    beforeAll(async () => {
      registerIndicatorDefinition(flightHours);
      t = await coverageTenant('flight-record-times');
      ids = {
        aircraft: `${t.prefix}-RIDGE-AC-1`,
        flown: `${t.prefix}-RIDGE-FLT-1`,
        unlogged: `${t.prefix}-RIDGE-FLT-2`,
        pilot: `${t.prefix}-RIDGE-P-1`,
        observer: `${t.prefix}-RIDGE-P-2`,
      };
      await t.importRecords('aircraft.identity', [
        {
          subjectId: ids.aircraft,
          aircraftMakeModel: 'Example Quad 4',
          serialNumber: 'EQ4-000117',
          registrationNumber: 'FA-RIDGE-0117',
        },
      ]);
      await t.importRecords('aircraft.time-in-service', [
        {
          subjectId: ids.aircraft,
          entryKind: 'opening_balance',
          totalTimeHours: 120.5,
          coveredThroughAt: hoursAgo(48),
          sourceReference: 'Example Ridge Survey logbook, page 14',
          coverage: 'complete',
          coverageNotes: 'Every flight before the opening total is in the paper logbook.',
        },
      ]);
      await t.importRecords(
        'flight.plan',
        [ids.flown, ids.unlogged].map((subjectId, index) => ({
          subjectId,
          secondarySubjectId: ids.aircraft,
          windowStartsAt: hoursAgo(8 - index * 3),
          windowEndsAt: hoursAgo(6 - index * 3),
          operationKind: 'aerial_survey',
          plannedOriginDescription: 'Ridge road pullout',
          plannedDestinationDescription: 'Ridge road pullout',
          routeSummary: 'Survey grid along the fictional ridge line',
          plannedMaxHeightAboveGroundMeters: 100,
        })),
      );
      await t.importRecords(
        'operation.role-assignment',
        [ids.flown, ids.unlogged].flatMap((subjectId, index) => [
          {
            subjectId,
            subjectKind: 'flight',
            personId: ids.pilot,
            role: 'pilot_in_command',
            startsAt: hoursAgo(8 - index * 3),
            endsAt: hoursAgo(6 - index * 3),
          },
          {
            subjectId,
            subjectKind: 'flight',
            personId: ids.observer,
            role: 'visual_observer',
            startsAt: hoursAgo(8 - index * 3),
            endsAt: hoursAgo(6 - index * 3),
          },
        ]),
      );
      // The second flight was planned and crewed, but its flight record has not been entered.
      await t.importRecords('flight.record', [
        {
          subjectId: ids.flown,
          secondarySubjectId: ids.aircraft,
          takeoffAt: hoursAgo(7.5),
          landingAt: hoursAgo(6.75),
          takeoffLocation: 'Ridge road pullout',
          landingLocations: 'Ridge road pullout',
          maxHeightFlownAboveGroundMeters: 110,
          flightPathReference: 'logs/RIDGE-FLT-1.kml',
        },
      ]);
      const effectiveInterval = { start: hoursAgo(72), end: new Date(started + 86_400_000).toISOString() };
      await t.adopt(part107, 'active', { effectiveInterval });
      await t.adopt(part108, 'shadow', { effectiveInterval });
      await t.settle();
    });
    afterAll(async () => {
      if (t) {
        await settleOwnedWork([t.prefix]);
        await t.close();
      }
      await pool.end();
    });

    it('refuses a flight record whose landing is before its takeoff, in a plain sentence', async () => {
      const artifact = JSON.stringify({
        recordType: 'flight.record',
        recordVersion: 1,
        records: [
          {
            subjectId: `${t.prefix}-RIDGE-FLT-9`,
            takeoffAt: hoursAgo(2),
            landingAt: hoursAgo(3),
            takeoffLocation: 'Ridge road pullout',
            landingLocations: 'Ridge road pullout',
            maxHeightFlownAboveGroundMeters: 60,
          },
        ],
      });
      const created = await t.call(t.operator, 'POST', '/v1/uploads', {
        contentType: 'application/json',
        byteLength: Buffer.byteLength(artifact),
      });
      const uploadId = created.json().upload.id as string;
      await t.call(t.operator, 'PUT', `/v1/uploads/${uploadId}/content`, Buffer.from(artifact), {
        'content-type': 'application/octet-stream',
      });
      const finalized = await t.call(t.operator, 'POST', `/v1/uploads/${uploadId}/finalize`);
      const preview = await t.call(t.operator, 'POST', '/v1/operator-records/imports/preview', {
        artifactId: finalized.json().artifact.id,
        recordType: 'flight.record',
        recordVersion: 1,
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().rows[0]).toMatchObject({
        status: 'refused',
        reasons: [
          `Landing at (landingAt), ${hoursAgo(3)}, is before Takeoff at (takeoffAt), ${hoursAgo(2)}; it must be after it.`,
        ],
      });
    });

    it('shows each item of the record of each flight on file for the logged flight, and not on file for the other', async () => {
      const items = [
        'ledger.nprm.108.40.a.3.i',
        'ledger.nprm.108.40.a.3.ii',
        'ledger.nprm.108.40.a.3.iii',
        'ledger.nprm.108.40.a.3.iv',
        'ledger.nprm.108.40.a.3.v',
        'ledger.nprm.108.40.a.3.vi',
      ];
      const flown = await evaluations('flight', ids.flown);
      for (const id of items)
        expect(latest(flown, id), id).toMatchObject({
          adoption: { mode: 'shadow' },
          pack: { id: part108.packId, version: 3, digest: part108.digest },
          evidenceState: 'supported',
          outcome: 'pass',
        });
      expect(latest(flown, 'ledger.nprm.108.40.a.3.i').summary).toMatch(
        new RegExp(
          `^On file for this flight, from the operator’s flight record: takeoff ${inZone(hoursAgo(7.5))}, landing ${inZone(hoursAgo(6.75))}, a duration of 45 minutes\\.`,
        ),
      );
      expect(latest(flown, 'ledger.nprm.108.40.a.3.ii').summary).toMatch(/registration number FA-RIDGE-0117\./);
      expect(latest(flown, 'ledger.nprm.108.40.a.3.iii').summary).toMatch(/type of operation Aerial survey\./);
      expect(latest(flown, 'ledger.nprm.108.40.a.3.v').summary).toContain(`${ids.pilot}, Pilot in command`);

      const unlogged = await evaluations('flight', ids.unlogged);
      for (const id of items)
        expect(latest(unlogged, id), id).toMatchObject({
          evidenceState: 'insufficient',
          outcome: 'pending',
          reasonCode: 'record_not_on_file',
        });
      expect(latest(unlogged, 'ledger.nprm.108.40.a.3.i').summary).toBe(
        'No takeoff or landing on file for this flight in the flight’s reports or the operator’s flight record.',
      );
      expect(latest(unlogged, 'ledger.nprm.108.40.a.3.iii').summary).toBe('No flight record on file.');
    });

    it('rests the height rules on the recorded flown height, and says so', async () => {
      const flown = await evaluations('flight', ids.flown);
      for (const [ruleId, mode] of [
        ['ledger.part107.107.51.b', 'active'],
        ['ledger.nprm.108.175.a', 'shadow'],
      ] as const) {
        const height = latest(flown, ruleId);
        expect(height, ruleId).toMatchObject({
          adoption: { mode },
          evidenceState: 'supported',
          outcome: 'pass',
          reasonCode: 'recorded_within_limit',
          details: { basis: 'recorded', value: 110, recordedValue: 110, plannedValue: 100 },
        });
        expect(height.summary, ruleId).toMatch(
          /^No flown height is reported for this flight; the result rests on the operator’s own record of the flight\. Read the maximum height flown above ground level in the operator’s flight record: (?:360\.89 ft \()?110 m\)?, within the limit/,
        );
      }
      // The flight without a flight record rests on its plan.
      expect(latest(await evaluations('flight', ids.unlogged), 'ledger.part107.107.51.b')).toMatchObject({
        reasonCode: 'planned_within_limit',
        details: { basis: 'planned', recordedValue: null },
      });
    });

    it('derives the aircraft’s total time in service from its opening total and the logged flight', async () => {
      const total = latest(await evaluations('aircraft', ids.aircraft), 'ledger.nprm.108.40.a.1');
      expect(total).toMatchObject({
        evidenceState: 'supported',
        outcome: 'pass',
        reasonCode: 'total_derived',
        details: {
          openingValue: 120.5,
          additionCount: 1,
          recordedAdditionCount: 1,
          recordedDiffering: 0,
          total: 121.25,
        },
      });
      expect(total.summary).toMatch(/^A total time in service of 121\.25 hours is derived for the aircraft/);
    });

    it('counts the logged flight’s hours in the flight-hours exposure kind', async () => {
      const end = await databaseNow(t.admin);
      const aircraft: SubjectReference = { scope: 'source', kind: 'aircraft', id: ids.aircraft, sourceId: t.sourceId };
      const gathered = await withScope(pool, t.actor, (client, principal) =>
        gatherIndicatorInputs(client, principal, {
          definition: { id: flightHours.id, version: 1 },
          window: { start: hoursAgo(24), end },
          recordedThrough: end,
          population: { subjects: [aircraft], complete: true, declaredBy: { kind: 'person', id: t.actor.id } },
        }),
      );
      expect(gathered.outcome).toBe('complete');
      const result = calculateIndicator(gathered.definition, gathered.input);
      expect(result.exposure).toMatchObject({ decimal: '0.75', unit: 'flight_hour', gaps: [] });
      expect(result.counted.exposure).toHaveLength(1);
    });
  },
);
