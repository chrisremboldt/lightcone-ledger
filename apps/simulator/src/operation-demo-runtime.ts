import { boundedOperationFetcher } from './operation-public-fetch.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LedgerClient } from '@ledger/adapters';
import type {
  MissionDepartureAuthorizationResponse,
  MissionRevisionRecord,
  Principal,
  SimulationAvoidanceDemoCycle,
  SimulationAvoidanceDemoListResponse,
  SimulationAvoidanceDemoProgress,
  SimulationAvoidanceDemoProgressResponse,
  SimulationAvoidanceDemoPreparationContext,
  SimulationAvoidanceDemoReferences,
} from '@ledger/contracts';
import { missionBriefingControls } from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest } from '@ledger/integrity';
import {
  prepareOperationDemoFlight,
  reserveOperationDemoFlight,
  cancelOperationDemoFlight,
  claimOperationDemoResources,
  clearOperationDemoResources,
  type OperationDemoFlight,
} from '@ledger/simulation-models/operation';
import { advanceLiveClock, type OperationCheckpoint, type OperationStore } from './operation-state.js';
import type { OperationActionClock } from './operation-action-clock.js';
import { runOperationDeparture } from './operation-departure-consumer.js';
import { validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import {
  createOperationMonitoringRuntimeState,
  OperationMonitoringRuntime,
  type OperationMonitoringRuntimeState,
} from './operation-monitoring-runtime.js';
import { assertSeparateOperationPaths } from './operation-paths.js';
import { OracleApi } from './oracle-api.js';

export interface OperationDemoCycleState {
  version: 'operation.demo-cycle.1';
  cycle: SimulationAvoidanceDemoCycle;
  cycleDigest: string;
  publicRevision: number;
  flight?: OperationDemoFlight;
  references: SimulationAvoidanceDemoReferences;
  progress?: SimulationAvoidanceDemoProgressResponse;
  pendingProgress?: { body: string; key: string };
  rejectedProgress?: Array<{ body: string; key: string; status: number; code: string; rejectedAt: string }>;
  preparationContext?: SimulationAvoidanceDemoPreparationContext;
  departurePlan?: MissionDeparturePlan;
  monitoring?: OperationMonitoringRuntimeState;
  terminalConfirmed?: boolean;
}

const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);
const pathFor = (id: string) => `/v1/simulation/avoidance-demos/${encodeURIComponent(id)}`;
const missionReference = (mission: MissionRevisionRecord) => ({
  missionId: mission.missionId,
  sourceRevision: mission.sourceRevision,
  eventId: mission.id,
  contentDigest: mission.contentDigest,
  recordDigest: canonicalDigest(mission),
});

export function selectDemoMission(
  cycle: OperationDemoCycleState,
  mission: NonNullable<SimulationAvoidanceDemoReferences['mission']>,
): void {
  if (cycle.departurePlan) throw new Error('A selected departure keeps its original mission and request');
  if (!same(cycle.references.mission ?? null, mission)) {
    delete cycle.references.release;
    delete cycle.references.briefing;
  }
  cycle.references.mission = structuredClone(mission);
}
export function selectDemoRelease(
  cycle: OperationDemoCycleState,
  release: NonNullable<SimulationAvoidanceDemoReferences['release']>,
): void {
  if (cycle.departurePlan) throw new Error('A selected departure keeps its original release and request');
  if (!same(cycle.references.release ?? null, release)) delete cycle.references.briefing;
  cycle.references.release = structuredClone(release);
}

export function validateOperationDemoCycles(state: OperationCheckpoint): void {
  const cycles = Object.values(state.demoCycles ?? {});
  const priority = state.world.demoResourcePriority;
  if (priority) {
    const cycle = state.demoCycles?.[priority.cycleId];
    if (!cycle || cycle.flight || cycle.terminalConfirmed || priority.tenant !== 'alpha')
      throw new Error('Demo resource priority must retain its exact unallocated active source cycle');
  }
  if (
    cycles.length > 2 ||
    new Set(cycles.map((row) => row.flight?.tenant ?? row.cycle.source.principalId)).size !== cycles.length
  )
    throw new Error('Demo cycles exceed one active job per operator');
  for (const cycle of cycles) {
    if (
      cycle.version !== 'operation.demo-cycle.1' ||
      cycle.cycleDigest !== canonicalDigest(cycle.cycle) ||
      !Number.isSafeInteger(cycle.publicRevision) ||
      cycle.publicRevision < 0 ||
      cycle.publicRevision > 128
    )
      throw new Error('Retained demo cycle commitment changed');
    if (cycle.pendingProgress) {
      const progress = JSON.parse(cycle.pendingProgress.body) as SimulationAvoidanceDemoProgress;
      if (
        progress.expectedRevision !== cycle.publicRevision ||
        !cycle.pendingProgress.key.startsWith('simulator:demo-progress:')
      )
        throw new Error('Demo progress request changed its exact recovery identity');
    }
    if (
      cycle.flight &&
      !same(
        cycle.flight,
        state.world.demoFlights?.find((flight) => flight.cycleId === cycle.cycle.id),
      )
    )
      throw new Error('Demo cycle differs from its held world identity');
  }
}

export function validateOperationDemoTransition(
  previous: OperationCheckpoint,
  next: OperationCheckpoint,
  retiredId?: string,
): void {
  for (const [id, cycle] of Object.entries(previous.demoCycles ?? {})) {
    const retained = next.demoCycles?.[id];
    if (!retained) {
      if (id !== retiredId || !cycle.terminalConfirmed || cycle.pendingProgress)
        throw new Error('Demo history cannot disappear without terminal archival');
      continue;
    }
    if (
      !same(cycle.cycle, retained.cycle) ||
      (cycle.flight && !same(cycle.flight, retained.flight ?? null)) ||
      (cycle.references.execution && !same(cycle.references.execution, retained.references.execution ?? null)) ||
      (cycle.departurePlan && !same(cycle.departurePlan, retained.departurePlan ?? null)) ||
      (cycle.monitoring && !same(cycle.monitoring.plan, retained.monitoring?.plan ?? null)) ||
      retained.publicRevision < cycle.publicRevision
    )
      throw new Error('Demo identity, authored promise or saved departure/monitoring plan changed');
    if (
      (retained.rejectedProgress?.length ?? 0) > 16 ||
      (cycle.rejectedProgress ?? []).some((request, index) => !same(request, retained.rejectedProgress?.[index]))
    )
      throw new Error('Known rejected progress must retain its original request and rejection');
    if (cycle.pendingProgress && retained.pendingProgress && !same(cycle.pendingProgress, retained.pendingProgress))
      throw new Error('Unknown demo progress cannot be replaced by another request');
  }
}

class DemoProgressRejected extends Error {}

export class OperationDemoRuntime {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly source: LedgerClient;
  private readonly actor: LedgerClient;
  private readonly fetcher: typeof fetch;
  constructor(
    private readonly config: {
      apiUrl: string;
      sourceToken: string;
      actorToken: string;
      departurePrincipalId: string;
      directory: string;
      fetcher?: typeof fetch;
      signal?: AbortSignal;
      clock?: OperationActionClock;
      now?: () => number;
    },
  ) {
    const fetcher = boundedOperationFetcher(config.apiUrl, config.fetcher ?? globalThis.fetch, config.signal);
    this.source = new LedgerClient(config.apiUrl, config.sourceToken, fetcher);
    this.actor = new LedgerClient(config.apiUrl, config.actorToken, fetcher);
    this.fetcher = fetcher;
  }
  run(store: OperationStore): Promise<void> {
    const work = this.serial
      .then(() => this.tick(store))
      .catch(async (error) => {
        const cycleId = store.state.world.demoResourcePriority?.cycleId;
        if (cycleId) await store.update((state) => clearOperationDemoResources(state.world, cycleId));
        throw error;
      });
    this.serial = work.catch(() => undefined);
    return work;
  }
  private now() {
    return (this.config.now ?? Date.now)();
  }
  private advance(state: OperationCheckpoint) {
    if (this.config.clock) this.config.clock(state, this.now());
    else advanceLiveClock(state, this.now(), false);
  }
  private current(store: OperationStore, id: string): OperationDemoCycleState {
    const cycle = store.state.demoCycles?.[id];
    if (!cycle) throw new Error('Demo cycle no longer has its retained active slot');
    return cycle;
  }
  private async update(
    store: OperationStore,
    id: string,
    change: (cycle: OperationDemoCycleState, state: OperationCheckpoint) => void,
  ) {
    await store.update((state) => {
      const cycle = state.demoCycles?.[id];
      if (!cycle) throw new Error('Demo active identity changed');
      change(cycle, state);
    });
  }
  private async recoverProgress(store: OperationStore, id: string) {
    const retained = this.current(store, id).pendingProgress;
    if (!retained) return;
    let response: SimulationAvoidanceDemoProgressResponse;
    try {
      response = await this.source.request<SimulationAvoidanceDemoProgressResponse>(
        `${pathFor(id)}/progress`,
        { method: 'POST', body: retained.body },
        retained.key,
      );
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { error?: { code?: string } }) : undefined;
      const code = body?.error?.code ?? 'progress_rejected';
      if (
        !(error instanceof ApiError) ||
        error.status < 400 ||
        error.status >= 500 ||
        [408, 425, 429].includes(error.status) ||
        code === 'simulation_demo_projection_pending' ||
        (this.current(store, id).rejectedProgress?.length ?? 0) >= 16
      )
        throw error;
      await this.update(store, id, (cycle) => {
        if (!same(cycle.pendingProgress, retained)) throw new Error('Rejected progress changed its original request');
        (cycle.rejectedProgress ??= []).push({
          ...retained,
          status: error.status,
          code,
          rejectedAt: new Date(this.now()).toISOString(),
        });
        delete cycle.pendingProgress;
      });
      throw new DemoProgressRejected(`Operational progress was definitively rejected: ${code}`);
    }
    const request = JSON.parse(retained.body) as SimulationAvoidanceDemoProgress;
    const {
      id: _id,
      cycleId: _cycle,
      revision: _revision,
      recordedAt: _at,
      actorId: _actor,
      ...content
    } = response.progress;
    const { expectedRevision: _expected, ...expected } = request;
    if (
      response.digest !== canonicalDigest(response.progress) ||
      response.progress.cycleId !== id ||
      response.progress.revision !== request.expectedRevision + 1 ||
      !same(content, expected)
    )
      throw new Error('Demo progress response changed its retained request');
    await this.update(store, id, (cycle, state) => {
      if (!same(cycle.pendingProgress, retained)) throw new Error('Demo progress request changed while pending');
      cycle.progress = structuredClone(response);
      cycle.publicRevision = response.progress.revision;
      cycle.references = structuredClone(response.progress.references);
      delete cycle.pendingProgress;
      if (['monitoring_available', 'abandoned'].includes(response.progress.phase)) {
        cycle.terminalConfirmed = true;
        clearOperationDemoResources(state.world, id);
      }
    });
  }
  private async progress(
    store: OperationStore,
    id: string,
    phase: SimulationAvoidanceDemoProgress['phase'],
    code: string,
    reason: string,
    retryable = true,
  ) {
    await this.recoverProgress(store, id);
    const cycle = this.current(store, id);
    const request: SimulationAvoidanceDemoProgress = {
      version: 'simulation.avoidance-progress.1',
      expectedRevision: cycle.publicRevision,
      phase,
      code,
      retryable,
      reason: reason.slice(0, 500),
      references: structuredClone(cycle.references),
    };
    if (cycle.progress) {
      const previous = cycle.progress.progress;
      if (
        previous.phase === phase &&
        previous.code === code &&
        previous.retryable === retryable &&
        previous.reason === reason &&
        same(previous.references, request.references)
      )
        return;
    }
    await this.update(store, id, (next) => {
      next.pendingProgress = { body: JSON.stringify(request), key: `simulator:demo-progress:${randomUUID()}` };
    });
    await this.recoverProgress(store, id);
  }
  private async tick(store: OperationStore) {
    validateOperationDemoCycles(store.state);
    const { principal } = await this.source.request<{ principal: Principal }>('/v1/me');
    if (principal.tenantId !== 'tenant-alpha')
      throw new Error('Avoidance demo currently supports only the configured Alpha source');
    if (store.state.demoDiscovery && store.state.demoDiscovery.sourcePrincipalId !== principal.id)
      throw new Error('Demo discovery changed its retained source principal');
    if (store.state.demoDiscovery && store.state.demoDiscovery.principalRevision !== principal.revision)
      await store.update((state) => {
        delete state.demoDiscovery;
      });
    let active = Object.values(store.state.demoCycles ?? {}).find(
      (cycle) => cycle.cycle.source.principalId === principal.id,
    );
    if (!active) {
      const list = await this.source.request<SimulationAvoidanceDemoListResponse>(
        `/v1/simulation/avoidance-demos/requests?limit=25${store.state.demoDiscovery?.cursor ? `&cursor=${encodeURIComponent(store.state.demoDiscovery.cursor)}` : ''}`,
      );
      if (list.cycles.length > 25) throw new Error('Demo request discovery exceeded its bound');
      const selected = list.cycles.find(
        (entry) =>
          entry.cycle.source.principalId === principal.id &&
          !['monitoring_available', 'abandoned'].includes(entry.progress?.phase ?? ''),
      );
      if (!selected) {
        if (list.nextCursor)
          await store.update((state) => {
            state.demoDiscovery = {
              sourcePrincipalId: principal.id,
              principalRevision: principal.revision,
              cursor: list.nextCursor!,
            };
          });
        return;
      }
      if (selected.progress?.references.execution)
        throw new Error(
          'Existing public execution has no matching local checkpoint; refusing to create a replacement flight',
        );
      if (
        selected.digest !== canonicalDigest(selected.cycle) ||
        selected.cycle.source.missionSourceId !== 'mission-planner' ||
        selected.cycle.source.commandLinkSourceId !== 'command-link'
      )
        throw new Error('Demo request source configuration is unsupported');
      await store.update((state) => {
        (state.demoCycles ??= {})[selected.cycle.id] = {
          version: 'operation.demo-cycle.1',
          cycle: structuredClone(selected.cycle),
          cycleDigest: selected.digest,
          publicRevision: selected.progress?.revision ?? 0,
          references: structuredClone(selected.progress?.references ?? {}),
        };
        claimOperationDemoResources(state.world, selected.cycle.id, 'alpha');
        this.advance(state);
      });
      active = this.current(store, selected.cycle.id);
    }
    const id = active.cycle.id;
    await this.update(store, id, (cycle, state) => {
      if (!cycle.flight && !cycle.terminalConfirmed) claimOperationDemoResources(state.world, id, 'alpha');
      else clearOperationDemoResources(state.world, id);
    });
    await this.recoverProgress(store, id);
    if (this.current(store, id).terminalConfirmed) {
      const attemptId = this.current(store, id).flight?.attemptId;
      if (
        !attemptId ||
        (!store.state.pending[attemptId]?.length &&
          !store.state.world.attempts.some((attempt) => attempt.id === attemptId && attempt.phase === 'flying'))
      )
        await store.archiveDemoCycle(id);
      return;
    }
    try {
      await this.step(store, id, principal);
    } catch (error) {
      await this.update(store, id, (_cycle, state) => clearOperationDemoResources(state.world, id));
      if (error instanceof DemoProgressRejected) return;
      if (this.current(store, id).pendingProgress) throw error;
      const code =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
          ? error.code
          : 'public_evidence_pending';
      await this.progress(
        store,
        id,
        'blocked',
        code,
        'The source coordinator is waiting for exact public evidence or authority. Existing requests remain retained.',
      );
    }
  }
  private async step(store: OperationStore, id: string, principal: Principal): Promise<void> {
    let cycle = this.current(store, id);
    if (
      !['input:write', 'flight:read', 'mission:write', 'monitoring:write'].every((capability) =>
        principal.capabilities.includes(capability as never),
      ) ||
      !principal.missionSources.includes(cycle.cycle.source.missionSourceId) ||
      !(principal.observationGrants ?? []).some(
        (grant) => grant.sourceId === cycle.cycle.source.commandLinkSourceId && grant.observationType === 'link.status',
      ) ||
      !principal.monitoringSources?.includes(cycle.cycle.source.monitoringSourceId)
    )
      throw new Error('The configured source lacks its exact mission, native radio or monitoring authority');
    if (cycle.cycle.source.principalId !== principal.id) throw new Error('Demo source principal changed');
    if (!cycle.flight) {
      const ref = cycle.cycle.control;
      // Readable only once accepted; the preparation context below checks the exact acceptance.
      const selected = await this.source.acceptedAreaControl(ref.hazardId, ref.controlId, ref.controlVersion);
      const view = selected.control;
      if (view.controlEventId !== ref.controlEventId || view.bodyDigest !== ref.controlDigest)
        throw new Error('Selected control acceptance no longer matches its exact cycle');
      const sourceInput = {
        cycleId: id,
        tenant: 'alpha' as const,
        control: ref,
        circle: { center: view.content.area.center, radiusMeters: view.content.area.radiusMeters },
        circles: [],
        effectiveFrom: view.content.effectiveFrom,
        // An area control without an end stays in effect; the demonstration window bounds the flight.
        effectiveUntil: view.content.effectiveUntil ?? '9999-12-31T00:00:00.000Z',
      };
      const proposed = prepareOperationDemoFlight(store.state.world, sourceInput);
      if (proposed.status === 'blocked') {
        await this.progress(
          store,
          id,
          'abandoned',
          proposed.reason,
          'The selected control cannot support a fresh mission from the actual Alpha launch site within its finite interval.',
          false,
        );
        return;
      }
      const context = await this.source.simulationAvoidanceDemoPreparationContext(id, {
        operatingInterval: proposed.flight.window,
      });
      if (
        context.status !== 'ready' ||
        context.candidateCompleteness.status !== 'complete' ||
        !context.contextDigest ||
        context.cycle.id !== id ||
        context.cycle.digest !== cycle.cycleDigest ||
        !same(context.operatingInterval, proposed.flight.window) ||
        !context.controls.some(
          (control) =>
            control.controlEventId === ref.controlEventId &&
            control.controlDigest === ref.controlDigest &&
            same(control.acceptance, ref.acceptance),
        )
      )
        throw new Error('Complete exact control preparation context is pending');
      let failure: string | undefined;
      await this.update(store, id, (next, state) => {
        this.advance(state);
        const prepared = prepareOperationDemoFlight(state.world, {
          ...sourceInput,
          circles: context.controls,
          window: context.operatingInterval,
        });
        if (prepared.status === 'blocked') {
          failure = prepared.reason;
          return;
        }
        const reservation = reserveOperationDemoFlight(state.world, prepared.flight);
        if (!reservation) {
          failure = 'resources_unavailable';
          return;
        }
        next.flight = prepared.flight;
        next.preparationContext = structuredClone(context);
        clearOperationDemoResources(state.world, id);
      });
      if (failure) {
        await this.progress(
          store,
          id,
          failure === 'resources_unavailable' ? 'preparing' : 'abandoned',
          failure,
          failure === 'resources_unavailable'
            ? 'Waiting for an available Alpha aircraft and named flight person.'
            : 'The selected control cannot support a feasible fresh mission from the retained Alpha launch site.',
          failure === 'resources_unavailable',
        );
        return;
      }
      await this.progress(
        store,
        id,
        'preparing',
        'source_delivery_pending',
        'The source is publishing the held order and original mission.',
      );
      return;
    }
    cycle = this.current(store, id);
    const flight = cycle.flight!;
    const reservation = store.state.world.reservations?.find((row) => row.id === flight.attemptId);
    if (reservation?.phase === 'cancelled') {
      if (store.state.pending[flight.attemptId]?.length) return;
      await this.progress(
        store,
        id,
        'abandoned',
        'requested_window_unreachable',
        'Dispatch cancelled the unused reservation when its original customer window could no longer fit.',
        false,
      );
      return;
    }
    if (!cycle.references.execution) {
      if (!reservation) throw new Error('Held demo reservation is unavailable');
      const response = await this.source.flights({ search: reservation.order.order_id, limit: 200 });
      const matches = response.flights.filter(
        (row) => row.originationKey === flight.attemptId && row.aircraft === reservation.aircraftId,
      );
      if (matches.length !== 1) return;
      await this.update(store, id, (next) => {
        next.references.execution = {
          runId: store.state.world.config.runId,
          reservationId: flight.attemptId,
          flightId: matches[0]!.id,
          aircraftId: reservation.aircraftId,
          sourceMissionId: reservation.plan.sourceMissionId,
        };
      });
    }
    cycle = this.current(store, id);
    const execution = cycle.references.execution!;
    if (cycle.departurePlan) {
      await this.depart(store, id);
      return;
    }
    const mission = await this.source.flightMission(execution.flightId);
    if (
      !mission.acceptedHead ||
      mission.acceptedHead.processing.status !== 'completed' ||
      !mission.projectedHead ||
      !same(mission.acceptedHead.record, mission.projectedHead)
    )
      return;
    const record = mission.projectedHead;
    await this.update(store, id, (next) => {
      selectDemoMission(next, missionReference(record));
    });
    const avoidance = await this.source.missionAvoidance(execution.flightId);
    if (
      !avoidance.contextDigest ||
      avoidance.candidateCompleteness.status !== 'complete' ||
      !avoidance.mission ||
      !same(avoidance.mission, missionReference(record))
    )
      throw new Error('Complete current avoidance context is pending');
    if (
      !avoidance.candidates.some(
        (candidate) =>
          candidate.controlEventId === cycle.cycle.control.controlEventId &&
          candidate.acceptance.id === cycle.cycle.control.acceptance.id,
      )
    )
      throw new Error('Selected accepted control is absent from the mission context');
    const selectedCandidate = avoidance.candidates.find(
      (candidate) => candidate.controlEventId === cycle.cycle.control.controlEventId,
    );
    if (record.sourceRevision === 1 && selectedCandidate?.geometry !== 'intersects') {
      await this.update(store, id, (_next, state) => {
        this.advance(state);
        cancelOperationDemoFlight(
          state.world,
          flight.attemptId,
          'The supported public geometry check did not establish an original route through the selected control. Dispatch cancelled this unused demonstration request.',
        );
      });
      return;
    }
    if (record.sourceRevision === 1 || avoidance.status !== 'outside') {
      const suggestion = await this.source.missionRouteSuggestion(execution.flightId, {
        expectedMission: missionReference(record),
        expectedContextDigest: avoidance.contextDigest,
        clearanceMeters: 25,
      });
      if (suggestion.status === 'infeasible') {
        await this.update(store, id, (_next, state) => {
          this.advance(state);
          cancelOperationDemoFlight(
            state.world,
            flight.attemptId,
            'No supported safe route preserves the required destinations and accepted avoidance controls within the original customer window. Dispatch cancelled this unused demonstration request.',
          );
        });
        return;
      }
      if (suggestion.status !== 'suggested' || suggestion.timeFit.status !== 'fits') {
        await this.progress(
          store,
          id,
          'blocked',
          'detour_not_feasible',
          'No supported detour currently preserves every required stop, accepted control and original time constraint.',
        );
        return;
      }
      await this.progress(
        store,
        id,
        'awaiting_route',
        'human_route_revision_required',
        'Review the intersecting original route, request a detour and explicitly apply the suggested mission revision.',
      );
      return;
    }
    const timeline = await this.source.timeline(execution.flightId, { limit: 200 });
    const releaseItems = timeline.items.filter((item) => item.kind === 'mission.release').slice(0, 8);
    let release: Awaited<ReturnType<LedgerClient['missionRelease']>> | undefined;
    for (const item of releaseItems) {
      const candidate = await this.source.missionRelease(execution.flightId, item.id);
      if (same(candidate.release.basis.mission, record)) {
        release = candidate;
        break;
      }
    }
    if (!release) {
      await this.progress(
        store,
        id,
        'awaiting_release',
        'human_release_required',
        'The revised route is clear. Record a separate human mission release.',
      );
      return;
    }
    await this.update(store, id, (next) => {
      selectDemoRelease(next, { id: release!.release.id, digest: release!.digest });
    });
    const briefItems = timeline.items.filter((item) => item.kind === 'mission.brief').slice(0, 8);
    let briefing: Awaited<ReturnType<LedgerClient['missionBriefing']>> | undefined;
    let lapsed = false;
    for (const item of briefItems) {
      const candidate = await this.source.missionBriefing(execution.flightId, item.id);
      if (
        same(candidate.briefing.context.release, { id: release.release.id, digest: release.digest }) &&
        missionBriefingControls(candidate.briefing).some(
          ({ reference }) => reference.controlEventId === cycle.cycle.control.controlEventId,
        )
      ) {
        // A lapsed briefing no longer counts; a person prepares a new one, as when there is none.
        if (candidate.standing.status === 'lapsed') {
          lapsed = true;
          continue;
        }
        briefing = candidate;
        break;
      }
    }
    if (!briefing) {
      await this.progress(
        store,
        id,
        'awaiting_briefing',
        lapsed ? 'briefing_lapsed' : 'human_briefing_required',
        lapsed
          ? 'The briefing for this exact release and accepted control has lapsed and no longer counts. Record a new informational briefing.'
          : 'Record an informational briefing for this exact release and accepted control.',
      );
      return;
    }
    await this.update(store, id, (next) => {
      next.references.briefing = { id: briefing!.briefing.id, digest: briefing!.digest };
    });
    const acknowledged = await this.source.missionBriefingAcknowledgements(execution.flightId, briefing.briefing.id);
    if (
      !acknowledged.recipients.length ||
      acknowledged.recipients.some((row) => !row.acknowledgement || row.processing !== 'completed')
    ) {
      await this.progress(
        store,
        id,
        'awaiting_acknowledgement',
        'personal_acknowledgements_required',
        'Each named recipient must personally review and acknowledge the exact briefing.',
      );
      return;
    }
    const actor = (await this.actor.request<{ principal: Principal }>('/v1/me')).principal;
    if (
      actor.tenantId !== 'tenant-alpha' ||
      actor.id !== this.config.departurePrincipalId ||
      !['decision:write', 'flight:read', 'mission:release'].every((capability) =>
        actor.capabilities.includes(capability as never),
      )
    )
      throw new Error('The configured nonhuman departure actor lacks current authority');
    const departureStart = Date.parse(release.release.departureWindow.start);
    if (this.now() < departureStart) {
      await this.progress(
        store,
        id,
        'ready',
        'departure_window_scheduled',
        'Human review is complete; waiting for the recorded departure window.',
      );
      return;
    }
    const plan = validateMissionDeparturePlan({
      version: 1,
      apiUrl: this.config.apiUrl,
      tenantId: actor.tenantId,
      principalId: actor.id,
      runId: execution.runId,
      reservationId: execution.reservationId,
      flightId: execution.flightId,
      aircraftId: execution.aircraftId,
      mission: missionReference(record),
      release: { id: release.release.id, digest: release.digest },
      departureAttemptId: `${id}:departure:1`,
      marginMs: 10_000,
      latencyMarginMs: 5000,
      handoffAllowanceMs: 30_000,
      allocationDurationMs: 90_000,
    });
    await this.update(store, id, (next, state) => {
      this.advance(state);
      const start = state.world.now + 30_000;
      const end = Math.min(start + 300_000, Date.parse(flight.window.end));
      if (end <= start) throw new Error('The prospective monitoring interval cannot fit the original promise');
      next.departurePlan = plan;
      next.monitoring = createOperationMonitoringRuntimeState(
        {
          version: 1,
          apiUrl: this.config.apiUrl,
          principalId: principal.id,
          radioInitialState: 'up',
          monitoring: {
            version: 1,
            runId: execution.runId,
            tenant: 'alpha',
            sourceId: cycle.cycle.source.monitoringSourceId,
            sourceSessionId: `${id}:monitoring:1`,
            sourceWindowId: `${id}:window:1`,
            control: cycle.cycle.control,
            window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
            flights: [{ attemptId: flight.attemptId, initialLinkState: 'unknown', monitoringAvailable: true }],
          },
        },
        state.world,
        true,
      );
    });
    await this.progress(
      store,
      id,
      'ready',
      'human_review_complete',
      'The recorded release and personal briefing reviews are complete. The source will perform the separately authorized departure.',
    );
    await this.depart(store, id);
  }
  private async depart(store: OperationStore, id: string) {
    const cycle = this.current(store, id);
    const plan = cycle.departurePlan!;
    const api = new OracleApi(
      this.config.apiUrl,
      this.config.actorToken,
      { requests: 40, bytes: 8 * 1024 * 1024, timeoutMs: 30_000 },
      this.fetcher,
    );
    const journalPath = join(this.config.directory, `${canonicalDigest(id)}.departure.json`);
    await assertSeparateOperationPaths([journalPath, `${journalPath}.lock`], store.checkpointPath);
    const result = await runOperationDeparture(
      plan,
      journalPath,
      store,
      api,
      (body, key) =>
        this.actor.request<MissionDepartureAuthorizationResponse>('/v1/commands', { method: 'POST', body }, key),
      () => this.now(),
      this.config.clock,
    );
    if (result.status !== 'departed') {
      await this.progress(
        store,
        id,
        result.status === 'abandoned' ? 'abandoned' : 'departure_unknown',
        result.code,
        result.reason,
        result.status !== 'abandoned',
      );
      return;
    }
    const committed = store.state.world.departures?.find((entry) => entry.reservationId === plan.reservationId);
    const publicReceipts = await this.source.receipts({ flightId: plan.flightId, limit: 200 });
    const receipt = publicReceipts.receipts.find(
      (entry) =>
        entry.kind === 'flight.observation' &&
        entry.payload?.activity === 'active' &&
        entry.sourceId === 'simulation-person-alpha' &&
        Date.parse(entry.occurredAt) === Date.parse(committed?.departureAt ?? '') &&
        entry.processing.status === 'completed',
    );
    if (!committed || !receipt) return;
    await this.update(store, id, (next) => {
      next.references.departure = {
        permit: { id: committed.permit.id, digest: committed.permitDigest },
        attemptId: committed.departureAttemptId,
        receiptId: receipt.id,
      };
    });
    const monitoring = this.current(store, id).monitoring!;
    const runtime = new OperationMonitoringRuntime({ plan: monitoring.plan, ledger: this.source, cycleId: id });
    await runtime.run(store);
    const current = this.current(store, id).monitoring!;
    await this.update(store, id, (next) => {
      if (current.controlWindow?.window) next.references.controlWindow = structuredClone(current.controlWindow.window);
    });
    if (current.controlWindow?.window)
      await this.progress(
        store,
        id,
        'monitoring_available',
        'control_window_open',
        'The control window for this flight is open. Record the indicator result through it and author a separate human review.',
        false,
      );
    else
      await this.progress(
        store,
        id,
        'monitoring',
        'prospective_monitoring_in_progress',
        'The aircraft is following the approved route while native evidence and prospective monitoring arrive.',
      );
  }
}
