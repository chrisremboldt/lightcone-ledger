import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  flightTimeCsv,
  occurrencesCsv,
  zonedWallTime,
  type FlightTimeByAircraft,
  type OccurrencesByMonth,
  type PeriodSummary,
} from '../../packages/contracts/src/index.js';
import { monthBefore } from '../../packages/domain/src/reports.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

const ZONE = 'America/Chicago';
/** March 2025 in Chicago runs from 06:00 UTC on the 1st to 05:00 UTC on 1 April: the clocks change on the 9th. */
const MONTH = '2025-03';

/**
 * Two reports of a calendar month in the organization's time zone, from the operator records on file: flight time by
 * aircraft, and the occurrences recorded, by record type. A flight belongs to the month of its takeoff; what is not
 * on file is said, never left out; a person who may not read records is told so, never shown a zero.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Reports of a month, to prepare what an operator sends', () => {
  let tenant: CoverageTenant;
  let other: CoverageTenant;
  let reader: AuthContext;
  let safetyOnly: AuthContext;
  let neither: AuthContext;
  const started = Date.now();
  const id = (name: string) => `${tenant.prefix}-${name}`;

  async function person(on: CoverageTenant, key: string, name: string, capabilities: string[]): Promise<AuthContext> {
    const principal: AuthContext = {
      id: `${on.tenantId}:${key}`,
      tenantId: on.tenantId,
      name,
      kind: 'human',
      capabilities,
      revision: 1,
    };
    await on.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principal.id,
      on.tenantId,
      name,
      'human',
      capabilities,
    ]);
    await on.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${principal.id}`),
      principal.id,
    ]);
    return principal;
  }

  async function read<T>(on: CoverageTenant, who: AuthContext, url: string): Promise<T> {
    const response = await on.call(who, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  const flightTime = (on: CoverageTenant, who: AuthContext, month: string | null = MONTH) =>
    read<FlightTimeByAircraft>(on, who, `/v1/reports/flight-time${month ? `?month=${month}` : ''}`);
  const occurrences = (on: CoverageTenant, who: AuthContext, month: string | null = MONTH) =>
    read<OccurrencesByMonth>(on, who, `/v1/reports/occurrences${month ? `?month=${month}` : ''}`);

  const flown = (flight: string, aircraft: string | null, takeoffAt: string, landingAt?: string) => ({
    subjectId: id(flight),
    ...(aircraft ? { secondarySubjectId: id(aircraft) } : {}),
    takeoffAt,
    ...(landingAt ? { landingAt } : {}),
    takeoffLocation: 'Ridge road pullout',
    landingLocations: 'Ridge road pullout',
    maxHeightFlownAboveGroundMeters: 90,
  });
  /** A flight flown a minute ago: its month, in the organization's time zone, has an identity record by its end or not. */
  const recent = {
    takeoffAt: new Date(started - 120_000).toISOString().slice(0, 19) + 'Z',
    landingAt: new Date(started - 60_000).toISOString().slice(0, 19) + 'Z',
  };
  const monthOf = (instant: number | string) => zonedWallTime(instant, ZONE)!.slice(0, 7);

  beforeAll(async () => {
    tenant = await coverageTenant('month-reports');
    other = await coverageTenant('month-reports-other');
    for (const organization of [tenant, other])
      await organization.admin.query('UPDATE tenants SET time_zone=$2 WHERE id=$1', [organization.tenantId, ZONE]);
    reader = await person(tenant, 'reader', 'Riley Example', ['evidence:read', 'document:read']);
    safetyOnly = await person(tenant, 'safety', 'Sam Example', ['sms:read']);
    neither = await person(tenant, 'documents', 'Devon Example', ['document:read']);

    // One aircraft has an identity record; the other has none.
    await tenant.importRecords('aircraft.identity', [
      {
        subjectId: id('AC-1'),
        aircraftMakeModel: 'Example Survey Quad X8',
        serialNumber: 'XSQ8-0001',
        registrationNumber: 'RIDGE-REG-1',
      },
    ]);
    const [, , third] = await tenant.importRecords('flight.record', [
      // An hour, in the middle of the month.
      flown('FLT-1', 'AC-1', '2025-03-10T15:00:00Z', '2025-03-10T16:00:00Z'),
      // Across midnight at the month's end: 23:40 on 31 March to 00:25 on 1 April in Chicago. UTC calls it April.
      flown('FLT-2', 'AC-1', '2025-04-01T04:40:00Z', '2025-04-01T05:25:00Z'),
      // Recorded with the wrong landing, and corrected below.
      flown('FLT-3', 'AC-2', '2025-03-12T15:00:00Z', '2025-03-12T15:30:00Z'),
      // A takeoff and no landing time.
      flown('FLT-4', 'AC-2', '2025-03-15T15:00:00Z'),
      // 23:30 on 28 February in Chicago: February's flight, though UTC calls it March.
      flown('FLT-5', 'AC-1', '2025-03-01T05:30:00Z', '2025-03-01T05:50:00Z'),
      // A flight record that names no aircraft.
      flown('FLT-6', null, '2025-03-20T15:00:00Z', '2025-03-20T15:10:00Z'),
      flown('FLT-NOW', 'AC-1', recent.takeoffAt, recent.landingAt),
    ]);
    await tenant.importRecords('flight.record', [
      { ...flown('FLT-3', 'AC-2', '2025-03-12T15:00:00Z', '2025-03-12T15:20:30Z'), replaces: third },
    ]);

    const anomaly = (flight: string, aircraft: string | null, occurredAt: string, more: Record<string, unknown>) => ({
      subjectId: id(flight),
      subjectKind: 'flight',
      ...(aircraft ? { secondarySubjectId: id(aircraft), secondarySubjectKind: 'aircraft' } : {}),
      occurredAt,
      ...more,
    });
    await tenant.importRecords('occurrence.operation-anomaly', [
      anomaly('FLT-1', 'AC-1', '2025-03-10T15:30:00Z', {
        summary: 'Landed at the north pad after a link warning',
        interruptionKind: 'landing_away',
      }),
      // 23:50 on 31 March in Chicago.
      anomaly('FLT-2', null, '2025-04-01T04:50:00Z', { summary: 'Held over the ridge for a passing helicopter' }),
      // April, in either zone.
      anomaly('FLT-2', null, '2025-04-02T15:00:00Z', { summary: 'A fictional anomaly of the next month' }),
    ]);
    await tenant.importRecords('occurrence.mechanical-irregularity', [
      {
        subjectId: id('AC-2'),
        subjectKind: 'aircraft',
        secondarySubjectId: id('NORTH-PAD'),
        secondarySubjectKind: 'site',
        // The log kept only the days.
        occurredAt: '2025-03-12',
        irregularityDescription: 'Motor three ran warm',
        correctiveAction: 'Replaced the motor',
        lossOfControlOrCommunication: 'no',
        reportedToManufacturerAt: '2025-03-13',
      },
    ]);
    // A safety report is no occurrence record: nothing of it may appear in either report.
    const reported = await tenant.call(tenant.actor, 'POST', '/v1/safety-reports', {
      whatWasSeen: 'A fictional near miss near the north ridge',
      named: false,
    });
    expect(reported.statusCode, reported.body).toBe(201);
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix, other?.prefix].filter(Boolean) as string[]);
    await tenant?.close();
    await other?.close();
  });

  it('adds up each aircraft’s flights of the month in the organization’s time zone', async () => {
    const report = await flightTime(tenant, tenant.actor);
    expect(report.period).toEqual({
      month: MONTH,
      from: '2025-03-01',
      until: '2025-03-31',
      timeZone: ZONE,
      start: '2025-03-01T06:00:00.000Z',
      end: '2025-04-01T05:00:00.000Z',
      ended: true,
    });
    if (!report.flights.readable) throw new Error('flights unreadable');
    expect(report.flights.aircraft).toEqual([
      {
        aircraftId: id('AC-1'),
        // Recorded today, after March ended: the report says so.
        identity: { registrationNumber: 'RIDGE-REG-1', serialNumber: 'XSQ8-0001', recordedAfterMonth: true },
        flights: 2,
        flightSeconds: 3600 + 2700,
        withoutTime: 0,
      },
      // The corrected landing counts, the replaced one does not; the flight with no landing adds no time.
      { aircraftId: id('AC-2'), identity: null, flights: 2, flightSeconds: 1230, withoutTime: 1 },
      { aircraftId: null, identity: null, flights: 1, flightSeconds: 600, withoutTime: 0 },
    ]);
    expect(report.flights.withoutTime).toEqual([
      {
        aircraftId: id('AC-2'),
        flightId: id('FLT-4'),
        takeoffAt: '2025-03-15T15:00:00.000Z',
        reason: 'no_landing_time',
      },
    ]);
    expect(report.flights.withoutTimeTruncated).toBe(false);
    expect(report.flights.total).toEqual({ aircraft: 2, flights: 5, flightSeconds: 8130, withoutTime: 1 });
    expect(JSON.stringify(report)).not.toContain('near miss');
  });

  it('counts the same flights and time as the summary of the same days', async () => {
    const report = await flightTime(tenant, tenant.actor);
    const summary = await read<PeriodSummary>(
      tenant,
      tenant.actor,
      '/v1/reports/summary?from=2025-03-01&until=2025-03-31',
    );
    if (!report.flights.readable || !summary.flights.readable) throw new Error('flights unreadable');
    expect(summary.flights).toMatchObject({
      flights: report.flights.total.flights,
      flightSeconds: report.flights.total.flightSeconds,
      withoutDuration: report.flights.total.withoutTime,
    });
  });

  it('puts a flight in the month of its takeoff, and says a month with no flight has none', async () => {
    const february = await flightTime(tenant, tenant.actor, '2025-02');
    if (!february.flights.readable) throw new Error('flights unreadable');
    expect(february.flights.aircraft.map((aircraft) => [aircraft.aircraftId, aircraft.flights])).toEqual([
      [id('AC-1'), 1],
    ]);
    expect(february.flights.total).toMatchObject({ flights: 1, flightSeconds: 1200 });
    // The flight across midnight took off in March: April has none of it.
    const april = await flightTime(tenant, tenant.actor, '2025-04');
    expect(april.flights).toMatchObject({ readable: true, aircraft: [], total: { aircraft: 0, flights: 0 } });
  });

  it('reads an identity record on file by the end of the month as that month’s', async () => {
    const month = monthOf(recent.takeoffAt);
    const report = await flightTime(tenant, tenant.actor, month);
    if (!report.flights.readable) throw new Error('flights unreadable');
    expect(report.flights.aircraft).toEqual([
      {
        aircraftId: id('AC-1'),
        identity: {
          registrationNumber: 'RIDGE-REG-1',
          serialNumber: 'XSQ8-0001',
          // Only when the month turned between the flight and the import was the record made after the flight's month.
          recordedAfterMonth: month !== monthOf(started),
        },
        flights: 1,
        flightSeconds: 60,
        withoutTime: 0,
      },
    ]);
  });

  it('takes the last whole month when none is asked for', async () => {
    const report = await flightTime(tenant, tenant.actor, null);
    expect(report.period.month).toBe(monthBefore(monthOf(Date.parse(report.computedAt)), 1));
    expect(report.period.ended).toBe(true);
    expect((await occurrences(tenant, tenant.actor, null)).period.month).toBe(report.period.month);
  });

  it('lists the month’s occurrences by record type, each with its day, flight, aircraft and own fields', async () => {
    const report = await occurrences(tenant, tenant.actor);
    expect(report.period).toMatchObject({ month: MONTH, timeZone: ZONE, ended: true });
    if (!report.occurrences.readable) throw new Error('occurrences unreadable');
    const counts = Object.fromEntries(report.occurrences.types.map((type) => [type.recordType, type.count]));
    // Every occurrence type the organization has is listed, those with none on file for the month too.
    expect(counts).toEqual({
      'occurrence.accident': 0,
      'occurrence.emergency-deviation': 0,
      'occurrence.mechanical-irregularity': 1,
      'occurrence.operation-anomaly': 2,
      'occurrence.property-or-area': 0,
      'occurrence.security': 0,
    });
    expect(report.occurrences).toMatchObject({ total: 3, truncated: false });
    const titles = report.occurrences.types.map((type) => type.title);
    expect(titles).toEqual([...titles].sort((left, right) => left.localeCompare(right)));

    const anomalies = report.occurrences.types.find((type) => type.recordType === 'occurrence.operation-anomaly')!;
    expect(anomalies).toMatchObject({ recordVersion: 1, title: 'Operation anomaly' });
    expect(anomalies.occurrences).toEqual([
      {
        recordId: expect.any(String),
        occurredAt: '2025-03-10T15:30:00.000Z',
        occurredOn: '2025-03-10',
        dateOnly: false,
        flightId: id('FLT-1'),
        aircraftId: id('AC-1'),
        about: [],
        fields: [
          { name: 'summary', label: 'What happened', value: 'Landed at the north pad after a link warning' },
          {
            name: 'interruptionKind',
            label: 'Interruption',
            value: 'Unplanned or precautionary landing away from the normal landing location',
          },
        ],
      },
      {
        recordId: expect.any(String),
        occurredAt: '2025-04-01T04:50:00.000Z',
        // The last day of March in Chicago.
        occurredOn: '2025-03-31',
        dateOnly: false,
        flightId: id('FLT-2'),
        aircraftId: null,
        about: [],
        fields: [{ name: 'summary', label: 'What happened', value: 'Held over the ridge for a passing helicopter' }],
      },
    ]);
    const irregularities = report.occurrences.types.find(
      (type) => type.recordType === 'occurrence.mechanical-irregularity',
    )!;
    expect(irregularities.occurrences).toHaveLength(1);
    expect(irregularities.occurrences[0]).toMatchObject({
      occurredOn: '2025-03-12',
      dateOnly: true,
      flightId: null,
      aircraftId: id('AC-2'),
      about: [{ kind: 'site', id: id('NORTH-PAD') }],
    });
    expect(irregularities.occurrences[0]!.fields).toEqual([
      { name: 'irregularityDescription', label: 'Irregularity', value: 'Motor three ran warm' },
      { name: 'correctiveAction', label: 'Corrective action', value: 'Replaced the motor' },
      { name: 'lossOfControlOrCommunication', label: 'Caused a loss of control or communication', value: 'No' },
      // A time given as a date alone is that date, never a midnight.
      { name: 'reportedToManufacturerAt', label: 'Reported to the manufacturer at', value: '2025-03-13' },
    ]);
    // Nothing of the safety report, and April's anomaly is April's.
    expect(JSON.stringify(report)).not.toContain('near miss');
    expect(JSON.stringify(report)).not.toContain('next month');
    const april = await occurrences(tenant, tenant.actor, '2025-04');
    expect(april.occurrences).toMatchObject({ readable: true, total: 1 });
  });

  it('writes each report as one table, with decimal hours beside the exact seconds', async () => {
    const flights = await flightTime(tenant, tenant.actor);
    if (!flights.flights.readable) throw new Error('flights unreadable');
    expect(flightTimeCsv(flights.period, flights.flights).split('\r\n')).toEqual([
      'month,timeZone,aircraftId,registrationNumber,serialNumber,flights,flightHours,flightSeconds,flightsWithoutTime,notes',
      `2025-03,${ZONE},${id('AC-1')},RIDGE-REG-1,XSQ8-0001,2,1.8,6300,0,Identity record recorded after the month ended.`,
      `2025-03,${ZONE},${id('AC-2')},,,2,0.3,1230,1,Aircraft: no identity record on file. Flight ${id('FLT-4')}: no landing time on file.`,
      `2025-03,${ZONE},,,,1,0.2,600,0,Flight records that name no aircraft.`,
      '',
    ]);
    const listed = await occurrences(tenant, tenant.actor);
    if (!listed.occurrences.readable) throw new Error('occurrences unreadable');
    const [header, ...rows] = occurrencesCsv(listed.period, listed.occurrences).trimEnd().split('\r\n');
    expect(header).toBe(
      'month,timeZone,recordType,recordVersion,type,occurredOn,occurredAtLocal,flightId,aircraftId,alsoAbout,irregularityDescription,correctiveAction,lossOfControlOrCommunication,reportedToManufacturerAt,summary,interruptionKind,recordId',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(
      `2025-03,${ZONE},occurrence.mechanical-irregularity,1,Mechanical irregularity,2025-03-12,,,${id('AC-2')},site ${id('NORTH-PAD')},Motor three ran warm,Replaced the motor,No,2025-03-13,,,`,
    );
  });

  it('names the part as not theirs to a person who may not read flights, never as zero', async () => {
    const asReader = await flightTime(tenant, reader);
    expect(asReader.flights).toMatchObject({ readable: true, total: { flights: 5 } });
    expect((await occurrences(tenant, reader)).occurrences).toMatchObject({ readable: true, total: 3 });
    const asSafety = await flightTime(tenant, safetyOnly);
    expect(asSafety.period.month).toBe(MONTH);
    expect(asSafety.flights).toEqual({ readable: false, capability: 'evidence:read' });
    expect((await occurrences(tenant, safetyOnly)).occurrences).toEqual({
      readable: false,
      capability: 'evidence:read',
    });
    for (const url of ['/v1/reports/flight-time', '/v1/reports/occurrences'])
      expect((await tenant.call(neither, 'GET', url)).statusCode, url).toBe(403);
  });

  it('never counts another organization’s records', async () => {
    const elsewhere = await flightTime(other, other.actor);
    expect(elsewhere.flights).toMatchObject({ readable: true, aircraft: [], withoutTime: [], total: { flights: 0 } });
    const listed = await occurrences(other, other.actor);
    expect(listed.occurrences).toMatchObject({ readable: true, total: 0 });
    expect(JSON.stringify([elsewhere, listed])).not.toContain(tenant.prefix);
  });

  it('refuses a month that is not one', async () => {
    for (const query of ['month=2025-13', 'month=2025-3', 'month=March', 'month=0000-01'])
      for (const path of ['/v1/reports/flight-time', '/v1/reports/occurrences'])
        expect((await tenant.call(tenant.actor, 'GET', `${path}?${query}`)).statusCode, `${path}?${query}`).toBe(400);
  });
});
