import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LedgerClient } from '@ledger/contracts/client';
import { type TranslationContext, type VendorMessage, translateAndSubmit } from '../src/adapter-contract.js';
import { djiOsdBatteryAdapter } from '../src/dji-osd-battery.js';
import { djiOsdPositionAdapter, type DjiOsdBinding } from '../src/dji-osd-position.js';
import { HttpObservationSink, ObservationSinkRefusal } from '../src/http-observation-sink.js';
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
