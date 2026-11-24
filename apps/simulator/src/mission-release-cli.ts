import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import type { MissionReleaseCommandResponse } from '@ledger/contracts';
import { runMissionRelease, type MissionReleaseActorResult } from './mission-release-actor.js';
import { ReleasePending, validateMissionReleasePlan } from './mission-release-plan.js';
import { OracleApi } from './oracle-api.js';
import { readPrivateText } from './private-journal.js';

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;
const maxSubmitResponseBytes = 2 * 1024 * 1024;

async function boundedResponse(response: Response): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxSubmitResponseBytes)
        throw new ReleasePending('response_too_large', 'The release command response exceeds its byte bound');
      chunks.push(value);
    }
    return new Response(length ? Buffer.concat(chunks, length) : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new ReleasePending('configuration_missing', `${name} is required`);
  return value;
}

export async function runMissionReleaseCli(env: NodeJS.ProcessEnv = process.env): Promise<MissionReleaseActorResult> {
  let stage: 'configuration' | 'plan' | 'actor' = 'configuration';
  let result: MissionReleaseActorResult;
  try {
    const planPath = resolve(required(env, 'SIMULATOR_RELEASE_PLAN'));
    const statePath = resolve(required(env, 'SIMULATOR_RELEASE_STATE'));
    if (planPath === statePath)
      throw new ReleasePending('configuration_invalid', 'The release plan and action journal require separate paths');
    const token = required(env, 'SIMULATOR_RELEASE_TOKEN');
    if (/[\r\n]/.test(token))
      throw new ReleasePending('credential_invalid', 'SIMULATOR_RELEASE_TOKEN must be a bearer credential');
    stage = 'plan';
    const plan = validateMissionReleasePlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)) as unknown);
    const api = new OracleApi(plan.apiUrl, token, {
      requests: 32,
      bytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      requestTimeoutMs: 5_000,
    });
    const origin = new URL(plan.apiUrl).origin;
    const submitFetch: typeof fetch = async (input, init) => {
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
        throw new ReleasePending('submit_scope_invalid', 'Release submission requires its pinned command endpoint');
      return boundedResponse(
        await globalThis.fetch(url, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(5_000),
        }),
      );
    };
    const ledger = new LedgerClient(plan.apiUrl, token, submitFetch);
    stage = 'actor';
    result = await runMissionRelease(plan, statePath, api, (payload, key) =>
      ledger.request<MissionReleaseCommandResponse>('/v1/commands', { method: 'POST', body: payload }, key),
    );
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof ReleasePending ? error.code : stage === 'plan' ? 'plan_unreadable' : 'actor_unavailable',
      reason:
        error instanceof ReleasePending
          ? error.message
          : stage === 'plan'
            ? 'The release plan could not be read or validated'
            : 'The release could not be confirmed; retain its journal before retrying',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runMissionReleaseCli();
  process.exitCode = exitStatus[result.status];
}
