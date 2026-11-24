import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createInvestigationClient, investigationApiOrigin } from '../../apps/api/src/investigation-transport.js';
import { INVESTIGATION_LIMITS } from '../../packages/contracts/src/investigation.js';

type InvestigationApp = Parameters<typeof createInvestigationClient>[0];

function injected(source: Readable, statusCode = 200) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    stream: () => source,
    get rawPayload(): never {
      throw new Error('The transport must not buffer an injected payload.');
    },
    get payload(): never {
      throw new Error('The transport must not buffer an injected payload.');
    },
  };
}

describe('in-process investigation transport', () => {
  it('uses the configured authority and original bearer only for allowlisted public GETs', async () => {
    expect(investigationApiOrigin('https://ledger.example:443/')).toBe('https://ledger.example');
    for (const origin of [
      'https://someone@ledger.example',
      'https://ledger.example/a/..',
      'https://ledger.example?origin=other',
      'https://ledger.example#fragment',
      '//ledger.example',
    ])
      expect(() => investigationApiOrigin(origin)).toThrow(TypeError);
    const inject = vi.fn().mockImplementation(async () => injected(Readable.from([Buffer.from('{"ok":true}')])));
    const app = { inject } as unknown as InvestigationApp;
    const controller = new AbortController();
    const client = createInvestigationClient(
      app,
      'https://ledger.example',
      'same-human',
      'selected-flight',
      controller.signal,
    );
    await expect(client.readJson('/v1/me', { maxBytes: 64 })).resolves.toEqual({ ok: true });
    await expect(
      client.readJson('/v1/flights/selected-flight/timeline?limit=1&decisionLimit=1&selectedItemId=exact-event', {
        maxBytes: 64,
      }),
    ).resolves.toEqual({ ok: true });
    expect(inject).toHaveBeenCalledTimes(2);
    for (const [request] of inject.mock.calls) {
      expect(request).toMatchObject({
        method: 'GET',
        authority: 'ledger.example',
        headers: { authorization: 'Bearer same-human', accept: 'application/json' },
        payloadAsStream: true,
      });
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.url).toMatch(/^\/v1\//);
      expect(Object.keys(request.headers).sort()).toEqual(['accept', 'authorization']);
    }
    for (const path of [
      '/v1/flights/another-flight/timeline?limit=1&decisionLimit=1',
      '/v1/flights/selected-flight/findings/finding/investigation',
    ])
      await expect(client.readBytes(path, { maxBytes: 64 })).rejects.toMatchObject({
        status: 500,
        code: 'investigation_transport_invalid',
      });
    await expect(client.request('/v1/inputs', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 500,
      code: 'investigation_transport_invalid',
    });
    await expect(client.request('/v1/artifacts/%252e%252e/content', { method: 'GET' })).rejects.toMatchObject({
      status: 500,
      code: 'investigation_transport_invalid',
    });
    client.baseUrl = 'https://other.example';
    await expect(client.readBytes('/v1/me', { maxBytes: 64 })).rejects.toMatchObject({
      status: 500,
      code: 'investigation_transport_invalid',
    });
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('shares actual streamed byte and read budgets across bootstrap and collector requests', async () => {
    const overflowSource = Readable.from([Buffer.alloc(1), Buffer.alloc(1)]);
    const inject = vi
      .fn()
      .mockResolvedValueOnce(injected(Readable.from([Buffer.alloc(INVESTIGATION_LIMITS.maxTotalReadBytes - 1)])))
      .mockResolvedValueOnce(injected(overflowSource));
    const controller = new AbortController();
    const client = createInvestigationClient(
      { inject } as unknown as InvestigationApp,
      'https://ledger.example',
      'same-human',
      'selected-flight',
      controller.signal,
    );
    await client.readBytes('/v1/me', { maxBytes: INVESTIGATION_LIMITS.maxTotalReadBytes });
    await expect(client.readBytes('/v1/artifacts/original/content', { maxBytes: 8 })).rejects.toMatchObject({
      status: 413,
      code: 'investigation_too_large',
    });
    expect(overflowSource.destroyed).toBe(true);
    expect(inject).toHaveBeenCalledTimes(2);
    await expect(client.readBytes('/v1/me', { maxBytes: 8 })).rejects.toMatchObject({
      status: 413,
      code: 'investigation_too_large',
    });
    expect(inject).toHaveBeenCalledTimes(2);

    const smallInject = vi.fn().mockImplementation(async () => injected(Readable.from([Buffer.from('{}')])));
    const smallClient = createInvestigationClient(
      { inject: smallInject } as unknown as InvestigationApp,
      'https://ledger.example',
      'same-human',
      'selected-flight',
      new AbortController().signal,
    );
    for (let count = 0; count < INVESTIGATION_LIMITS.maxReads; count++)
      await smallClient.readJson('/v1/me', { maxBytes: 8 });
    await expect(smallClient.readJson('/v1/me', { maxBytes: 8 })).rejects.toMatchObject({
      status: 413,
      code: 'investigation_too_large',
    });
    expect(smallInject).toHaveBeenCalledTimes(INVESTIGATION_LIMITS.maxReads);
  });

  it('cancels a stalled injected response when the outer request aborts', async () => {
    const pull = vi.fn();
    const source = new Readable({ read: pull });
    const inject = vi.fn().mockResolvedValue(injected(source));
    const controller = new AbortController();
    const client = createInvestigationClient(
      { inject } as unknown as InvestigationApp,
      'https://ledger.example',
      'same-human',
      'selected-flight',
      controller.signal,
    );
    const result = client.readBytes('/v1/artifacts/original/content', { maxBytes: 64 });
    await vi.waitFor(() => expect(pull).toHaveBeenCalled());
    const reason = new Error('Outer request closed');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(source.destroyed).toBe(true);
  });
});
