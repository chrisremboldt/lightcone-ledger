import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from '@ledger/integrity';
import {
  advanceOperation,
  activateOperationOrdinaryDispatch,
  assertOperationDemandWindows,
  capacityStatus,
  commandLinkEpisodeStatus,
  createOperation,
  operationCapacityPreset,
  operationSummary,
  applyOrdinaryIncidentBudget,
  enableOperationOrdinaryWork,
  type OperationConfig,
  type OrdinaryIncidentBudget,
} from '@ledger/simulation-models/operation';
import { scenarioConfig } from './scenario.js';
import {
  advanceRunnerClock,
  HOSTED_WORLD_LIMITS,
  assertFreshOperationStart,
  assertOperationCredentials,
  operationTarget,
} from './operation-target.js';
import { OperationDelivery } from './operation-delivery.js';
import { prepareOperationBroker, loadOperationBindings } from './operation-broker.js';
import {
  assertHostedOrdinarySourceTokens,
  assertOperationSourceReadiness,
  checkOperationReadiness,
} from './operation-readiness.js';
import { OperationTransport } from './operation-transport.js';
import { acquireControlLease } from './control-lease.js';
import {
  runOperationReservationRevision,
  validateOperationReservationRevisionPlan,
} from './operation-reservation-revision.js';
import { loadOperationDepartureRuntime } from './operation-departure-runtime.js';
import { loadOperationMonitoringRuntime } from './operation-monitoring-options.js';
import { OperationOrdinaryDispatchRuntime } from './operation-ordinary-runtime.js';
import { OperationDemoRuntime } from './operation-demo-runtime.js';
import { createOperationMonitoringRuntimeState } from './operation-monitoring-runtime.js';
import { checkOperationDepartureSelection } from './operation-departure-consumer.js';
import { readPrivateText } from './private-journal.js';
import { assertHostedSmsCheckpoint, assertHostedSmsWorld, loadHostedSmsTarget } from './hosted-sms-target.js';
import { hostedActionClock } from './operation-action-clock.js';
import { readOrdinaryIncidentBudget } from './operation-incident-budget.js';
import {
  commandLinkDeliveryStatus,
  missionDeliveryStatus,
  telemetryDeliveryInterrupted,
  telemetryDeliveryStatus,
} from './operation-delivery-policy.js';
import {
  initialOperationCheckpoint,
  lockOperation,
  OperationStore,
  readOperationCheckpoint,
  type OperationCheckpoint,
} from './operation-state.js';

const sleep = (milliseconds: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
export const HOSTED_OPERATION_DRAIN_MS = 60_000;

export interface OperationRuntimeState {
  runId: string;
  paused: boolean;
  pending: number;
}
export interface OperationStopResult {
  runId: string;
  pending: number;
  drained: boolean;
}
export interface OperationLifecycle {
  signal?: AbortSignal;
  onBrokerPrepared?: (
    prepared: Awaited<ReturnType<typeof prepareOperationBroker>> & { runId: string },
  ) => void | Promise<void>;
  onReady?: (state: OperationRuntimeState, resume: () => Promise<void>) => void | Promise<void>;
  onStopped?: (result: OperationStopResult) => void | Promise<void>;
}
class OperationStartupStopped extends Error {}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function ordinaryWorkRequested(env: NodeJS.ProcessEnv): boolean {
  const selected = env.SIMULATOR_WORLD_ORDINARY_WORK;
  if (selected === undefined) return false;
  if (selected !== 'upcoming-bounded-incidents.1')
    throw new Error('SIMULATOR_WORLD_ORDINARY_WORK must be upcoming-bounded-incidents.1');
  return true;
}

export function ordinaryDispatchRequested(env: NodeJS.ProcessEnv): boolean {
  const selected = env.SIMULATOR_WORLD_DISPATCH_REVIEW;
  if (selected === undefined) return false;
  if (selected !== 'accepted-controls.1')
    throw new Error('SIMULATOR_WORLD_DISPATCH_REVIEW must be accepted-controls.1');
  return true;
}

export function commandLinkEpisodeOptions(env: NodeJS.ProcessEnv, retained?: OperationConfig) {
  const selected = env.SIMULATOR_WORLD_COMMAND_LINK_EPISODE;
  if (selected === undefined) return {};
  if (selected !== 'canal-market-relay.1')
    throw new Error('SIMULATOR_WORLD_COMMAND_LINK_EPISODE must be canal-market-relay.1');
  if (retained && selected !== retained.commandLinkEpisode)
    throw new Error('World configuration is retained in its checkpoint; use a new path to change the episode');
  return { commandLinkEpisode: selected } as const;
}

export function missionPlanOptions(env: NodeJS.ProcessEnv, retained?: OperationConfig) {
  const selected = env.SIMULATOR_WORLD_MISSION_PLAN;
  if (selected === undefined) return {};
  if (selected !== 'dispatch-plan.1') throw new Error('SIMULATOR_WORLD_MISSION_PLAN must be dispatch-plan.1');
  if (retained && selected !== retained.missionPlan)
    throw new Error('World configuration is retained in its checkpoint; use a new path to change the mission plan');
  return { missionPlan: selected } as const;
}

export function predepartureOptions(env: NodeJS.ProcessEnv, retained?: OperationConfig) {
  const version = env.SIMULATOR_WORLD_PREDEPARTURE;
  const tenant = env.SIMULATOR_WORLD_PREDEPARTURE_TENANT;
  const attemptId = env.SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT;
  if (version === undefined && tenant === undefined && attemptId === undefined) return {};
  if (version !== 'reserve-await-release.1' && version !== 'reserve-selected-await-release.1')
    throw new Error('SIMULATOR_WORLD_PREDEPARTURE must be reserve-await-release.1 or reserve-selected-await-release.1');
  if (tenant !== 'alpha' && tenant !== 'beta')
    throw new Error('SIMULATOR_WORLD_PREDEPARTURE_TENANT must select alpha or beta');
  let predeparture: NonNullable<OperationConfig['predeparture']>;
  if (version === 'reserve-selected-await-release.1') {
    if (tenant !== 'alpha' || !attemptId?.trim())
      throw new Error('Selected predeparture requires Alpha and an explicit SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT');
    predeparture = { version, tenant, attemptId };
  } else {
    if (attemptId !== undefined)
      throw new Error('SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT requires reserve-selected-await-release.1');
    predeparture = { version, tenant };
  }
  const selectedProfile =
    version === 'reserve-selected-await-release.1' ||
    retained?.predeparture?.version === 'reserve-selected-await-release.1';
  const changed =
    retained &&
    (selectedProfile
      ? canonicalize(predeparture) !== canonicalize(retained.predeparture ?? null)
      : version !== retained.predeparture?.version || tenant !== retained.predeparture?.tenant);
  if (changed)
    throw new Error(
      'World configuration is retained in its checkpoint; use a new path to change predeparture reservations',
    );
  return { predeparture };
}

export function demandWindowOptions(env: NodeJS.ProcessEnv, retained?: OperationConfig) {
  const start = env.SIMULATOR_WORLD_REQUESTED_START;
  const end = env.SIMULATOR_WORLD_REQUESTED_END;
  if (start === undefined && end === undefined) return {};
  if (!start || !end || !env.SIMULATOR_WORLD_RUN_ID)
    throw new Error('A selected customer window requires both requested UTC clocks and an explicit run ID');
  const selectedDemandWindow = {
    attemptId: env.SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT ?? `intent-${env.SIMULATOR_WORLD_RUN_ID}-alpha-0:attempt:1`,
    start,
    end,
  };
  if (retained && canonicalize(selectedDemandWindow) !== canonicalize(retained.selectedDemandWindow ?? null))
    throw new Error('The customer window is retained; use a new request rather than moving its original promise');
  return { selectedDemandWindow };
}

function retainedOperationOptions(
  env: NodeJS.ProcessEnv,
  previous: OperationCheckpoint | undefined,
  mode: 'manual' | 'live',
) {
  const episodeOptions = commandLinkEpisodeOptions(env, previous?.world.config);
  const missionOptions = missionPlanOptions(env, previous?.world.config);
  const reservationOptions = predepartureOptions(env, previous?.world.config);
  const demandOptions = demandWindowOptions(env, previous?.world.config);
  if (
    previous &&
    (previous.clock.mode !== mode ||
      (env.SIMULATOR_WORLD_RUN_ID && previous.world.config.runId !== env.SIMULATOR_WORLD_RUN_ID))
  )
    throw new Error('Checkpoint belongs to a different world or clock mode; use a new path for a fresh run');
  if (previous) {
    const retained = previous.world.config;
    const fields = {
      SIMULATOR_WORLD_SEED: retained.seed,
      SIMULATOR_WORLD_FLEET_ALPHA: retained.fleet.alpha,
      SIMULATOR_WORLD_FLEET_BETA: retained.fleet.beta,
      SIMULATOR_WORLD_DEMAND_MS: retained.demandIntervalMs,
      SIMULATOR_WORLD_SAMPLE_MS: retained.sampleIntervalMs,
    };
    if (
      Object.entries(fields).some(([key, value]) => env[key] !== undefined && Number(env[key]) !== value) ||
      (env.SIMULATOR_WORLD_INCIDENT !== undefined && env.SIMULATOR_WORLD_INCIDENT !== (retained.incident ?? 'none')) ||
      (env.SIMULATOR_WORLD_PROFILE !== undefined && env.SIMULATOR_WORLD_PROFILE !== retained.profile) ||
      (env.SIMULATOR_WORLD_CAPACITY !== undefined && env.SIMULATOR_WORLD_CAPACITY !== retained.capacity?.id) ||
      (env.SIMULATOR_WORLD_START !== undefined && Date.parse(env.SIMULATOR_WORLD_START) !== Date.parse(retained.start))
    )
      throw new Error('World configuration is retained in its checkpoint; use a new path to change the profile');
  }
  return { episodeOptions, missionOptions, reservationOptions, demandOptions };
}

export async function runOperation(
  env: NodeJS.ProcessEnv = process.env,
  lifecycle: OperationLifecycle = {},
): Promise<void> {
  const command = env.SIMULATOR_WORLD_MODE ?? 'preview';
  if (!['preview', 'live', 'status', 'broker', 'revise'].includes(command))
    throw new Error('World mode must be preview, live, status, broker or revise');
  if (command === 'revise' && (!env.SIMULATOR_WORLD_STATE?.trim() || !env.SIMULATOR_WORLD_REVISION_PLAN?.trim()))
    throw new Error('Reservation revision requires explicit SIMULATOR_WORLD_STATE and SIMULATOR_WORLD_REVISION_PLAN');
  const mode = command === 'preview' ? 'manual' : 'live';
  const ordinaryRequested = ordinaryWorkRequested(env);
  const dispatchReviewRequested = ordinaryDispatchRequested(env);
  const path = resolve(env.SIMULATOR_WORLD_STATE ?? `.local/simulator/operation-${mode}.json`);
  if (command === 'status') {
    const state = await readOperationCheckpoint(path);
    if (!state) throw new Error('No world exists at this checkpoint path');
    console.log(
      JSON.stringify(
        {
          ...operationSummary(state.world),
          ...capacityStatus(state.world),
          ...commandLinkEpisodeStatus(state.world),
          ...commandLinkDeliveryStatus(state.world, state.pending),
          ...missionDeliveryStatus(state.world, state.pending),
          ...telemetryDeliveryStatus(state.world, state.pending),
          ...(state.monitoring ? { monitoring: state.monitoring.last } : {}),
          paused: state.clock.paused,
          accepted: state.accepted,
          pending: state.clock.mode === 'live' ? state.world.nextFact - state.accepted : 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  const target =
    ['broker', 'live'].includes(command) || env.LEDGER_ENV === 'staging' || env.FLY_APP_NAME
      ? operationTarget(env, path)
      : { environment: 'local' as const };
  if (target.environment === 'staging' && !['broker', 'live'].includes(command))
    throw new Error('Hosted world mutation supports broker preparation and live ordinary dispatch only');
  if (target.environment === 'staging' && target.sms && command === 'live' && !lifecycle.signal)
    throw new Error('Hosted SMS live execution requires the managed hosted producer');
  const hostedConfig = command === 'live' && target.environment === 'staging' ? scenarioConfig(env) : undefined;
  if (hostedConfig) assertOperationCredentials(target, hostedConfig);
  let release: (() => Promise<void>) | undefined;
  let transport: OperationTransport | undefined;
  let controlLease: Awaited<ReturnType<typeof acquireControlLease>> | undefined;
  let activeStore: OperationStore | undefined;
  let hostedSms: Awaited<ReturnType<typeof loadHostedSmsTarget>>;
  let stopRequested = false;
  let runtimeClosing = false;
  let failed = false;
  let drainDeadline = Infinity;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const deliveryCancellation = new AbortController();
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    drainDeadline = Date.now() + HOSTED_OPERATION_DRAIN_MS;
    drainTimer = setTimeout(() => deliveryCancellation.abort(), HOSTED_OPERATION_DRAIN_MS);
    drainTimer.unref();
  };
  const checkStartup = () => {
    if (stopRequested) throw new OperationStartupStopped();
  };
  lifecycle.signal?.addEventListener('abort', requestStop, { once: true });
  if (lifecycle.signal?.aborted) requestStop();
  try {
    checkStartup();
    hostedSms = await loadHostedSmsTarget(env, target);
    checkStartup();
    release = await lockOperation(path);
    checkStartup();
    const previous = await readOperationCheckpoint(path);
    checkStartup();
    const monitoring = await (lifecycle.signal
      ? loadOperationMonitoringRuntime(env, path, env.LEDGER_API_URL ?? '', undefined, {
          signal: deliveryCancellation.signal,
        })
      : loadOperationMonitoringRuntime(env, path, env.LEDGER_API_URL ?? ''));
    checkStartup();
    if (
      hostedSms &&
      canonicalize(monitoring?.plan ?? null) !==
        canonicalize(hostedSms.preparation.phase === 'followup' ? hostedSms.preparation.monitoring : null)
    )
      throw new Error('Hosted SMS requires its exact fresh monitoring plan');
    if (hostedSms?.revision && !previous) throw new Error('Hosted SMS revision requires its retained follow-up world');
    if (monitoring && !['live', 'broker'].includes(command))
      throw new Error('Monitoring can be enabled only for an explicit fresh live world');
    if (monitoring && previous && !previous.monitoring)
      throw new Error('Monitoring cannot be attached to an existing world; use a fresh path and run ID');
    if (previous?.monitoring && command === 'live' && !monitoring)
      throw new Error('Resume this monitored world with its original monitoring plan and credential');
    if (monitoring && previous?.monitoring && canonicalize(monitoring.plan) !== canonicalize(previous.monitoring.plan))
      throw new Error('Monitoring plan is retained in its checkpoint; resume with the original plan');
    if (command === 'revise' && !previous) throw new Error('Reservation revision requires an existing live world');
    const { episodeOptions, missionOptions, reservationOptions, demandOptions } = retainedOperationOptions(
      env,
      previous,
      mode,
    );
    const capacityName = env.SIMULATOR_WORLD_CAPACITY;
    if (capacityName !== undefined && capacityName !== 'illustrative-25.1' && capacityName !== 'alpha-25.1')
      throw new Error('SIMULATOR_WORLD_CAPACITY must be illustrative-25.1 or alpha-25.1');
    const selectedCapacity =
      capacityName ??
      (episodeOptions.commandLinkEpisode || reservationOptions.predeparture ? 'illustrative-25.1' : undefined);
    const preset = !previous && selectedCapacity ? operationCapacityPreset(selectedCapacity) : undefined;
    const world =
      previous?.world ??
      createOperation({
        ...(preset ?? {}),
        ...episodeOptions,
        ...missionOptions,
        ...reservationOptions,
        ...demandOptions,
        ...(monitoring
          ? {
              simulatedLink: {
                version: 'simulated-link.1' as const,
                attemptId: monitoring.plan.monitoring.flights[0]!.attemptId,
                initialState: monitoring.plan.radioInitialState,
              },
            }
          : {}),
        runId: env.SIMULATOR_WORLD_RUN_ID ?? randomUUID().slice(0, 8),
        seed: positiveInteger(env, 'SIMULATOR_WORLD_SEED', 71031),
        start: env.SIMULATOR_WORLD_START ?? new Date().toISOString(),
        fleet: {
          alpha: positiveInteger(env, 'SIMULATOR_WORLD_FLEET_ALPHA', preset?.fleet.alpha ?? 3),
          beta: positiveInteger(env, 'SIMULATOR_WORLD_FLEET_BETA', preset?.fleet.beta ?? 2),
        },
        demandIntervalMs: positiveInteger(
          env,
          'SIMULATOR_WORLD_DEMAND_MS',
          target.environment === 'staging' ? 150_000 : 30_000,
        ),
        sampleIntervalMs: positiveInteger(env, 'SIMULATOR_WORLD_SAMPLE_MS', 10_000),
        incident: (env.SIMULATOR_WORLD_INCIDENT ?? 'none') as 'none' | 'landing-disagreement',
        ...(env.SIMULATOR_WORLD_PROFILE
          ? { profile: env.SIMULATOR_WORLD_PROFILE as 'telemetry-delivery-interruption' }
          : {}),
      });
    if ((ordinaryRequested || world.ordinaryWork) && (hostedSms || monitoring))
      throw new Error('Ordinary upcoming work and bounded incidents cannot replace a selected SMS profile');
    assertOperationDemandWindows(world);
    assertFreshOperationStart(target, world.now, previous !== undefined);
    if (hostedSms) assertHostedSmsWorld(hostedSms.preparation, world);
    if (monitoring && world.config.missionPlan !== 'dispatch-plan.1')
      throw new Error('Monitoring requires the explicit dispatch-plan.1 mission profile');
    if (mode === 'live' && world.version !== 'operation-world.2')
      throw new Error(
        'This legacy world uses in-process captures; use a fresh run ID and state path for HTTP/MQTT transport',
      );
    if (mode === 'live' && world.now > Date.now()) throw new Error('A live world cannot start in the future');
    const store = new OperationStore(
      path,
      previous ??
        initialOperationCheckpoint(world, { mode, wallAt: mode === 'live' ? world.now : Date.now(), paused: false }),
    );
    if (monitoring && !previous) store.state.monitoring = createOperationMonitoringRuntimeState(monitoring.plan, world);
    if (hostedSms) assertHostedSmsCheckpoint(hostedSms.preparation, store.state);
    activeStore = store;
    if (store.state.world.ordinaryDispatch && !dispatchReviewRequested)
      throw new Error('Resume this retained ordinary world with accepted-controls.1 dispatch review enabled');
    if (dispatchReviewRequested && !['live', 'broker'].includes(command))
      throw new Error('Control-aware ordinary dispatch requires its live source coordinator');
    if (command === 'revise') {
      const planPath = resolve(env.SIMULATOR_WORLD_REVISION_PLAN!);
      if ([path, `${path}.pending`, `${path}.lock`].includes(planPath))
        throw new Error('The revision plan must be separate from the world checkpoint and its transaction files');
      const plan = validateOperationReservationRevisionPlan(JSON.parse(await readPrivateText(planPath, 128 * 1024)));
      console.log(JSON.stringify(await runOperationReservationRevision(plan, store), null, 2));
      return;
    }
    if (command === 'broker') {
      if (!env.SIMULATOR_WORLD_RUN_ID && !previous)
        throw new Error('Broker preparation requires SIMULATOR_WORLD_RUN_ID');
      await store.update(() => {});
      const broker = await prepareOperationBroker(
        world,
        `${path}.broker`,
        positiveInteger(env, 'SIMULATOR_WORLD_MQTT_PORT', 14283),
        target.environment === 'staging' ? { profile: 'hosted.2' } : undefined,
      );
      if (lifecycle.onBrokerPrepared) await lifecycle.onBrokerPrepared({ ...broker, runId: world.config.runId });
      else console.log(JSON.stringify({ ...broker, bindings: undefined, runId: world.config.runId }, null, 2));
      return;
    }
    await store.update(() => {});
    if (command === 'preview') {
      if (ordinaryRequested)
        await store.update((state) =>
          enableOperationOrdinaryWork(
            state.world,
            Object.values(state.pending)
              .flat()
              .map((entry) => entry.fact),
          ),
        );
      const duration = positiveInteger(env, 'SIMULATOR_WORLD_DURATION_MS', 600_000);
      await store.update((state) => advanceOperation(state.world, state.world.now + duration));
      console.log(
        JSON.stringify(
          {
            ...operationSummary(store.state.world),
            ...capacityStatus(store.state.world),
            ...commandLinkEpisodeStatus(store.state.world),
            ...commandLinkDeliveryStatus(store.state.world, store.state.pending),
            ...missionDeliveryStatus(store.state.world, store.state.pending),
            ...telemetryDeliveryStatus(store.state.world, store.state.pending),
            clock: 'manual',
            checkpoint: path,
          },
          null,
          2,
        ),
      );
      return;
    }
    const config = hostedConfig ?? scenarioConfig(env);
    for (const name of [
      'LEDGER_API_URL',
      'EMULATOR_BASE_URL',
      'SIMULATOR_WORLD_MQTT_URL',
      'SIMULATOR_WORLD_CALLBACK_PORT',
    ])
      if (!env[name]) throw new Error(`Live world transport requires an explicitly allocated ${name}`);
    if (
      target.environment === 'local' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.apiUrl).hostname)
    )
      throw new Error('The first world runner supports local delivery only');
    const actionClock =
      target.environment === 'staging' ? hostedActionClock(() => stopRequested || runtimeClosing) : undefined;
    const departure = await (actionClock || lifecycle.signal
      ? loadOperationDepartureRuntime(env, path, config.apiUrl, undefined, {
          clock: actionClock,
          ...(lifecycle.signal ? { signal: deliveryCancellation.signal } : {}),
        })
      : loadOperationDepartureRuntime(env, path, config.apiUrl));
    if (
      departure &&
      (!previous ||
        departure.plan.runId !== world.config.runId ||
        departure.plan.tenantId !== `tenant-${world.config.predeparture?.tenant}`)
    )
      throw new Error('Departure requires one explicitly selected reservation in this retained live world');
    if (departure) checkOperationDepartureSelection(store.state, departure.plan);
    if (target.environment === 'staging' && (ordinaryRequested || world.ordinaryWork))
      assertHostedOrdinarySourceTokens(config.tokens);
    const demoSetting = env.SIMULATOR_WORLD_AVOIDANCE_DEMO;
    if (demoSetting !== undefined && demoSetting !== 'accepted-control.1')
      throw new Error('SIMULATOR_WORLD_AVOIDANCE_DEMO must be accepted-control.1');
    if (!demoSetting && Object.keys(store.state.demoCycles ?? {}).length)
      throw new Error('Resume active demo cycles with their explicit source coordinator enabled');
    if (demoSetting && (!env.SIMULATOR_WORLD_AVOIDANCE_DEMO_ACTOR?.trim() || command !== 'live'))
      throw new Error('Avoidance demos require a live world and explicit departure actor');
    const demo = demoSetting
      ? new OperationDemoRuntime({
          apiUrl: config.apiUrl,
          sourceToken: config.tokens.alpha.source,
          actorToken: config.tokens.alpha.actor,
          departurePrincipalId: env.SIMULATOR_WORLD_AVOIDANCE_DEMO_ACTOR!,
          directory: `${path}.demo`,
          signal: deliveryCancellation.signal,
          clock: actionClock,
        })
      : undefined;
    const readiness = await checkOperationReadiness(config);
    const ordinary = dispatchReviewRequested
      ? new OperationOrdinaryDispatchRuntime({
          apiUrl: config.apiUrl,
          directory: `${path}.ordinary-dispatch`,
          signal: deliveryCancellation.signal,
          clock: actionClock,
          tenants: Object.fromEntries(
            (['alpha', 'beta'] as const).map((tenant) => {
              const principalId = env[`SIMULATOR_WORLD_DISPATCH_REVIEW_${tenant.toUpperCase()}_ACTOR`]?.trim();
              if (!principalId)
                throw new Error(
                  'Ordinary dispatch review requires an explicit automatic release service for each operator',
                );
              return [
                tenant,
                {
                  sourceToken: config.tokens[tenant].source,
                  actorToken: config.tokens[tenant].actor,
                  sourcePrincipalId: readiness.principals[tenant].source.id,
                  automaticReleasePrincipalId: principalId,
                },
              ];
            }),
          ) as import('./operation-ordinary-runtime.js').OperationOrdinaryRuntimeOptions['tenants'],
        })
      : undefined;
    checkStartup();
    if (target.environment === 'staging' || ordinaryRequested || world.ordinaryWork)
      assertOperationSourceReadiness(readiness, world.config, ordinaryRequested || Boolean(world.ordinaryWork));
    const bindings = await loadOperationBindings(
      env.SIMULATOR_WORLD_BINDINGS ?? `${path}.broker/bindings.json`,
      world,
      target.environment === 'staging' ? { profile: 'hosted.2', port: target.mqttPort } : undefined,
    );
    checkStartup();
    controlLease = await acquireControlLease(config.emulatorUrl, config.adminKey, 'scenario');
    checkStartup();
    transport = new OperationTransport({
      emulatorUrl: config.emulatorUrl,
      adminKey: config.adminKey,
      partnerKey: config.partnerKey,
      callbackHost: config.callbackHost,
      callbackPort: positiveInteger(env, 'SIMULATOR_WORLD_CALLBACK_PORT', 14203),
      mqttUrl: env.SIMULATOR_WORLD_MQTT_URL!,
      bindings,
      stateDirectory: `${path}.delivery/transport`,
      controlHeaders: () => controlLease!.headers(),
      ...(lifecycle.signal ? { signal: deliveryCancellation.signal } : {}),
    });
    await transport.start();
    checkStartup();
    if (ordinaryRequested || world.ordinaryWork)
      await store.update((state) =>
        enableOperationOrdinaryWork(
          state.world,
          Object.values(state.pending)
            .flat()
            .map((entry) => entry.fact),
        ),
      );
    if (dispatchReviewRequested) await store.update((state) => activateOperationOrdinaryDispatch(state.world));
    const delivery = new OperationDelivery(
      {
        ...config,
        stateDirectory: `${path}.delivery`,
        transport,
        departureBinding: (attemptId) => {
          const departure = store.state.world.departures?.find((entry) => entry.attemptId === attemptId);
          return departure
            ? {
                flightId: departure.flightId,
                tenantId: departure.caller.tenantId,
                aircraftId: departure.aircraftId,
                sourceSessionId: departure.sourceSessionId,
              }
            : undefined;
        },
      },
      lifecycle.signal
        ? (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([deliveryCancellation.signal, ...(init?.signal ? [init.signal] : [])]),
            })
        : undefined,
    );
    const active = new Map<string, Promise<void>>();
    const activeCommandLink = new Map<string, Promise<void>>();
    const activeMission = new Map<string, Promise<void>>();
    const retries = new Map<number, number>();
    let stopped = false;
    let paused = store.state.clock.paused;
    let pauseWork: Promise<void> = Promise.resolve();
    const stop = () => {
      stopped = true;
    };
    const togglePause = () => {
      if (stopRequested || stopped) return;
      paused = !paused;
      const selectedPause = paused;
      const at = Date.now();
      pauseWork = store
        .update((state) => {
          if (stopRequested || stopped) return;
          const appliedPause = advanceRunnerClock(state, at, selectedPause, target);
          if (target.environment === 'staging' && appliedPause && !selectedPause) paused = true;
        })
        .catch(() => {
          stopped = true;
          console.error('World pause could not be retained; stopping the scheduler');
        });
    };
    const resume = async () => {
      if (stopRequested || stopped || !paused) return;
      paused = false;
      pauseWork = store.update((state) => {
        if (stopRequested || stopped) return;
        paused = advanceRunnerClock(state, Date.now(), stopRequested, target);
      });
      await pauseWork;
    };
    if (!lifecycle.signal) {
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }
    process.on('SIGUSR1', togglePause);
    console.log(
      `Live simulation ${store.state.world.config.runId}; fictional operators. Node PID ${process.pid}. SIGUSR1 pauses/resumes the scheduler; resume catches up to wall time. Ctrl-C stops. Checkpoint: ${path}`,
    );
    let lastSummary = 0;
    let interruptedDevice: string | undefined;
    let interruptionWork: Promise<void> = Promise.resolve();
    let departureWork: Promise<void> | undefined;
    let revisionWork: Promise<void> | undefined;
    let monitoringWork: Promise<void> | undefined;
    let demoWork: Promise<void> | undefined;
    let ordinaryDispatchWork: Promise<void> | undefined;
    let nextOrdinaryDispatchAt = 0;
    let nextDemoAt = 0;
    let nextMonitoringAt = 0;
    let monitoringResult: string | undefined;
    let incidentBudgetWork: Promise<void> | undefined;
    let nextIncidentBudgetAt = 0;
    try {
      checkStartup();
      await lifecycle.onReady?.(
        { runId: world.config.runId, paused, pending: store.state.world.nextFact - store.state.accepted },
        resume,
      );
      while (!stopped) {
        const wallAt = Date.now();
        await store.update((state) => {
          const selectedPause = advanceRunnerClock(state, wallAt, paused || stopRequested, target);
          if (selectedPause && !paused && !stopRequested)
            console.error('Hosted world paused at its pending-fact limit; deliveries continue');
          paused = selectedPause;
        });
        if (stopRequested && (store.state.world.nextFact === store.state.accepted || wallAt >= drainDeadline)) {
          if (wallAt >= drainDeadline) deliveryCancellation.abort();
          break;
        }
        if (store.state.world.ordinaryWork && !stopRequested && !incidentBudgetWork && wallAt >= nextIncidentBudgetAt) {
          const reservations = structuredClone(store.state.world.ordinaryWork.incidents);
          const initial = {
            alpha: !store.state.world.ordinaryWork.baselineEstablished?.alpha,
            beta: !store.state.world.ordinaryWork.baselineEstablished?.beta,
          };
          incidentBudgetWork = readOrdinaryIncidentBudget(config, reservations, undefined, Date.now, initial)
            .then((budget) => store.update((state) => applyOrdinaryIncidentBudget(state.world, budget)))
            .catch(async () => {
              const unavailable = {
                complete: false,
                unresolved: { 'command-link': 0, 'landing-disagreement': 0 },
                reservations: [],
                reason: 'Public incident budget is unavailable',
              };
              const budget: OrdinaryIncidentBudget = {
                checkedAt: new Date().toISOString(),
                tenants: { alpha: structuredClone(unavailable), beta: structuredClone(unavailable) },
              };
              await store.update((state) => applyOrdinaryIncidentBudget(state.world, budget));
            })
            .catch(() => {
              stopped = true;
              console.error('The public incident budget could not be retained; stopping the scheduler');
            })
            .finally(() => {
              nextIncidentBudgetAt = Date.now() + 30_000;
              incidentBudgetWork = undefined;
            });
        }
        const actionClockReady =
          target.environment === 'local' || Date.now() - store.state.clock.wallAt <= HOSTED_WORLD_LIMITS.advanceMs;
        if (hostedSms?.revision && !revisionWork && !paused && !stopRequested && actionClockReady)
          revisionWork = runOperationReservationRevision(hostedSms.revision, store, Date.now, actionClock).then(
            (result) => {
              console.log(JSON.stringify({ revision: result }));
            },
            () => {
              console.error('Selected revision remains pending; retain its exact plan before restarting');
            },
          );
        if (departure && !departureWork && !paused && !stopRequested && actionClockReady)
          departureWork = departure.run(store).then(
            (result) => {
              console.log(JSON.stringify({ departure: result }));
            },
            () => {
              console.error('Selected departure remains pending; retain its exact plan and journal before restarting');
            },
          );
        if (
          monitoring &&
          !stopRequested &&
          !monitoringWork &&
          wallAt >= nextMonitoringAt &&
          !store.state.monitoring?.controlWindow?.window
        ) {
          monitoringWork = monitoring
            .run(store)
            .then((result) => {
              const summary = JSON.stringify(result);
              if (summary !== monitoringResult) console.log(JSON.stringify({ monitoring: result }));
              monitoringResult = summary;
            })
            .catch(() => {
              console.error('Monitoring delivery remains pending; retain its original plan and checkpoint');
            })
            .finally(() => {
              nextMonitoringAt = Date.now() + 5000;
              monitoringWork = undefined;
            });
        }
        if (
          ordinary &&
          !ordinaryDispatchWork &&
          !paused &&
          !stopRequested &&
          actionClockReady &&
          wallAt >= nextOrdinaryDispatchAt
        ) {
          ordinaryDispatchWork = ordinary
            .run(store)
            .catch(() => {
              console.error('Ordinary dispatch review remains held; exact source jobs and requests are retained.');
            })
            .finally(() => {
              nextOrdinaryDispatchAt = Date.now() + 5000;
              ordinaryDispatchWork = undefined;
            });
        }
        if (demo && !demoWork && !paused && !stopRequested && actionClockReady && wallAt >= nextDemoAt) {
          demoWork = demo
            .run(store)
            .catch(() => {
              console.error('Avoidance demo coordinator remains pending; retained world and requests are unchanged.');
            })
            .finally(() => {
              nextDemoAt = Date.now() + 5000;
              demoWork = undefined;
            });
        }
        const nextInterruptedDevice = telemetryDeliveryInterrupted(store.state.world)
          ? store.state.world.telemetryDeliveryInterruption!.aircraftId
          : undefined;
        if (nextInterruptedDevice !== interruptedDevice) {
          const deviceId = nextInterruptedDevice ?? interruptedDevice!;
          interruptedDevice = nextInterruptedDevice;
          interruptionWork = transport
            .setTelemetryDeliveryInterrupted(deviceId, Boolean(nextInterruptedDevice))
            .catch((error) =>
              console.error(`Telemetry delivery publisher: ${error instanceof Error ? error.message : 'unavailable'}`),
            );
        }
        const channels = [
          { heads: store.pendingHeads(), active, limit: 4 },
          { heads: store.pendingCommandLinkHeads(), active: activeCommandLink, limit: 1 },
          { heads: store.pendingMissionHeads(), active: activeMission, limit: 1 },
        ];
        const pendingSequences = new Set(
          channels.flatMap((channel) => channel.heads.map((prepared) => prepared.fact.sequence)),
        );
        for (const sequence of retries.keys()) if (!pendingSequences.has(sequence)) retries.delete(sequence);
        for (const channel of channels)
          for (const prepared of channel.heads) {
            const { fact } = prepared;
            const deliveryKey = store.deliveryKey(prepared);
            if (channel.active.size >= channel.limit) break;
            if (channel.active.has(deliveryKey) || (retries.get(fact.sequence) ?? 0) > wallAt) continue;
            const pending = (async () => {
              try {
                const result = await delivery.deliver(prepared);
                await store.accept(prepared, result.receiptId);
                retries.delete(fact.sequence);
              } catch (error) {
                retries.set(fact.sequence, Date.now() + 5000);
                console.error(
                  `Evidence pending for ${fact.attemptId}: ${error instanceof Error ? error.message : 'delivery unavailable'}`,
                );
              } finally {
                channel.active.delete(deliveryKey);
              }
            })();
            channel.active.set(deliveryKey, pending);
          }
        if (wallAt - lastSummary >= 10_000) {
          console.log(
            JSON.stringify({
              ...operationSummary(store.state.world),
              ...capacityStatus(store.state.world),
              ...commandLinkEpisodeStatus(store.state.world),
              ...commandLinkDeliveryStatus(store.state.world, store.state.pending),
              ...missionDeliveryStatus(store.state.world, store.state.pending),
              ...telemetryDeliveryStatus(store.state.world, store.state.pending),
              ...(store.state.monitoring ? { monitoring: store.state.monitoring.last } : {}),
              paused,
              accepted: store.state.accepted,
              pending: store.state.world.nextFact - store.state.accepted,
            }),
          );
          lastSummary = wallAt;
        }
        await sleep(250);
      }
    } finally {
      stopped = true;
      runtimeClosing = true;
      if (!lifecycle.signal) {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
      process.off('SIGUSR1', togglePause);
      await Promise.allSettled([...active.values(), ...activeCommandLink.values(), ...activeMission.values()]);
      await departureWork;
      await revisionWork;
      await monitoringWork;
      await demoWork;
      await ordinaryDispatchWork;
      await incidentBudgetWork;
      await pauseWork;
      await interruptionWork;
    }
  } catch (error) {
    if (!(error instanceof OperationStartupStopped)) {
      failed = true;
      throw error;
    }
  } finally {
    runtimeClosing = true;
    try {
      try {
        if (stopRequested && release) {
          if (!activeStore && !failed) {
            const retained = await readOperationCheckpoint(path);
            retainedOperationOptions(env, retained, mode);
            if (retained && hostedSms) assertHostedSmsCheckpoint(hostedSms.preparation, retained);
            if (retained) activeStore = new OperationStore(path, retained);
          }
          if (activeStore)
            await activeStore.update((state) => {
              state.clock.paused = true;
            });
        }
      } finally {
        try {
          await transport?.stop();
        } finally {
          try {
            await controlLease?.release();
          } finally {
            await release?.();
          }
        }
      }
    } finally {
      lifecycle.signal?.removeEventListener('abort', requestStop);
      if (drainTimer) clearTimeout(drainTimer);
    }
    if (stopRequested && !failed) {
      const retained = activeStore?.state ?? (await readOperationCheckpoint(path));
      retainedOperationOptions(env, retained, mode);
      if (retained && hostedSms) assertHostedSmsCheckpoint(hostedSms.preparation, retained);
      const pending = retained ? retained.world.nextFact - retained.accepted : 0;
      await lifecycle.onStopped?.({
        runId: retained?.world.config.runId ?? env.SIMULATOR_WORLD_RUN_ID ?? '',
        pending,
        drained: pending === 0,
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runOperation();
