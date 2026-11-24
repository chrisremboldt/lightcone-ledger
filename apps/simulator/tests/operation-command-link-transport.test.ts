import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreparedWorldFact } from '../src/operation-delivery.js';
import { OperationTransport } from '../src/operation-transport.js';

const servers: Server[] = [];
const transports: OperationTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('world command-link HTTP transport', () => {
  it('checks callback authority and exact retained bytes, then returns one callback result after an ambiguous emulator response', async () => {
    const source = {
      sourceSessionId: 'capture:command-link:1',
      occurredAt: '2026-10-15T14:01:30.000Z',
      sourceEventId: 'source:lost:1',
      incidentId: 'incident:canal-market:1',
      aircraftId: 'DJI-test-alpha-01',
      status: 'lost' as const,
      position: { longitude: -87.64105, latitude: 41.88115 },
    };
    const bytes = Buffer.from(JSON.stringify(source, null, 2) + '\n');
    const prepared: PreparedWorldFact = {
      fact: {
        kind: 'command-link',
        sequence: 1,
        tenant: 'alpha',
        attemptId: 'intent-test-alpha-0:attempt:1',
        at: source.occurredAt,
        sourceId: 'command-link',
        sourceSessionId: source.sourceSessionId,
        sourceEventId: source.sourceEventId,
        incidentId: source.incidentId,
        aircraftId: source.aircraftId,
        status: source.status,
        position: source.position,
      },
      bytesBase64: bytes.toString('base64'),
    };
    const paths: string[] = [];
    const errors: unknown[] = [];
    let failBytes = true;
    const emulator = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/_simulation/command-link/deliver');
        expect(request.headers['x-emulator-admin']).toBe('admin-key');
        expect(request.headers['x-simulator-lease']).toBe('lease-id');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          callbackUrl: string;
          bytesBase64: string;
        };
        expect(envelope.bytesBase64).toBe(prepared.bytesBase64);
        const path = new URL(envelope.callbackUrl).pathname;
        expect(path).toMatch(/^\/world\/command-link\/[a-f0-9]{64}$/);
        paths.push(path);
        const callback = (raw: Uint8Array, key = 'partner-key') =>
          fetch(envelope.callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partner-key': key },
            body: new Uint8Array(raw),
          });
        if (failBytes) {
          expect((await callback(bytes, 'wrong-key')).status).toBe(403);
          const altered = Buffer.from(bytes);
          altered[0] = altered[0]! ^ 1;
          const rejected = await callback(altered);
          expect(rejected.status).toBe(400);
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ status: rejected.status }));
        } else {
          const callbacks = await Promise.all([callback(bytes), callback(bytes)]);
          expect(callbacks.map((entry) => entry.status)).toEqual([200, 200]);
          response.destroy();
        }
      } catch (error) {
        errors.push(error);
        response.writeHead(500, { 'content-type': 'application/json' }).end('{"status":500}');
      }
    });
    servers.push(emulator);
    await new Promise<void>((resolve) => emulator.listen(0, '127.0.0.1', resolve));
    const transport = new OperationTransport({
      emulatorUrl: `http://127.0.0.1:${(emulator.address() as { port: number }).port}`,
      adminKey: 'admin-key',
      partnerKey: 'partner-key',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://unused.invalid',
      bindings: {},
      stateDirectory: join(tmpdir(), 'unused-command-link-transport'),
      controlHeaders: () => ({ 'x-simulator-lease': 'lease-id' }),
    });
    transports.push(transport);
    await transport.start();
    const ingested: Buffer[] = [];
    const ingest = async (raw: Uint8Array) => {
      ingested.push(Buffer.from(raw));
      return { capture: 'retained-command-link' };
    };
    await expect(transport.commandLink(prepared, ingest)).rejects.toThrow('retained source bytes');
    expect(ingested).toEqual([]);
    failBytes = false;
    expect(await transport.commandLink(prepared, ingest)).toEqual({ capture: 'retained-command-link' });
    expect(ingested).toEqual([bytes]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1]);
    expect(
      (
        await fetch(`${transport.callbackUrl}${paths[0]}`, {
          method: 'POST',
          headers: { 'x-partner-key': 'partner-key' },
          body: new Uint8Array(bytes),
        })
      ).status,
    ).toBe(404);
    await expect(
      transport.commandLink({ ...prepared, bytesBase64: `${prepared.bytesBase64}\n` }, ingest),
    ).rejects.toThrow('canonical source bytes');
    await expect(
      transport.commandLink({ ...prepared, bytesBase64: Buffer.alloc(64 * 1024 + 1).toString('base64') }, ingest),
    ).rejects.toThrow('64 KiB');
    expect(paths).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});
