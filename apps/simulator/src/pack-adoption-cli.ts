import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import type { CommandResponse } from '@ledger/contracts';
import { OracleApi } from './oracle-api.js';
import { runPackAdoption, type AdoptionActorResult } from './pack-adoption-actor.js';
import { AdoptionPending, validateAdoptionPlan } from './pack-adoption-review.js';
import { readAdoptionSelection, type AdoptionSelectionResult } from './adoption-selection-reader.js';

const maxPlanBytes = 128 * 1024;
const exitStatus = { accepted: 0, rejected: 1, match: 0, pending: 2, unverifiable: 3 } as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new AdoptionPending('configuration_missing', `${name} is required`);
  return value;
}

async function readPlan(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxPlanBytes)
      throw new AdoptionPending('plan_unreadable', 'The adoption plan must be a regular file no larger than 128 KiB');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxPlanBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxPlanBytes) throw new AdoptionPending('plan_unreadable', 'The adoption plan exceeds 128 KiB');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))) as unknown;
  } finally {
    await file.close();
  }
}

export async function runPackAdoptionCli(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdoptionActorResult | AdoptionSelectionResult> {
  const selectionFlightId = env.SIMULATOR_ADOPTION_SELECTION_FLIGHT_ID;
  const selectionOnly = selectionFlightId !== undefined;
  let stage: 'configuration' | 'plan' | 'actor' = 'configuration';
  let result: AdoptionActorResult | AdoptionSelectionResult;
  try {
    if (
      selectionOnly &&
      (!selectionFlightId.trim() || selectionFlightId.length > 200 || /[\u0000-\u001f\u007f]/.test(selectionFlightId))
    )
      throw new AdoptionPending(
        'selection_flight_invalid',
        'Selection inspection requires one explicit supported flight ID',
      );
    const planPath = resolve(required(env, 'SIMULATOR_ADOPTION_PLAN'));
    const statePath = resolve(required(env, 'SIMULATOR_ADOPTION_STATE'));
    const token = required(env, 'SIMULATOR_ADOPTION_TOKEN');
    if (/[\r\n]/.test(token))
      throw new AdoptionPending('credential_invalid', 'SIMULATOR_ADOPTION_TOKEN must be a bearer credential');
    stage = 'plan';
    const plan = validateAdoptionPlan(await readPlan(planPath));
    const api = new OracleApi(plan.apiUrl, token, {
      requests: 128,
      bytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      requestTimeoutMs: 5_000,
    });
    stage = 'actor';
    if (selectionOnly) result = await readAdoptionSelection(plan, statePath, selectionFlightId, api);
    else {
      const origin = new URL(plan.apiUrl).origin;
      const submitFetch: typeof fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (
          url.origin !== origin ||
          url.pathname !== '/v1/commands' ||
          url.search ||
          url.hash ||
          init?.method !== 'POST'
        )
          throw new AdoptionPending(
            'submit_scope_invalid',
            'Pack adoption submission requires its exact command endpoint',
          );
        return globalThis.fetch(url, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
          signal: AbortSignal.timeout(5_000),
        });
      };
      const ledger = new LedgerClient(plan.apiUrl, token, submitFetch);
      result = await runPackAdoption(plan, statePath, api, (payload, key) =>
        ledger.request<CommandResponse>('/v1/commands', { method: 'POST', body: payload }, key),
      );
    }
  } catch (error) {
    const code =
      error instanceof AdoptionPending ? error.code : stage === 'plan' ? 'plan_unreadable' : 'actor_unavailable';
    result = selectionOnly
      ? {
          kind: 'flight-rule-selection',
          status:
            error instanceof AdoptionPending && ['plan_invalid', 'selection_flight_invalid'].includes(error.code)
              ? 'unverifiable'
              : 'pending',
          code,
          reason:
            error instanceof AdoptionPending
              ? error.message
              : 'The selection inspection could not read its configuration',
          flightId: selectionFlightId,
        }
      : {
          status: 'pending',
          code,
          reason:
            error instanceof AdoptionPending
              ? error.message
              : stage === 'plan'
                ? 'The adoption plan could not be read or validated'
                : 'The pack adoption action could not be completed; retain its state before retrying',
          attempts: 0,
        };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runPackAdoptionCli();
  process.exitCode = exitStatus[result.status];
}
