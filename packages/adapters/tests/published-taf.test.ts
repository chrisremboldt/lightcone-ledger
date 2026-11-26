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
import type { MetarBinding } from '../src/published-metar.js';
import { publishedTafAdapter, publishedTafDescriptor, readTaf, tafDayHour } from '../src/published-taf.js';
import { jsonArrayElements, ServicePoll } from '../src/source-transports.js';
import { answerTafRequest, recordedTafForecasts } from '../../../apps/emulators/src/taf.js';
import { createEmulator, emulatorConfig } from '../../../apps/emulators/src/server.js';

const goldenDirectory = join(import.meta.dirname, '../src/golden/published-taf-forecasts');
const binding: MetarBinding = {
  stations: {
    KORD: [{ siteId: 'RIDGE-SITE-1', distanceMeters: 14200 }],
    EGLL: [{ siteId: 'RIDGE-SITE-6' }],
    KLAX: [{ siteId: 'RIDGE-SITE-3' }],
    UUEE: [{ siteId: 'RIDGE-SITE-8' }],
    CYYZ: [{ siteId: 'RIDGE-SITE-11', distanceMeters: 3000 }],
    LEMD: [{ siteId: 'RIDGE-SITE-12' }],
    KJFK: [{ siteId: 'RIDGE-SITE-13', distanceMeters: 21000 }],
    SBGR: [{ siteId: 'RIDGE-SITE-14' }],
    RJTT: [{ siteId: 'RIDGE-SITE-15' }],
    ZZZZ: [{ siteId: 'RIDGE-SITE-10' }],
  },
};
const context: TranslationContext<MetarBinding> = { subjects: { scope: 'source' }, binding };
const fetchedAt = '2026-11-26T04:33:53.000Z';
const knots = (value: number) => (value * 1852) / 3600;
const MILE = 1609.344;

describe('published TAF adapter on the contract', () => {
  it('passes the conformance kit against its golden files, most of them forecasts fetched from the service', async () => {
    const report = await assertAdapterConformance({
      adapter: publishedTafAdapter,
      context,
      goldenDirectory,
      vendorTerms: ['aviation weather center', 'aviationweather', 'noaa'],
    });
    expect(report.checked).toMatchObject({ goldens: 17, observations: 10 });
  });

  it('serves every fetched golden forecast from the emulator’s recordings, byte for byte', () => {
    const recorded = new Set(recordedTafForecasts());
    const fetched = loadGoldenFiles(goldenDirectory).filter((golden) =>
      String((golden as { note?: string }).note).startsWith('Fetched'),
    );
    expect(fetched).toHaveLength(9);
    for (const golden of fetched) expect(recorded.has(golden.message.bodyText!), golden.name).toBe(true);
  });

  it('reads the validity and each change group of a recorded forecast as the forecast gives them', () => {
    const forecast = readTaf(
      'TAF KORD 260259Z 2603/2706 06014G21KT P6SM SCT030 BKN035 OVC060 FM260600 05013KT P6SM FEW025 SCT035 OVC100 FM270100 01018G28KT 5SM -SHRA BKN015 OVC035',
      fetchedAt,
    );
    expect(forecast).toMatchObject({
      station: 'KORD',
      issuedAt: '2026-11-26T02:59:00.000Z',
      validFrom: '2026-11-26T03:00:00.000Z',
      validTo: '2026-11-27T06:00:00.000Z',
      notRead: [],
    });
    expect(forecast.periods).toEqual([
      {
        change: 'base',
        startAt: '2026-11-26T03:00:00.000Z',
        endAt: '2026-11-26T06:00:00.000Z',
        text: '06014G21KT P6SM SCT030 BKN035 OVC060',
        wind: { speedMetersPerSecond: knots(14), gustSpeedMetersPerSecond: knots(21), directionFromDegrees: 60 },
        visibility: { visibilityMeters: 6 * MILE, bound: 'at_least' },
      },
      {
        change: 'from',
        startAt: '2026-11-26T06:00:00.000Z',
        endAt: '2026-11-27T01:00:00.000Z',
        text: 'FM260600 05013KT P6SM FEW025 SCT035 OVC100',
        wind: { speedMetersPerSecond: knots(13), directionFromDegrees: 50 },
        visibility: { visibilityMeters: 6 * MILE, bound: 'at_least' },
      },
      {
        change: 'from',
        startAt: '2026-11-27T01:00:00.000Z',
        endAt: '2026-11-27T06:00:00.000Z',
        text: 'FM270100 01018G28KT 5SM -SHRA BKN015 OVC035',
        wind: { speedMetersPerSecond: knots(18), gustSpeedMetersPerSecond: knots(28), directionFromDegrees: 10 },
        visibility: { visibilityMeters: 5 * MILE, bound: 'stated' },
      },
    ]);
  });

  it('keeps temporary, probability and becoming groups apart, and reads only their own groups', () => {
    const forecast = readTaf(
      'TAF LEMD 252300Z 2600/2706 VRB04KT CAVOK TX11/2614Z TNM03/2705Z PROB40 TEMPO 2603/2611 3000 BR BCFG BKN004 BECMG 2618/2620 2 1/2SM',
      '2026-11-26T04:33:53.000Z',
    );
    expect(forecast.periods.map((period) => [period.change, period.probabilityPercent, period.startAt])).toEqual([
      ['base', undefined, '2026-11-26T00:00:00.000Z'],
      ['probability_temporary', 40, '2026-11-26T03:00:00.000Z'],
      ['becoming', undefined, '2026-11-26T18:00:00.000Z'],
    ]);
    expect(forecast.periods[0]).toMatchObject({
      endAt: '2026-11-27T06:00:00.000Z',
      wind: { speedMetersPerSecond: knots(4), directionVariable: true },
      visibility: { visibilityMeters: 10_000, bound: 'at_least' },
    });
    expect(forecast.periods[1]).toMatchObject({
      endAt: '2026-11-26T11:00:00.000Z',
      visibility: { visibilityMeters: 3000 },
    });
    expect(forecast.periods[1]).not.toHaveProperty('wind');
    expect(forecast.periods[2]).toMatchObject({ visibility: { visibilityMeters: 2.5 * MILE, bound: 'stated' } });
  });

  it('places a day and hour after the issue time, across the end of a month, with hour 24 as midnight', () => {
    const issued = Date.parse('2026-11-30T23:20:00.000Z');
    expect(new Date(tafDayHour('3024', issued)).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(new Date(tafDayHour('0106', issued)).toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(new Date(tafDayHour('3000', issued)).toISOString()).toBe('2026-11-30T00:00:00.000Z');
    expect(() => tafDayHour('3299', issued)).toThrow(/not a day and hour/);
    expect(() => readTaf('TAF ZZZZ 260200Z 2606/2603 27010KT P6SM', fetchedAt)).toThrow(/ends before it starts/);
    expect(() => readTaf('TAF ZZZZ 260200Z 2603/2706', fetchedAt)).toThrow(/no base conditions/);
  });

  it('writes a forecast as its own type, never as a wind or visibility reading', async () => {
    const sink = new InMemoryObservationSink();
    const line = recordedTafForecasts().find((text) => text.includes('"icaoId":"KORD"'))!;
    const message: VendorMessage = {
      bytes: new TextEncoder().encode(line),
      contentType: 'application/json',
      transport: { method: 'GET', path: '/api/data/taf' },
      capturedAt: fetchedAt,
    };
    const outcome = await translateAndSubmit(publishedTafAdapter, message, context, sink);
    expect(outcome.rejections).toEqual([]);
    expect(sink.observations.map((entry) => entry.observation.type)).toEqual(['weather.forecast']);
    expect(sink.observations[0]!.observation).toMatchObject({
      subject: { kind: 'site', id: 'RIDGE-SITE-1', scope: 'source' },
      occurredAt: '2026-11-26T02:59:00.000Z',
      interval: { start: '2026-11-26T03:00:00.000Z', end: '2026-11-27T06:00:00.000Z' },
      values: { stationId: 'KORD', stationDistanceMeters: 14_200 },
    });
    expect(sink.observations[0]!.observation.limitations).toContain(
      'Forecast for station KORD, configured for the site RIDGE-SITE-1; 14.2 km from the site as configured.',
    );
    expect(publishedTafDescriptor.produces).toEqual([{ type: 'weather.forecast', version: 1 }]);
    expect(publishedTafDescriptor.limitations.join(' ')).not.toMatch(/aviation weather center|aviationweather|noaa/i);
  });

  it('answers as the service does: the latest forecast per station issued by the source clock, and 204 for none', () => {
    const forecasts = recordedTafForecasts();
    const answer = answerTafRequest(forecasts, new URLSearchParams('ids=KORD,EGLL&format=json'), fetchedAt);
    expect(answer.status).toBe(200);
    expect((JSON.parse(answer.body) as { icaoId: string }[]).map((forecast) => forecast.icaoId)).toEqual([
      'EGLL',
      'KORD',
    ]);
    // Before KORD's forecast was issued, only EGLL's is.
    const earlier = answerTafRequest(
      forecasts,
      new URLSearchParams('ids=KORD,EGLL&format=json'),
      '2026-11-26T01:00:00Z',
    );
    expect((JSON.parse(earlier.body) as { icaoId: string }[]).map((forecast) => forecast.icaoId)).toEqual(['EGLL']);
    expect(answerTafRequest(forecasts, new URLSearchParams('ids=KXYZ&format=json'), fetchedAt)).toEqual({
      status: 204,
      body: '',
    });
    expect(answerTafRequest(forecasts, new URLSearchParams('ids=KORD&format=raw'), fetchedAt).status).toBe(400);
    expect(answerTafRequest(forecasts, new URLSearchParams('ids=KORD&format=json&metar=true'), fetchedAt).status).toBe(
      400,
    );
  });
});

describe('published TAF adapter against the emulator', () => {
  const config = { ...emulatorConfig({}), port: 0 };
  const { server } = createEmulator(config);
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/_simulation/clock`, {
      method: 'POST',
      headers: { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ now: fetchedAt }),
    });
    expect(response.status).toBe(200);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('polls the stations and submits each forecast once', async () => {
    const received: VendorMessage[] = [];
    const poll = new ServicePoll(
      {
        url: `${base}/api/data/taf?ids=CYYZ,KJFK,KORD&format=json`,
        headers: { 'user-agent': 'ledger-adapter-test' },
        intervalMs: 5,
        split: jsonArrayElements,
      },
      async (item) => {
        received.push(item);
      },
    );
    void poll.start();
    for (let attempt = 0; attempt < 500 && poll.polls < 2; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await poll.stop();
    expect(received).toHaveLength(3);
    const sink = new InMemoryObservationSink();
    for (const item of [...received, ...received]) await translateAndSubmit(publishedTafAdapter, item, context, sink);
    expect(sink.observations.map((entry) => entry.observation.subject.id).sort()).toEqual([
      'RIDGE-SITE-1',
      'RIDGE-SITE-11',
      'RIDGE-SITE-13',
    ]);
  });
});
