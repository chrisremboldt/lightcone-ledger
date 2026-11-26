import { readFileSync } from 'node:fs';
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
  type RestrictionBinding,
  boundaryTouchesCircle,
  parseRestrictionRegions,
  publishedTfrAdapter,
  publishedTfrDescriptor,
  restrictionListItems,
  translatePublishedTfr,
} from '../src/published-tfr.js';
import { ServicePoll } from '../src/source-transports.js';
import { readXmlElements } from '../src/xml-elements.js';
import { answerTfrRequest, RECORDED_TFR_DIRECTORY } from '../../../apps/emulators/src/tfr.js';
import { createEmulator, emulatorConfig } from '../../../apps/emulators/src/server.js';

const goldenDirectory = join(import.meta.dirname, '../src/golden/published-flight-restrictions');
// Invented regions around invented sites, placed where the recorded restrictions were published.
const binding: RestrictionBinding = parseRestrictionRegions(
  [
    'RIDGE-AREA-1=RIDGE-SITE-1@39.9692,-86.13,2km',
    'RIDGE-AREA-2=RIDGE-SITE-2@38.34,-79.79,1km',
    'RIDGE-AREA-3=RIDGE-SITE-3@39.132,-84.6678,100m',
    'RIDGE-AREA-4=RIDGE-SITE-4@33.8515,-117.9214,300m',
    'RIDGE-AREA-5=RIDGE-SITE-5@45.0,-100.0,50km',
  ].join(';'),
);
const context: TranslationContext<RestrictionBinding> = { subjects: { scope: 'source' }, binding };
const recorded = (file: string) => readFileSync(new URL(file, RECORDED_TFR_DIRECTORY));
const message = (bytes: Uint8Array, path = '/download/detail_6_9800.xml'): VendorMessage => ({
  bytes,
  contentType: 'application/xml',
  transport: { method: 'GET', path },
  capturedAt: '2026-11-26T04:34:40.000Z',
});

describe('published flight restriction adapter on the contract', () => {
  it('passes the conformance kit against its golden files, most of them documents fetched from the service', async () => {
    const report = await assertAdapterConformance({
      adapter: publishedTfrAdapter,
      context,
      goldenDirectory,
      vendorTerms: ['faa', 'federal aviation', 'tfr.faa.gov'],
    });
    expect(report.checked).toMatchObject({ goldens: 10, observations: 5 });
  });

  it('serves every fetched golden document from the emulator’s recordings, byte for byte', () => {
    const fetched = loadGoldenFiles(goldenDirectory).filter((golden) =>
      String((golden as { note?: string }).note).startsWith('Fetched'),
    );
    expect(fetched).toHaveLength(5);
    for (const golden of fetched) {
      const answer = answerTfrRequest(golden.message.transport.path!)!;
      expect(answer.status, golden.name).toBe(200);
      expect(answer.body.toString(), golden.name).toBe(golden.message.bodyText);
    }
  });

  it('records a restriction about the site of each region its area touches, with times, altitudes and area as published', () => {
    const result = translatePublishedTfr(message(recorded('detail_6_9800.xml')), context);
    expect(result.rejections).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      type: 'airspace.restriction',
      subject: { kind: 'site', id: 'RIDGE-SITE-1', scope: 'source' },
      occurredAt: '2026-11-25T22:07:52.000Z',
      interval: { start: '2026-11-26T20:30:00.000Z', end: '2026-12-25T02:00:00.000Z' },
      values: {
        notamId: '6/9800',
        areaName: 'Area A',
        sourceTypeCode: '99.7',
        floor: { meters: 0, datum: 'ground_level' },
        ceiling: { meters: 121.92, datum: 'ground_level' },
        dailySchedule: { fromTime: '20:30', toTime: '02:00' },
        regionId: 'RIDGE-AREA-1',
      },
    });
    const boundary = (result.drafts[0]!.values as { area: { boundary: unknown[] } }).area.boundary;
    expect(boundary).toHaveLength(36);
    // A region too far away records nothing, and nothing of the document is retained.
    const far = translatePublishedTfr(message(recorded('detail_6_9800.xml')), {
      ...context,
      binding: parseRestrictionRegions('RIDGE-AREA-9=RIDGE-SITE-9@39.9692,-86.2,3km'),
    });
    expect(far).toEqual({ drafts: [], rejections: [], unmapped: [] });
  });

  it('decides whether a boundary touches a circle from its edges and its inside', () => {
    const square = [
      { latitudeDegrees: 40, longitudeDegrees: -86 },
      { latitudeDegrees: 40.1, longitudeDegrees: -86 },
      { latitudeDegrees: 40.1, longitudeDegrees: -85.9 },
      { latitudeDegrees: 40, longitudeDegrees: -85.9 },
    ];
    // Inside the square, far from every edge.
    expect(boundaryTouchesCircle(square, { latitudeDegrees: 40.05, longitudeDegrees: -85.95 }, 10)).toBe(true);
    // 0.01 degree of latitude south of the square is about 1112 m.
    const south = { latitudeDegrees: 39.99, longitudeDegrees: -85.95 };
    expect(boundaryTouchesCircle(square, south, 1100)).toBe(false);
    expect(boundaryTouchesCircle(square, south, 1125)).toBe(true);
  });

  it('reads the service’s list into the documents to read, keyed by each entry', () => {
    const list = recorded('list.json');
    const items = restrictionListItems(list)!;
    expect(items.map((item) => item.path)).toContain('/download/detail_6_9800.xml');
    expect(items).toHaveLength(6);
    expect(restrictionListItems(new TextEncoder().encode('{"a":1}'))).toBeUndefined();
    expect(restrictionListItems(new TextEncoder().encode('[{"notam_id":"../x"}]'))).toBeUndefined();
  });

  it('reads the region configuration and refuses what it cannot place', () => {
    expect(parseRestrictionRegions('RIDGE-AREA-1=RIDGE-SITE-1@39.97,-86.13,5km')).toEqual({
      regions: [
        {
          regionId: 'RIDGE-AREA-1',
          siteId: 'RIDGE-SITE-1',
          center: { latitudeDegrees: 39.97, longitudeDegrees: -86.13 },
          radiusMeters: 5000,
        },
      ],
    });
    expect(() => parseRestrictionRegions('')).toThrow(/at least one region/);
    expect(() => parseRestrictionRegions('A=S@95,0,1km')).toThrow(/degrees of latitude/);
    expect(() => parseRestrictionRegions('A=S@40,0,101km')).toThrow(/at most 100 km/);
    expect(() => parseRestrictionRegions('A=S@40,0,1mi')).toThrow(/REGION=SITE@LATITUDE/);
    expect(() => parseRestrictionRegions('A=S@40,0,1km;A=T@41,0,1km')).toThrow(/named twice/);
  });

  it('reads XML without expanding entities or fetching anything', () => {
    expect(readXmlElements('\ufeff<a x="1"><b>&lt;c&gt; &#x41;</b><!-- note --><b/></a>')).toMatchObject({
      name: 'a',
      text: '',
      children: [
        { name: 'b', text: '<c> A', children: [] },
        { name: 'b', text: '', children: [] },
      ],
    });
    expect(() => readXmlElements('<a>&custom;</a>')).toThrow(/not one XML defines/);
    expect(() => readXmlElements('<a><b></a>')).toThrow(/does not match/);
    expect(() => readXmlElements('<a/><b/>')).toThrow(/more than one root/);
  });

  it('names the service in its descriptor but not in what it puts into observations', () => {
    expect(publishedTfrDescriptor.produces).toEqual([{ type: 'airspace.restriction', version: 1 }]);
    expect(publishedTfrDescriptor.limitations.join(' ')).not.toMatch(/\bfaa\b|federal aviation|tfr\.faa/i);
  });
});

describe('published flight restriction adapter against the emulator', () => {
  const config = { ...emulatorConfig({}), port: 0 };
  const { server } = createEmulator(config);
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('polls the list, reads each listed document once, and records the restrictions that touch a region', async () => {
    const received: VendorMessage[] = [];
    const poll = new ServicePoll(
      {
        url: `${base}/tfrapi/exportTfrList`,
        headers: { 'user-agent': 'ledger-adapter-test' },
        intervalMs: 5,
        follow: restrictionListItems,
      },
      async (item) => {
        received.push(item);
      },
    );
    void poll.start();
    for (let attempt = 0; attempt < 500 && poll.polls < 2; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await poll.stop();
    expect(received).toHaveLength(6);
    expect(poll.unchanged).toBeGreaterThanOrEqual(1);
    expect(new Set(received.map((item) => item.contentType))).toEqual(new Set(['application/xml']));
    const sink = new InMemoryObservationSink();
    for (const item of received) await translateAndSubmit(publishedTfrAdapter, item, context, sink);
    expect(
      sink.observations.map((entry) => `${entry.observation.values.notamId} ${entry.observation.subject.id}`).sort(),
    ).toEqual([
      '6/6925 RIDGE-SITE-4',
      '6/9661 RIDGE-SITE-3',
      '6/9661 RIDGE-SITE-3',
      '6/9741 RIDGE-SITE-2',
      '6/9800 RIDGE-SITE-1',
    ]);
    // Only the documents that gave a restriction are retained.
    expect(sink.originals.size).toBe(4);
  });
});
