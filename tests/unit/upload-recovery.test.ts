import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Artifact, Upload } from '../../packages/contracts/src/index.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';

const bytes = new TextEncoder().encode('retained native report');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const key = 'simulation-person-alpha:bytes:retained';
const contentType = 'application/json';
const upload: Upload = {
  id: 'retained-upload',
  status: 'finalized',
  byteLength: bytes.byteLength,
  contentType,
  sha256,
  artifactId: 'retained-artifact',
  expiresAt: '2026-10-17T00:00:00Z',
};
const artifact: Artifact = {
  id: 'retained-artifact',
  uploadId: upload.id,
  sha256,
  byteLength: bytes.byteLength,
  contentType,
  key: 'tenant-alpha/retained-upload/content',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('immutable upload recovery', () => {
  it('recovers an expired finalized upload using its original finalization key without rewriting content', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'PUT') return json({ error: { code: 'upload_expired' } }, 410);
      return String(url).endsWith('/finalize') ? json({ artifact }) : json({ upload });
    });
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);

    await expect(client.upload(bytes, contentType, key)).resolves.toMatchObject({ artifact });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ['https://ledger.example/v1/uploads', 'POST'],
      ['https://ledger.example/v1/uploads/retained-upload/finalize', 'POST'],
    ]);
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'))).toEqual([
      `${key}:create`,
      `${key}:finalize`,
    ]);
    for (const [, init] of fetcher.mock.calls)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer same-caller');
  });

  it('rejects changed bytes of the same length before reusing retained content under the same key', async () => {
    const changed = bytes.slice();
    changed[0] ^= 1;
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/finalize') ? json({ artifact }) : json({ upload }),
    );
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);

    await expect(client.upload(changed, contentType, key)).rejects.toMatchObject({
      status: 409,
      body: { error: { code: 'upload_content_conflict' } },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('recovers stored content and a lost finalization reply with the exact same request and one artifact', async () => {
    let finalized = false;
    let artifactsCreated = 0;
    let loseReply = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'PUT') return json({ error: { code: 'upload_expired' } }, 410);
      if (String(url).endsWith('/finalize')) {
        if (!finalized) artifactsCreated++;
        finalized = true;
        if (loseReply) {
          loseReply = false;
          throw new TypeError('Finalization reply lost after acceptance');
        }
        return json({ artifact });
      }
      return json({
        upload: finalized ? upload : { ...upload, status: 'stored', artifactId: undefined },
      });
    });
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);

    await expect(client.upload(bytes, contentType, key)).rejects.toThrow('Finalization reply lost');
    await expect(client.upload(bytes, contentType, key)).resolves.toMatchObject({ artifact });
    expect(artifactsCreated).toBe(1);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    const creates = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/uploads'));
    expect(creates[0]?.[1]).toEqual(creates[1]?.[1]);
    const finalizes = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/finalize'));
    expect(finalizes[0]).toEqual(finalizes[1]);
    expect(new Headers(finalizes[0]?.[1]?.headers).get('idempotency-key')).toBe(`${key}:finalize`);
  });

  it('keeps unavailable pending bytes explicit instead of obtaining a replacement session or key', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
      init?.method === 'PUT'
        ? json({ error: { code: 'upload_expired', message: 'Upload session expired' } }, 410)
        : json({ upload: { ...upload, status: 'pending', sha256: undefined, artifactId: undefined } }),
    );
    const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);

    await expect(client.upload(bytes, contentType, key)).rejects.toMatchObject({
      status: 410,
      body: { error: { code: 'upload_expired' } },
    });
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('idempotency-key'))).toEqual([
      `${key}:create`,
      `${key}:bytes`,
    ]);
  });

  it('rejects a final artifact that does not match the retained upload and caller bytes', async () => {
    for (const changed of [
      { id: 'different-artifact' },
      { uploadId: 'different-upload' },
      { sha256: '0'.repeat(64) },
      { byteLength: bytes.byteLength + 1 },
      { contentType: 'text/plain' },
    ]) {
      const fetcher = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith('/finalize') ? json({ artifact: { ...artifact, ...changed } }) : json({ upload }),
      );
      const client = new LedgerClient('https://ledger.example', 'same-caller', fetcher);
      await expect(client.upload(bytes, contentType, key)).rejects.toMatchObject({
        status: 502,
        body: { error: { code: 'upload_artifact_mismatch' } },
      });
    }
  });
});
