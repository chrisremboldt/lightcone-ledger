import { isAbsolute, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { MissionSourceSchema } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  operationCapacityPreset,
  type OperationCapacity,
  type OperationMissionSource,
  type OperationReservation,
  type OperationReservationChange,
} from '@ledger/simulation-models/operation';
import { validateSmsAcceptedControlSelection, type SmsAcceptedControlSelection } from './sms-rehearsal-control.js';
import {
  validateOperationMonitoringRuntimePlan,
  type OperationMonitoringRuntimePlan,
} from './operation-monitoring-runtime.js';
import type { OperationReservationRevisionPlan } from './operation-reservation-revision.js';

export interface SmsRehearsalConfigV1 {
  version: 1;
  rehearsalId: string;
  directory: string;
  apiUrl: string;
  emulatorUrl: string;
  ports: { mqtt: number; callback: number };
  seed: 71031;
  fleet: { alpha: 1; beta: 1 };
  sourcePrincipalId: string;
  monitoringSourceId: string;
  followup: {
    radioInitialState: 'up' | 'down' | 'unknown';
    monitoringAvailable: boolean;
    departureOffsetMs: number;
    windowStartOffsetMs: number;
    windowEndOffsetMs: number;
    missionEndOffsetMs: number;
    route: OperationMissionSource['route'];
  };
}
export interface SmsRehearsalConfigV2 extends Omit<SmsRehearsalConfigV1, 'version' | 'fleet'> {
  version: 2;
  fleet: { alpha: 25; beta: 25 };
  capacityPreset: 'alpha-25.1';
  predepartureProfile: 'reserve-selected-await-release.1';
}
export interface SmsRehearsalConfigV3 extends Omit<SmsRehearsalConfigV1, 'version' | 'fleet'> {
  version: 3;
  target: 'isolated-staging.1';
  fleet: { alpha: 3; beta: 2 };
  capacityPreset: 'illustrative-25.1';
  predepartureProfile: 'reserve-selected-await-release.1';
}
export type SmsRehearsalConfig = SmsRehearsalConfigV1 | SmsRehearsalConfigV2 | SmsRehearsalConfigV3;

export interface SmsRehearsalProfileV2 {
  fleet: SmsRehearsalConfigV2['fleet'];
  capacity: OperationCapacity;
  timing: {
    sampleIntervalMs: 10000;
    cruiseMetersPerSecond: 12;
    turnaroundMs: 60000;
    chargeMs: 120000;
  };
  predeparture: { version: 'reserve-selected-await-release.1'; tenant: 'alpha'; attemptId: string } | null;
  resourceIds: Record<
    'aircraft' | 'flightPeople' | 'turnaroundCrews' | 'chargers' | 'launchPads',
    { alpha: string[]; beta: string[] }
  >;
}
export interface SmsRehearsalProfileV3 extends Omit<SmsRehearsalProfileV2, 'fleet'> {
  fleet: SmsRehearsalConfigV3['fleet'];
}
export type SmsRehearsalPhase = 'incident' | 'followup';
interface PreparationFields {
  kind: 'sms-rehearsal-preparation';
  phase: SmsRehearsalPhase;
  configDigest: string;
  preparedAt: string;
  start: string;
  runId: string;
  worldPath: string;
  identities: {
    intentId: string;
    attemptId: string;
    aircraftId: string;
    sourceSessionId: string;
    commandLinkSourceSessionId: string;
    sourceMissionId: string;
    monitoringSourceSessionId: string;
    monitoringSourceWindowId: string;
  };
  environment: Record<string, string>;
  clearEnvironment: string[];
}
type Preparation = PreparationFields &
  (
    | { version: 1; config: SmsRehearsalConfigV1 }
    | { version: 2; config: SmsRehearsalConfigV2; profile: SmsRehearsalProfileV2 }
    | { version: 3; config: SmsRehearsalConfigV3; profile: SmsRehearsalProfileV3 }
  );
export type SmsIncidentPreparation = Preparation & {
  phase: 'incident';
};
export type SmsFollowupPreparation = Preparation & {
  phase: 'followup';
  monitoring: OperationMonitoringRuntimePlan;
  selection: SmsAcceptedControlSelection;
  missionChange: OperationReservationChange & { operatingInterval: OperationMissionSource['operatingInterval'] };
};
export type SmsRehearsalPreparation = SmsIncidentPreparation | SmsFollowupPreparation;

const ajv = new Ajv({ strict: false, strictNumbers: true, validateFormats: false });
const missionShape = ajv.compile(MissionSourceSchema);
const settings = [
  'RUN_ID',
  'STATE',
  'START',
  'REQUESTED_START',
  'REQUESTED_END',
  'ORDINARY_WORK',
  'SEED',
  'FLEET_ALPHA',
  'FLEET_BETA',
  'DEMAND_MS',
  'SAMPLE_MS',
  'CAPACITY',
  'INCIDENT',
  'PROFILE',
  'COMMAND_LINK_EPISODE',
  'MISSION_PLAN',
  'PREDEPARTURE',
  'PREDEPARTURE_TENANT',
  'MQTT_PORT',
  'MQTT_URL',
  'CALLBACK_PORT',
  'BINDINGS',
  'DURATION_MS',
  'REVISION_PLAN',
  'MONITORING_PLAN',
  'MONITORING_TOKEN',
  'DEPARTURE_PLAN',
  'DEPARTURE_STATE',
  'DEPARTURE_TOKEN',
].map((name) => `SIMULATOR_WORLD_${name}`);
function invalid(reason: string): never {
  throw new Error(reason);
}
function fields(value: unknown, names: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid('Rehearsal clocks require finite explicit UTC timestamps');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19))
    return invalid('Rehearsal clock is invalid');
  return at;
}
function origin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return invalid('Rehearsal URLs require loopback origins');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return invalid('Rehearsal URLs require loopback HTTP(S) origins without credentials');
  return url.origin;
}
function at(start: string, offset: number): string {
  const value = utc(start) + offset;
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime()))
    return invalid('Rehearsal timing exceeds the supported clock');
  const result = new Date(value).toISOString();
  utc(result);
  return result;
}
function source(value: OperationMissionSource): OperationMissionSource {
  if (
    !missionShape(value) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024 ||
    utc(value.operatingInterval.start) >= utc(value.operatingInterval.end) ||
    value.altitude.minimum > value.altitude.maximum
  )
    return invalid('Rehearsal route or mission interval is unsupported');
  utc(value.occurredAt);
  return structuredClone(value);
}

export function validateSmsRehearsalConfig(value: unknown): SmsRehearsalConfig {
  const version = value !== null && typeof value === 'object' ? (value as { version?: unknown }).version : undefined;
  if (
    !fields(value, [
      'version',
      'rehearsalId',
      'directory',
      'apiUrl',
      'emulatorUrl',
      'ports',
      'seed',
      'fleet',
      'sourcePrincipalId',
      'monitoringSourceId',
      'followup',
      ...(version === 2 || version === 3 ? ['capacityPreset', 'predepartureProfile'] : []),
      ...(version === 3 ? ['target'] : []),
    ]) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    typeof value.rehearsalId !== 'string' ||
    !/^[A-Za-z0-9-]{1,30}$/.test(value.rehearsalId) ||
    typeof value.directory !== 'string' ||
    !isAbsolute(value.directory) ||
    /[\u0000-\u001f\u007f]/.test(value.directory) ||
    !fields(value.ports, ['mqtt', 'callback']) ||
    !fields(value.fleet, ['alpha', 'beta']) ||
    value.seed !== 71031 ||
    value.fleet.alpha !== (value.version === 3 ? 3 : value.version === 2 ? 25 : 1) ||
    value.fleet.beta !== (value.version === 3 ? 2 : value.version === 2 ? 25 : 1) ||
    (value.version === 2 &&
      (value.capacityPreset !== 'alpha-25.1' || value.predepartureProfile !== 'reserve-selected-await-release.1')) ||
    (value.version === 3 &&
      (value.target !== 'isolated-staging.1' ||
        value.capacityPreset !== 'illustrative-25.1' ||
        value.predepartureProfile !== 'reserve-selected-await-release.1' ||
        value.directory !== `/data/ledger/world/sms/${value.rehearsalId}`)) ||
    !identity(value.sourcePrincipalId) ||
    !identity(value.monitoringSourceId) ||
    !fields(value.followup, [
      'radioInitialState',
      'monitoringAvailable',
      'departureOffsetMs',
      'windowStartOffsetMs',
      'windowEndOffsetMs',
      'missionEndOffsetMs',
      'route',
    ])
  )
    return invalid('Rehearsal configuration has missing or unsupported fields');
  const apiUrl = origin(value.apiUrl);
  const emulatorUrl = origin(value.emulatorUrl);
  const port = (entry: unknown): entry is number =>
    Number.isSafeInteger(entry) && Number(entry) >= 1 && Number(entry) <= 65535;
  if (!port(value.ports.mqtt) || !port(value.ports.callback))
    return invalid('Rehearsal ports must be explicit valid ports');
  if (
    value.version === 3 &&
    (apiUrl !== 'http://127.0.0.1:4000' ||
      emulatorUrl !== 'http://127.0.0.1:4002' ||
      value.ports.mqtt !== 1884 ||
      value.ports.callback !== 4003)
  )
    return invalid('Version-three rehearsal requires the fixed isolated-staging endpoints');
  const httpPort = (url: string) => Number(new URL(url).port || (new URL(url).protocol === 'https:' ? 443 : 80));
  if (new Set([httpPort(apiUrl), httpPort(emulatorUrl), value.ports.mqtt, value.ports.callback]).size !== 4)
    return invalid('Rehearsal API, emulator, MQTT and callback ports must be distinct');
  const followup = value.followup;
  const offsets = [
    followup.departureOffsetMs,
    followup.windowStartOffsetMs,
    followup.windowEndOffsetMs,
    followup.missionEndOffsetMs,
  ];
  if (
    !['up', 'down', 'unknown'].includes(String(followup.radioInitialState)) ||
    typeof followup.monitoringAvailable !== 'boolean' ||
    offsets.some((offset) => !Number.isSafeInteger(offset) || Number(offset) <= 0 || Number(offset) > 3_600_000) ||
    offsets.some((offset, index) => index > 0 && Number(offset) <= Number(offsets[index - 1]))
  )
    return invalid('Rehearsal requires ordered departure, observation window and mission end offsets within one hour');
  if (value.version === 3 && Number(followup.windowEndOffsetMs) - Number(followup.windowStartOffsetMs) !== 300_000)
    return invalid('Version-three rehearsal requires a full five-minute prospective monitoring window');
  source({
    sourceMissionId: 'route-validation',
    sourceRevision: 1,
    aircraftId: 'route-validation',
    occurredAt: '2026-01-01T00:00:00.000Z',
    route: followup.route as OperationMissionSource['route'],
    lateralToleranceMeters: 30,
    altitude: { minimum: 0, maximum: 60, unit: 'm', reference: 'AGL' },
    operatingInterval: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T01:00:00.000Z' },
  });
  return {
    ...structuredClone(value),
    directory: resolve(value.directory),
    apiUrl,
    emulatorUrl,
  } as unknown as SmsRehearsalConfig;
}

function configuredResourceIds(
  runId: string,
  kind: keyof SmsRehearsalProfileV2['resourceIds'],
  counts: { alpha: number; beta: number },
): { alpha: string[]; beta: string[] } {
  const ids = (tenant: 'alpha' | 'beta') =>
    Array.from({ length: counts[tenant] }, (_, index) => {
      const suffix = `${tenant}-${String(index + 1).padStart(2, '0')}`;
      return kind === 'aircraft'
        ? `DJI-${runId}-${suffix}`
        : `${runId}-${kind === 'flightPeople' ? 'person' : kind}-${suffix}`;
    });
  return { alpha: ids('alpha'), beta: ids('beta') };
}

function profile(
  config: SmsRehearsalConfigV2,
  phase: SmsRehearsalPhase,
  runId: string,
  attemptId: string,
): SmsRehearsalProfileV2;
function profile(
  config: SmsRehearsalConfigV3,
  phase: SmsRehearsalPhase,
  runId: string,
  attemptId: string,
): SmsRehearsalProfileV3;
function profile(
  config: SmsRehearsalConfigV2 | SmsRehearsalConfigV3,
  phase: SmsRehearsalPhase,
  runId: string,
  attemptId: string,
): SmsRehearsalProfileV2 | SmsRehearsalProfileV3 {
  const capacity = operationCapacityPreset(config.capacityPreset).capacity;
  if (!capacity) return invalid('Rehearsal capacity preset is unavailable');
  const result = {
    capacity: structuredClone(capacity),
    timing: { sampleIntervalMs: 10000, cruiseMetersPerSecond: 12, turnaroundMs: 60000, chargeMs: 120000 } as const,
    predeparture:
      phase === 'followup' ? { version: config.predepartureProfile, tenant: 'alpha' as const, attemptId } : null,
    resourceIds: {
      aircraft: configuredResourceIds(runId, 'aircraft', config.fleet),
      flightPeople: configuredResourceIds(runId, 'flightPeople', capacity.flightPeople),
      turnaroundCrews: configuredResourceIds(runId, 'turnaroundCrews', capacity.turnaroundCrews),
      chargers: configuredResourceIds(runId, 'chargers', capacity.chargers),
      launchPads: configuredResourceIds(runId, 'launchPads', capacity.launchPads),
    },
  };
  return config.version === 2
    ? { fleet: structuredClone(config.fleet), ...result }
    : { fleet: structuredClone(config.fleet), ...result };
}

function base(
  configValue: SmsRehearsalConfig,
  phase: SmsRehearsalPhase,
  start: string,
  preparedAt: string,
): Preparation {
  const config = validateSmsRehearsalConfig(configValue);
  if (utc(start) > utc(preparedAt) || utc(preparedAt) - utc(start) > 30_000)
    return invalid('First rehearsal preparation requires an actual start no more than 30 seconds before preparation');
  at(start, config.followup.missionEndOffsetMs);
  const runId = `${config.rehearsalId}-${phase}`;
  const intentId = `intent-${runId}-alpha-0`;
  const attemptId = `${intentId}:attempt:1`;
  const sourceSessionId = `${intentId}-capture-1`;
  const worldPath = join(config.directory, phase, 'world.json');
  const environment: Record<string, string> = {
    LEDGER_API_URL: config.apiUrl,
    EMULATOR_BASE_URL: config.emulatorUrl,
    LEDGER_ENV: config.version === 3 ? 'staging' : 'local',
    ...(config.version === 3 ? { LEDGER_SIMULATION_TARGET: 'isolated', FLY_APP_NAME: 'ledger-staging' } : {}),
    SIMULATOR_CALLBACK_HOST: '127.0.0.1',
    SIMULATOR_WORLD_STATE: worldPath,
    SIMULATOR_WORLD_RUN_ID: runId,
    SIMULATOR_WORLD_START: start,
    SIMULATOR_WORLD_SEED: String(config.seed),
    SIMULATOR_WORLD_FLEET_ALPHA: String(config.fleet.alpha),
    SIMULATOR_WORLD_FLEET_BETA: String(config.fleet.beta),
    SIMULATOR_WORLD_DEMAND_MS: '30000',
    SIMULATOR_WORLD_SAMPLE_MS: '10000',
    SIMULATOR_WORLD_CAPACITY: config.version === 2 ? config.capacityPreset : 'illustrative-25.1',
    SIMULATOR_WORLD_INCIDENT: 'none',
    SIMULATOR_WORLD_MISSION_PLAN: 'dispatch-plan.1',
    SIMULATOR_WORLD_MQTT_PORT: String(config.ports.mqtt),
    SIMULATOR_WORLD_MQTT_URL: `mqtt://127.0.0.1:${config.ports.mqtt}`,
    SIMULATOR_WORLD_CALLBACK_PORT: String(config.ports.callback),
    ...(config.version === 3
      ? {
          SIMULATOR_WORLD_BROKER_PROFILE: 'hosted.2',
          SIMULATOR_WORLD_SMS_PREPARATION: join(config.directory, phase, 'preparation.json'),
        }
      : {}),
    ...(phase === 'incident'
      ? { SIMULATOR_WORLD_COMMAND_LINK_EPISODE: 'canal-market-relay.1' }
      : {
          SIMULATOR_WORLD_PREDEPARTURE: config.version !== 1 ? config.predepartureProfile : 'reserve-await-release.1',
          SIMULATOR_WORLD_PREDEPARTURE_TENANT: 'alpha',
          SIMULATOR_WORLD_REQUESTED_START: at(start, config.followup.departureOffsetMs),
          SIMULATOR_WORLD_REQUESTED_END: at(start, config.followup.missionEndOffsetMs),
          ...(config.version !== 1 ? { SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT: attemptId } : {}),
          SIMULATOR_WORLD_MONITORING_PLAN: join(config.directory, phase, 'monitoring.plan.json'),
        }),
  };
  const result = {
    version: 1 as const,
    kind: 'sms-rehearsal-preparation' as const,
    phase,
    config,
    configDigest: canonicalDigest(config),
    preparedAt,
    start,
    runId,
    worldPath,
    identities: {
      intentId,
      attemptId,
      aircraftId: `DJI-${runId}-alpha-01`,
      sourceSessionId,
      commandLinkSourceSessionId: `${sourceSessionId}-command-link-1`,
      sourceMissionId: `${attemptId}:mission`,
      monitoringSourceSessionId: `${runId}:monitoring:1`,
      monitoringSourceWindowId: `${runId}:window:1`,
    },
    environment,
    clearEnvironment: (config.version !== 1 ? [...settings, 'SIMULATOR_WORLD_PREDEPARTURE_ATTEMPT'] : settings).filter(
      (name) => !(name in environment) && !(phase === 'followup' && name === 'SIMULATOR_WORLD_MONITORING_TOKEN'),
    ),
  };
  if (config.version === 3) return { ...result, version: 3, config, profile: profile(config, phase, runId, attemptId) };
  return config.version === 2
    ? { ...result, version: 2, config, profile: profile(config, phase, runId, attemptId) }
    : { ...result, config };
}
export function prepareSmsIncident(
  config: SmsRehearsalConfig,
  start: string,
  preparedAt: string,
): SmsIncidentPreparation {
  return { ...base(config, 'incident', start, preparedAt), phase: 'incident' };
}
export function prepareSmsFollowup(
  config: SmsRehearsalConfig,
  start: string,
  preparedAt: string,
  incidentValue: SmsIncidentPreparation,
  selectionValue: unknown,
): SmsFollowupPreparation {
  const incident = validateSmsRehearsalPreparation(incidentValue) as SmsIncidentPreparation;
  const result = base(config, 'followup', start, preparedAt);
  if (canonicalDigest(result.config) !== incident.configDigest || utc(start) < utc(incident.start))
    return invalid('Followup must retain the same rehearsal configuration and follow the incident start');
  const end = at(start, result.config.followup.missionEndOffsetMs);
  const { selection, reference } = validateSmsAcceptedControlSelection(selectionValue, incident, start, end);
  const monitoring = validateOperationMonitoringRuntimePlan({
    version: 1,
    apiUrl: result.config.apiUrl,
    principalId: result.config.sourcePrincipalId,
    radioInitialState: result.config.followup.radioInitialState,
    monitoring: {
      version: 1,
      runId: result.runId,
      tenant: 'alpha',
      sourceId: result.config.monitoringSourceId,
      sourceSessionId: result.identities.monitoringSourceSessionId,
      sourceWindowId: result.identities.monitoringSourceWindowId,
      control: reference,
      window: {
        start: at(start, result.config.followup.windowStartOffsetMs),
        end: at(start, result.config.followup.windowEndOffsetMs),
      },
      flights: [
        {
          attemptId: result.identities.attemptId,
          initialLinkState: 'unknown',
          monitoringAvailable: result.config.followup.monitoringAvailable,
        },
      ],
    },
  });
  return {
    ...result,
    phase: 'followup',
    monitoring,
    selection,
    missionChange: {
      sourceRevision: 2,
      route: structuredClone(result.config.followup.route),
      operatingInterval: { start: at(start, result.config.followup.departureOffsetMs), end },
    },
  };
}
export function validateSmsRehearsalPreparation(
  value: unknown,
  incident?: SmsIncidentPreparation,
): SmsRehearsalPreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('Rehearsal preparation is unsupported');
  const result = value as SmsRehearsalPreparation;
  const expected =
    result.phase === 'incident'
      ? prepareSmsIncident(result.config, result.start, result.preparedAt)
      : result.phase === 'followup' && incident
        ? prepareSmsFollowup(result.config, result.start, result.preparedAt, incident, result.selection)
        : invalid('Followup preparation requires its retained incident preparation');
  if (canonicalDigest(expected) !== canonicalDigest(value))
    return invalid('Retained rehearsal preparation differs from its exact inputs');
  return expected;
}
export function prepareSmsRevision(
  followup: SmsFollowupPreparation,
  actual: OperationReservation,
): OperationReservationRevisionPlan {
  const config = validateSmsRehearsalConfig(followup.config);
  const expected = base(config, 'followup', followup.start, followup.preparedAt);
  const ids = expected.identities;
  const { monitoring: _monitoring, selection: _selection, missionChange: _change, ...common } = followup;
  if (
    followup.phase !== 'followup' ||
    followup.configDigest !== canonicalDigest(config) ||
    canonicalDigest(common) !== canonicalDigest(expected) ||
    !actual ||
    actual.phase !== 'awaiting-release' ||
    actual.id !== ids.attemptId ||
    actual.intentId !== ids.intentId ||
    actual.tenant !== 'alpha' ||
    actual.aircraftId !== ids.aircraftId ||
    actual.sourceSessionId !== ids.sourceSessionId ||
    actual.plan?.sourceMissionId !== ids.sourceMissionId ||
    actual.plan.sourceRevision !== 1 ||
    actual.plan.aircraftId !== ids.aircraftId
  )
    return invalid('Revision requires the exact original held Alpha reservation and capture identity');
  source(actual.plan);
  const change = {
    sourceRevision: 2,
    route: structuredClone(config.followup.route),
    operatingInterval: {
      start: at(followup.start, config.followup.departureOffsetMs),
      end: at(followup.start, config.followup.missionEndOffsetMs),
    },
  };
  if (canonicalDigest(change) !== canonicalDigest(followup.missionChange))
    return invalid('Followup mission revision differs from the retained recipe');
  source({ ...actual.plan, ...change });
  return {
    version: 1,
    runId: followup.runId,
    tenant: 'alpha',
    reservationId: actual.id,
    aircraftId: actual.aircraftId,
    expectedPlan: { sourceRevision: actual.plan.sourceRevision, digest: canonicalDigest(actual.plan) },
    change,
  };
}
