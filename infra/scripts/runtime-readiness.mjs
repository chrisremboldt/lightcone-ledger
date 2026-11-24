import { setTimeout as delay } from 'node:timers/promises';

export const RUNTIME_READINESS_TIMEOUT_MS = 120_000;

async function readReadyResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Readiness body is missing');
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error('Readiness body exceeds its limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function waitForHttpReady(url, isReady, signal, fetcher = fetch) {
  const deadline = Date.now() + RUNTIME_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(2_000, deadline - Date.now()))]),
        redirect: 'error',
      });
      if (response.ok && isReady(await readReadyResponse(response))) {
        signal.throwIfAborted();
        return;
      }
      await response.body?.cancel().catch(() => {});
    } catch {
      signal.throwIfAborted();
    }
    await delay(Math.min(200, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw new Error('Runtime dependency did not become ready');
}

export function isWorldReady(value, runId) {
  return (
    value?.event === 'operation_world_ready' &&
    value.runId === runId &&
    typeof value.paused === 'boolean' &&
    Number.isSafeInteger(value.pending) &&
    value.pending >= 0
  );
}

export function isWorldStopped(value, runId) {
  return (
    value?.event === 'operation_world_stopped' &&
    value.runId === runId &&
    typeof value.drained === 'boolean' &&
    Number.isSafeInteger(value.pending) &&
    value.pending >= 0 &&
    value.drained === (value.pending === 0)
  );
}

export function waitForWorldReady(child, runId, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('World did not become ready')), RUNTIME_READINESS_TIMEOUT_MS);
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
      child.off('error', exited);
      child.off('disconnect', exited);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    }
    function message(value) {
      if (signal.aborted) aborted();
      else if (isWorldReady(value, runId)) finish(undefined, value);
    }
    function exited() {
      finish(new Error('World exited before readiness'));
    }
    function aborted() {
      finish(new Error('Runtime is stopping'));
    }
    child.on('message', message);
    child.once('exit', exited);
    child.once('error', exited);
    child.once('disconnect', exited);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
