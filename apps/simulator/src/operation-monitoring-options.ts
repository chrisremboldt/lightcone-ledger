import { resolve } from 'node:path';
import { LedgerClient } from '@ledger/adapters';
import { assertSeparateOperationPaths } from './operation-paths.js';
import { readPrivateText } from './private-journal.js';
import { OperationMonitoringRuntime, validateOperationMonitoringRuntimePlan } from './operation-monitoring-runtime.js';

const settings = ['SIMULATOR_WORLD_MONITORING_PLAN', 'SIMULATOR_WORLD_MONITORING_TOKEN'];
const maxResponseBytes = 4 * 1024 * 1024;

function monitoringFetcher(origin: string, fetcher: typeof fetch, cancellation?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== '/openapi.json' && !url.pathname.startsWith('/v1/')) ||
      !['GET', 'POST', 'PUT'].includes(init?.method ?? 'GET')
    )
      throw new Error('Monitoring delivery requires its pinned Ledger API');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(cancellation ? [cancellation] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    let response: Response | undefined;
    const expiresAt = Date.now() + 5000;
    const timer = setTimeout(() => {
      controller.abort(new Error('Monitoring delivery timed out; retain its original submission'));
    }, 5000);
    try {
      response = await fetcher(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        signal.throwIfAborted();
      }
      if (Date.now() >= expiresAt) throw new Error('Monitoring delivery timed out; retain its original submission');
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new Error('Monitoring delivery redirects are unsupported');
      if (!response.body) return response;
      const reader = response.body.getReader();
      const cancel = () => void reader.cancel().catch(() => {});
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (Date.now() >= expiresAt) throw new Error('Monitoring delivery timed out; retain its original submission');
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes) throw new Error('Monitoring response exceeds its byte bound');
          chunks.push(value);
        }
        return new Response(length ? Buffer.concat(chunks, length) : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  };
}

export async function loadOperationMonitoringRuntime(
  env: NodeJS.ProcessEnv,
  worldPath: string,
  apiUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
  options: { signal?: AbortSignal } = {},
): Promise<OperationMonitoringRuntime | undefined> {
  if (settings.every((name) => env[name] === undefined)) return undefined;
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`${name} is required for explicit monitoring`);
    return value;
  };
  const planPath = resolve(required(settings[0]!));
  const token = required(settings[1]!);
  if (/[\r\n]/.test(token)) throw new Error('Monitoring requires one bearer credential');
  await assertSeparateOperationPaths([planPath], worldPath);
  const plan = validateOperationMonitoringRuntimePlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)));
  let runner: URL;
  try {
    runner = new URL(apiUrl);
    if (
      !['http:', 'https:'].includes(runner.protocol) ||
      runner.username ||
      runner.password ||
      runner.pathname !== '/' ||
      runner.search ||
      runner.hash
    )
      throw new Error();
  } catch {
    throw new Error('Monitoring requires an explicit Ledger API origin');
  }
  if (new URL(plan.apiUrl).origin !== runner.origin)
    throw new Error('Monitoring plan API differs from the live runner API');
  return new OperationMonitoringRuntime({
    plan,
    ledger: new LedgerClient(
      plan.apiUrl,
      token,
      monitoringFetcher(new URL(plan.apiUrl).origin, fetcher, options.signal),
    ),
  });
}
