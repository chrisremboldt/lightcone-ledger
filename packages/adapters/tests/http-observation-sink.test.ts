import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import { djiOsdPositionAdapter, type DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink, ObservationSinkRefusal } from '../src/http-observation-sink.js';
import { skydioCloudFlightsAdapter } from '../src/skydio-cloud-flights.js';
import { classifySubmissionFailure } from '../src/source-loop.js';
import { djiOsdBytes } from '../../../apps/emulators/src/dji.js';

const binding = { deviceId: 'ALPHA-AIRCRAFT-01', gatewayId: 'ALPHA-DOCK-01' };
const context: TranslationContext<DjiOsdBinding> = { subjects: { scope: 'source' }, binding };
const message: VendorMessage = {
  bytes: djiOsdBytes(
    {
      occurredAt: '2026-10-01T17:00:00.000Z',
      latitude: 41.88,
      longitude: -87.63,
      battery: { capacityPercent: 70, landingPower: 10 },
    },
    binding.gatewayId,
    { tid: 'tid-sink', bid: 'bid-sink' },
  ),
  contentType: 'application/json',
  transport: { topic: `thing/product/${binding.deviceId}/osd` },
  capturedAt: '2026-10-01T17:00:00.300Z',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface Call {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}

/** Just enough of the public API: idempotent uploads and inputs, keyed as the real intake keys them. */
function fakeLedger(refuseInputs?: { status: number; code: string }) {
  const calls: Call[] = [];
  const uploads = new Map<string, { id: string; contentType: string; byteLength: number; sha256?: string }>();
  const replies = new Map<string, Response>();
  let counter = 0;
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const headers = new Headers(init.headers);
    const key = headers.get('idempotency-key');
    const method = init.method ?? 'GET';
    const body =
      init.body instanceof Uint8Array ? init.body : typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, key, body });
    const remembered = key && replies.get(key);
    if (remembered) return remembered.clone();
    let reply: Response;
    if (method === 'POST' && path === '/v1/uploads') {
      const id = `upload-${++counter}`;
      uploads.set(id, { id, contentType: body.contentType, byteLength: body.byteLength });
      reply = json(201, { upload: { ...uploads.get(id), status: 'pending' } });
    } else if (method === 'PUT' && path.endsWith('/content')) {
      const upload = uploads.get(path.split('/')[3]!)!;
      upload.sha256 = hex(body as Uint8Array);
      reply = json(200, { upload: { ...upload, status: 'stored' } });
    } else if (method === 'POST' && path.endsWith('/finalize')) {
      const upload = uploads.get(path.split('/')[3]!)!;
      reply = json(201, {
        artifact: {
          id: `artifact-${upload.id}`,
          uploadId: upload.id,
          sha256: upload.sha256,
          byteLength: upload.byteLength,
          contentType: upload.contentType,
        },
      });
    } else if (method === 'POST' && path === '/v1/inputs') {
      reply = refuseInputs
        ? json(refuseInputs.status, { error: { code: refuseInputs.code, message: 'Refused by the fake' } })
        : json(201, { receipt: { id: `receipt-${++counter}`, kind: 'observation' } });
    } else reply = json(404, { error: { code: 'not_found', message: path } });
    if (key && reply.ok) replies.set(key, reply.clone());
    return reply;
  }) as typeof fetch;
  return { calls, ledger: new LedgerClient('http://ledger.test', 'ledger-dev-alpha-source', fetcher) };
}

describe('HTTP observation sink', () => {
  it('retains the original once through the upload flow and submits each observation citing it', async () => {
    const { calls, ledger } = fakeLedger();
    const sink = new HttpObservationSink({ ledger, sourceId: 'fictional-telemetry' });
    const battery = await translateAndSubmit(djiOsdBatteryAdapter, message, context, sink);
    const position = await translateAndSubmit(djiOsdPositionAdapter, message, context, sink);
    expect(battery.artifactId).toBe('artifact-upload-1');
    expect(position.artifactId).toBe(battery.artifactId);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /v1/uploads',
      'PUT /v1/uploads/upload-1/content',
      'POST /v1/uploads/upload-1/finalize',
      'POST /v1/inputs',
      'POST /v1/inputs',
    ]);
    expect(calls[1]!.body).toEqual(message.bytes);
    const input = calls[3]!;
    expect(input.body).toEqual({
      sourceId: 'fictional-telemetry',
      kind: 'observation',
      occurredAt: '2026-10-01T17:00:00.000Z',
      payload: battery.submitted[0]!.observation,
    });
    expect(input.key).toMatch(/^observation:[0-9a-f]{64}$/);
    expect(battery.submitted[0]!.observation.originalArtifactId).toBe('artifact-upload-1');
  });

  it('uses the same keys from a fresh sink, so a replay after a restart finds the same artifact and receipts', async () => {
    const { calls, ledger } = fakeLedger();
    const first = await translateAndSubmit(
      djiOsdBatteryAdapter,
      message,
      context,
      new HttpObservationSink({ ledger, sourceId: 'fictional-telemetry' }),
    );
    const replay = await translateAndSubmit(
      djiOsdBatteryAdapter,
      message,
      context,
      new HttpObservationSink({ ledger, sourceId: 'fictional-telemetry' }),
    );
    expect(replay.artifactId).toBe(first.artifactId);
    expect(replay.submitted[0]!.receiptId).toBe(first.submitted[0]!.receiptId);
    const keys = calls.map((call) => call.key);
    expect(keys.slice(4)).toEqual(keys.slice(0, 4));
  });

  it('surfaces a refusal with its status and code, once, without retrying', async () => {
    const { calls, ledger } = fakeLedger({ status: 403, code: 'observation_grant_required' });
    const sink = new HttpObservationSink({ ledger, sourceId: 'fictional-telemetry' });
    const failure = await translateAndSubmit(djiOsdBatteryAdapter, message, context, sink).catch((error) => error);
    expect(failure).toBeInstanceOf(ObservationSinkRefusal);
    expect(failure).toMatchObject({ step: 'submit_observation', status: 403, code: 'observation_grant_required' });
    expect(failure.message).toMatch(/403 observation_grant_required/);
    expect(calls.filter((call) => call.path === '/v1/inputs')).toHaveLength(1);
  });

  it('surfaces a refused upload and checks the stated digest before sending anything', async () => {
    const refusing = new LedgerClient('http://ledger.test', 'token', (async () =>
      json(413, { error: { code: 'upload_too_large', message: 'Too large' } })) as typeof fetch);
    const sink = new HttpObservationSink({ ledger: refusing, sourceId: 'fictional-telemetry' });
    const request = {
      adapterId: 'test',
      bytes: message.bytes,
      contentType: 'application/json',
      sha256: hex(message.bytes),
      capturedAt: message.capturedAt,
    };
    await expect(sink.retainOriginal(request)).rejects.toMatchObject({
      step: 'retain_original',
      status: 413,
      code: 'upload_too_large',
    });
    await expect(sink.retainOriginal({ ...request, sha256: '0'.repeat(64) })).rejects.toThrow(/SHA-256/);
  });
});

/**
 * Just enough of the public API for a record a source keeps one of: inputs that may name the observation they
 * replace, a source event that conflicts when retained with other content, and the read of what is current.
 */
function fakeIntake(options: { refuseReads?: boolean } = {}) {
  const calls: { method: string; path: string; search: string; body?: Record<string, unknown> }[] = [];
  const stored: {
    id: string;
    receiptId: string;
    sourceId: string;
    receivedAt: string;
    replaces?: string;
    observation: Record<string, unknown>;
  }[] = [];
  let counter = 0;
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: target.pathname, search: target.search, ...(body ? { body } : {}) });
    if (method === 'GET' && target.pathname === '/v1/observations') {
      if (options.refuseReads)
        return json(403, {
          error: { code: 'capability_required', message: 'Reading observations requires evidence:read' },
        });
      const replaced = new Set(stored.map((entry) => entry.replaces));
      const subject = (entry: (typeof stored)[number]) => entry.observation.subject as { kind: string; id: string };
      return json(200, {
        observations: stored
          .filter(
            (entry) =>
              !replaced.has(entry.id) &&
              entry.sourceId === target.searchParams.get('sourceId') &&
              entry.observation.type === target.searchParams.get('type') &&
              subject(entry).kind === target.searchParams.get('subjectKind') &&
              subject(entry).id === target.searchParams.get('subjectId'),
          )
          .map(({ observation, ...entry }) => ({ ...entry, sourceEventId: observation.sourceEventId, observation })),
      });
    }
    if (method === 'POST' && target.pathname === '/v1/inputs') {
      const observation = body!.payload as Record<string, unknown>;
      if (stored.some((entry) => entry.observation.sourceEventId === observation.sourceEventId))
        return json(409, { error: { code: 'source_event_conflict', message: 'Already retained' } });
      const id = `observation-${stored.length + 1}`;
      stored.push({
        id,
        receiptId: `receipt-${stored.length + 1}`,
        sourceId: body!.sourceId as string,
        receivedAt: new Date(Date.UTC(2026, 10, 20, 16, 0, stored.length)).toISOString(),
        ...(body!.replaces ? { replaces: body!.replaces as string } : {}),
        observation,
      });
      return json(201, { receipt: { id: stored.at(-1)!.receiptId, eventId: id, kind: 'observation' } });
    }
    return json(404, { error: { code: 'not_found', message: target.pathname } });
  }) as typeof fetch;
  // This fake is not about uploads: the flow above covers them.
  const ledger = new LedgerClient('http://ledger.test', 'ledger-dev-alpha-source', fetcher);
  ledger.upload = async () => ({ artifact: { id: `artifact-${++counter}` } }) as never;
  return { calls, stored, ledger };
}

describe('HTTP observation sink for a record the source keeps one of', () => {
  const flightContext: TranslationContext = { subjects: { scope: 'source' }, binding: undefined };
  const flight = {
    flight_id: 'EXAMPLE-FLIGHT-0001',
    vehicle_serial: 'EXAMPLE-VEHICLE-01',
    takeoff: '2026-11-20T15:00:02Z',
    has_telemetry: false,
  };
  const listed = (body: unknown): VendorMessage => ({
    bytes: new TextEncoder().encode(JSON.stringify(body)),
    contentType: 'application/json',
    transport: { method: 'GET', path: '/api/v0/flights' },
    capturedAt: '2026-11-20T16:00:05.000Z',
  });
  const submit = (sink: HttpObservationSink, body: unknown) =>
    translateAndSubmit(skydioCloudFlightsAdapter, listed(body), flightContext, sink);
  const options = { sourceId: 'fictional-flights', oneCurrentPerSubject: ['flight.report'] };

  it('reads what is on file first: the same statement is not submitted again, a changed one replaces it', async () => {
    const { calls, stored, ledger } = fakeIntake();
    const first = await submit(new HttpObservationSink({ ledger, ...options }), flight);
    expect(stored).toHaveLength(1);
    const read = calls.find((call) => call.path === '/v1/observations')!;
    expect(Object.fromEntries(new URLSearchParams(read.search))).toEqual({
      subjectKind: 'flight',
      subjectId: 'EXAMPLE-FLIGHT-0001',
      subjectScope: 'source',
      sourceId: 'fictional-flights',
      type: 'flight.report',
      from: '1970-01-01T00:00:00.000Z',
      to: '9999-12-31T23:59:59.000Z',
      order: 'newest_first',
      limit: '100',
    });
    expect(calls.find((call) => call.path === '/v1/inputs')!.body).not.toHaveProperty('replaces');

    // The same flight read after a restart, its bytes different only in a field no observation carries.
    const again = await submit(new HttpObservationSink({ ledger, ...options }), { ...flight, has_telemetry: true });
    expect(again.submitted[0]!.receiptId).toBe(first.submitted[0]!.receiptId);
    expect(stored).toHaveLength(1);

    // The service now lists the flight with its landing: the report on file is replaced.
    const landed = await submit(new HttpObservationSink({ ledger, ...options }), {
      ...flight,
      landing: '2026-11-20T15:18:40Z',
    });
    expect(stored).toHaveLength(2);
    expect(stored[1]).toMatchObject({ replaces: 'observation-1', receiptId: landed.submitted[0]!.receiptId });
    expect(calls.filter((call) => call.path === '/v1/inputs').at(-1)!.body).toMatchObject({
      kind: 'observation',
      sourceId: 'fictional-flights',
      replaces: 'observation-1',
      occurredAt: '2026-11-20T15:18:40.000Z',
    });
    // A third statement replaces the second, never the first again.
    await submit(new HttpObservationSink({ ledger, ...options }), { ...flight, landing: '2026-11-20T15:19:00Z' });
    expect(stored[2]).toMatchObject({ replaces: 'observation-2' });
  });

  it('reads nothing for a type the source does not keep one of, or without the option', async () => {
    const { calls, ledger } = fakeIntake();
    await submit(new HttpObservationSink({ ledger, sourceId: 'fictional-flights' }), flight);
    expect(calls.filter((call) => call.path === '/v1/observations')).toEqual([]);
  });

  it('stops as for a refused credential when Ledger does not let it read what is on file', async () => {
    const { stored, ledger } = fakeIntake({ refuseReads: true });
    const failure = await submit(new HttpObservationSink({ ledger, ...options }), flight).catch((error) => error);
    expect(failure).toBeInstanceOf(ObservationSinkRefusal);
    expect(failure).toMatchObject({ step: 'read_on_file', status: 403, code: 'capability_required' });
    expect(failure.message).toMatch(/Ledger refused read on file with 403/);
    expect(classifySubmissionFailure(failure)).toBe('credential');
    expect(stored).toEqual([]);
  });
});
