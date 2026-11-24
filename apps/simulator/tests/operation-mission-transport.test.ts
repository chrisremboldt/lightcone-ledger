import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '@ledger/integrity';
import { missionSource } from '../../../packages/contracts/fixtures/demo/v1/missions.js';
import { prepareWorldFact } from '../src/operation-delivery.js';
import { OperationTransport } from '../src/operation-transport.js';

const servers: Server[] = [];
const transports: OperationTransport[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('world mission HTTP transport', () => {
  it('authenticates exact retained callbacks and keeps revision identity stable across a lost emulator response and retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-mission-wire-'));
    directories.push(directory);
    const source = structuredClone(missionSource);
    const prepared = prepareWorldFact({
      kind: 'mission',
      sequence: 1,
      tenant: 'alpha',
      at: source.occurredAt,
      attemptId: 'mission-wire-alpha:attempt:1',
      aircraftId: source.aircraftId,
      sourceId: 'mission-planner',
      source,
    });
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    const paths: string[] = [];
    const errors: unknown[] = [];
    let rejectBytes = true;
    const emulator = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/_simulation/mission/deliver');
        expect(request.headers['x-emulator-admin']).toBe('mission-admin');
        expect(request.headers['x-simulator-lease']).toBe('mission-lease');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          callbackUrl: string;
          bytesBase64: string;
        };
        expect(Object.keys(envelope).sort()).toEqual(['bytesBase64', 'callbackUrl']);
        expect(envelope.bytesBase64).toBe(prepared.bytesBase64);
        const path = new URL(envelope.callbackUrl).pathname;
        expect(path).toMatch(/^\/world\/mission\/[a-f0-9]{64}$/);
        paths.push(path);
        const callback = (raw: Uint8Array, key = 'mission-partner') =>
          fetch(envelope.callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partner-key': key },
            body: new Uint8Array(raw),
          });
        if (rejectBytes) {
          expect((await callback(bytes, 'wrong-key')).status).toBe(403);
          const altered = Buffer.from(bytes);
          altered[0] = altered[0]! ^ 1;
          const denied = await callback(altered);
          expect(denied.status).toBe(400);
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ status: denied.status }));
        } else {
          expect((await Promise.all([callback(bytes), callback(bytes)])).map((result) => result.status)).toEqual([
            200, 200,
          ]);
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
      adminKey: 'mission-admin',
      partnerKey: 'mission-partner',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://unused.invalid',
      bindings: {},
      stateDirectory: directory,
      controlHeaders: () => ({ 'x-simulator-lease': 'mission-lease' }),
    });
    transports.push(transport);
    await transport.start();
    const observed: Buffer[] = [];
    const ingest = async (raw: Uint8Array) => {
      observed.push(Buffer.from(raw));
      return { observedSha256: sha256(raw) };
    };
    await expect(transport.mission(prepared, ingest)).rejects.toThrow('retained source bytes');
    expect(observed).toEqual([]);
    rejectBytes = false;
    for (let retry = 0; retry < 2; retry++) {
      expect(await transport.mission(prepared, ingest)).toEqual({ observedSha256: sha256(bytes) });
    }
    expect(observed).toEqual([bytes, bytes]);
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(1);
    expect(errors).toEqual([]);
    expect(
      (
        await fetch(`${transport.callbackUrl}${paths[0]}`, {
          method: 'POST',
          headers: { 'x-partner-key': 'mission-partner' },
          body: new Uint8Array(bytes),
        })
      ).status,
    ).toBe(404);
    await expect(transport.mission({ ...prepared, bytesBase64: `${prepared.bytesBase64}\n` }, ingest)).rejects.toThrow(
      'canonical source bytes',
    );
    expect(paths).toHaveLength(3);
  });
});
