import { resolve } from 'node:path';
import { LedgerClient } from '@ledger/adapters';
import type { MissionDepartureAuthorizationResponse } from '@ledger/contracts';
import { ReleasePending, validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import { runOperationDeparture, type OperationDepartureResult } from './operation-departure-consumer.js';
import { assertSeparateOperationPaths } from './operation-paths.js';
import type { OperationActionClock } from './operation-action-clock.js';
import type { OperationStore } from './operation-state.js';
import { OracleApi, OracleReadError } from './oracle-api.js';
import { readPrivateText } from './private-journal.js';

const settings = [
  'SIMULATOR_WORLD_DEPARTURE_PLAN',
  'SIMULATOR_WORLD_DEPARTURE_STATE',
  'SIMULATOR_WORLD_DEPARTURE_TOKEN',
];
const maxResponseBytes = 4 * 1024 * 1024;
const requestTimeoutMs = 5000;

function invalid(reason: string): never {
  throw new ReleasePending('configuration_invalid', reason);
}

function readFetcher(fetcher: typeof fetch, cancellation?: AbortSignal): typeof fetch {
  if (!cancellation) return fetcher;
  return async (input, init) => {
    const signal = AbortSignal.any([cancellation, ...(init?.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await fetcher(input, { ...init, signal });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      signal.throwIfAborted();
    }
    if (response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new OracleReadError('unverifiable', 'redirect_unsupported', 'Oracle API redirects are unsupported');
    }
    return new Response(response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) ?? null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function submitFetcher(origin: string, fetcher: typeof fetch, cancellation?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.pathname !== '/v1/commands' ||
      url.search ||
      url.hash ||
      init?.method !== 'POST'
    )
      throw new ReleasePending('submit_scope_invalid', 'Departure submission requires its pinned command endpoint');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(cancellation ? [cancellation] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    let response: Response | undefined;
    const expiresAt = Date.now() + requestTimeoutMs;
    const timer = setTimeout(() => {
      controller.abort(
        new ReleasePending('authorization_uncertain', 'The departure response timed out; retain its original request'),
      );
    }, requestTimeoutMs);
    const checkClock = () => {
      signal.throwIfAborted();
      if (Date.now() >= expiresAt)
        throw new ReleasePending(
          'authorization_uncertain',
          'The departure response timed out; retain its original request',
        );
    };
    try {
      response = await fetcher(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal,
      });
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      checkClock();
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new ReleasePending('submit_scope_invalid', 'Departure submission redirects are unsupported');
      if (!response.body) return response;
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          checkClock();
          if (done) break;
          length += value.byteLength;
          if (length > maxResponseBytes)
            throw new ReleasePending('response_too_large', 'The departure command response exceeds its byte bound');
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

export async function loadOperationDepartureRuntime(
  env: NodeJS.ProcessEnv,
  worldPath: string,
  apiUrl: string,
  fetcher: typeof fetch = globalThis.fetch,
  options: { signal?: AbortSignal; clock?: OperationActionClock } = {},
): Promise<undefined | { plan: MissionDeparturePlan; run(store: OperationStore): Promise<OperationDepartureResult> }> {
  if (settings.every((name) => env[name] === undefined)) return undefined;
  const required = (name: string) => {
    const value = env[name];
    if (!value?.trim()) throw new ReleasePending('configuration_missing', `${name} is required for explicit departure`);
    return value;
  };
  const planPath = resolve(required(settings[0]!));
  const journalPath = resolve(required(settings[1]!));
  const token = required(settings[2]!);
  if (/[\r\n]/.test(token)) throw new ReleasePending('credential_invalid', 'Departure requires one bearer credential');
  try {
    await assertSeparateOperationPaths([planPath, journalPath, `${journalPath}.lock`], worldPath);
  } catch (error) {
    if (error instanceof ReleasePending) throw error;
    return invalid('Departure plan, journal and world paths could not be resolved safely');
  }
  let plan: MissionDeparturePlan;
  try {
    plan = validateMissionDeparturePlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)) as unknown);
  } catch (error) {
    if (error instanceof ReleasePending) throw error;
    throw new ReleasePending('plan_unreadable', 'The explicit departure plan could not be read or validated');
  }
  let origin: string;
  try {
    const runner = new URL(apiUrl);
    if (!['http:', 'https:'].includes(runner.protocol) || runner.username || runner.password) throw new Error();
    origin = runner.origin;
  } catch {
    return invalid('The live runner API origin is invalid');
  }
  if (new URL(plan.apiUrl).origin !== origin) invalid('The departure plan API differs from the live runner API');
  const approved = structuredClone(plan);
  return {
    plan: structuredClone(approved),
    async run(store) {
      const api = new OracleApi(
        approved.apiUrl,
        token,
        {
          requests: 32,
          bytes: 8 * 1024 * 1024,
          timeoutMs: 30_000,
          requestTimeoutMs,
        },
        readFetcher(fetcher, options.signal),
      );
      const ledger = new LedgerClient(approved.apiUrl, token, submitFetcher(origin, fetcher, options.signal));
      return runOperationDeparture(
        structuredClone(approved),
        journalPath,
        store,
        api,
        (payload, key) =>
          ledger.request<MissionDepartureAuthorizationResponse>('/v1/commands', { method: 'POST', body: payload }, key),
        Date.now,
        options.clock,
      );
    },
  };
}
