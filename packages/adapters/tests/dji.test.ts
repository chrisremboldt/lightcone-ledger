import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LedgerClient } from '@ledger/contracts/client';
import type { Input, TelemetrySegment } from '@ledger/contracts';
import { sha256 } from '@ledger/integrity';
import { DjiMqttAdapter, describeTelemetry } from '../src/dji.js';
import { decodeDjiOsd } from '../src/dji-osd.js';
import { djiOsdBytes } from '../../../apps/emulators/src/dji.js';

const mqttCleanup = vi.hoisted(() => ({
  unsubscribeAsync: vi.fn(async () => {}),
  endAsync: vi.fn(async () => {}),
}));
vi.mock('mqtt', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    connect: () => {
      const client = Object.assign(new EventEmitter(), {
        subscribe: (_topic: string, _options: unknown, callback: (error: null, grants: { qos: number }[]) => void) =>
          callback(null, [{ qos: 1 }]),
        ...mqttCleanup,
      });
      queueMicrotask(() => client.emit('connect'));
      return client;
    },
  };
});

const deviceId = 'DJI-ALPHA-01',
  gatewayId = 'DJI-ALPHA-GATEWAY';
const topic = `thing/product/${deviceId}/osd`;
const point = {
  occurredAt: '2026-10-01T17:00:00.000Z',
  latitude: 41.88,
  longitude: -87.63,
  height: 220,
  horizontalSpeed: 10,
};
const directories: string[] = [];
const connectedAdapters: DjiMqttAdapter[] = [];
afterEach(async () => {
  for (const adapter of connectedAdapters.splice(0)) await adapter.stop();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  vi.clearAllMocks();
});
async function setup(maxSamples = 120) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-dji-unit-'));
  directories.push(directory);
  const uploads: Uint8Array[] = [];
  const inputs: Input[] = [];
  const segments: { segment: TelemetrySegment; receiptId: string }[] = [];
  const receiptsRead: string[] = [];
  let fail = true;
  let projected = false;
  let baseline = 1;
  let truncated = false;
  let omittedSequence: number | undefined;
  let uploadMetadata = { byteLength: 0, contentType: '' };
  const ledger = new LedgerClient('http://127.0.0.1:4000', 'local-source', async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/uploads') {
      const declared = JSON.parse(init!.body as string) as { byteLength: number; contentType: string };
      uploadMetadata = { byteLength: declared.byteLength, contentType: declared.contentType };
      return Response.json({ upload: { id: 'upload', status: 'pending', ...uploadMetadata } });
    }
    if (path.endsWith('/content')) {
      uploads.push((init?.body as Uint8Array).slice());
      return Response.json({
        upload: { id: 'upload', status: 'stored', ...uploadMetadata, sha256: sha256(uploads.at(-1)!) },
      });
    }
    if (path.endsWith('/finalize'))
      return Response.json({
        artifact: {
          id: 'artifact',
          uploadId: 'upload',
          sha256: sha256(uploads.at(-1)!),
          byteLength: uploads.at(-1)!.byteLength,
          contentType: uploadMetadata.contentType,
          key: 'tenant-alpha/uploads/upload',
        },
      });
    if (path === '/v1/inputs') {
      if (fail) throw new Error('Injected API outage');
      inputs.push(JSON.parse(init!.body as string));
      const receiptId = `receipt-${inputs.length}`;
      segments.push({ segment: JSON.parse(Buffer.from(uploads.at(-1)!).toString()), receiptId });
      return Response.json({ receipt: { id: receiptId, eventId: 'segment-event' } });
    }
    if (path === '/v1/flights/flight-one/telemetry') {
      const segment = segments[0]?.segment;
      return Response.json({
        window: { truncated },
        sessions: segment
          ? [
              {
                sourceId: segment.sourceId,
                sourceSessionId: segment.sourceSessionId,
                deviceId,
                sessionStartSequence: baseline,
                sequenceBasis: 'adapter_capture',
              },
            ]
          : [],
        samples: segments.flatMap(({ segment, receiptId }) =>
          segment.samples
            .filter((sample) => sample.sequence !== omittedSequence)
            .map((sample) => ({
              ...sample,
              sourceId: segment.sourceId,
              sourceSessionId: segment.sourceSessionId,
              deviceId,
              receiptId,
            })),
        ),
      });
    }
    if (path.startsWith('/v1/receipts/')) {
      const id = path.split('/').at(-1)!;
      receiptsRead.push(id);
      return Response.json({
        receipt: {
          id,
          kind: 'telemetry.segment',
          sourceId: 'dji-osd',
          flightId: 'flight-one',
          processing: { status: projected ? 'completed' : 'pending' },
        },
      });
    }
    throw new Error('Unexpected mocked route');
  });
  const config = {
    ledger,
    tenantId: 'tenant-alpha',
    sourceId: 'dji-osd',
    sourceSessionId: 'flight-session-one',
    deviceId,
    gatewayId,
    mqttUrl: 'mqtt://127.0.0.1:1883',
    username: 'ledger-local-alpha-adapter',
    password: 'ledger-local-alpha-adapter-password',
    statePath: join(directory, 'state.json'),
    subject: { flightId: 'flight-one' },
    maxSamples,
  };
  return {
    config,
    uploads,
    inputs,
    receiptsRead,
    recover: () => {
      fail = false;
    },
    project: () => {
      projected = true;
    },
    baseline: (value: number) => {
      baseline = value;
    },
    truncate: () => {
      truncated = true;
    },
    omitSequence: (value?: number) => {
      omittedSequence = value;
    },
  };
}
describe('DJI selected-scalar normalization and durable capture checkpoint', () => {
  it('preserves original byte spelling and documented ellipsoid height, with unknown altitude explicit', () => {
    const raw = Buffer.from(
      ' \n' + Buffer.from(djiOsdBytes(point, gatewayId, { tid: 't', bid: 'b' })).toString() + '\n',
    );
    const sample = decodeDjiOsd(topic, raw, { deviceId, gatewayId }, 1);
    expect(sample.altitudeReference).toBe('ellipsoid');
    expect(sample.altitudeMeters).toBe(220);
    expect(sample.speedMetersPerSecond).toBe(10);
    expect(sample.occurredAt).toBe(point.occurredAt);
    expect(Buffer.from(sample.original.bytesBase64, 'base64')).toEqual(raw);
    const unknown = decodeDjiOsd(
      topic,
      djiOsdBytes({ ...point, height: undefined }, gatewayId),
      { deviceId, gatewayId },
      2,
    );
    expect(unknown.altitudeMeters).toBeNull();
    expect(unknown.altitudeReference).toBe('unknown');
  });
  it('recovers an exact pending segment and sample deduplication across API outage and adapter restart', async () => {
    const fixture = await setup();
    const adapter = new DjiMqttAdapter(fixture.config);
    const raw = djiOsdBytes(point, gatewayId, { tid: 'same-tid', bid: 'same-bid' });
    await adapter.ingest(topic, raw);
    const id = await adapter.seal();
    expect(id).toBeTruthy();
    await expect(adapter.commitPending(id!)).rejects.toThrow('API outage');
    const before = await readFile(fixture.config.statePath, 'utf8');
    fixture.recover();
    const restarted = new DjiMqttAdapter(fixture.config);
    await restarted.initialize();
    expect(await restarted.ingest(topic, raw)).toBe('duplicate');
    expect(restarted.stats.nextSequence).toBe(2);
    await restarted.commitPending(id!);
    expect(restarted.stats.pending).toBe(0);
    expect(fixture.uploads[0]).toEqual(fixture.uploads[1]);
    expect(JSON.parse(before).pending[0].id).toBe(id);
    const segment = JSON.parse(Buffer.from(fixture.uploads[1]!).toString());
    expect(segment.sourceSessionId).toBe(fixture.config.sourceSessionId);
    expect(segment.gatewayId).toBe(gatewayId);
    expect(segment.sequenceBasis).toBe('adapter_capture');
    expect(segment.fidelity).toBe('synthetic_contract');
    expect(fixture.inputs[0].payload).toEqual(describeTelemetry(segment));
    expect(fixture.inputs[0].artifactId).toBe('artifact');
    expect(JSON.stringify(fixture.uploads.map((value) => Buffer.from(value).toString()))).not.toContain(
      fixture.config.password,
    );
  });
  it('completes a truncated nonempty view only with every capture and completed receipt proved', async () => {
    const fixture = await setup(2);
    const adapter = new DjiMqttAdapter(fixture.config);
    connectedAdapters.push(adapter);
    for (let sequence = 1; sequence <= 33; sequence++) {
      await adapter.ingest(
        topic,
        djiOsdBytes(
          { ...point, occurredAt: new Date(Date.parse(point.occurredAt) + sequence * 1000).toISOString() },
          gatewayId,
          { tid: `sample-${sequence}`, bid: 'capture' },
        ),
      );
      if (sequence <= 9) await adapter.seal();
    }
    fixture.recover();
    await adapter.flush();
    expect(fixture.inputs).toHaveLength(21);
    await adapter.start();
    fixture.truncate();
    fixture.omitSequence(17);
    await expect(adapter.completeSession()).rejects.toThrow('every capture position');
    fixture.omitSequence();
    await expect(adapter.completeSession()).rejects.toThrow('receipt is not completed');
    expect(mqttCleanup.unsubscribeAsync).not.toHaveBeenCalled();
    expect(mqttCleanup.endAsync).not.toHaveBeenCalled();

    fixture.project();
    fixture.receiptsRead.splice(0);
    await adapter.completeSession();
    expect(new Set(fixture.receiptsRead).size).toBe(21);
    expect(mqttCleanup.unsubscribeAsync).toHaveBeenCalledWith(topic);
    expect(mqttCleanup.endAsync).toHaveBeenCalledExactlyOnceWith(false, { properties: { sessionExpiryInterval: 0 } });
  });
  it('rejects an empty truncated view before cleaning up its connected session', async () => {
    const fixture = await setup();
    const adapter = new DjiMqttAdapter(fixture.config);
    connectedAdapters.push(adapter);
    await adapter.start();
    fixture.truncate();
    await expect(adapter.completeSession()).rejects.toThrow('untruncated bounded evidence view');
    expect(mqttCleanup.unsubscribeAsync).not.toHaveBeenCalled();
    expect(mqttCleanup.endAsync).not.toHaveBeenCalled();
  });
});
