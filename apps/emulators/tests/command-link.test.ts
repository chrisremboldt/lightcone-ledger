import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmulator, emulatorConfig } from '../src/server.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('retained command-link source delivery', () => {
  it('forwards exact bytes only within its authenticated control lease and callback bounds', async () => {
    const received: Array<{ path: string; bytes: Buffer; key: unknown; contentType: unknown }> = [];
    const callback = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        path: request.url!,
        bytes: Buffer.concat(chunks),
        key: request.headers['x-partner-key'],
        contentType: request.headers['content-type'],
      });
      if (request.url === '/redirect') response.writeHead(302, { location: '/escaped' }).end();
      else response.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}');
    });
    const callbackUrl = await listen(callback);
    const config = { ...emulatorConfig({}), port: 0, callbackOrigins: [callbackUrl] };
    const { server } = createEmulator(config);
    const base = await listen(server);
    const bytes = Buffer.from(' { "sourceEventId" : "retained:lost", "note" : "é" }\n');
    const body = { callbackUrl: `${callbackUrl}/source`, bytesBase64: bytes.toString('base64') };
    const deliver = (value: unknown, headers: Record<string, string> = { 'x-emulator-admin': config.adminKey }) =>
      fetch(`${base}/_simulation/command-link/deliver`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
    expect((await deliver(body, {})).status).toBe(403);
    expect((await deliver({ ...body, callbackUrl: 'http://outside.invalid/source' })).status).toBe(400);
    expect((await deliver({ ...body, bytesBase64: `${body.bytesBase64}\n` })).status).toBe(400);
    expect((await deliver({ ...body, bytesBase64: Buffer.alloc(64 * 1024 + 1).toString('base64') })).status).toBe(413);
    expect(received).toEqual([]);
    const leaseResponse = await fetch(`${base}/_simulation/control-lease`, {
      method: 'POST',
      headers: { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'scenario' }),
    });
    const { leaseId } = (await leaseResponse.json()) as { leaseId: string };
    expect((await deliver(body)).status).toBe(409);
    const headers = { 'x-emulator-admin': config.adminKey, 'x-simulator-lease': leaseId };
    const delivered = await deliver(body, headers);
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toEqual({ status: 200 });
    expect(received).toEqual([{ path: '/source', bytes, key: config.partnerKey, contentType: 'application/json' }]);
    expect((await deliver({ ...body, callbackUrl: `${callbackUrl}/redirect` }, headers)).status).toBeGreaterThanOrEqual(
      400,
    );
    expect(received.map((entry) => entry.path)).toEqual(['/source', '/redirect']);
  });
});
