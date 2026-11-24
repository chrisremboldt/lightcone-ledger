import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  RUNTIME_READINESS_TIMEOUT_MS,
  isWorldStopped,
  waitForHttpReady,
  waitForWorldReady,
} from '../../infra/scripts/runtime-readiness.mjs';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('slow HTTP startup can become ready after thirty seconds while its overall wait remains finite', async () => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const controller = new AbortController();
  const slow = vi.fn(async () => {
    if (now === 0) {
      now = 45_000;
      throw new Error('Dependency has not started listening');
    }
    return Response.json({ status: 'ready' });
  });
  await waitForHttpReady(
    'http://127.0.0.1:4000/readyz',
    (body: { status: string }) => body.status === 'ready',
    controller.signal,
    slow,
  );
  expect(slow).toHaveBeenCalledTimes(2);
  expect(now).toBeGreaterThan(30_000);

  now = 0;
  const unavailable = vi.fn(async () => {
    now += 30_000;
    throw new Error('Dependency remains unavailable');
  });
  await expect(
    waitForHttpReady('http://127.0.0.1:4000/readyz', () => true, controller.signal, unavailable),
  ).rejects.toThrow('did not become ready');
  expect(now).toBe(RUNTIME_READINESS_TIMEOUT_MS);
  expect(unavailable).toHaveBeenCalledTimes(4);
});

test('HTTP startup cancellation aborts its current bounded request without another poll', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const pending = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = options.signal as AbortSignal;
        requestSignal.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
      }),
  );
  const ready = waitForHttpReady('http://127.0.0.1:4000/readyz', () => true, controller.signal, pending);
  const rejected = expect(ready).rejects.toThrow();
  controller.abort();
  await rejected;
  expect(requestSignal?.aborted).toBe(true);
  expect(pending).toHaveBeenCalledOnce();
});

test('cancellation while reading an otherwise ready body cannot complete startup', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          pull(body) {
            controller.abort();
            body.enqueue(new TextEncoder().encode('{"status":"ready"}'));
            body.close();
          },
        }),
      ),
  );
  await expect(
    waitForHttpReady('http://127.0.0.1:4000/readyz', () => true, controller.signal, fetcher),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});

test('slow exact-run world readiness succeeds and its finite timeout releases every listener', async () => {
  vi.useFakeTimers();
  const child = new EventEmitter();
  const controller = new AbortController();
  const ready = waitForWorldReady(child, 'retained-run', controller.signal);
  await vi.advanceTimersByTimeAsync(45_000);
  child.emit('message', { event: 'operation_world_ready', runId: 'another-run', paused: false, pending: 0 });
  expect(child.listenerCount('message')).toBe(1);
  child.emit('message', { event: 'operation_world_ready', runId: 'retained-run', paused: false, pending: 0 });
  await expect(ready).resolves.toMatchObject({ runId: 'retained-run' });
  expect(child.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);

  const unavailable = waitForWorldReady(child, 'retained-run', controller.signal);
  const rejected = expect(unavailable).rejects.toThrow('did not become ready');
  await vi.advanceTimersByTimeAsync(RUNTIME_READINESS_TIMEOUT_MS);
  await rejected;
  expect(child.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

test('startup requires the actual ready response and cancellation prevents another readiness request', async () => {
  const controller = new AbortController();
  const ready = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({ status: 'ready', role: 'ledger_app' }),
  );
  await waitForHttpReady(
    'http://127.0.0.1:4000/readyz',
    (body: { status: string; role: string }) => body.status === 'ready' && body.role === 'ledger_app',
    controller.signal,
    ready,
  );
  expect(ready).toHaveBeenCalledOnce();
  expect(ready.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });

  controller.abort();
  await expect(
    waitForHttpReady('http://127.0.0.1:4000/readyz', () => true, controller.signal, ready),
  ).rejects.toThrow();
  expect(ready).toHaveBeenCalledOnce();
});

test('world startup needs the selected run readiness and releases listeners on success or cancellation', async () => {
  const child = new EventEmitter();
  const controller = new AbortController();
  const ready = waitForWorldReady(child, 'retained-run', controller.signal);
  let completed = false;
  void ready.then(() => {
    completed = true;
  });
  child.emit('message', { event: 'operation_world_ready', runId: 'another-run', paused: false, pending: 0 });
  await Promise.resolve();
  expect(completed).toBe(false);
  child.emit('message', { event: 'operation_world_ready', runId: 'retained-run', paused: true, pending: 7 });
  expect(await ready).toMatchObject({ paused: true, pending: 7 });
  expect(child.eventNames()).toEqual([]);
  expect(
    isWorldStopped(
      { event: 'operation_world_stopped', runId: 'retained-run', pending: 7, drained: true },
      'retained-run',
    ),
  ).toBe(false);

  const aborted = waitForWorldReady(child, 'retained-run', controller.signal);
  controller.abort();
  await expect(aborted).rejects.toThrow('stopping');
  expect(child.eventNames()).toEqual([]);
});
