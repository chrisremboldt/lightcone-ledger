import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { LedgerClient } from '@ledger/adapters';
import { missionBriefingControls } from '@ledger/contracts';
import type {
  FlightPredepartureProgress,
  FlightPredepartureProgressResponse,
  MissionBriefingAcknowledgementsResponse,
  MissionDepartureAuthorizationResponse,
  MissionReleaseRecordResponse,
  MissionRevisionRecord,
  Principal,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { canonicalDigest } from '@ledger/integrity';
import type { OperationTenant } from '@ledger/simulation-models/operation';
import type { OperationActionClock } from './operation-action-clock.js';
import { advanceLiveClock, type OperationCheckpoint, type OperationStore } from './operation-state.js';
import {
  selectOrdinaryMission,
  selectOrdinaryRelease,
  type OperationOrdinaryFlightState,
} from './operation-ordinary-state.js';
import { boundedOperationFetcher } from './operation-public-fetch.js';
import { assertSeparateOperationPaths } from './operation-paths.js';
import type { OracleReader } from './attempt-oracle.js';
import { readDepartureJournal } from './operation-departure-journal.js';
import { OracleApi } from './oracle-api.js';
import { runMissionRelease } from './mission-release-actor.js';
import {
  ReleasePending,
  reviewedMissionReleaseCalculation,
  reviewedMissionReleasePolicy,
  validateMissionReleasePlan,
} from './mission-release-plan.js';
import { validateMissionDeparturePlan } from './mission-departure-plan.js';
import { runOperationDeparture } from './operation-departure-consumer.js';

export interface OrdinaryDispatchTenant {
  sourceToken: string;
  actorToken: string;
  sourcePrincipalId: string;
  automaticReleasePrincipalId: string;
}
export interface OperationOrdinaryRuntimeOptions {
  apiUrl: string;
  directory: string;
  tenants: Record<OperationTenant, OrdinaryDispatchTenant>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  clock?: OperationActionClock;
  now?: () => number;
}
const same = (first: unknown, second: unknown) => canonicalDigest(first) === canonicalDigest(second);
const missionReference = (mission: MissionRevisionRecord) => ({
  missionId: mission.missionId,
  sourceRevision: mission.sourceRevision,
  eventId: mission.id,
  contentDigest: mission.contentDigest,
  recordDigest: canonicalDigest(mission),
});
class ProgressRejected extends Error {}

export class OperationOrdinaryDispatchRuntime {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly clients: Record<OperationTenant, { source: LedgerClient; actor: LedgerClient }>;
  private readonly fetcher: typeof fetch;
  constructor(private readonly config: OperationOrdinaryRuntimeOptions) {
    this.fetcher = boundedOperationFetcher(config.apiUrl, config.fetcher ?? globalThis.fetch, config.signal);
    const client = (tenant: OperationTenant) => ({
      source: new LedgerClient(config.apiUrl, config.tenants[tenant].sourceToken, this.fetcher),
      actor: new LedgerClient(config.apiUrl, config.tenants[tenant].actorToken, this.fetcher),
    });
    this.clients = { alpha: client('alpha'), beta: client('beta') };
  }
  run(store: OperationStore): Promise<void> {
    const work = this.serial.then(() => this.tick(store));
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
  private current(store: OperationStore, id: string): OperationOrdinaryFlightState {
    const flight = store.state.ordinaryFlights?.[id];
    if (!flight) throw new Error('Ordinary flight lost its retained source job');
    return flight;
  }
  private update(
    store: OperationStore,
    id: string,
    change: (flight: OperationOrdinaryFlightState, state: OperationCheckpoint) => void,
  ) {
    return store.update((state) => {
      const flight = state.ordinaryFlights?.[id];
      if (!flight) throw new Error('Ordinary source job changed before its atomic update');
      change(flight, state);
    });
  }
  private requireFreshActor(tenant: OperationTenant, principal: Principal): void {
    if (
      principal.id !== this.config.tenants[tenant].automaticReleasePrincipalId ||
      principal.tenantId !== `tenant-${tenant}` ||
      !['source', 'service'].includes(principal.kind ?? '') ||
      !['decision:write', 'flight:read', 'mission:release'].every((capability) =>
        principal.capabilities.includes(capability as never),
      )
    )
      throw new ReleasePending(
        'automatic_release_authority_unavailable',
        'Automatic dispatch requires its current nonhuman release service authority',
      );
  }
  private actorApi(tenant: OperationTenant): OracleReader {
    const configured = this.config.tenants[tenant];
    const api = new OracleApi(
      this.config.apiUrl,
      configured.actorToken,
      { requests: 48, bytes: 8 * 1024 * 1024, timeoutMs: 30_000 },
      this.fetcher,
    );
    return {
      json: async <T>(path: string): Promise<T> => {
        const value = await api.json<T>(path);
        if (path === '/v1/me') {
          const acting = (value as { principal?: Principal & { kind?: string } }).principal;
          if (!acting || acting.id !== configured.automaticReleasePrincipalId || acting.tenantId !== `tenant-${tenant}`)
            throw new ReleasePending(
              'automatic_release_authority_unavailable',
              'Automatic dispatch changed its exact release service identity',
            );
        }
        return value;
      },
      bytes: (path) => api.bytes(path),
      usage: () => api.usage(),
    };
  }
  private async recoverProgress(store: OperationStore, id: string) {
    const flight = this.current(store, id);
    const retained = flight.pendingProgress;
    if (!retained || !flight.flightId) return;
    let response: FlightPredepartureProgressResponse;
    try {
      response = await this.clients[flight.tenant].source.request<FlightPredepartureProgressResponse>(
        `/v1/flights/${encodeURIComponent(flight.flightId)}/predeparture/progress`,
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
        code === 'predeparture_projection_pending' ||
        (flight.rejectedProgress?.length ?? 0) >= 16
      )
        throw error;
      await this.update(store, id, (next) => {
        if (!same(next.pendingProgress, retained))
          throw new Error('Rejected ordinary status changed its original request');
        (next.rejectedProgress ??= []).push({
          ...retained,
          status: error.status,
          code,
          rejectedAt: new Date(this.now()).toISOString(),
        });
        delete next.pendingProgress;
      });
      throw new ProgressRejected(code);
    }
    const request = JSON.parse(retained.body) as FlightPredepartureProgress;
    const {
      id: _id,
      flightId: _flightId,
      revision: _revision,
      recordedAt: _at,
      source,
      ...content
    } = response.progress;
    const { expectedRevision: _expected, ...expected } = request;
    if (
      response.digest !== canonicalDigest(response.progress) ||
      response.progress.flightId !== flight.flightId ||
      response.progress.revision !== request.expectedRevision + 1 ||
      source.principalId !== flight.sourcePrincipalId ||
      source.automaticReleasePrincipalId !== flight.automaticReleasePrincipalId ||
      source.missionSourceId !== 'mission-planner' ||
      !same(content, expected)
    )
      throw new Error('Ordinary public progress changed its exact request or configured source');
    await this.update(store, id, (next) => {
      if (!same(next.pendingProgress, retained)) throw new Error('Ordinary progress changed while pending');
      next.progress = structuredClone(response);
      next.publicRevision = response.progress.revision;
      delete next.pendingProgress;
      if (['departed', 'cancelled'].includes(response.progress.phase)) next.terminalConfirmed = true;
    });
  }
  private async progress(
    store: OperationStore,
    id: string,
    phase: FlightPredepartureProgress['phase'],
    code: string,
    reason: string,
    retryable = true,
  ) {
    await this.recoverProgress(store, id);
    const flight = this.current(store, id);
    if (!flight.flightId || !flight.references) return;
    const registration = store.state.world.ordinaryDispatch!.flights.find((row) => row.attemptId === id)!;
    const request: FlightPredepartureProgress = {
      version: 'flight.predeparture-progress.1',
      expectedRevision: flight.publicRevision,
      execution: {
        runId: store.state.world.config.runId,
        reservationId: id,
        aircraftId: registration.aircraftId,
        sourceMissionId: `${id}:mission`,
      },
      sourceObservedAt: new Date(this.now()).toISOString(),
      phase,
      code,
      retryable,
      reason: reason.slice(0, 500),
      needsHumanReview: flight.needsHumanReview,
      references: structuredClone(flight.references),
    };
    if (flight.progress) {
      const previous = flight.progress.progress;
      if (
        previous.phase === phase &&
        previous.code === code &&
        previous.retryable === retryable &&
        previous.reason === request.reason &&
        previous.needsHumanReview === request.needsHumanReview &&
        same(previous.references, request.references)
      )
        return;
    }
    await this.update(store, id, (next) => {
      next.pendingProgress = { body: JSON.stringify(request), key: `simulator:predeparture-progress:${randomUUID()}` };
    });
    await this.recoverProgress(store, id);
  }
  private async tick(store: OperationStore) {
    if (!store.state.world.ordinaryDispatch)
      throw new Error('Ordinary source coordinator requires its retained activation');
    for (const registration of store.state.world.ordinaryDispatch.flights) {
      if (!store.state.ordinaryFlights?.[registration.attemptId]) {
        const configured = this.config.tenants[registration.tenant];
        await store.update((state) => {
          (state.ordinaryFlights ??= {})[registration.attemptId] = {
            version: 'operation.ordinary-source.1',
            reservationId: registration.attemptId,
            tenant: registration.tenant,
            sourcePrincipalId: configured.sourcePrincipalId,
            automaticReleasePrincipalId: configured.automaticReleasePrincipalId,
            publicRevision: 0,
            needsHumanReview: false,
          };
        });
      }
    }
    const failures: unknown[] = [];
    for (const id of Object.keys(store.state.ordinaryFlights ?? {})) {
      try {
        await this.recoverProgress(store, id);
        const flight = this.current(store, id);
        if (flight.terminalConfirmed) {
          if (
            !store.state.pending[id]?.length &&
            !store.state.world.attempts.some((row) => row.id === id && row.phase === 'flying') &&
            !store.state.world.events.some((event) => 'attemptId' in event && event.attemptId === id)
          )
            await store.archiveOrdinaryFlight(id);
          continue;
        }
        await this.step(store, id);
      } catch (error) {
        if (error instanceof ProgressRejected) continue;
        if (this.current(store, id).pendingProgress) {
          failures.push(error);
          continue;
        }
        try {
          await this.progress(
            store,
            id,
            'blocked',
            'public_evidence_pending',
            'The source is waiting for exact public evidence or current authority. The flight remains grounded.',
          );
        } catch (failure) {
          failures.push(failure);
        }
      }
    }
    if (failures.length) throw failures[0];
  }
  private async requireHuman(store: OperationStore, id: string) {
    await this.update(store, id, (next) => {
      if (!next.needsHumanReview) {
        next.needsHumanReview = true;
        if (next.references && !next.departurePlan) {
          delete next.references.release;
          next.references.briefings = [];
        }
      }
    });
  }
  private async step(store: OperationStore, id: string) {
    let flight = this.current(store, id);
    const configured = this.config.tenants[flight.tenant];
    const { source, actor } = this.clients[flight.tenant];
    const principal = (await source.request<{ principal: Principal }>('/v1/me')).principal;
    if (
      principal.id !== flight.sourcePrincipalId ||
      principal.id !== configured.sourcePrincipalId ||
      principal.tenantId !== `tenant-${flight.tenant}` ||
      !['input:write', 'flight:read', 'mission:write'].every((capability) =>
        principal.capabilities.includes(capability as never),
      ) ||
      !principal.missionSources.includes('mission-planner')
    )
      throw new Error('The ordinary mission source lacks its exact tenant authority');
    const reservation = store.state.world.reservations?.find((row) => row.id === id);
    if (!flight.flightId) {
      if (!reservation) throw new Error('The original ordinary reservation is unavailable');
      const list = await source.flights({ search: reservation.order.order_id, limit: 200 });
      const exact = list.flights.filter((row) => row.originationKey === id && row.aircraft === reservation.aircraftId);
      if (exact.length !== 1) return;
      await this.update(store, id, (next) => {
        next.flightId = exact[0]!.id;
      });
    }
    flight = this.current(store, id);
    const flightId = flight.flightId!;
    if (flight.departurePlan) {
      await this.depart(store, id);
      return;
    }
    const publicState = await source.flightPredeparture(flightId);
    if (!publicState.enabled || (publicState.progress && !flight.progress))
      throw new Error('The configured public workflow is unavailable or has unretained prior execution');
    const mission = await source.flightMission(flightId);
    if (
      !mission.acceptedHead ||
      mission.acceptedHead.processing.status !== 'completed' ||
      !mission.projectedHead ||
      !same(mission.acceptedHead.record, mission.projectedHead)
    )
      return;
    const record = mission.projectedHead;
    const reference = missionReference(record);
    await this.update(store, id, (next) => {
      if (next.automaticReleasePlan && !same(next.automaticReleasePlan.mission, reference))
        next.needsHumanReview = true;
      selectOrdinaryMission(next, reference);
    });
    if (reservation?.phase === 'cancelled') {
      if (store.state.pending[id]?.length) return;
      await this.progress(
        store,
        id,
        'cancelled',
        'requested_window_unreachable',
        'Dispatch cancelled the unused flight when it could no longer finish within the original customer window.',
        false,
      );
      return;
    }
    if (!this.current(store, id).progress)
      await this.progress(
        store,
        id,
        'evaluating',
        'accepted_mission_projected',
        'The original source mission is held while all applicable accepted controls are checked.',
      );
    const avoidance = await source.missionAvoidance(flightId);
    if (!same(avoidance.mission, reference)) return;
    if (avoidance.candidates.some((candidate) => candidate.context === 'pending')) {
      await this.progress(
        store,
        id,
        'evaluating',
        'control_projection_pending',
        'Waiting for the exact accepted control context to finish processing.',
      );
      return;
    }
    if (
      avoidance.status !== 'outside' ||
      avoidance.candidateCompleteness.status !== 'complete' ||
      !avoidance.contextDigest ||
      avoidance.candidates.some((candidate) => candidate.geometry !== 'outside' || candidate.context !== 'current')
    ) {
      await this.requireHuman(store, id);
      await this.progress(
        store,
        id,
        avoidance.status === 'intersects' ? 'awaiting_route' : 'blocked',
        avoidance.status === 'intersects' ? 'accepted_control_intersection' : 'avoidance_context_uncertain',
        avoidance.status === 'intersects'
          ? 'The planned corridor intersects an accepted control. Review and apply a feasible route revision before a separate human release.'
          : 'The retained route or control context cannot establish a supported clear route. Human review is required.',
      );
      return;
    }
    flight = this.current(store, id);
    if (flight.automaticReleasePlan && flight.automaticReleasePlan.expectedContextDigest !== avoidance.contextDigest)
      await this.requireHuman(store, id);
    flight = this.current(store, id);
    const timeline = await source.timeline(flightId, { limit: 500, decisionLimit: 200 });
    const items = [...timeline.items].sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
    let release: MissionReleaseRecordResponse | undefined;
    if (flight.needsHumanReview) {
      for (const item of items.filter((row) => row.kind === 'mission.release').slice(0, 16)) {
        const candidate = await source.missionRelease(flightId, item.id);
        if (
          candidate.release.actor.kind === 'human' &&
          same(candidate.release.basis.mission, record) &&
          candidate.release.basis.avoidance.contextDigest === avoidance.contextDigest
        ) {
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
          'The route is clear. Record a separate human release for this exact mission.',
        );
        return;
      }
    } else {
      if (!flight.automaticReleasePlan) {
        // The configured service release attests the open findings listed when its plan is made.
        const findings = await source.missionReleaseFindings(flightId);
        const plan = validateMissionReleasePlan({
          version: 2,
          apiUrl: this.config.apiUrl,
          tenantId: `tenant-${flight.tenant}`,
          principalId: flight.automaticReleasePrincipalId,
          flightId,
          aircraftId: record.aircraftId,
          mission: reference,
          calculation: {
            id: reviewedMissionReleaseCalculation.id,
            version: reviewedMissionReleaseCalculation.version,
            digest: reviewedMissionReleaseCalculation.digest,
          },
          policy: {
            id: reviewedMissionReleasePolicy.id,
            version: reviewedMissionReleasePolicy.version,
            digest: reviewedMissionReleasePolicy.digest,
          },
          expectedContextDigest: avoidance.contextDigest,
          expectedFindingsDigest: findings.basis.digest,
          departureWindow: structuredClone(record.operatingInterval),
          note: 'Autonomous dispatch: the original ordinary mission has a complete supported clear route through all applicable accepted controls.',
        });
        await this.update(store, id, (next) => {
          next.automaticReleasePlan = plan;
        });
      }
      const plan = this.current(store, id).automaticReleasePlan!;
      const journalPath = join(this.config.directory, `${canonicalDigest(id)}.release.json`);
      await assertSeparateOperationPaths([journalPath, `${journalPath}.lock`], store.checkpointPath);
      const api = this.actorApi(flight.tenant);
      const result = await runMissionRelease(
        plan,
        journalPath,
        api,
        (body, key) => actor.request('/v1/commands', { method: 'POST', body }, key),
        (principal) => this.requireFreshActor(flight.tenant, principal),
      );
      if (result.status !== 'accepted' || !result.eventId) {
        await this.progress(store, id, 'blocked', result.code, result.reason, result.status !== 'rejected');
        return;
      }
      release = await source.missionRelease(flightId, result.eventId);
      if (
        release.release.actor.id !== flight.automaticReleasePrincipalId ||
        !['source', 'service'].includes(release.release.actor.kind)
      )
        throw new Error('Automatic release changed its configured service identity');
    }
    await this.update(store, id, (next) => {
      selectOrdinaryRelease(next, { id: release!.release.id, digest: release!.digest });
    });
    const validity = await source.missionReleaseValidity(flightId, release.release.id);
    if (!['current', 'scheduled'].includes(validity.status)) {
      await this.progress(
        store,
        id,
        'blocked',
        'release_not_current',
        'The recorded release is no longer current for this exact mission and accepted controls.',
      );
      return;
    }
    flight = this.current(store, id);
    if (flight.needsHumanReview) {
      const availableBriefings = [];
      for (const item of items.filter((row) => row.kind === 'mission.brief').slice(0, 128))
        availableBriefings.push(await source.missionBriefing(flightId, item.id));
      const selected: NonNullable<OperationOrdinaryFlightState['references']>['briefings'] = [];
      let missing = false;
      let lapsed = false;
      let waiting = false;
      const acknowledgements = new Map<string, MissionBriefingAcknowledgementsResponse>();
      for (const control of avoidance.candidates) {
        const covering = availableBriefings.filter(
          (candidate) =>
            candidate.briefing.actor.kind === 'human' &&
            missionBriefingControls(candidate.briefing).some(
              ({ reference }) => reference.controlEventId === control.controlEventId,
            ) &&
            same(candidate.briefing.context.release, { id: release!.release.id, digest: release!.digest }),
        );
        // A lapsed briefing no longer counts; a person prepares a new one, as for a control with none.
        const briefing = covering.find((candidate) => candidate.standing.status === 'in_force');
        if (!briefing) {
          missing = true;
          if (covering.length) lapsed = true;
          continue;
        }
        selected.push({
          controlEventId: control.controlEventId,
          briefing: { id: briefing.briefing.id, digest: briefing.digest },
        });
        // One briefing may cover several controls; its acknowledgements are read once.
        const acks =
          acknowledgements.get(briefing.briefing.id) ??
          (await source.missionBriefingAcknowledgements(flightId, briefing.briefing.id));
        acknowledgements.set(briefing.briefing.id, acks);
        if (
          !acks.recipients.length ||
          acks.recipients.some((recipient) => !recipient.acknowledgement || recipient.processing !== 'completed')
        )
          waiting = true;
      }
      await this.update(store, id, (next) => {
        next.references!.briefings = selected;
      });
      if (missing) {
        await this.progress(
          store,
          id,
          'awaiting_briefing',
          lapsed ? 'briefing_lapsed' : 'human_briefings_required',
          lapsed
            ? 'A briefing this flight relied on has lapsed and no longer counts. Record a new human briefing that lists each applicable accepted control and this exact release.'
            : 'Record a human briefing that lists each applicable accepted control and this exact release.',
        );
        return;
      }
      if (waiting) {
        await this.progress(
          store,
          id,
          'awaiting_acknowledgement',
          'personal_acknowledgements_required',
          'Every named briefing recipient must personally review and acknowledge the exact briefing.',
        );
        return;
      }
    }
    const acting = (await this.actorApi(flight.tenant).json<{ principal: Principal & { kind?: string } }>('/v1/me'))
      .principal;
    if (
      acting.id !== flight.automaticReleasePrincipalId ||
      acting.id !== configured.automaticReleasePrincipalId ||
      acting.tenantId !== `tenant-${flight.tenant}` ||
      !['source', 'service'].includes(acting.kind ?? '') ||
      !['decision:write', 'flight:read', 'mission:release'].every((capability) =>
        acting.capabilities.includes(capability as never),
      )
    )
      throw new Error('The configured ordinary departure service lacks its exact current authority');
    if (this.now() < Date.parse(release.release.departureWindow.start)) {
      await this.progress(
        store,
        id,
        'ready',
        'departure_window_scheduled',
        'Review is complete. Waiting for the original scheduled departure window.',
      );
      return;
    }
    const plan = validateMissionDeparturePlan({
      version: 1,
      apiUrl: this.config.apiUrl,
      tenantId: acting.tenantId,
      principalId: acting.id,
      runId: store.state.world.config.runId,
      reservationId: id,
      flightId,
      aircraftId: record.aircraftId,
      mission: reference,
      release: { id: release.release.id, digest: release.digest },
      departureAttemptId: `${id}:departure:1`,
      marginMs: 10_000,
      latencyMarginMs: 5000,
      handoffAllowanceMs: 30_000,
      allocationDurationMs: 90_000,
    });
    await this.progress(
      store,
      id,
      'ready',
      'review_complete',
      flight.needsHumanReview
        ? 'The exact human release and personal briefing reviews are complete. The source will separately authorize departure.'
        : 'The complete clear route has its recorded service release. The source will separately authorize departure.',
    );
    await this.update(store, id, (next) => {
      next.departurePlan = plan;
    });
    await this.depart(store, id);
  }
  private async depart(store: OperationStore, id: string) {
    const flight = this.current(store, id);
    const plan = flight.departurePlan!;
    const configured = this.config.tenants[flight.tenant];
    const { source, actor } = this.clients[flight.tenant];
    const api = this.actorApi(flight.tenant);
    const journalPath = join(this.config.directory, `${canonicalDigest(id)}.departure.json`);
    await assertSeparateOperationPaths([journalPath, `${journalPath}.lock`], store.checkpointPath);
    const result = await runOperationDeparture(
      plan,
      journalPath,
      store,
      api,
      (body, key) =>
        actor.request<MissionDepartureAuthorizationResponse>('/v1/commands', { method: 'POST', body }, key),
      () => this.now(),
      this.config.clock,
      (principal) => this.requireFreshActor(flight.tenant, principal),
    );
    const retained = await readDepartureJournal(journalPath, plan);
    const permit = retained?.authorization?.authorization;
    if (permit)
      await this.update(store, id, (next) => {
        next.references!.permit = { id: permit.permit.id, digest: permit.digest };
      });
    if (['current_controls_changed', 'current_controls_unsupported'].includes(result.code))
      await this.requireHuman(store, id);
    if (result.status !== 'departed') {
      if (result.status === 'abandoned') {
        const cancelled = store.state.world.reservations?.some((row) => row.id === id && row.phase === 'cancelled');
        if (cancelled && store.state.pending[id]?.length) return;
        await this.progress(store, id, cancelled ? 'cancelled' : 'blocked', result.code, result.reason, false);
      } else
        await this.progress(
          store,
          id,
          'departure_unknown',
          result.code,
          result.reason,
          result.code !== 'permit_expired',
        );
      return;
    }
    const committed = store.state.world.departures?.find((row) => row.reservationId === id);
    if (!committed) throw new Error('Ordinary departure confirmation lost its exact physical commit');
    const receipts = await source.receipts({ flightId: plan.flightId, limit: 200 });
    const receipt = receipts.receipts.find(
      (row) =>
        row.kind === 'flight.observation' &&
        row.payload?.activity === 'active' &&
        row.sourceId === `simulation-person-${flight.tenant}` &&
        row.processing.status === 'completed' &&
        Date.parse(row.occurredAt) === Date.parse(committed.departureAt),
    );
    if (!receipt) return;
    await this.update(store, id, (next) => {
      next.references!.permit = { id: committed.permit.id, digest: committed.permitDigest };
      next.references!.departureReceipt = receipt.id;
    });
    await this.progress(
      store,
      id,
      'departed',
      'native_departure_projected',
      'The separately authorized aircraft departed and is flying the retained mission geometry.',
      false,
    );
  }
}
