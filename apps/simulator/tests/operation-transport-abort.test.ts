import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DjiMqttAdapter, LedgerClient } from '@ledger/adapters';
import { DjiOsdEmulator } from '@ledger/emulators';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { OperationTransport, type OperationCaptureConfig } from '../src/operation-transport.js';

const servers: Server[] = [];
const transports: OperationTransport[] = [];
const directories: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('world transport cancellation', () => {
  it('closes an authenticated partial callback without ingesting or changing its retained bytes', async () => {
    const prepared = prepareWorldFact({
      kind: 'command-link',
      sequence: 1,
      tenant: 'alpha',
      attemptId: 'intent-abort-alpha-0:attempt:1',
      at: '2026-10-16T14:00:00.000Z',
      sourceId: 'command-link',
      sourceSessionId: 'capture:abort:1',
      sourceEventId: 'loss:abort:1',
      incidentId: 'incident:abort:1',
      aircraftId: 'DJI-abort-alpha-01',
      status: 'lost',
      position: { longitude: -87.64105, latitude: 41.88115 },
    });
    const retained = structuredClone(prepared);
    const partialStarted = deferred();
    const errors: unknown[] = [];
    const emulator = createServer(async (incoming, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          callbackUrl: string;
          bytesBase64: string;
        };
        expect(envelope.bytesBase64).toBe(prepared.bytesBase64);
        const bytes = Buffer.from(envelope.bytesBase64, 'base64');
        const callback = request(envelope.callbackUrl, {
          method: 'POST',
          headers: {
            'x-partner-key': 'partner-key',
            'content-length': bytes.byteLength,
            expect: '100-continue',
          },
        });
        callback.once('continue', () => {
          callback.write(bytes.subarray(0, 1), partialStarted.resolve);
        });
        callback.on('error', () => response.destroy());
        callback.flushHeaders();
      } catch (error) {
        errors.push(error);
        partialStarted.resolve();
        response.destroy();
      }
    });
    servers.push(emulator);
    await new Promise<void>((resolve) => emulator.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const transport = new OperationTransport({
      emulatorUrl: `http://127.0.0.1:${(emulator.address() as { port: number }).port}`,
      adminKey: 'admin-key',
      partnerKey: 'partner-key',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://unused.invalid',
      bindings: {},
      stateDirectory: join(tmpdir(), 'unused-aborted-callback'),
      signal: controller.signal,
      controlHeaders: () => ({}),
    });
    transports.push(transport);
    await transport.start();
    const ingest = vi.fn(async () => ({ accepted: true }));
    const delivered = transport.commandLink(prepared, ingest).then(
      () => true,
      () => false,
    );
    await partialStarted.promise;
    controller.abort(new Error('World drain deadline exceeded'));
    expect(await delivered).toBe(false);
    await transport.stop();
    expect(ingest).not.toHaveBeenCalled();
    expect(prepared).toEqual(retained);
    expect(errors).toEqual([]);
  });

  it('waits for an interrupted MQTT startup and opens no subsequent client or queued capture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-abort-'));
    directories.push(directory);
    const starting = deferred();
    const finishStart = deferred();
    vi.spyOn(DjiMqttAdapter.prototype, 'initialize').mockResolvedValue();
    const start = vi.spyOn(DjiMqttAdapter.prototype, 'start').mockImplementation(async () => {
      starting.resolve();
      await finishStart.promise;
    });
    const adapterStop = vi.spyOn(DjiMqttAdapter.prototype, 'stop').mockResolvedValue();
    const flush = vi.spyOn(DjiMqttAdapter.prototype, 'flush').mockResolvedValue([]);
    const emulatorStart = vi.spyOn(DjiOsdEmulator.prototype, 'start').mockResolvedValue();
    vi.spyOn(DjiOsdEmulator.prototype, 'stop').mockResolvedValue();
    const controller = new AbortController();
    const transport = new OperationTransport({
      emulatorUrl: 'http://unused.invalid',
      adminKey: 'admin-key',
      partnerKey: 'partner-key',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://127.0.0.1:1',
      bindings: {
        'DJI-abort-alpha-01': {
          adapter: { username: 'adapter', password: 'adapter-password' },
          device: { username: 'device', password: 'device-password' },
        },
      },
      stateDirectory: directory,
      signal: controller.signal,
      controlHeaders: () => ({}),
    });
    transports.push(transport);
    await transport.start();
    const prepared = prepareWorldFact({
      kind: 'position',
      sequence: 1,
      tenant: 'alpha',
      attemptId: 'intent-abort-alpha-0:attempt:1',
      at: '2026-10-16T14:00:00.000Z',
      sourceSessionId: 'capture:abort:1',
      aircraftId: 'DJI-abort-alpha-01',
      point: {
        occurredAt: '2026-10-16T14:00:00.000Z',
        latitude: 41.88115,
        longitude: -87.64105,
        height: 100,
        horizontalSpeed: 12,
      },
    });
    const config: OperationCaptureConfig = {
      ledger: new LedgerClient('http://unused.invalid', 'source-token'),
      tenantId: 'tenant-alpha',
      sourceId: 'dji-osd',
      sourceSessionId: 'capture:abort:1',
      deviceId: 'DJI-abort-alpha-01',
      gatewayId: 'GW-DJI-abort-alpha-01',
      statePath: join(directory, 'capture.json'),
      subject: { flightId: 'flight-alpha-01' },
    };
    const deliveries = [transport.position(prepared, config), transport.position(prepared, config)].map((work) =>
      work.then(
        () => true,
        () => false,
      ),
    );
    await starting.promise;
    controller.abort(new Error('World drain deadline exceeded'));
    let stopped = false;
    const stopping = transport.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(adapterStop).toHaveBeenCalled();
    finishStart.resolve();
    expect(await Promise.all(deliveries)).toEqual([false, false]);
    await stopping;
    await expect(transport.position(prepared, config)).rejects.toThrow('World drain deadline exceeded');
    expect(start).toHaveBeenCalledTimes(1);
    expect(emulatorStart).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });
});
