import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuleCoverageSubjectsResponse, RulePackVersion } from '../../packages/contracts/src/index.js';
import { registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import { buildPackFile, registerStandardPacks, verifiedPackFile } from '../../packages/standard-packs/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// An organization with no aircraft or site reporting to Ledger keeps its flights in its own log. Its waiver, built
// from text as a pack file, states a wind limit, a battery reserve and inspections due by hours in service; the rules
// read the operator's flight records and say so. One flight also has a source's reports, and those are read instead
// (docs/design/observed-values.md, section 7; docs/design/date-only-records.md).

const DAY = 86_400_000;
const source = `Certificate of Waiver EX-0121 (invented for this test)

1. No flight takes off when the sustained wind at the launch site is above 11 meters per second.

2. Each flight lands with not less than 25 percent battery remaining.

3. An aircraft is not flown after its next inspection is due, at a date or at a number of hours in service.
`;

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Rules that read the operator’s own flight log', () => {
  let tenant: CoverageTenant;
  let pack: RulePackVersion;
  let adoptionId: string;
  const id = (name: string) => `${tenant.prefix}-${name}`;
  const rule = (number: number) => `${pack.packId}.provision-${number}`;
  const started = Date.now();
  /** An instant whole days and hours from when the test started, in UTC. */
  const at = (days: number, hours = 0) => new Date(started + days * DAY + hours * 3_600_000).toISOString();
  const dateOf = (days: number) => at(days).slice(0, 10);

  async function behind(number: number, result: string) {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${rule(number)}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return Object.fromEntries(
      (read.json() as RuleCoverageSubjectsResponse).subjects.map((item) => [item.subject.id, item]),
    );
  }

  /** Submits a source's report under the organization's own source, as a hand-written adapter would. */
  async function report(payload: Record<string, unknown>, occurredAt: string) {
    const artifact = await tenant.call(tenant.operator, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: 2,
    });
    expect(artifact.statusCode, artifact.body).toBe(201);
    const uploadId = artifact.json().upload.id as string;
    await tenant.call(tenant.operator, 'PUT', `/v1/uploads/${uploadId}/content`, Buffer.from('{}'), {
      'content-type': 'application/octet-stream',
    });
    const finalized = await tenant.call(tenant.operator, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const response = await tenant.call(tenant.operator, 'POST', '/v1/inputs', {
      sourceId: tenant.sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        ...payload,
        version: 1,
        occurredAt,
        fidelity: 'synthetic_contract',
        limitations: ['Invented for this test.'],
        originalArtifactId: finalized.json().artifact.id,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  beforeAll(async () => {
    registerStandardPacks({ examples: true });
    tenant = await coverageTenant('flown-values');
    const description = {
      pack: { id: `test-${process.pid}.waiver-ex-0121`, version: 1, title: 'Waiver EX-0121 (invented)' },
      source: { file: 'source.txt', kind: 'waiver', reference: 'Certificate of Waiver EX-0121' },
      waiver: {
        certificateNumber: 'EX-0121',
        effective: { from: dateOf(-60), through: dateOf(300) },
        conditionsCover: 'every flight',
      },
      provisions: [
        {
          number: 1,
          title: 'Wind at takeoff',
          quote: 'No flight takes off when the sustained wind at the launch site is above 11 meters per second.',
          obligation: 'weather.wind-at-takeoff',
          parameters: { maxMetersPerSecond: 11 },
        },
        {
          number: 2,
          title: 'Battery reserve',
          quote: 'Each flight lands with not less than 25 percent battery remaining.',
          obligation: 'condition.battery-at-landing',
          parameters: { minPercent: 25 },
        },
        {
          number: 3,
          title: 'Inspection',
          quote:
            'An aircraft is not flown after its next inspection is due, at a date or at a number of hours in service.',
          obligation: 'maintenance.inspection-due',
        },
      ],
    };
    pack = verifiedPackFile(buildPackFile(description as never, source).file).version;
    registerRulePack({ packId: pack.packId, versions: [pack] });
    // The records clerk may also submit what a source reports, under the organization's own source.
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.operator.id)}`,
    );
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.operator.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['operator.record', 'flight.report', 'weather.wind', 'battery.state'].map(
        (observationType) => ({ sourceId: tenant.sourceId, observationType }),
      ),
    });
    expect(granted.statusCode, granted.body).toBe(201);
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('checks the wind, battery and inspection limits from the flight log, and reads a report when there is one', async () => {
    await tenant.importRecords('aircraft.identity', [
      {
        subjectId: id('AC-1'),
        aircraftMakeModel: 'Fictional Quad 6',
        serialNumber: 'SN-1',
        registrationNumber: 'FICT-1',
      },
      {
        subjectId: id('AC-2'),
        aircraftMakeModel: 'Fictional Quad 6',
        serialNumber: 'SN-2',
        registrationNumber: 'FICT-2',
      },
    ]);
    // The aircraft's hours in service as of a day, from its logbook: a date with no time.
    await tenant.importRecords('aircraft.time-in-service', [
      {
        subjectId: id('AC-1'),
        entryKind: 'running_total',
        totalTimeHours: 314,
        coveredThroughAt: dateOf(-21),
        sourceReference: 'Logbook AC-1',
        coverage: 'complete',
        coverageNotes: 'Every flight since delivery.',
      },
    ]);
    // AC-1's next inspection is due at hours in service; AC-2's at a time that has passed.
    await tenant.importRecords('aircraft.inspection', [
      {
        subjectId: id('AC-1'),
        inspectionKind: 'scheduled',
        inspectedAt: dateOf(-25),
        'nextDueTimeInService [h]': '315.0',
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      },
      {
        subjectId: id('AC-2'),
        inspectionKind: 'scheduled',
        inspectedAt: at(-25),
        nextDueAt: at(-5),
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      },
    ]);
    const flights = [
      { flight: 'FLT-1', aircraft: 'AC-1', day: -15, wind: '26 kt', battery: '40', gust: '' },
      { flight: 'FLT-2', aircraft: 'AC-1', day: -10, wind: '5 m/s', battery: '17%', gust: '' },
      { flight: 'FLT-3', aircraft: 'AC-2', day: -3, wind: '5', battery: '50', gust: '' },
      { flight: 'FLT-4', aircraft: 'AC-1', day: -2, wind: '13', battery: '10', gust: '' },
    ];
    await tenant.importRecords(
      'flight.plan',
      flights.map((item) => ({
        subjectId: id(item.flight),
        secondarySubjectId: id(item.aircraft),
        windowStartsAt: at(item.day),
        windowEndsAt: at(item.day, 2),
        operationKind: 'inspection',
        plannedOriginDescription: 'North pad',
        plannedDestinationDescription: 'North pad',
        routeSummary: 'Fictional line survey',
        siteId: id('SITE-1'),
      })),
    );
    await tenant.importRecords(
      'flight.record',
      flights.map((item) => ({
        subjectId: id(item.flight),
        secondarySubjectId: id(item.aircraft),
        takeoffAt: at(item.day),
        landingAt: at(item.day, 1.5),
        takeoffLocation: 'North pad',
        landingLocations: 'North pad',
        maxHeightFlownAboveGroundMeters: 90,
        windAtTakeoffMetersPerSecond: item.wind,
        batteryAtLandingPercent: item.battery,
      })),
    );
    // FLT-4 also has a source's reports: its takeoff and landing, the wind measured at its site, and its battery.
    const flight4 = { kind: 'flight', id: id('FLT-4'), scope: 'source' };
    const aircraft1 = { kind: 'aircraft', id: id('AC-1'), scope: 'source' };
    await report(
      {
        type: 'flight.report',
        subject: flight4,
        secondarySubject: aircraft1,
        values: { activity: 'landed', takeoffAt: at(-2), landingAt: at(-2, 1.5) },
      },
      at(-2, 1.6),
    );
    await report(
      {
        type: 'weather.wind',
        subject: { kind: 'site', id: id('SITE-1'), scope: 'source' },
        values: { method: 'measured', speedMetersPerSecond: 6 },
      },
      at(-2, -0.1),
    );
    await report({ type: 'battery.state', subject: aircraft1, values: { totalRemainingPercent: 30 } }, at(-2, 1.49));

    adoptionId = await tenant.adopt(pack, 'active', { effectiveInterval: { start: at(-40), end: at(1) } });
    await tenant.settle();

    // Wind: FLT-1's logged 26 kt is above the limit, read from the flight record because nothing measured it.
    const windOver = await behind(1, 'attention');
    expect(Object.keys(windOver)).toEqual([id('FLT-1')]);
    expect(windOver[id('FLT-1')]!.evaluation!.summary).toBe(
      'No measured wind at the site is reported; the result rests on the operator’s own record. Read the wind at takeoff in the operator’s flight record: 13.38 m/s, outside the limit, at most 11 m/s.',
    );
    expect(windOver[id('FLT-1')]!.finding).toMatchObject({ status: 'open' });
    // FLT-4's wind was measured at the site: the report is read and the logged value named beside it.
    const windWithin = await behind(1, 'supported');
    expect(Object.keys(windWithin).sort()).toEqual([id('FLT-2'), id('FLT-3'), id('FLT-4')]);
    expect(windWithin[id('FLT-4')]!.evaluation!.summary).toContain(
      'The wind at takeoff in the operator’s flight record is 13 m/s; the reported value is read, not the recorded one.',
    );
    expect(windWithin[id('FLT-2')]!.evaluation!.summary).toContain('the result rests on the operator’s own record');

    // Battery: FLT-2 landed at 17 % by its log; FLT-4's logged 10 % is not read, its reported 30 % is.
    const batteryLow = await behind(2, 'attention');
    expect(Object.keys(batteryLow)).toEqual([id('FLT-2')]);
    expect(batteryLow[id('FLT-2')]!.evaluation!.summary).toBe(
      'No battery remaining is reported; the result rests on the operator’s own record. Read the battery remaining at landing in the operator’s flight record: 17 %, outside the limit, at least 25 %.',
    );
    expect(batteryLow[id('FLT-2')]!.finding).toMatchObject({ status: 'open' });
    expect((await behind(2, 'supported'))[id('FLT-4')]!.evaluation!.summary).toContain(
      'The battery remaining at landing in the operator’s flight record is 10 %; the reported value is read, not the recorded one.',
    );

    // Inspection: AC-1 passed its due hours during FLT-1 (314 h + 1.5 h), so FLT-2 and FLT-4 took off overdue; AC-2's
    // inspection was due at a time before FLT-3. FLT-4's hours count FLT-1 and FLT-2 from their records.
    const overdue = await behind(3, 'attention');
    expect(Object.keys(overdue).sort()).toEqual([id('FLT-2'), id('FLT-3'), id('FLT-4')]);
    expect(overdue[id('FLT-2')]!.evaluation!.summary).toBe(
      `${id('AC-1')} had 315.5 h in service at takeoff; the inspection recorded on ${dateOf(-25)} was due at 315 h.`,
    );
    expect(overdue[id('FLT-4')]!.evaluation!.summary).toContain(`${id('AC-1')} had 317 h in service at takeoff`);
    expect(overdue[id('FLT-3')]!.evaluation!.summary).toMatch(
      /^The inspection recorded at .+ was due by .+, before takeoff at .+\.$/,
    );
    expect(overdue[id('FLT-3')]!.finding).toMatchObject({ status: 'open' });
    expect((await behind(3, 'supported'))[id('FLT-1')]!.evaluation!.summary).toBe(
      `${id('AC-1')} had 314 h in service at takeoff; the inspection recorded on ${dateOf(-25)} is next due at 315 h, 1 h later.`,
    );
  }, 180_000);
});
