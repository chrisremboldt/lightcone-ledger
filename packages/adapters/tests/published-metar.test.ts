import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance, loadGoldenFiles } from '../src/conformance.js';
import {
  type MetarBinding,
  MetarRefusal,
  metarTime,
  parseMetarStations,
  publishedMetarAdapter,
  publishedMetarDescriptor,
  readMetar,
  readVisibilityGroups,
  readWindGroup,
  translatePublishedMetar,
} from '../src/published-metar.js';
import { jsonArrayElements, ServicePoll } from '../src/source-transports.js';
import { answerMetarRequest, recordedMetarReports } from '../../../apps/emulators/src/metar.js';
import { createEmulator, emulatorConfig } from '../../../apps/emulators/src/server.js';

const goldenDirectory = join(import.meta.dirname, '../src/golden/published-metar-observations');
const binding: MetarBinding = {
  stations: {
    KORD: [{ siteId: 'RIDGE-SITE-1', distanceMeters: 14200 }],
    KLAX: [{ siteId: 'RIDGE-SITE-3' }],
    KLAS: [{ siteId: 'RIDGE-SITE-4', distanceMeters: 800 }],
    KMIA: [{ siteId: 'RIDGE-SITE-5', distanceMeters: 9600 }],
    EGLL: [{ siteId: 'RIDGE-SITE-6' }],
    LFPG: [{ siteId: 'RIDGE-SITE-7', distanceMeters: 5000 }],
    UUEE: [{ siteId: 'RIDGE-SITE-8' }],
    EDDF: [{ siteId: 'RIDGE-SITE-9', distanceMeters: 12500 }],
    ZZZZ: [{ siteId: 'RIDGE-SITE-10' }],
  },
};
const context: TranslationContext<MetarBinding> = { subjects: { scope: 'source' }, binding };
const fetchedAt = '2026-11-25T19:17:31.000Z';
const knots = (value: number) => (value * 1852) / 3600;
const MILE = 1609.344;
const message = (body: unknown, capturedAt = fetchedAt): VendorMessage => ({
  bytes: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
  contentType: 'application/json',
  transport: { method: 'GET', path: '/api/data/metar' },
  capturedAt,
});
const wind = (group: string) => {
  const reading = readWindGroup(group);
  return 'values' in reading ? reading.values : reading.notRead;
};
const visibility = (...groups: string[]) => {
  const { reading } = readVisibilityGroups(groups);
  return 'values' in reading ? reading.values : reading.notRead;
};

describe('published METAR adapter on the contract', () => {
  it('passes the conformance kit against its golden files, most of them reports fetched from the service', async () => {
    const report = await assertAdapterConformance({
      adapter: publishedMetarAdapter,
      context,
      goldenDirectory,
      vendorTerms: ['aviation weather center', 'aviationweather', 'noaa'],
    });
    expect(report.checked).toMatchObject({ goldens: 19, observations: 25 });
  });

  it('serves every fetched golden report from the emulator’s recordings, byte for byte', () => {
    const recorded = new Set(recordedMetarReports());
    const fetched = loadGoldenFiles(goldenDirectory).filter((golden) =>
      String((golden as { note?: string }).note).startsWith('Fetched'),
    );
    expect(fetched.length).toBeGreaterThanOrEqual(12);
    for (const golden of fetched) expect(recorded.has(golden.message.bodyText!), golden.name).toBe(true);
  });

  it('reads the wind group in each form, and refuses to guess', () => {
    expect(wind('06018G25KT')).toEqual({
      method: 'measured',
      speedMetersPerSecond: knots(18),
      gustSpeedMetersPerSecond: knots(25),
      directionFromDegrees: 60,
    });
    expect(wind('33007G15MPS')).toEqual({
      method: 'measured',
      speedMetersPerSecond: 7,
      gustSpeedMetersPerSecond: 15,
      directionFromDegrees: 330,
    });
    expect(wind('VRB03KT')).toEqual({ method: 'measured', speedMetersPerSecond: knots(3), directionVariable: true });
    expect(wind('00000KT')).toEqual({ method: 'measured', speedMetersPerSecond: 0 });
    expect(wind('36010KT')).toMatchObject({ directionFromDegrees: 0 });
    expect(wind('270105KT')).toMatchObject({ directionFromDegrees: 270, speedMetersPerSecond: knots(105) });
    expect(wind('27105KT')).toMatchObject({ directionFromDegrees: 271, speedMetersPerSecond: knots(5) });
    expect(readWindGroup('///08KT')).toEqual({
      values: { method: 'measured', speedMetersPerSecond: knots(8) },
      notes: ['The station did not report the wind direction (///08KT).'],
    });
    expect(wind('/////KT')).toBe('The station reported no wind (/////KT)');
    expect(wind('/////')).toBe('The station reported no wind (/////)');
    expect(wind('27010KMH')).toBe('The wind group 27010KMH could not be read');
    expect(wind('27010G08KT')).toMatch(/gust no higher than the speed/);
    expect(wind('37010KT')).toMatch(/above 360 degrees/);
    expect(wind('00010KT')).toMatch(/direction of 000 with a speed/);
    expect(wind('27000KT')).toMatch(/speed of 0 with a direction/);
  });

  it('reads the visibility in miles, fractions, metres and CAVOK, with its bound', () => {
    expect(visibility('10SM')).toEqual({ method: 'observed', visibilityMeters: 10 * MILE, bound: 'stated' });
    expect(visibility('1/2SM')).toEqual({ method: 'observed', visibilityMeters: 0.5 * MILE, bound: 'stated' });
    expect(visibility('1', '1/2SM')).toEqual({ method: 'observed', visibilityMeters: 1.5 * MILE, bound: 'stated' });
    expect(visibility('2', '1/2SM', 'RA')).toEqual({
      method: 'observed',
      visibilityMeters: 2.5 * MILE,
      bound: 'stated',
    });
    expect(visibility('M1/4SM')).toEqual({ method: 'observed', visibilityMeters: 0.25 * MILE, bound: 'less_than' });
    expect(visibility('P6SM')).toEqual({ method: 'observed', visibilityMeters: 6 * MILE, bound: 'at_least' });
    expect(visibility('1800')).toEqual({ method: 'observed', visibilityMeters: 1800, bound: 'stated' });
    expect(visibility('4000NDV')).toEqual({ method: 'observed', visibilityMeters: 4000, bound: 'stated' });
    expect(visibility('9999')).toEqual({ method: 'observed', visibilityMeters: 10_000, bound: 'at_least' });
    expect(visibility('0000')).toEqual({ method: 'observed', visibilityMeters: 50, bound: 'less_than' });
    expect(visibility('CAVOK')).toEqual({ method: 'observed', visibilityMeters: 10_000, bound: 'at_least' });
    expect(readVisibilityGroups(['2', '1/2SM']).used).toBe(2);
    expect(visibility('////')).toBe('The station reported no visibility (////)');
    expect(visibility('3/3SM')).toBe('The visibility group 3/3SM could not be read');
    expect(visibility('1', '5/3SM')).toBe('The visibility group 1 5/3SM could not be read');
    expect(visibility('99SM')).toMatch(/states more than 100000 m/);
    expect(visibility('BKN020')).toBe('The visibility group BKN020 could not be read');
    expect(visibility()).toBe('The report ends before its visibility group');
  });

  it('rolls the report’s day of month against the fetch time, and refuses a time it cannot place', () => {
    expect(metarTime('251851Z', '2026-11-25T19:17:31.000Z')).toBe('2026-11-25T18:51:00.000Z');
    expect(metarTime('302355Z', '2026-12-01T00:05:00.000Z')).toBe('2026-11-30T23:55:00.000Z');
    expect(metarTime('312350Z', '2027-01-01T00:10:00.000Z')).toBe('2026-12-31T23:50:00.000Z');
    expect(metarTime('010005Z', '2026-12-01T00:04:00.000Z')).toBe('2026-12-01T00:05:00.000Z');
    expect(() => metarTime('312350Z', '2026-03-01T00:10:00.000Z')).toThrow(/a day the month before the fetch does not/);
    expect(() => metarTime('252100Z', '2026-11-25T19:17:31.000Z')).toThrow(/more than an hour after/);
    expect(() => metarTime('252460Z', '2026-11-25T19:17:31.000Z')).toThrow(/not a day, hour and minute/);
    expect(() => metarTime('2518Z', '2026-11-25T19:17:31.000Z')).toThrow(MetarRefusal);
  });

  it('reads the AUTO, COR and NIL marks wherever the report places them', () => {
    expect(readMetar('METAR COR KLAX 251653Z VRB03KT 10SM', fetchedAt)).toMatchObject({
      reportType: 'METAR',
      corrected: true,
      automated: false,
    });
    expect(readMetar('METAR EGLL 251550Z COR AUTO 06012KT 9999 OVC025', fetchedAt)).toMatchObject({
      corrected: true,
      automated: true,
      wind: { values: { directionFromDegrees: 60 } },
      visibility: { values: { visibilityMeters: 10_000, bound: 'at_least' } },
    });
    expect(readMetar('ZZZZ 251855Z 27010KT 3SM=', fetchedAt)).toMatchObject({
      station: 'ZZZZ',
      visibility: { values: { visibilityMeters: 3 * MILE } },
    });
    expect(() => readMetar('METAR ZZZZ 251855Z AUTO NIL', fetchedAt)).toThrow(/is NIL/);
    expect(() => readMetar('METAR 251855Z 27010KT 10SM', fetchedAt)).toThrow(/does not begin with a station/);
  });

  it('reports a missing or unreadable group with its text and still carries the groups it read', () => {
    const noWindGroup = readMetar('METAR ZZZZ 251855Z 10SM CLR', fetchedAt);
    expect(noWindGroup.wind).toEqual({ notRead: 'The report has no wind group: 10SM stands in its place' });
    expect(noWindGroup.visibility).toMatchObject({ values: { visibilityMeters: 10 * MILE } });
    const badRange = readMetar('METAR ZZZZ 251855Z 27010KT 270V270 10SM', fetchedAt);
    expect(badRange.wind).toEqual({
      values: { method: 'measured', speedMetersPerSecond: knots(10), directionFromDegrees: 270 },
      notes: ['The wind direction range 270V270 could not be read; the wind is carried without it.'],
    });
    const result = translatePublishedMetar(
      message({ icaoId: 'ZZZZ', rawOb: 'METAR ZZZZ 251855Z 27010KMH ////' }),
      context,
    );
    expect(result.drafts).toEqual([]);
    expect(result.rejections).toEqual([
      { reason: 'The wind group 27010KMH could not be read', locator: { kind: 'json_pointer', value: '/rawOb' } },
      { reason: 'The station reported no visibility (////)', locator: { kind: 'json_pointer', value: '/rawOb' } },
    ]);
  });

  it('reads the station-to-site configuration, with distances in m or km', () => {
    expect(parseMetarStations('KORD=RIDGE-SITE-1@14.2km; KORD=RIDGE-SITE-2;KMDW=RIDGE-SITE-3@800m')).toEqual({
      stations: {
        KORD: [{ siteId: 'RIDGE-SITE-1', distanceMeters: 14_200 }, { siteId: 'RIDGE-SITE-2' }],
        KMDW: [{ siteId: 'RIDGE-SITE-3', distanceMeters: 800 }],
      },
    });
    expect(() => parseMetarStations('')).toThrow(/at least one station/);
    expect(() => parseMetarStations('kord=RIDGE-SITE-1')).toThrow(/not a station identifier/);
    expect(() => parseMetarStations('KORD=RIDGE-SITE-1@14mi')).toThrow(/STATION=SITE@DISTANCE/);
    expect(() => parseMetarStations('KORD=RIDGE-SITE-1;KORD=RIDGE-SITE-1@3km')).toThrow(/named twice/);
  });

  it('cuts each report from the service’s array exactly as sent', () => {
    const text = '[{"a":"x],{\\"y\\"}","b":[1,{"c":2}]} , {"d":"\\\\"}]';
    expect(jsonArrayElements(new TextEncoder().encode(text))!.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      '{"a":"x],{\\"y\\"}","b":[1,{"c":2}]}',
      '{"d":"\\\\"}',
    ]);
    expect(jsonArrayElements(new TextEncoder().encode('[]'))).toEqual([]);
    expect(jsonArrayElements(new TextEncoder().encode('{"a":1}'))).toBeUndefined();
    expect(jsonArrayElements(new TextEncoder().encode('[1,'))).toBeUndefined();
  });

  it('answers as the service does: the latest report per station, or the hours asked for, and 204 for none', () => {
    const reports = recordedMetarReports();
    const now = '2026-11-25T19:17:31.000Z';
    const latest = answerMetarRequest(reports, new URLSearchParams('ids=KORD,UUEE&format=json'), now);
    expect(latest.status).toBe(200);
    expect((JSON.parse(latest.body) as { rawOb: string }[]).map((report) => report.rawOb)).toEqual([
      'METAR UUEE 251900Z 33007G15MPS 9999 -SN OVC010 M03/M05 Q1007 R06R/590340 R06C/590340 NOSIG',
      'METAR KORD 251851Z 06018G25KT 10SM OVC028 04/M02 A3042 RMK AO2 SLP308 T00441022',
    ]);
    const earlier = answerMetarRequest(
      reports,
      new URLSearchParams('ids=KORD&format=json&hours=1'),
      '2026-11-25T18:00:00Z',
    );
    expect((JSON.parse(earlier.body) as { rawOb: string }[]).map((report) => report.rawOb.split(' ')[2])).toEqual([
      '251751Z',
    ]);
    expect(answerMetarRequest(reports, new URLSearchParams('ids=KXYZ&format=json'), now)).toEqual({
      status: 204,
      body: '',
    });
    expect(answerMetarRequest(reports, new URLSearchParams('ids=KORD&format=raw'), now).status).toBe(400);
    expect(answerMetarRequest(reports, new URLSearchParams('ids=KORD&format=json&taf=true'), now).status).toBe(400);
  });

  it('names the service in its descriptor but not in what it puts into observations', () => {
    expect(publishedMetarDescriptor.id).toBe('published-metar-observations');
    expect(publishedMetarDescriptor.fidelity).toBe('captured_source_replay');
    expect(publishedMetarDescriptor.limitations.join(' ')).not.toMatch(/aviation weather center|aviationweather|noaa/i);
  });
});

describe('published METAR adapter against the emulator', () => {
  const config = { ...emulatorConfig({}), port: 0 };
  const { server } = createEmulator(config);
  let base: string;
  const admin = { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json' };
  const setClock = async (now: string) => {
    const response = await fetch(`${base}/_simulation/clock`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ now }),
    });
    expect(response.status).toBe(200);
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('polls the stations, submits each report’s observations once, and hands over only reports it has not seen', async () => {
    await setClock('2026-11-25T18:00:00Z');
    const received: VendorMessage[][] = [];
    let requests = 0;
    // The source clock moves on between the first read and the second, past one new report of KORD and of EGLL.
    const fetcher: typeof fetch = async (input, init) => {
      if (requests++ === 1) await setClock('2026-11-25T18:52:00Z');
      return fetch(input, init);
    };
    const poll = new ServicePoll(
      {
        url: `${base}/api/data/metar?ids=KORD,KLAX,EGLL&format=json`,
        headers: { 'user-agent': 'ledger-adapter-test' },
        intervalMs: 5,
        split: jsonArrayElements,
        fetcher,
      },
      async (item) => {
        (received[poll.polls - 1] ??= []).push(item);
      },
    );
    void poll.start();
    for (let attempt = 0; attempt < 500 && poll.polls < 3; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await poll.stop();
    const stations = (items: VendorMessage[] = []) =>
      items.map((item) => (JSON.parse(new TextDecoder().decode(item.bytes)) as { rawOb: string }).rawOb.split(' ')[1]);
    expect(stations(received[0])).toEqual(['KLAX', 'KORD', 'EGLL']);
    expect(stations(received[1])).toEqual(['KORD', 'EGLL']);
    expect(received[2]).toBeUndefined();
    expect(poll.unchanged).toBeGreaterThanOrEqual(1);

    const sink = new InMemoryObservationSink();
    const first = [];
    for (const item of received[0]!) first.push(await translateAndSubmit(publishedMetarAdapter, item, context, sink));
    expect(first.flatMap((outcome) => outcome.rejections)).toEqual([]);
    expect(sink.observations).toHaveLength(6);
    const ord = sink.observations.find(
      (entry) => entry.observation.type === 'weather.wind' && entry.observation.subject.id === 'RIDGE-SITE-1',
    )!.observation;
    expect(ord).toMatchObject({
      subject: { kind: 'site', id: 'RIDGE-SITE-1', scope: 'source' },
      occurredAt: '2026-11-25T17:51:00.000Z',
      fidelity: 'captured_source_replay',
      values: { speedMetersPerSecond: knots(17), gustSpeedMetersPerSecond: knots(25), directionFromDegrees: 70 },
    });
    expect(ord.limitations).toContain(
      'Reported by station KORD for the site RIDGE-SITE-1, 14.2 km from the site as configured.',
    );
    // The retained original is the report's own object as the emulator sent it.
    expect(new TextDecoder().decode(sink.originals.get(ord.originalArtifactId)!.bytes)).toBe(
      recordedMetarReports().find((text) => text.includes('"METAR KORD 251751Z')),
    );
    // The same reports submitted again change nothing; the newer ones add theirs.
    for (const item of received[0]!) await translateAndSubmit(publishedMetarAdapter, item, context, sink);
    expect(sink.observations).toHaveLength(6);
    for (const item of received[1]!) await translateAndSubmit(publishedMetarAdapter, item, context, sink);
    expect(sink.observations).toHaveLength(10);
  });
});
