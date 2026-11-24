import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import {
  runControlEffectiveness,
  resultPath,
  resultsPath,
  windowsPath,
  type ControlEffectivenessActorResult,
} from './control-effectiveness-actor.js';
import { maxCalculationResponseBytes, validateControlEffectivenessPlan } from './control-effectiveness-plan.js';
import { ActorPending, boundedFetcher, requiredSetting, separatePaths } from './indicator-actor-common.js';
import { readPrivateText } from './private-journal.js';

// pnpm scenario:control:calculate — opens the planned control window and records its indicator result.
// SIMULATOR_EFFECTIVENESS_PLAN, SIMULATOR_EFFECTIVENESS_STATE (the journal) and SIMULATOR_EFFECTIVENESS_TOKEN.

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;
const segment = '[^/]+';
const recordPattern = new RegExp(`^${resultsPath.replace('{windowId}', segment)}$`);
const readPattern = new RegExp(`^${resultPath.replace('{resultId}', segment)}$`);

function allowed(method: string, path: string): boolean {
  if (method === 'POST') return path === windowsPath || recordPattern.test(path);
  return method === 'GET' && readPattern.test(path);
}

export async function runControlEffectivenessCli(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<ControlEffectivenessActorResult> {
  let stage = 'configuration';
  let result: ControlEffectivenessActorResult;
  try {
    const planPath = resolve(requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_PLAN'));
    const statePath = resolve(requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_STATE'));
    const token = requiredSetting(env, 'SIMULATOR_EFFECTIVENESS_TOKEN');
    if (/[\r\n]/.test(token)) throw new ActorPending('credential_invalid', 'One bearer credential is required');
    await separatePaths(planPath, statePath);
    stage = 'plan';
    const plan = validateControlEffectivenessPlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)));
    const ledger = new LedgerClient(
      plan.apiUrl,
      token,
      boundedFetcher(plan.apiUrl, fetcher, allowed, maxCalculationResponseBytes),
    );
    stage = 'actor';
    result = await runControlEffectiveness(plan, statePath, ledger);
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending ? error.message : 'The result could not be recorded; retain its plan and journal',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runControlEffectivenessCli();
  process.exitCode = exitStatus[result.status];
}
