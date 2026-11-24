import { isAbsolute, resolve } from 'node:path';
import type { ScenarioConfig } from './scenario.js';
import { advanceLiveClock, type OperationCheckpoint } from './operation-state.js';

export interface HostedSmsTarget {
  directory: string;
  phase: 'incident' | 'followup';
  preparationPath: string;
}
export type OperationTarget =
  { environment: 'local' } | { environment: 'staging'; mqttPort: 1884; sms?: HostedSmsTarget };

export const HOSTED_WORLD_LIMITS = Object.freeze({ pendingFacts: 500, advanceMs: 1000 });

export function operationTarget(env: NodeJS.ProcessEnv, path: string): OperationTarget {
  if ((env.LEDGER_ENV ?? 'local') === 'local' && !env.FLY_APP_NAME) {
    if (env.SIMULATOR_WORLD_BROKER_PROFILE !== undefined || env.SIMULATOR_WORLD_SMS_PREPARATION !== undefined)
      throw new Error('The hosted world broker profile requires the isolated staging target');
    return { environment: 'local' };
  }
  let sms: HostedSmsTarget | undefined;
  if (env.SIMULATOR_WORLD_SMS_PREPARATION !== undefined) {
    const match = /^\/data\/ledger\/world\/sms\/([A-Za-z0-9-]{1,30})\/(incident|followup)\/world\.json$/.exec(path);
    const preparationPath = path.replace(/world\.json$/, 'preparation.json');
    if (!match || env.SIMULATOR_WORLD_SMS_PREPARATION !== preparationPath)
      throw new Error('Hosted SMS requires its exact named phase checkpoint and preparation path');
    sms = {
      directory: `/data/ledger/world/sms/${match[1]}`,
      phase: match[2] as 'incident' | 'followup',
      preparationPath,
    };
  } else if (path.startsWith('/data/ledger/world/sms/'))
    throw new Error('Hosted SMS requires its retained preparation');
  if (
    env.LEDGER_ENV !== 'staging' ||
    env.LEDGER_SIMULATION_TARGET !== 'isolated' ||
    env.FLY_APP_NAME !== 'ledger-staging'
  )
    throw new Error('Hosted world delivery requires the dedicated isolated ledger-staging Fly app');
  const settings = {
    LEDGER_API_URL: 'http://127.0.0.1:4000',
    EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
    SIMULATOR_CALLBACK_HOST: '127.0.0.1',
    SIMULATOR_WORLD_CALLBACK_PORT: '4003',
    SIMULATOR_WORLD_MQTT_PORT: '1884',
    SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:1884',
    SIMULATOR_WORLD_BROKER_PROFILE: 'hosted.2',
  };
  if (Object.entries(settings).some(([name, value]) => env[name] !== value))
    throw new Error('Hosted world delivery requires its fixed loopback services and hosted.2 broker profile');
  if (
    !sms &&
    ['SIMULATOR_WORLD_DEPARTURE_PLAN', 'SIMULATOR_WORLD_DEPARTURE_STATE', 'SIMULATOR_WORLD_DEPARTURE_TOKEN'].some(
      (name) => env[name] !== undefined,
    )
  )
    throw new Error('Selected departure orchestration remains local; hosted worlds support ordinary dispatch');
  if (
    !env.SIMULATOR_WORLD_STATE ||
    !isAbsolute(env.SIMULATOR_WORLD_STATE) ||
    resolve(env.SIMULATOR_WORLD_STATE) !== path ||
    !path.startsWith('/data/ledger/') ||
    /[\s\\'"#\u0000-\u001f\u007f-\u009f]/u.test(path) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(env.SIMULATOR_WORLD_RUN_ID ?? '') ||
    (env.SIMULATOR_WORLD_BINDINGS !== undefined &&
      resolve(env.SIMULATOR_WORLD_BINDINGS) !== `${path}.broker/bindings.json`)
  )
    throw new Error('Hosted world delivery requires an explicit run ID and dedicated persistent checkpoint path');
  return { environment: 'staging', mqttPort: 1884, ...(sms ? { sms } : {}) };
}

export function assertFreshOperationStart(target: OperationTarget, startedAt: number, retained: boolean): void {
  if (target.environment === 'staging' && !retained && (startedAt > Date.now() || Date.now() - startedAt > 60_000))
    throw new Error('A fresh hosted world must start at the current UTC wall clock');
}

export function assertOperationCredentials(target: OperationTarget, config: ScenarioConfig): void {
  if (target.environment !== 'staging') return;
  const secrets = [
    config.adminKey,
    config.partnerKey,
    ...Object.values(config.tokens).flatMap((tenant) => [tenant.source, tenant.actor]),
  ];
  if (
    secrets.some(
      (value) => !value || value !== value.trim() || value.length < 24 || /^(?:ledger-local-|ledger-dev-)/.test(value),
    ) ||
    new Set(secrets).size !== secrets.length
  )
    throw new Error('Hosted world delivery requires separately provisioned tenant and role credentials');
}

export function advanceRunnerClock(
  state: OperationCheckpoint,
  wallAt: number,
  paused: boolean,
  target: OperationTarget,
): boolean {
  if (target.environment === 'local') {
    advanceLiveClock(state, wallAt, paused);
    return paused;
  }
  const pause = paused || state.world.nextFact - state.accepted >= HOSTED_WORLD_LIMITS.pendingFacts;
  advanceLiveClock(state, Math.min(wallAt, state.clock.wallAt + HOSTED_WORLD_LIMITS.advanceMs), pause);
  return pause;
}
