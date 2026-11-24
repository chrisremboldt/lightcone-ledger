import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import type { CommandResponse, SubjectExportResponse } from '@ledger/contracts';
import { runAdoptionReview, type ReviewActorResult } from './adoption-review-actor.js';
import { validateReviewPlan } from './adoption-review-plan.js';
import { OracleApi } from './oracle-api.js';
import { AdoptionPending } from './pack-adoption-review.js';
import { readPrivateText } from './private-journal.js';

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new AdoptionPending('configuration_missing', `${name} is required`);
  return value;
}

export async function runAdoptionReviewCli(env: NodeJS.ProcessEnv = process.env): Promise<ReviewActorResult> {
  let stage: 'configuration' | 'plan' | 'actor' = 'configuration';
  let result: ReviewActorResult;
  try {
    const planPath = resolve(required(env, 'SIMULATOR_REVIEW_PLAN'));
    const statePath = resolve(required(env, 'SIMULATOR_REVIEW_STATE'));
    const token = required(env, 'SIMULATOR_REVIEW_TOKEN');
    if (/[\r\n]/.test(token))
      throw new AdoptionPending('credential_invalid', 'SIMULATOR_REVIEW_TOKEN must be a bearer credential');
    stage = 'plan';
    const plan = validateReviewPlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)) as unknown);
    const metadata = new OracleApi(plan.apiUrl, token, {
      requests: 128,
      bytes: 8 * 1024 * 1024,
      timeoutMs: 120_000,
      requestTimeoutMs: 15_000,
    });
    let download: OracleApi | undefined;
    const api = {
      json: <T>(path: string) => metadata.json<T>(path),
      bytes(path: string) {
        download ??= new OracleApi(plan.apiUrl, token, {
          requests: 1,
          bytes: 32 * 1024 * 1024,
          timeoutMs: 30_000,
          requestTimeoutMs: 30_000,
        });
        return download.bytes(path);
      },
      usage() {
        const reads = metadata.usage();
        const bundle = download?.usage() ?? { requests: 0, bytes: 0 };
        return { requests: reads.requests + bundle.requests, bytes: reads.bytes + bundle.bytes };
      },
    };
    const origin = new URL(plan.apiUrl).origin;
    const submitFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        !['/v1/commands', '/v1/subject-exports'].includes(url.pathname) ||
        url.search ||
        url.hash ||
        init?.method !== 'POST'
      )
        throw new AdoptionPending(
          'submit_scope_invalid',
          'Review submission requires its exact command or export endpoint',
        );
      return globalThis.fetch(url, {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(url.pathname === '/v1/subject-exports' ? 50_000 : 5_000),
      });
    };
    const ledger = new LedgerClient(plan.apiUrl, token, submitFetch);
    stage = 'actor';
    result = await runAdoptionReview(plan, statePath, api, (endpoint, payload, key) =>
      ledger.request<CommandResponse | SubjectExportResponse>(endpoint, { method: 'POST', body: payload }, key),
    );
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof AdoptionPending ? error.code : stage === 'plan' ? 'plan_unreadable' : 'actor_unavailable',
      reason:
        error instanceof AdoptionPending
          ? error.message
          : stage === 'plan'
            ? 'The review plan could not be read or validated'
            : 'The adoption review could not be completed; retain its journal and bundle before retrying',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runAdoptionReviewCli();
  process.exitCode = exitStatus[result.status];
}
