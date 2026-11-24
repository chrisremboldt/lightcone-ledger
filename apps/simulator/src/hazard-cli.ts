import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import { commandsPath, promotionPath, recordPath, runHazardRecord, type HazardActorResult } from './hazard-actor.js';
import { maxHazardResponseBytes, validateHazardRecordPlan } from './hazard-plan.js';
import { ActorPending, boundedFetcher, requiredSetting, separatePaths } from './indicator-actor-common.js';
import { readPrivateText } from './private-journal.js';

// pnpm scenario:hazard — a simulated safety lead promotes a finding to a hazard on the safety record, proposes an
// avoidance area on it and assesses it. SIMULATOR_HAZARD_PLAN, SIMULATOR_HAZARD_STATE (the journal) and
// SIMULATOR_HAZARD_TOKEN.

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;
const pattern = (path: string) => new RegExp(`^${path.replace(/\{[a-zA-Z]+\}/, '[^/]+')}$`);
const reads = [pattern(promotionPath), pattern(recordPath)];

function allowed(method: string, path: string): boolean {
  if (method === 'POST') return path === commandsPath;
  return method === 'GET' && reads.some((read) => read.test(path));
}

export async function runHazardCli(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<HazardActorResult> {
  let stage = 'configuration';
  let result: HazardActorResult;
  try {
    const planPath = resolve(requiredSetting(env, 'SIMULATOR_HAZARD_PLAN'));
    const statePath = resolve(requiredSetting(env, 'SIMULATOR_HAZARD_STATE'));
    const token = requiredSetting(env, 'SIMULATOR_HAZARD_TOKEN');
    if (/[\r\n]/.test(token)) throw new ActorPending('credential_invalid', 'One bearer credential is required');
    await separatePaths(planPath, statePath);
    stage = 'plan';
    const plan = validateHazardRecordPlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)));
    const ledger = new LedgerClient(
      plan.apiUrl,
      token,
      boundedFetcher(plan.apiUrl, fetcher, allowed, maxHazardResponseBytes, 16),
    );
    stage = 'actor';
    result = await runHazardRecord(plan, statePath, ledger);
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending ? error.message : 'The hazard was not recorded; retain its plan and journal',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runHazardCli();
  process.exitCode = exitStatus[result.status];
}
