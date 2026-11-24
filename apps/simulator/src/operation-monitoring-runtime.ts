import {
  ControlWindowResponseSchema,
  type ControlWindow,
  type ControlWindowOpen,
  type FlightSummary,
  type Principal,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/adapters';
import { commandLinkLossesPerFlightHourV1 } from '@ledger/domain/builtin-packs';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import {
  createOperationMonitoringObserver,
  createFutureOperationMonitoringObserver,
  operationMonitoringSnapshot,
  type OperationMonitoringObserver,
  type OperationWorld,
} from '@ledger/simulation-models/operation';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import type { OperationMonitoringPlan } from '@ledger/simulation-models/operation';
import { OPERATION_MONITORING_JOURNAL_LIMITS } from './operation-monitoring-source.js';
import type { OperationStore } from './operation-state.js';

// Monitoring for a monitored flight: once its prospective window has been observed, the source opens a control
// window for the accepted control over that period, naming the flight as its complete population, for the lost-link
// indicator. The link reports themselves arrive as link.status observations through the ordinary delivery. The
// request is retained with its key before it is sent, so a retry replays it exactly. Older runtimes reported a
// baseline and a monitoring window through their own intake; those records stay readable where they were recorded.

/** The public flight a monitored attempt resolved to, and the capture session its link reports use. */
export interface OperationMonitoringFlightBinding {
  attemptId: string;
  tenantId: string;
  sourceId: string;
  sourceSessionId: string;
  flight: Pick<FlightSummary, 'id' | 'originationKey' | 'aircraft'>;
}

export interface OperationMonitoringRuntimePlan {
  version: 1;
  apiUrl: string;
  principalId: string;
  monitoring: OperationMonitoringPlan;
  radioInitialState: 'up' | 'down' | 'unknown';
}
/** The control window request, retained with its key before it is sent, and the window Ledger opened. */
export interface OperationMonitoringControlWindow {
  request: ControlWindowOpen;
  key: string;
  window?: { id: string; digest: string };
}
export interface OperationMonitoringRuntimeState {
  version: 'operation.monitoring-runtime.2';
  plan: OperationMonitoringRuntimePlan;
  observer: OperationMonitoringObserver;
  binding?: OperationMonitoringFlightBinding;
  controlWindow?: OperationMonitoringControlWindow;
  last?: OperationMonitoringRuntimeResult;
}
export interface OperationMonitoringRuntimeResult {
  status: 'pending' | 'accepted';
  code: string;
  reason: string;
  controlWindowId?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const windowResponseShape = ajv.compile(ControlWindowResponseSchema);
const same = (left: unknown, right: unknown) => canonicalize(left) === canonicalize(right);
const clone = <T>(value: T): T => structuredClone(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    record(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function invalid(reason: string): never {
  throw new Error(reason);
}
function utc(value: unknown): number {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return invalid('Monitoring requires a finite UTC clock');
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toISOString().slice(0, 19) !== value.slice(0, 19))
    return invalid('Monitoring requires a finite UTC clock');
  return at;
}
function origin(value: unknown): string {
  if (typeof value !== 'string') return invalid('Monitoring requires an explicit API origin');
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    return invalid('Monitoring requires an explicit API origin');
  return url.origin;
}
const tenant = (plan: OperationMonitoringRuntimePlan) => `tenant-${plan.monitoring.tenant}`;

export function validateOperationMonitoringRuntimePlan(value: unknown): OperationMonitoringRuntimePlan {
  if (
    !fields(value, ['version', 'apiUrl', 'principalId', 'monitoring', 'radioInitialState']) ||
    value.version !== 1 ||
    !id(value.principalId) ||
    !['up', 'down', 'unknown'].includes(String(value.radioInitialState))
  )
    return invalid('Monitoring requires an explicit principal, plan and physical radio state');
  const apiUrl = origin(value.apiUrl);
  const plan = value.monitoring;
  if (
    !fields(plan, [
      'version',
      'runId',
      'tenant',
      'sourceId',
      'sourceSessionId',
      'sourceWindowId',
      'control',
      'window',
      'flights',
    ]) ||
    plan.version !== 1 ||
    ![plan.runId, plan.sourceId, plan.sourceSessionId, plan.sourceWindowId].every(id) ||
    !['alpha', 'beta'].includes(String(plan.tenant)) ||
    !fields(plan.control, [
      'hazardId',
      'controlId',
      'controlVersion',
      'controlEventId',
      'controlDigest',
      'acceptance',
    ]) ||
    ![plan.control.hazardId, plan.control.controlId, plan.control.controlEventId].every(id) ||
    !positive(plan.control.controlVersion) ||
    !digest(plan.control.controlDigest) ||
    !fields(plan.control.acceptance, ['id', 'acceptedRevision', 'digest']) ||
    !id(plan.control.acceptance.id) ||
    !positive(plan.control.acceptance.acceptedRevision) ||
    !digest(plan.control.acceptance.digest) ||
    !fields(plan.window, ['start', 'end']) ||
    !Array.isArray(plan.flights) ||
    plan.flights.length !== 1 ||
    !fields(plan.flights[0], ['attemptId', 'initialLinkState', 'monitoringAvailable']) ||
    !id(plan.flights[0].attemptId) ||
    !['up', 'down', 'unknown'].includes(String(plan.flights[0].initialLinkState)) ||
    typeof plan.flights[0].monitoringAvailable !== 'boolean'
  )
    return invalid('Monitoring requires one exact retained attempt, control and source window');
  const duration = utc(plan.window.end) - utc(plan.window.start);
  if (duration <= 0 || duration > 3_600_000) return invalid('Monitoring window must be positive and at most one hour');
  return { ...clone(value), apiUrl } as unknown as OperationMonitoringRuntimePlan;
}

function worldIdentity(plan: OperationMonitoringRuntimePlan, world: OperationWorld): void {
  const selected = plan.monitoring.flights[0]!;
  if (
    world.config.runId !== plan.monitoring.runId ||
    (world.config.missionPlan !== 'dispatch-plan.1' &&
      !world.demoFlights?.some((flight) => flight.attemptId === selected.attemptId)) ||
    (!world.demoFlights?.some(
      (flight) =>
        flight.attemptId === selected.attemptId &&
        flight.tenant === plan.monitoring.tenant &&
        flight.radioInitialState === plan.radioInitialState,
    ) &&
      !same(world.config.simulatedLink, {
        version: 'simulated-link.1',
        attemptId: selected.attemptId,
        initialState: plan.radioInitialState,
      }))
  )
    invalid('Monitoring plan differs from its fresh world, mission profile or physical radio');
}
export function createOperationMonitoringRuntimeState(
  value: OperationMonitoringRuntimePlan,
  world: OperationWorld,
  future = false,
): OperationMonitoringRuntimeState {
  const plan = validateOperationMonitoringRuntimePlan(value);
  worldIdentity(plan, world);
  return {
    version: 'operation.monitoring-runtime.2',
    plan,
    observer: future
      ? createFutureOperationMonitoringObserver(world, plan.monitoring)
      : createOperationMonitoringObserver(world, plan.monitoring),
  };
}

/** The window the monitoring opens: the plan's control and period, with the bound flight as its whole population. */
export function operationMonitoringControlWindowRequest(
  plan: OperationMonitoringRuntimePlan,
  binding: OperationMonitoringFlightBinding,
): OperationMonitoringControlWindow {
  const control = plan.monitoring.control;
  const indicator = commandLinkLossesPerFlightHourV1();
  return {
    request: {
      control: {
        kind: 'control_record',
        hazardId: control.hazardId,
        recordId: control.controlId,
        versionNumber: control.controlVersion,
        bodyDigest: control.controlDigest,
        acceptanceId: control.acceptance.id,
      },
      period: { ...plan.monitoring.window },
      subjectKind: 'flight',
      subjects: [{ scope: 'ledger', kind: 'flight', id: binding.flight.id }],
      complete: true,
      // The indicator counts link reports and measures exposure from reported takeoff and landing, so the window
      // expects both.
      expectedObservations: [
        { type: 'flight.report', versions: [1] },
        { type: 'link.status', versions: [1] },
      ],
      indicators: [{ id: indicator.id, version: indicator.version, digest: indicator.digest }],
      note: 'The simulated flight monitored over its prospective window; its link reports arrive as link.status observations.',
    },
    key: `monitoring:control-window:${canonicalDigest({
      tenantId: tenant(plan),
      runId: plan.monitoring.runId,
      sourceId: plan.monitoring.sourceId,
      sourceWindowId: plan.monitoring.sourceWindowId,
    })}`,
  };
}

/** True when the window Ledger returned is the one requested. */
function openedAsRequested(window: ControlWindow, request: ControlWindowOpen): boolean {
  return (
    window.variant === 'generic' &&
    same(window.control, request.control) &&
    same(window.period, request.period) &&
    window.population.subjectKind === request.subjectKind &&
    same(window.population.subjects, request.subjects) &&
    window.population.complete === request.complete &&
    same(window.expectedObservations, request.expectedObservations) &&
    same(window.indicators, request.indicators)
  );
}

export function validateOperationMonitoringRuntimeState(
  value: unknown,
  world: OperationWorld,
): OperationMonitoringRuntimeState {
  if (
    !fields(value, ['version', 'plan', 'observer'], ['binding', 'controlWindow', 'last']) ||
    value.version !== 'operation.monitoring-runtime.2' ||
    Buffer.byteLength(JSON.stringify(value)) > OPERATION_MONITORING_JOURNAL_LIMITS.maxBytes + 2 * 1024 * 1024
  )
    return invalid('Monitoring runtime checkpoint exceeds its shape or byte bound');
  const state = value as unknown as OperationMonitoringRuntimeState;
  const plan = validateOperationMonitoringRuntimePlan(state.plan);
  if (!same(plan, state.plan)) return invalid('Monitoring API origin changed');
  worldIdentity(plan, world);
  const snapshot = operationMonitoringSnapshot(state.observer);
  const observed = snapshot.flights[0]!;
  if (
    !same(state.observer.plan, plan.monitoring) ||
    (!world.demoFlights?.some((flight) => flight.attemptId === plan.monitoring.flights[0]!.attemptId) &&
      state.observer.startedAt !== new Date(Date.parse(world.config.start)).toISOString()) ||
    utc(state.observer.observedThrough) > world.now ||
    state.observer.nextFact > world.nextFact ||
    snapshot.flights.length !== 1 ||
    state.observer.flights.some(
      (flight) =>
        typeof flight.monitoringAvailable !== 'boolean' ||
        typeof flight.telemetryDeliveryAvailable !== 'boolean' ||
        flight.reports.length > 128 ||
        flight.observedIntervals.length > 16 ||
        flight.coverageIntervals.length > 16 ||
        flight.gaps.length > 16,
    ) ||
    (observed.initialLinkObservation && observed.initialLinkObservation.state !== plan.radioInitialState)
  )
    return invalid('Monitoring retained observer differs from its fresh physical world or bounds');
  if (
    state.binding &&
    (!fields(state.binding, ['attemptId', 'tenantId', 'sourceId', 'sourceSessionId', 'flight']) ||
      !fields(state.binding.flight, ['id', 'originationKey', 'aircraft']) ||
      !id(state.binding.flight.id) ||
      state.binding.attemptId !== observed.attemptId ||
      state.binding.flight.originationKey !== observed.attemptId ||
      state.binding.flight.aircraft !== observed.aircraftId ||
      state.binding.tenantId !== tenant(plan) ||
      state.binding.sourceId !== observed.c2SourceId ||
      state.binding.sourceSessionId !== observed.c2SourceSessionId)
  )
    return invalid('Monitoring public flight binding changed');
  if (state.controlWindow) {
    if (
      !state.binding ||
      !fields(state.controlWindow, ['request', 'key'], ['window']) ||
      !same(
        { request: state.controlWindow.request, key: state.controlWindow.key },
        operationMonitoringControlWindowRequest(plan, state.binding),
      ) ||
      (state.controlWindow.window !== undefined &&
        (!fields(state.controlWindow.window, ['id', 'digest']) ||
          !id(state.controlWindow.window.id) ||
          !digest(state.controlWindow.window.digest)))
    )
      return invalid('Monitoring control window request changed its control, period, population or key');
  }
  return clone(state);
}

/**
 * Whether a link report of the monitored attempt may be delivered: once the attempt's public flight is bound, so its
 * reports cite the flight the window names.
 */
export function operationMonitoringStatusAllowed(
  state: OperationMonitoringRuntimeState | undefined,
  attemptId: string,
): boolean {
  if (!state || state.plan.monitoring.flights[0]?.attemptId !== attemptId) return true;
  if (!state.binding) return false;
  try {
    const observed = operationMonitoringSnapshot(state.observer).flights[0]!;
    return (
      state.binding.attemptId === observed.attemptId &&
      state.binding.flight.aircraft === observed.aircraftId &&
      state.binding.sourceId === observed.c2SourceId &&
      state.binding.sourceSessionId === observed.c2SourceSessionId
    );
  } catch {
    return false;
  }
}

class MonitoringPending extends Error {
  constructor(
    readonly code: string,
    reason: string,
  ) {
    super(reason);
  }
}
function pending(code: string, reason: string): never {
  throw new MonitoringPending(code, reason);
}

export class OperationMonitoringRuntime {
  readonly plan: OperationMonitoringRuntimePlan;
  private readonly ledger: LedgerClient;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly cycleId?: string;
  constructor(config: { plan: OperationMonitoringRuntimePlan; ledger: LedgerClient; cycleId?: string }) {
    this.cycleId = config.cycleId;
    this.plan = validateOperationMonitoringRuntimePlan(config.plan);
    if (origin(config.ledger.baseUrl) !== this.plan.apiUrl)
      invalid('Monitoring client differs from its pinned API origin');
    this.ledger = config.ledger;
  }
  run(store: OperationStore): Promise<OperationMonitoringRuntimeResult> {
    const task = this.serial.then(() => this.deliver(store));
    this.serial = task.catch(() => undefined);
    return task;
  }
  private current(store: OperationStore): OperationMonitoringRuntimeState {
    const state = this.cycleId ? store.state.demoCycles?.[this.cycleId]?.monitoring : store.state.monitoring;
    if (!state || !same(state.plan, this.plan)) return invalid('Monitoring runtime differs from its checkpoint plan');
    return state;
  }
  private async save(store: OperationStore, change: (state: OperationMonitoringRuntimeState) => void): Promise<void> {
    await store.update((next) => {
      const selected = this.cycleId ? next.demoCycles?.[this.cycleId]?.monitoring : next.monitoring;
      if (!selected || !same(selected.plan, this.plan)) invalid('Monitoring checkpoint plan changed');
      change(selected);
    });
  }
  private async principal(): Promise<void> {
    const response = await this.ledger.request<{ principal: Principal }>('/v1/me');
    const principal = response.principal;
    if (
      !principal ||
      principal.id !== this.plan.principalId ||
      principal.tenantId !== tenant(this.plan) ||
      !positive(principal.revision) ||
      !Array.isArray(principal.capabilities)
    )
      pending('principal_changed', 'Monitoring requires its original active principal and tenant');
  }
  private async resolveBinding(store: OperationStore): Promise<void> {
    if (this.current(store).binding) return;
    const observed = operationMonitoringSnapshot(this.current(store).observer).flights[0]!;
    if (!observed.initialLinkObservation || !observed.aircraftId || !observed.c2SourceId || !observed.c2SourceSessionId)
      pending('baseline_observation_pending', 'The selected departure needs its explicit physical C2 observation');
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const matches: OperationMonitoringFlightBinding['flight'][] = [];
    for (let page = 0; page < 4; page++) {
      const response = await this.ledger.flights({
        search: observed.aircraftId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(response.flights) || response.flights.length > 200)
        invalid('Monitoring flight lookup is malformed');
      for (const flight of response.flights)
        if (flight.originationKey === observed.attemptId && flight.aircraft === observed.aircraftId) {
          if (!id(flight.id)) invalid('Monitoring public flight identity is malformed');
          matches.push({ id: flight.id, originationKey: flight.originationKey, aircraft: flight.aircraft });
        }
      if (!response.nextCursor) break;
      if (
        typeof response.nextCursor !== 'string' ||
        response.nextCursor.length > 4096 ||
        cursors.has(response.nextCursor) ||
        page === 3
      )
        pending('public_bindings_pending', 'The selected exact flight is outside the bounded public roster view');
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    if (matches.length !== 1)
      pending('public_bindings_pending', 'The selected originating order must resolve to exactly one public flight');
    const binding: OperationMonitoringFlightBinding = {
      attemptId: observed.attemptId,
      tenantId: tenant(this.plan),
      sourceId: observed.c2SourceId!,
      sourceSessionId: observed.c2SourceSessionId!,
      flight: matches[0]!,
    };
    await this.save(store, (state) => {
      state.binding = clone(binding);
    });
  }
  private async controlWindow(store: OperationStore): Promise<void> {
    await this.resolveBinding(store);
    if (!this.current(store).controlWindow) {
      const snapshot = operationMonitoringSnapshot(this.current(store).observer);
      if (snapshot.failure) pending(snapshot.failure.code, snapshot.failure.reason);
      if (!snapshot.complete) pending('observation_pending', 'The prospective monitoring window is still open');
      const planned = operationMonitoringControlWindowRequest(this.plan, this.current(store).binding!);
      await this.save(store, (next) => {
        next.controlWindow = clone(planned);
      });
    }
    const planned = this.current(store).controlWindow!;
    if (planned.window) return;
    const response = await this.ledger.request<unknown>(
      '/v1/control-windows',
      { method: 'POST', body: JSON.stringify(planned.request) },
      planned.key,
    );
    if (!windowResponseShape(response)) invalid('Control window response is unsupported');
    const window = (response as { window: ControlWindow }).window;
    if (!openedAsRequested(window, planned.request))
      invalid('The opened control window differs from its retained request');
    await this.save(store, (next) => {
      next.controlWindow!.window = { id: window.id, digest: window.revision.digest };
    });
  }
  private async deliver(store: OperationStore): Promise<OperationMonitoringRuntimeResult> {
    validateOperationMonitoringRuntimeState(this.current(store), store.state.world);
    if (origin(this.ledger.baseUrl) !== this.plan.apiUrl) invalid('Monitoring client changed its retained API origin');
    let result: OperationMonitoringRuntimeResult;
    try {
      await this.principal();
      await this.controlWindow(store);
      result = {
        status: 'accepted',
        code: 'monitoring_confirmed',
        reason: 'The control window for the monitored flight is open and confirmed',
      };
    } catch (error) {
      const code =
        record(error) && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(error.code)
          ? error.code
          : 'monitoring_delivery_pending';
      result = {
        status: 'pending',
        code,
        reason:
          error instanceof MonitoringPending
            ? error.message
            : 'Monitoring is pending; its retained control window request is unchanged',
      };
    }
    const state = this.current(store);
    if (state.controlWindow?.window) result.controlWindowId = state.controlWindow.window.id;
    await this.save(store, (next) => {
      next.last = clone(result);
    });
    return result;
  }
}
