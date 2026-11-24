import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import {
  reviewPath,
  reviewsPath,
  runControlEffectivenessReview,
  type ControlEffectivenessReviewActorResult,
} from './control-effectiveness-review-actor.js';
import { maxReviewResponseBytes, validateControlEffectivenessReviewPlan } from './control-effectiveness-review-plan.js';
import { ActorPending, boundedFetcher, requiredSetting, separatePaths } from './indicator-actor-common.js';
import { readPrivateText } from './private-journal.js';

// pnpm scenario:control:review — records the planned review of one recorded indicator result.
// SIMULATOR_EFFECTIVENESS_REVIEW_PLAN, SIMULATOR_EFFECTIVENESS_REVIEW_STATE (the journal) and SIMULATOR_EFFECTIVENESS_REVIEW_TOKEN.

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;
const readPattern = new RegExp(`^${reviewPath.replace('{reviewId}', '[^/]+')}$`);

export async function runControlEffectivenessReviewCli(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ControlEffectivenessReviewActorResult> {
  let stage = 'configuration';
  let result: ControlEffectivenessReviewActorResult;
  try {
    const planPath = resolve(requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_REVIEW_PLAN'));
    const statePath = resolve(requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_REVIEW_STATE'));
    const token = requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_REVIEW_TOKEN');
    if (/[\r\n]/.test(token)) throw new ActorPending('credential_invalid', 'One bearer credential is required');
    await separatePaths(planPath, statePath);
    stage = 'plan';
    const plan = validateControlEffectivenessReviewPlan(JSON.parse(await readPrivateText(planPath, 64 * 1024)));
    const ledger = new LedgerClient(
      plan.apiUrl,
      token,
      boundedFetcher(
        plan.apiUrl,
        fetcher,
        (method, path) => (method === 'POST' ? path === reviewsPath : method === 'GET' && readPattern.test(path)),
        maxReviewResponseBytes,
      ),
    );
    stage = 'actor';
    result = await runControlEffectivenessReview(plan, statePath, ledger);
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending ? error.message : 'The review could not be recorded; retain its plan and journal',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runControlEffectivenessReviewCli();
  process.exitCode = exitStatus[result.status];
}
