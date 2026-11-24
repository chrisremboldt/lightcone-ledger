import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerClient } from '@ledger/adapters';
import { commandsPath, recordPath } from './hazard-actor.js';
import {
  reauthenticationPath,
  runRiskAcceptance,
  signingPath,
  type RiskAcceptanceActorResult,
} from './hazard-control-actor.js';
import { maxHazardResponseBytes, validateRiskAcceptancePlan } from './hazard-plan.js';
import { ActorPending, boundedFetcher, requiredSetting, separatePaths } from './indicator-actor-common.js';
import { readPrivateText } from './private-journal.js';

// pnpm scenario:hazard:control — a simulated accountable person signs the risk acceptance of an assessed hazard,
// binding its controls. Only where Ledger offers the local fixture confirmation (local and test).
// SIMULATOR_CONTROL_PLAN, SIMULATOR_CONTROL_STATE (the journal) and SIMULATOR_CONTROL_TOKEN.

const exitStatus = { accepted: 0, rejected: 1, pending: 2 } as const;
const pattern = (path: string) => new RegExp(`^${path.replace(/\{[a-zA-Z]+\}/, '[^/]+')}$`);
const record = pattern(recordPath);
const signing = pattern(signingPath);

function allowed(method: string, path: string): boolean {
  if (method === 'POST') return path === commandsPath || path === reauthenticationPath;
  return method === 'GET' && (record.test(path) || signing.test(path));
}

export async function runHazardControlCli(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RiskAcceptanceActorResult> {
  let stage = 'configuration';
  let result: RiskAcceptanceActorResult;
  try {
    const planPath = resolve(requiredSetting(env, 'SIMULATOR_CONTROL_PLAN'));
    const statePath = resolve(requiredSetting(env, 'SIMULATOR_CONTROL_STATE'));
    const token = requiredSetting(env, 'SIMULATOR_CONTROL_TOKEN');
    if (/[\r\n]/.test(token)) throw new ActorPending('credential_invalid', 'One bearer credential is required');
    await separatePaths(planPath, statePath);
    stage = 'plan';
    const plan = validateRiskAcceptancePlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)));
    const ledger = new LedgerClient(
      plan.apiUrl,
      token,
      boundedFetcher(
        plan.apiUrl,
        fetcher,
        allowed,
        maxHazardResponseBytes,
        12,
        (method, path, search) => method === 'GET' && signing.test(path) && search === '?meaning=risk.accept',
      ),
    );
    stage = 'actor';
    result = await runRiskAcceptance(plan, statePath, ledger, token);
  } catch (error) {
    result = {
      status: 'pending',
      code: error instanceof ActorPending ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ActorPending
          ? error.message
          : 'The risk acceptance was not recorded; retain its plan and journal',
      attempts: 0,
    };
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runHazardControlCli();
  process.exitCode = exitStatus[result.status];
}
