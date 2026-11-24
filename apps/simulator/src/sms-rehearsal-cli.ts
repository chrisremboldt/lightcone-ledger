import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalize } from '@ledger/integrity';
import {
  prepareSmsFollowup,
  prepareSmsIncident,
  prepareSmsRevision,
  validateSmsRehearsalConfig,
  type SmsFollowupPreparation,
  type SmsRehearsalConfig,
  type SmsRehearsalPreparation,
} from './sms-rehearsal-plan.js';
import {
  readRetainedSmsDeparture,
  readRetainedSmsCalculation,
  readRetainedSmsReview,
  readRetainedSmsPreparation,
  readRetainedSmsRevision,
  retainSmsDeparture,
  retainSmsCalculation,
  retainSmsReview,
  retainSmsPreparation,
  retainSmsRevision,
} from './sms-rehearsal-files.js';
import { prepareSmsDeparture } from './sms-departure-preparation.js';
import { prepareSmsCalculation, type SmsCalculationPreparation } from './sms-calculation-preparation.js';
import { maxSmsReviewSelectionBytes, prepareSmsReview } from './sms-review-preparation.js';
import { readControlEffectivenessJournal } from './control-effectiveness-plan.js';
import { checkOperationDepartureSelection } from './operation-departure-consumer.js';
import { readOperationCheckpoint } from './operation-state.js';
import { readPrivateText } from './private-journal.js';

export type SmsRehearsalCliResult =
  | {
      status: 'prepared';
      phase: 'incident' | 'followup' | 'revision' | 'departure' | 'calculation' | 'review';
      runId: string;
      worldPath: string;
      file: string;
      next: string;
    }
  | { status: 'pending'; reason: string };

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

async function input(path: string, maximum: number): Promise<unknown> {
  const text = await readPrivateText(path, maximum);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('SMS preparation inputs must contain valid JSON');
  }
}

function prepared(preparation: SmsRehearsalPreparation): SmsRehearsalCliResult {
  return {
    status: 'prepared',
    phase: preparation.phase,
    runId: preparation.runId,
    worldPath: preparation.worldPath,
    file: resolve(preparation.config.directory, preparation.phase, 'world.env'),
    next:
      preparation.version === 3
        ? preparation.phase === 'incident'
          ? 'Activate this retained phase through the managed hosted producer after preserving the ordinary world. The owner opens and assesses the hazard and accepts the actual control in Safety.'
          : 'Activate this fresh monitored follow-up through the managed hosted producer. Retain its selected Alpha reservation, then prepare its exact revision; release, briefing and acknowledgement remain human actions.'
        : preparation.version !== 1
          ? preparation.phase === 'incident'
            ? 'Use the retained settings on the coordinated runtime and inspect actual per-tenant counts with SIMULATOR_WORLD_MODE=status pnpm scenario:world. Pause for a person to open the hazard, assess it and select an accepted control in Safety.'
            : 'Use the retained settings to hold the selected Alpha attempt while background flights continue. Inspect actual per-tenant counts with SIMULATOR_WORLD_MODE=status pnpm scenario:world; prepare the revision from its actual reservation. Release and briefing remain explicit human actions.'
          : preparation.phase === 'incident'
            ? 'Use the retained settings on the coordinated runtime. Pause for a person to open the hazard, assess it and select an accepted control in Safety.'
            : 'Use the retained settings to create the separate held world. Prepare its revision from the actual reservation; release and briefing remain explicit human actions.',
  };
}

async function followupCheckpoint(followup: SmsFollowupPreparation) {
  const checkpoint = await readOperationCheckpoint(followup.worldPath);
  if (!checkpoint || canonicalize(checkpoint.monitoring?.plan ?? null) !== canonicalize(followup.monitoring))
    throw new Error('Preparation requires the exact retained follow-up world and monitoring plan');
  const world = checkpoint.world;
  const selectedDemandWindow = {
    attemptId: followup.identities.attemptId,
    ...followup.missionChange.operatingInterval,
  };
  if (followup.version === 1) {
    if (
      world.config.runId !== followup.runId ||
      world.config.start !== followup.start ||
      canonicalize(world.config.selectedDemandWindow ?? null) !== canonicalize(selectedDemandWindow) ||
      world.config.predeparture?.version !== 'reserve-await-release.1' ||
      world.config.predeparture.tenant !== 'alpha'
    )
      throw new Error('Preparation requires the exact retained follow-up world and monitoring plan');
  } else {
    const { profile } = followup;
    const expectedConfig = {
      seed: followup.config.seed,
      fleet: profile.fleet,
      demandIntervalMs: 30000,
      ...profile.timing,
      incident: 'none',
      capacity: profile.capacity,
      missionPlan: 'dispatch-plan.1',
      predeparture: profile.predeparture,
      selectedDemandWindow,
      simulatedLink: {
        version: 'simulated-link.1',
        attemptId: followup.identities.attemptId,
        initialState: followup.monitoring.radioInitialState,
      },
      runId: followup.runId,
      start: new Date(followup.start).toISOString(),
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
    if (canonicalize(world.config) !== canonicalize(expectedConfig) || !resourcesMatch)
      throw new Error(
        `Preparation requires the exact retained version-${followup.version === 3 ? 'three' : 'two'} world profile and resource identities`,
      );
  }
  return checkpoint;
}

async function actualRevision(followup: SmsFollowupPreparation) {
  const checkpoint = await followupCheckpoint(followup);
  const reservation = checkpoint.world.reservations?.find((row) => row.id === followup.identities.attemptId);
  if (!reservation) throw new Error('The selected follow-up reservation has not been retained yet');
  return prepareSmsRevision(followup, reservation);
}

async function actualMonitoring(followup: SmsFollowupPreparation): Promise<SmsCalculationPreparation['actual']> {
  await followupCheckpoint(followup);
  // The live monitoring now opens a control window instead of reporting a monitoring window and its baseline, and
  // the calculation this step prepared is retired. A preparation already retained stays readable.
  throw new Error(
    'New calculation preparation needs a monitoring window, which live monitoring no longer reports; record the indicator result through the control window instead',
  );
}

async function calculation(
  config: SmsRehearsalConfig,
  configPath: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<SmsRehearsalCliResult> {
  const followup = await readRetainedSmsPreparation(config, 'followup');
  if (!followup) throw new Error('Retain the follow-up preparation before selecting its monitoring record');
  const retained = await readRetainedSmsCalculation(followup);
  const selectionPath = resolve(required(env, 'SIMULATOR_SMS_CALCULATION_SELECTION'));
  const selectionText = await readPrivateText(selectionPath, 16 * 1024);
  const preparation = prepareSmsCalculation(
    followup,
    retained?.actual ?? (await actualMonitoring(followup)),
    selectionText,
    retained?.preparedAt ?? new Date(now()).toISOString(),
  );
  await retainSmsCalculation(followup, preparation, [configPath, selectionPath]);
  return {
    status: 'prepared',
    phase: 'calculation',
    runId: followup.runId,
    worldPath: followup.worldPath,
    file: resolve(config.directory, 'followup', 'calculation.plan.json'),
    next: 'Source calculation.env, supply the separate credential and explicitly run scenario:control:calculate. Inspect its recorded calculation and currentness before a human review.',
  };
}

async function review(
  config: SmsRehearsalConfig,
  configPath: string,
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<SmsRehearsalCliResult> {
  const followup = await readRetainedSmsPreparation(config, 'followup');
  if (!followup) throw new Error('Retain the follow-up preparation before preparing its human review');
  const retained = await readRetainedSmsReview(followup);
  const calculation = await readRetainedSmsCalculation(followup);
  if (!calculation) throw new Error('Retain the calculation preparation before preparing its human review');
  const selectionPath = resolve(required(env, 'SIMULATOR_SMS_REVIEW_SELECTION'));
  const selectionText = await readPrivateText(selectionPath, maxSmsReviewSelectionBytes, { preserveBom: true });
  const actual =
    retained?.actual ??
    (await readControlEffectivenessJournal(resolve(config.directory, 'followup', 'calculation.journal.json')));
  if (!actual) throw new Error('Human review preparation requires the actual accepted calculation journal');
  const preparation = prepareSmsReview(
    followup,
    calculation,
    actual,
    selectionText,
    retained?.preparedAt ?? new Date(now()).toISOString(),
  );
  await retainSmsReview(followup, preparation, [configPath, selectionPath]);
  return {
    status: 'prepared',
    phase: 'review',
    runId: followup.runId,
    worldPath: followup.worldPath,
    file: resolve(config.directory, 'followup', 'review.plan.json'),
    next: 'Source review.env, supply the named human’s separate credential and explicitly run scenario:control:review. The actor checks current authority, context and review eligibility before submitting the authored judgment.',
  };
}

export async function runSmsRehearsalCli(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
  options: { hostedOnly?: boolean; silent?: boolean } = {},
): Promise<SmsRehearsalCliResult> {
  let result: SmsRehearsalCliResult;
  try {
    const configPath = resolve(required(env, 'SIMULATOR_SMS_CONFIG'));
    const config = validateSmsRehearsalConfig(await input(configPath, 128 * 1024));
    if (options.hostedOnly && config.version !== 3)
      throw new Error('Hosted SMS preparation requires the version-three isolated-staging configuration');
    if (config.version === 3) {
      const target = {
        LEDGER_ENV: 'staging',
        LEDGER_SIMULATION_TARGET: 'isolated',
        FLY_APP_NAME: 'ledger-staging',
        LEDGER_API_URL: config.apiUrl,
        EMULATOR_BASE_URL: config.emulatorUrl,
      };
      if (Object.entries(target).some(([name, value]) => env[name] !== value))
        throw new Error('Hosted SMS preparation requires the actual isolated ledger-staging target');
    }
    const phase = required(env, 'SIMULATOR_SMS_PHASE');
    if (
      phase !== 'incident' &&
      phase !== 'followup' &&
      phase !== 'revision' &&
      phase !== 'departure' &&
      phase !== 'calculation' &&
      phase !== 'review'
    )
      throw new Error('SIMULATOR_SMS_PHASE must be incident, followup, revision, departure, calculation or review');
    if (phase === 'review') {
      result = await review(config, configPath, env, now);
    } else if (phase === 'calculation') {
      result = await calculation(config, configPath, env, now);
    } else if (phase === 'departure') {
      const followup = await readRetainedSmsPreparation(config, 'followup');
      if (!followup) throw new Error('Retain the follow-up preparation before selecting its release');
      const retained = await readRetainedSmsDeparture(followup);
      const revision = await readRetainedSmsRevision(followup);
      if (!revision) throw new Error('Retain and apply the exact reservation revision before preparing departure');
      const selectionPath = resolve(required(env, 'SIMULATOR_SMS_DEPARTURE_SELECTION'));
      const selectionText = await readPrivateText(selectionPath, 2 * 1024 * 1024);
      let actual = retained?.actual;
      let checkpoint: Awaited<ReturnType<typeof followupCheckpoint>> | undefined;
      if (!actual) {
        checkpoint = await followupCheckpoint(followup);
        const reservation = checkpoint.world.reservations?.find((row) => row.id === followup.identities.attemptId);
        if (
          !reservation ||
          !checkpoint.reservationRevision ||
          checkpoint.departureJob ||
          checkpoint.world.departureAllocations?.length ||
          checkpoint.world.departures?.length ||
          Object.keys(checkpoint.departureRequests ?? {}).length
        )
          throw new Error('Departure preparation requires the exact revised held reservation before a departure job');
        actual = { reservation, revisionReceipt: checkpoint.reservationRevision };
      }
      const preparation = prepareSmsDeparture(
        followup,
        revision,
        actual,
        selectionText,
        retained?.preparedAt ?? new Date(now()).toISOString(),
      );
      if (checkpoint) checkOperationDepartureSelection(checkpoint, preparation.plan);
      await retainSmsDeparture(followup, preparation, [configPath, selectionPath]);
      result = {
        status: 'prepared',
        phase,
        runId: followup.runId,
        worldPath: followup.worldPath,
        file: resolve(config.directory, 'followup', 'departure.plan.json'),
        next:
          config.version === 3
            ? 'Complete the owner briefing and personal acknowledgement, remove the revision setting, then restart this same managed follow-up with departure.env and its child-only credential. Explicitly resume before the once-only departure.'
            : 'Complete the demo briefing and personal acknowledgement, then choose whether to run the existing departure consumer. Source world.env and departure.env before supplying its separate credential.',
      };
    } else if (phase === 'revision') {
      const followup = await readRetainedSmsPreparation(config, 'followup');
      if (!followup) throw new Error('Prepare the follow-up phase before binding its actual reservation');
      const revision = (await readRetainedSmsRevision(followup)) ?? (await actualRevision(followup));
      await retainSmsRevision(followup, revision, [configPath]);
      result = {
        status: 'prepared',
        phase: 'revision',
        runId: followup.runId,
        worldPath: followup.worldPath,
        file: resolve(config.directory, 'followup', 'revision.plan.json'),
        next:
          config.version === 3
            ? 'Restart this same managed follow-up with SIMULATOR_WORLD_REVISION_PLAN set to this exact plan, then explicitly resume. Inspect the accepted revised mission before the owner records release and briefing; standalone hosted revise is unavailable.'
            : 'Apply this exact plan with the existing reservation revision command, then inspect the recorded mission before a person releases or briefs it.',
      };
    } else {
      const start = required(env, 'SIMULATOR_SMS_START');
      const retained = await readRetainedSmsPreparation(config, phase);
      const preparedAt = retained?.preparedAt ?? new Date(now()).toISOString();
      if (phase === 'incident') {
        result = prepared(await retainSmsPreparation(prepareSmsIncident(config, start, preparedAt), [configPath]));
      } else {
        const incident = await readRetainedSmsPreparation(config, 'incident');
        if (!incident) throw new Error('Retain the incident phase before selecting its accepted control');
        const selectionPath = resolve(required(env, 'SIMULATOR_SMS_CONTROL_SELECTION'));
        const selection = await input(selectionPath, 2 * 1024 * 1024);
        const followup = prepareSmsFollowup(config, start, preparedAt, incident, selection);
        result = prepared(await retainSmsPreparation(followup, [configPath, selectionPath]));
      }
    }
  } catch (error) {
    result = { status: 'pending', reason: error instanceof Error ? error.message : 'SMS preparation is unavailable' };
  }
  if (!options.silent) console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runSmsRehearsalCli();
  process.exitCode = result.status === 'prepared' ? 0 : 2;
}
