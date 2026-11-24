import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { INVESTIGATION_LIMITS } from '@ledger/contracts';
import { LedgerClient } from '@ledger/contracts/client';
import { DomainError } from '@ledger/persistence';

export function investigationApiOrigin(value: string): string {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/@?#\\]+\/?$/i.test(value))
    throw new TypeError('Investigation requires a configured HTTP(S) API origin.');
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    throw new TypeError('Investigation requires a configured HTTP(S) API origin.');
  return parsed.origin;
}

function blockedRead(): DomainError {
  return new DomainError(500, 'investigation_transport_invalid', 'The internal investigation read was blocked.');
}

function boundedId(value: string): boolean {
  let decoded = value;
  for (let depth = 0; depth < 8; depth++) {
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) return false;
    if (!/%[a-f0-9]{2}/i.test(decoded)) return true;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return false;
    }
  }
  return false;
}

function permittedRead(url: URL, flightId: string): boolean {
  if (url.pathname === `/v1/flights/${encodeURIComponent(flightId)}/timeline`) {
    for (const name of url.searchParams.keys()) {
      const values = url.searchParams.getAll(name);
      if (values.length !== 1) return false;
      if (name === 'limit' || name === 'decisionLimit') {
        if (values[0] !== '1') return false;
      } else if (name !== 'selectedItemId' || !boundedId(values[0]!)) return false;
    }
    return true;
  }
  if (url.search) return false;
  if (url.pathname === '/v1/me') return true;
  const match = /^\/v1\/(?:receipts\/([^/]+)|artifacts\/([^/]+)(?:\/content)?)$/.exec(url.pathname);
  return Boolean(match && boundedId(match[1] ?? match[2]!));
}

export function createInvestigationClient(
  app: FastifyInstance,
  apiOrigin: string,
  bearer: string,
  flightId: string,
  signal: AbortSignal,
): LedgerClient {
  const origin = investigationApiOrigin(apiOrigin);
  const authority = new URL(origin).host;
  const budget = new AbortController();
  const lifetime = AbortSignal.any([signal, budget.signal]);
  let reads = 0;
  let bytes = 0;
  const tooLarge = () => {
    const error = new DomainError(413, 'investigation_too_large', 'The investigation exceeds its public-read budget.');
    budget.abort(error);
    return error;
  };
  const fetcher: typeof fetch = async (input, init) => {
    if (
      typeof input !== 'string' ||
      !input.startsWith(`${origin}/`) ||
      /[\s\\#]/.test(input) ||
      (init?.method ?? 'GET') !== 'GET' ||
      init?.body != null
    )
      throw blockedRead();
    const url = new URL(input);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname + url.search !== input.slice(origin.length) ||
      !permittedRead(url, flightId)
    )
      throw blockedRead();
    const requestSignal = init?.signal ? AbortSignal.any([lifetime, init.signal]) : lifetime;
    requestSignal.throwIfAborted();
    if (++reads > INVESTIGATION_LIMITS.maxReads || bytes >= INVESTIGATION_LIMITS.maxTotalReadBytes) throw tooLarge();
    let response;
    try {
      response = await app.inject({
        method: 'GET',
        url: url.pathname + url.search,
        authority,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept:
            new Headers(init?.headers).get('accept') === 'application/json'
              ? 'application/json'
              : 'application/octet-stream',
        },
        payloadAsStream: true,
        signal: requestSignal,
      });
    } catch (error) {
      requestSignal.throwIfAborted();
      throw error;
    }
    const source = response.stream();
    const reader = (
      Readable.toWeb(source, { strategy: { highWaterMark: 0 } }) as ReadableStream<Uint8Array>
    ).getReader();
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const detach = () => requestSignal.removeEventListener('abort', abort);
    const cancel = (reason?: unknown) => {
      if (finished) return;
      finished = true;
      detach();
      void reader
        .cancel(reason)
        .catch(() => {})
        .finally(() => reader.releaseLock());
    };
    const fail = (error: unknown) => {
      if (finished) return;
      cancel(error);
      controller.error(error);
    };
    const abort = () => fail(requestSignal.reason);
    const body = new ReadableStream<Uint8Array>(
      {
        start(output) {
          controller = output;
          requestSignal.addEventListener('abort', abort, { once: true });
          if (requestSignal.aborted) abort();
        },
        async pull(output) {
          try {
            const { done, value } = await reader.read();
            requestSignal.throwIfAborted();
            if (finished) return;
            if (done) {
              finished = true;
              detach();
              reader.releaseLock();
              output.close();
              return;
            }
            if (value.byteLength > INVESTIGATION_LIMITS.maxTotalReadBytes - bytes) throw tooLarge();
            bytes += value.byteLength;
            output.enqueue(value);
          } catch (error) {
            fail(requestSignal.aborted ? requestSignal.reason : error);
          }
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    try {
      const headers = new Headers();
      for (const name of ['content-type', 'content-length']) {
        const value = response.headers[name];
        if (value !== undefined) headers.set(name, String(value));
      }
      if ([204, 205, 304].includes(response.statusCode)) {
        await body.cancel();
        return new Response(null, { status: response.statusCode, headers });
      }
      return new Response(body, { status: response.statusCode, headers });
    } catch (error) {
      await body.cancel(error).catch(() => {});
      throw error;
    }
  };
  return new LedgerClient(origin, bearer, fetcher);
}
