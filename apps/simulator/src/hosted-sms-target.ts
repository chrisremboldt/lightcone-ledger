import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalize } from '@ledger/integrity';
import type { OperationWorld } from '@ledger/simulation-models/operation';
import type { OperationTarget } from './operation-target.js';
import { readJournalEnvelope, readPrivateText } from './private-journal.js';
import type { OperationCheckpoint } from './operation-state.js';
import type { OperationReservationRevisionPlan } from './operation-reservation-revision.js';
import {
  readRetainedSmsDeparture,
  readRetainedSmsPreparation,
  readRetainedSmsRevision,
} from './sms-rehearsal-files.js';
import { validateSmsRehearsalConfig, type SmsRehearsalPreparation } from './sms-rehearsal-plan.js';

const actionSettings = [
  'SIMULATOR_WORLD_REVISION_PLAN',
  'SIMULATOR_WORLD_DEPARTURE_PLAN',
  'SIMULATOR_WORLD_DEPARTURE_STATE',
  'SIMULATOR_WORLD_DEPARTURE_TOKEN',
  'SIMULATOR_WORLD_MONITORING_TOKEN',
];

export interface HostedSmsRuntime {
  preparation: SmsRehearsalPreparation;
  revision?: OperationReservationRevisionPlan;
}

export async function loadHostedSmsTarget(
  env: NodeJS.ProcessEnv,
  target: OperationTarget,
): Promise<HostedSmsRuntime | undefined> {
  if (target.environment !== 'staging' || !target.sms) return undefined;
  const { directory, phase, preparationPath } = target.sms;
  for (const path of [
    '/data',
    '/data/ledger',
    '/data/ledger/world',
    '/data/ledger/world/sms',
    directory,
    dirname(preparationPath),
  ]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (path !== '/data' && (metadata.mode & 0o777) !== 0o700))
      throw new Error('Hosted SMS ancestors must be private regular directories');
  }
  const value = await readJournalEnvelope(preparationPath, 4 * 1024 * 1024);
  const config = validateSmsRehearsalConfig((value as { config?: unknown } | undefined)?.config);
  if (config.version !== 3 || config.directory !== directory)
    throw new Error('Hosted SMS requires its retained version-three configuration');
  const preparation = await readRetainedSmsPreparation(config, phase);
  if (!preparation || canonicalize(preparation) !== canonicalize(value))
    throw new Error('Hosted SMS requires the exact retained phase preparation');
  if (
    Object.entries(preparation.environment).some(([name, expected]) => env[name] !== expected) ||
    preparation.clearEnvironment.some((name) => !actionSettings.includes(name) && env[name] !== undefined)
  )
    throw new Error('Hosted SMS settings differ from the retained phase preparation');
  const revisionPath = env.SIMULATOR_WORLD_REVISION_PLAN;
  const departure = [
    'SIMULATOR_WORLD_DEPARTURE_PLAN',
    'SIMULATOR_WORLD_DEPARTURE_STATE',
    'SIMULATOR_WORLD_DEPARTURE_TOKEN',
  ].some((name) => env[name] !== undefined);
  if ((revisionPath !== undefined || departure) && phase !== 'followup')
    throw new Error('Hosted SMS actions require the retained follow-up phase');
  if (revisionPath !== undefined && departure)
    throw new Error('Hosted SMS revision and departure must be armed in separate stages');
  if (preparation.phase !== 'followup') return { preparation };
  const monitoringPath = join(directory, phase, 'monitoring.plan.json');
  const metadata = await lstat(monitoringPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > 128 * 1024
  )
    throw new Error('Hosted SMS monitoring plan must be a private regular file');
  if ((await readPrivateText(monitoringPath, 128 * 1024)) !== JSON.stringify(preparation.monitoring, null, 2) + '\n')
    throw new Error('Hosted SMS monitoring plan differs from its retained preparation');
  let revision;
  if (revisionPath !== undefined) {
    if (revisionPath !== join(directory, phase, 'revision.plan.json'))
      throw new Error('Hosted SMS revision requires its retained phase plan path');
    revision = await readRetainedSmsRevision(preparation);
    if (!revision) throw new Error('Hosted SMS revision has not been prepared from its actual reservation');
  }
  if (departure) {
    if (
      env.SIMULATOR_WORLD_DEPARTURE_PLAN !== join(directory, phase, 'departure.plan.json') ||
      env.SIMULATOR_WORLD_DEPARTURE_STATE !== join(directory, phase, 'departure.journal.json') ||
      !env.SIMULATOR_WORLD_DEPARTURE_TOKEN?.trim() ||
      !(await readRetainedSmsDeparture(preparation))
    )
      throw new Error('Hosted SMS departure requires its retained actual-release preparation and journal');
  }
  return { preparation, revision };
}

export function assertHostedSmsWorld(preparation: SmsRehearsalPreparation, world: OperationWorld): void {
  if (preparation.version !== 3) throw new Error('Hosted SMS requires a version-three preparation');
  const { profile } = preparation;
  const expected = {
    seed: preparation.config.seed,
    fleet: profile.fleet,
    demandIntervalMs: 30000,
    ...profile.timing,
    incident: 'none',
    capacity: profile.capacity,
    missionPlan: 'dispatch-plan.1',
    ...(preparation.phase === 'incident'
      ? { commandLinkEpisode: 'canal-market-relay.1' }
      : {
          predeparture: profile.predeparture,
          selectedDemandWindow: {
            attemptId: preparation.identities.attemptId,
            ...preparation.missionChange.operatingInterval,
          },
          simulatedLink: {
            version: 'simulated-link.1',
            attemptId: preparation.identities.attemptId,
            initialState: preparation.monitoring.radioInitialState,
          },
        }),
    runId: preparation.runId,
    start: new Date(preparation.start).toISOString(),
  };
  const resourcesMatch = (['alpha', 'beta'] as const).every(
    (tenant) =>
      canonicalize(world.aircraft.filter((row) => row.tenant === tenant).map((row) => row.id)) ===
        canonicalize(profile.resourceIds.aircraft[tenant]) &&
      (['flightPeople', 'turnaroundCrews', 'chargers', 'launchPads'] as const).every(
        (kind) =>
          canonicalize(world.resources?.[kind].filter((row) => row.tenant === tenant).map((row) => row.id) ?? []) ===
          canonicalize(profile.resourceIds[kind][tenant]),
      ),
  );
  if (canonicalize(world.config) !== canonicalize(expected) || !resourcesMatch)
    throw new Error('Hosted SMS world differs from its exact prepared profile and resource identities');
}

export function assertHostedSmsCheckpoint(preparation: SmsRehearsalPreparation, state: OperationCheckpoint): void {
  assertHostedSmsWorld(preparation, state.world);
  if (
    state.clock.mode !== 'live' ||
    canonicalize(state.monitoring?.plan ?? null) !==
      canonicalize(preparation.phase === 'followup' ? preparation.monitoring : null)
  )
    throw new Error('Hosted SMS checkpoint differs from its retained monitoring preparation');
}
