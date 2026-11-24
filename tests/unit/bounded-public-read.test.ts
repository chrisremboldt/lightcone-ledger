import { describe, expect, it, vi } from 'vitest';
import { ApiError, LedgerClient, MAX_PUBLIC_READ_BYTES } from '../../packages/contracts/src/client.js';

const bytes = (value: string) => new TextEncoder().encode(value);

describe('bounded authenticated public reads', () => {
  it('reuses the client credential and fetcher while permitting only GET with the caller signal', async () => {
    let issued = 0;
    const token = vi.fn(() => `same-caller-${++issued}`);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"principal":{"id":"reader"}}', { headers: { 'content-type': 'application/json' } }),
      )
      .mockResolvedValueOnce(new Response(bytes('original')));
    const client = new LedgerClient('https://ledger.example/', token, fetcher);
    const controller = new AbortController();
    const options = { maxBytes: 128, signal: controller.signal, method: 'POST', body: 'must not be sent' };

    await expect(client.readJson('/v1/me', options)).resolves.toEqual({ principal: { id: 'reader' } });
    await expect(client.readBytes('/v1/artifacts/retained%20original/content', options)).resolves.toEqual(
      bytes('original'),
    );
    expect(token).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [index, [url, init]] of fetcher.mock.calls.entries()) {
      expect(String(url)).toMatch(/^https:\/\/ledger\.example\/v1\//);
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer same-caller-${index + 1}`);
    }
  });

  it('rejects escaping paths and invalid byte limits before resolving credentials or sending a request', async () => {
    const token = vi.fn(() => 'same-caller');
    const fetcher = vi.fn<typeof fetch>();
    const client = new LedgerClient('https://ledger.example', token, fetcher);
    for (const path of [
      'https://elsewhere.example/v1/me',
      '//elsewhere.example/v1/me',
      '/health',
      '/v1/../admin',
      '/v1/%252e%252e/admin',
      '/v1/flights/a%2fb',
    ])
      await expect(client.readJson(path, { maxBytes: 64 })).rejects.toMatchObject({
        status: 400,
        body: { error: { code: 'public_read_path_invalid' } },
      });
    await expect(client.readBytes('/v1/me', { maxBytes: MAX_PUBLIC_READ_BYTES + 1 })).rejects.toMatchObject({
      status: 400,
      body: { error: { code: 'public_read_limit_invalid' } },
    });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never follows an authenticated redirect and cancels its response body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 302,
      headers: { location: 'https://elsewhere.example/private' },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);
    await expect(client.readBytes('/v1/artifacts/original/content', { maxBytes: 64 })).rejects.toMatchObject({
      status: 502,
      body: { error: { code: 'public_read_redirect' } },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://ledger.example/v1/artifacts/original/content');
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels responses exceeding either declared length or actual streamed bytes without trusting a short header', async () => {
    for (const declared of ['100', '1']) {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes('12'));
            controller.enqueue(bytes('345'));
          },
          cancel,
        }),
        { headers: { 'content-length': declared } },
      );
      const client = new LedgerClient(
        'https://ledger.example',
        'same-caller',
        vi.fn<typeof fetch>().mockResolvedValue(response),
      );
      await expect(client.readBytes('/v1/artifacts/original/content', { maxBytes: 4 })).rejects.toMatchObject({
        status: 413,
        body: { error: { code: 'public_read_too_large' } },
      });
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('returns parsed API errors only after reading them within the same byte bound', async () => {
    const body = { error: { code: 'outside_scope', message: 'Read denied' } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 403 }))
      .mockResolvedValueOnce(new Response('x'.repeat(129), { status: 403 }));
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);
    await expect(client.readJson('/v1/me', { maxBytes: 128 })).rejects.toMatchObject(new ApiError(403, body));
    await expect(client.readJson('/v1/me', { maxBytes: 128 })).rejects.toMatchObject({
      status: 413,
      body: { error: { code: 'public_read_too_large' } },
    });
  });

  it('cancels a stalled body when the caller aborts', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const reading = vi.spyOn(response.body!, 'getReader');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);
    const controller = new AbortController();
    const result = client.readBytes('/v1/artifacts/original/content', { maxBytes: 64, signal: controller.signal });
    await vi.waitFor(() => expect(reading).toHaveBeenCalledOnce());
    const reason = new Error('Collector deadline exceeded');
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
