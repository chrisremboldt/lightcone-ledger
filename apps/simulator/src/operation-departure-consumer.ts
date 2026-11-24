import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  type MissionDepartureAuthorizationResponse,
  type MissionDepartureFitWitness,
  type MissionReleaseRecordResponse,
  type MissionAvoidanceResponse,
  type FlightControlsResponse,
  type MissionReleaseValidityResponse,
  type Principal,
  MissionReleaseValidityResponseSchema,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import {
  FlightMissionResponseSchema,
  FlightResponseSchema,
  MissionAvoidanceResponseSchema,
} from '@ledger/contracts/openapi';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  allocateOperationDeparture,
  consumeOperationDeparture,
  operationAdditiveFlight,
  holdsWorldOperationAttempt,
  operationDepartureResources,
  operationReservationFit,
  type OperationDepartureCurrentControls,
} from '@ledger/simulation-models/operation';
import type { OracleReader } from './attempt-oracle.js';
import {
  checkMissionDepartureAuthority,
  validateMissionDepartureRequest,
  validateMissionDepartureResponse,
} from './mission-departure-api.js';
import { ReleasePending, validateMissionDeparturePlan, type MissionDeparturePlan } from './mission-departure-plan.js';
import { confirmMissionRelease } from './mission-release-confirmation.js';
import { validateMissionReleaseMission, validateMissionReleasePlan } from './mission-release-plan.js';
import {
  lockDepartureJournal,
  preparationFromJournal,
  readDepartureJournal,
  saveDepartureJournal,
  validateDeparturePreparation,
  type OperationDepartureJournal,
  type OperationDeparturePreparation,
} from './operation-departure-journal.js';
import { advanceLiveClock, type OperationCheckpoint, type OperationStore } from './operation-state.js';
import type { OperationActionClock } from './operation-action-clock.js';
import { OracleReadError } from './oracle-api.js';
import { adoptSelectedPublicMission } from './operation-mission-adoption.js';

export interface OperationDepartureResult {
  status: 'held' | 'departed' | 'abandoned';
  code: string;
  reason: string;
  flightId: string;
  attemptId?: string;
  departureAt?: string;
}

const ajv = new Ajv({ strict: false, strictNumbers: true });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const flightShape = ajv.compile(FlightResponseSchema);
const missionShape = ajv.compile(FlightMissionResponseSchema);
const avoidanceShape = ajv.compile<MissionAvoidanceResponse>(MissionAvoidanceResponseSchema);
const validityShape = ajv.compile<MissionReleaseValidityResponse>(MissionReleaseValidityResponseSchema);
const same = (first: unknown, second: unknown) => canonicalDigest(first) === canonicalDigest(second);

function held(code: string, reason: string): never {
  throw new ReleasePending(code, reason);
}

function wallClock(at: number): number {
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime()))
    held('wall_clock_invalid', 'Departure requires a finite live wall clock');
  return at;
}

function synchronize(
  state: OperationCheckpoint,
  at: number,
  plan: MissionDeparturePlan,
  clock?: OperationActionClock,
): void {
  wallClock(at);
  if (
    state.world.config.runId !== plan.runId ||
    state.clock.mode !== 'live' ||
    state.clock.paused ||
    state.world.now !== state.clock.wallAt ||
    at < state.clock.wallAt
  )
    held('world_clock_unavailable', 'Departure requires this live, unpaused world aligned with the current wall clock');
  if (clock) clock(state, at);
  else advanceLiveClock(state, at, false);
}

function departureJob(plan: MissionDeparturePlan): NonNullable<OperationCheckpoint['departureJob']> {
  return {
    version: 'operation.departure-job.1',
    flightId: plan.flightId,
    reservationId: plan.reservationId,
    departureAttemptId: plan.departureAttemptId,
    planDigest: canonicalDigest(plan),
  };
}

function selectedJob(state: OperationCheckpoint, plan: MissionDeparturePlan) {
  if (state.world.ordinaryDispatch?.flights.some((flight) => flight.attemptId === plan.reservationId))
    return state.ordinaryDepartureJobs?.[plan.reservationId];
  return state.world.demoFlights?.some((flight) => flight.attemptId === plan.reservationId)
    ? state.demoDepartureJobs?.[plan.reservationId]
    : state.departureJob;
}

function checkDepartureJob(state: OperationCheckpoint, plan: MissionDeparturePlan): void {
  const demo =
    state.world.demoFlights?.find((flight) => flight.attemptId === plan.reservationId) ??
    state.world.ordinaryDispatch?.flights.find((flight) => flight.attemptId === plan.reservationId);
  if (demo && (plan.runId !== state.world.config.runId || plan.tenantId !== `tenant-${demo.tenant}`))
    held('reservation_changed', 'Demo departure changed its exact operator or run');
  const predeparture = state.world.config.predeparture;
  if (
    !demo &&
    predeparture?.version === 'reserve-selected-await-release.1' &&
    (state.world.config.runId !== plan.runId ||
      plan.tenantId !== `tenant-${predeparture.tenant}` ||
      !holdsWorldOperationAttempt(state.world, predeparture.tenant, plan.reservationId))
  )
    held('reservation_changed', 'Departure must select the reservation pinned by this world');
  const job = selectedJob(state, plan);
  if (job && !same(job, departureJob(plan)))
    held('departure_job_conflict', 'This world already selected its one exact departure job');
  const selected = (reservationId: string) =>
    demo ? reservationId === plan.reservationId : !operationAdditiveFlight(state.world, reservationId);
  const allocations = state.world.departureAllocations?.filter((row) => selected(row.reservationId));
  const departures = state.world.departures?.filter((row) => selected(row.reservationId));
  const requests = state.departureRequests
    ? Object.fromEntries(Object.entries(state.departureRequests).filter(([, row]) => selected(row.reservationId)))
    : undefined;
  if (
    (allocations !== undefined && (!Array.isArray(allocations) || allocations.length > 1)) ||
    (departures !== undefined && (!Array.isArray(departures) || departures.length > 1)) ||
    (requests !== undefined &&
      (typeof requests !== 'object' ||
        requests === null ||
        Array.isArray(requests) ||
        Object.keys(requests).length > 1))
  )
    held('checkpoint_mismatch', 'The single-job departure checkpoint exceeds its retained record bound');
  const allocation = allocations?.[0];
  const commit = departures?.[0];
  const requestKeys = Object.keys(requests ?? {});
  const prepared = requestKeys.length ? requests![requestKeys[0]!] : undefined;
  if (
    (!job && (allocations?.length || departures?.length || requestKeys.length)) ||
    (allocations?.length && !allocation) ||
    (departures?.length && !commit) ||
    (requestKeys.length && (requestKeys[0] !== plan.flightId || !prepared)) ||
    (prepared &&
      (requestKeys[0] !== plan.flightId ||
        prepared.planDigest !== job?.planDigest ||
        prepared.reservationId !== plan.reservationId ||
        prepared.flightId !== plan.flightId)) ||
    (allocation &&
      (!prepared ||
        !same(allocation, prepared.allocation) ||
        allocation.flightId !== plan.flightId ||
        allocation.reservationId !== plan.reservationId ||
        allocation.departureAttemptId !== plan.departureAttemptId)) ||
    (commit &&
      (!allocation ||
        !same(commit.allocation, allocation) ||
        commit.caller.planDigest !== job?.planDigest ||
        commit.flightId !== plan.flightId ||
        commit.reservationId !== plan.reservationId ||
        commit.departureAttemptId !== plan.departureAttemptId))
  )
    held('checkpoint_mismatch', "The retained departure records differ from this world's one selected job");
}

export function checkOperationDepartureSelection(
  state: OperationCheckpoint,
  plan: MissionDeparturePlan,
): OperationDepartureResult | undefined {
  checkDepartureJob(state, plan);
  const terminal = cancelled(state, plan);
  if (terminal) return terminal;
  if (selectedJob(state, plan)) return;
  const reservation = state.world.reservations?.find((row) => row.id === plan.reservationId);
  const aircraft = state.world.aircraft.find((row) => row.id === plan.aircraftId);
  if (
    state.world.config.runId !== plan.runId ||
    !reservation ||
    reservation.phase !== 'awaiting-release' ||
    !holdsWorldOperationAttempt(state.world, reservation.tenant, reservation.id) ||
    plan.tenantId !== `tenant-${reservation.tenant}` ||
    reservation.aircraftId !== plan.aircraftId ||
    (reservation.plan.sourceRevision !== plan.mission.sourceRevision &&
      !(
        (state.world.config.predeparture?.version === 'reserve-selected-await-release.1' ||
          state.world.demoFlights?.some((flight) => flight.attemptId === plan.reservationId)) &&
        reservation.plan.routePlanning &&
        plan.mission.sourceRevision > reservation.plan.sourceRevision
      )) ||
    state.world.attempts.some((attempt) => attempt.id === reservation.id) ||
    aircraft?.phase !== 'reserved' ||
    aircraft.attemptId !== reservation.id ||
    aircraft.personId !== reservation.personId
  )
    held('reservation_changed', 'Departure must select the exact current held reservation and aircraft');
  return undefined;
}

function recorded(state: OperationCheckpoint, plan: MissionDeparturePlan): OperationDepartureResult | undefined {
  checkDepartureJob(state, plan);
  const commit = state.world.departures?.find((row) => row.flightId === plan.flightId);
  if (!commit) return undefined;
  if (
    commit.version !== 'operation.departure-commit.1' ||
    commit.caller.planDigest !== canonicalDigest(plan) ||
    commit.caller.principalId !== plan.principalId ||
    commit.caller.tenantId !== plan.tenantId ||
    commit.caller.apiUrl !== plan.apiUrl ||
    commit.reservationId !== plan.reservationId ||
    commit.aircraftId !== plan.aircraftId ||
    commit.departureAttemptId !== plan.departureAttemptId ||
    commit.permitDigest !== canonicalDigest(commit.permit) ||
    sha256(commit.requestBytes) !== commit.caller.payloadSha256 ||
    !same(commit.permit.mission, plan.mission) ||
    !same(commit.permit.release, plan.release)
  )
    held('checkpoint_mismatch', 'The retained departure belongs to another exact caller or reviewed plan');
  return {
    status: 'departed',
    code: 'departure_recorded',
    reason: 'The checkpoint already records this departure and its complete physical schedule',
    flightId: plan.flightId,
    attemptId: commit.attemptId,
    departureAt: commit.departureAt,
  };
}

function cancelled(state: OperationCheckpoint, plan: MissionDeparturePlan): OperationDepartureResult | undefined {
  const reservation = state.world.reservations?.find((row) => row.id === plan.reservationId);
  if (reservation?.phase !== 'cancelled') return;
  const cancellation = reservation.cancellation;
  if (
    state.world.config.runId !== plan.runId ||
    plan.tenantId !== `tenant-${reservation.tenant}` ||
    reservation.aircraftId !== plan.aircraftId ||
    !holdsWorldOperationAttempt(state.world, reservation.tenant, reservation.id) ||
    !cancellation ||
    cancellation.reason !== 'requested_window_unreachable' ||
    typeof cancellation.note !== 'string' ||
    !cancellation.note
  )
    held('checkpoint_mismatch', 'The cancelled reservation differs from this exact departure selection');
  return {
    status: 'abandoned',
    code: 'requested_window_unreachable',
    reason: cancellation.note,
    flightId: plan.flightId,
  };
}

function sourceMatches(
  state: OperationCheckpoint,
  plan: MissionDeparturePlan,
  release: MissionReleaseRecordResponse,
): void {
  const reservation = state.world.reservations?.find((row) => row.id === plan.reservationId);
  const mission = release.release.basis.mission;
  if (
    !reservation ||
    !holdsWorldOperationAttempt(state.world, reservation.tenant, reservation.id) ||
    plan.tenantId !== `tenant-${reservation.tenant}` ||
    reservation.aircraftId !== plan.aircraftId ||
    mission.sourceId !== 'mission-planner'
  )
    held('reservation_changed', 'The reviewed departure no longer selects this held aircraft and tenant');
  const {
    sourceRevision,
    occurredAt,
    sourceMissionId,
    aircraftId,
    route,
    lateralToleranceMeters,
    altitude,
    operatingInterval,
  } = mission;
  if (
    !same(reservation.plan, {
      sourceRevision,
      occurredAt,
      sourceMissionId,
      aircraftId,
      route,
      lateralToleranceMeters,
      altitude,
      operatingInterval,
      ...(mission.routePlanning ? { routePlanning: mission.routePlanning } : {}),
    })
  )
    held('mission_changed', 'The held source plan differs from the exact released mission');
}

function checkSubmissionAllocation(
  state: OperationCheckpoint,
  plan: MissionDeparturePlan,
  prepared: OperationDeparturePreparation,
  at: number,
  clock?: OperationActionClock,
): OperationDepartureResult | undefined {
  checkDepartureJob(state, plan);
  let terminal = cancelled(state, plan);
  if (terminal) return terminal;
  synchronize(state, at, plan, clock);
  terminal = cancelled(state, plan);
  if (terminal) return terminal;
  sourceMatches(state, plan, prepared.release);
  const allocation = prepared.allocation;
  const retained = state.world.departureAllocations?.find((row) => row.id === allocation.id);
  const aircraft = state.world.aircraft.find((row) => row.id === allocation.aircraftId);
  const person = operationDepartureResources(state.world, plan.reservationId)?.flightPeople.find(
    (row) => row.id === allocation.personId,
  );
  const pad = operationDepartureResources(state.world, plan.reservationId)?.launchPads.find(
    (row) => row.id === allocation.padId,
  );
  if (
    !same(state.departureRequests?.[plan.flightId], prepared) ||
    !same(retained, allocation) ||
    aircraft?.phase !== 'reserved' ||
    aircraft.attemptId !== plan.reservationId ||
    aircraft.personId !== allocation.personId ||
    aircraft.maintenanceUntil > at ||
    person?.aircraftId !== allocation.aircraftId ||
    person.tenant !== aircraft.tenant ||
    pad?.aircraftId !== allocation.aircraftId ||
    pad.tenant !== aircraft.tenant ||
    pad.availableAt !== Date.parse(allocation.endsAt) ||
    at < Date.parse(allocation.startsAt) ||
    at + plan.handoffAllowanceMs + plan.latencyMarginMs + 10_000 > Date.parse(allocation.endsAt)
  )
    held(
      'allocation_unavailable',
      'The original exclusive resources no longer cover the bounded authorization handoff',
    );
  if (
    at < Date.parse(prepared.release.release.departureWindow.start) ||
    at + plan.handoffAllowanceMs + plan.latencyMarginMs >= Date.parse(prepared.release.release.departureWindow.end)
  )
    held(
      'release_window_unavailable',
      'The original release window no longer covers the bounded authorization handoff',
    );
  const fit = operationReservationFit(state.world, plan.reservationId, {
    marginMs: plan.marginMs,
    handoffAllowanceMs: plan.handoffAllowanceMs,
  });
  if (fit.status !== 'fits')
    held(
      'operation_does_not_fit',
      'The full original route, known holds and handoff no longer fit the exact mission interval',
    );
  return undefined;
}

async function reviewRelease(plan: MissionDeparturePlan, api: OracleReader): Promise<MissionReleaseRecordResponse> {
  const path = `/v1/flights/${encodeURIComponent(plan.flightId)}`;
  const value = await api.json<MissionReleaseRecordResponse>(
    `${path}/mission-releases/${encodeURIComponent(plan.release.id)}`,
  );
  if (
    !value?.release ||
    value.digest !== plan.release.digest ||
    value.release.id !== plan.release.id ||
    canonicalDigest(value.release) !== plan.release.digest
  )
    held('release_changed', 'The exact immutable release differs from the reviewed reference');
  const release = value.release;
  const releasePlan = validateMissionReleasePlan({
    version: 2,
    apiUrl: plan.apiUrl,
    tenantId: plan.tenantId,
    principalId: release.actor.id,
    flightId: plan.flightId,
    aircraftId: plan.aircraftId,
    mission: plan.mission,
    calculation: {
      id: release.basis.avoidance.calculation.id,
      version: release.basis.avoidance.calculation.version,
      digest: release.basis.avoidance.calculation.digest,
    },
    policy: { id: release.policy.id, version: release.policy.version, digest: release.policy.digest },
    expectedContextDigest: release.basis.avoidance.contextDigest,
    expectedFindingsDigest: 'findings' in release.basis ? release.basis.findings.digest : '',
    departureWindow: release.departureWindow,
    note: release.note,
  });
  const payload = {
    kind: 'mission.release',
    flightId: plan.flightId,
    aircraftId: plan.aircraftId,
    mission: plan.mission,
    calculation: releasePlan.calculation,
    policy: releasePlan.policy,
    expectedContextDigest: releasePlan.expectedContextDigest,
    expectedFindingsDigest: releasePlan.expectedFindingsDigest,
    expectedPrincipalRevision: release.actor.principalRevision,
    departureWindow: release.departureWindow,
    note: release.note,
  };
  const confirmed = await confirmMissionRelease(
    releasePlan,
    {
      id: release.id,
      kind: 'mission.release',
      flightId: plan.flightId,
      actorId: release.actor.id,
      recordedAt: release.recordedAt,
      payload,
    },
    {
      json: async <T>(requested: string): Promise<T> =>
        requested === `${path}/mission-releases/${encodeURIComponent(plan.release.id)}`
          ? (value as T)
          : api.json<T>(requested),
      bytes: (requested) => api.bytes(requested),
      usage: () => api.usage(),
    },
    1,
  );
  if (confirmed.record !== 'confirmed' || confirmed.validity?.status !== 'current')
    held('release_not_current', 'The exact release does not have confirmed current as-of validity');
  const flight = await api.json<unknown>(path);
  if (!flightShape(flight) || flight.flight.id !== plan.flightId || flight.flight.aircraft !== plan.aircraftId)
    held('aircraft_changed', 'The current flight assignment differs from the reviewed aircraft');
  const mission = await api.json<unknown>(`${path}/mission`);
  if (
    !missionShape(mission) ||
    !mission.acceptedHead ||
    !mission.projectedHead ||
    mission.acceptedHead.processing.status !== 'completed'
  )
    held('mission_pending', 'The exact mission must be accepted and successfully projected');
  validateMissionReleaseMission(mission.acceptedHead.record, releasePlan);
  validateMissionReleaseMission(mission.projectedHead, releasePlan);
  const { missionId, flightId, sourceId, sourceMissionId, aircraftId } = release.basis.mission;
  if (!same(mission.binding, { missionId, flightId, sourceId, sourceMissionId, aircraftId }))
    held('mission_changed', 'The current mission binding differs from the released flight and aircraft');
  return structuredClone(value);
}

// The departure pins the controls in scope its authorizer read. When they change before the command commits, the
// authorizer reads them again and retries, as a person would; after this many reads the refusal stands.
const CONTROLS_SEEN_VERSION = 'flight.controls-seen.1';
const CONTROLS_CHANGED = 'flight_controls_changed';
export const DEPARTURE_CONTROLS_READS = 3;

/** The digest of the controls in scope for the flight, as listed now; it must reproduce from the list. */
export async function readFlightControlsDigest(plan: MissionDeparturePlan, api: OracleReader): Promise<string> {
  const value = await api.json<Partial<FlightControlsResponse> | undefined>(
    `/v1/flights/${encodeURIComponent(plan.flightId)}/controls`,
  );
  if (
    !value ||
    value.flightId !== plan.flightId ||
    !Array.isArray(value.controls) ||
    !Array.isArray(value.notApplicable) ||
    typeof value.complete !== 'boolean' ||
    value.mission === undefined ||
    typeof value.digest !== 'string' ||
    value.digest !==
      canonicalDigest({
        version: CONTROLS_SEEN_VERSION,
        controls: value.controls,
        notApplicable: value.notApplicable,
        complete: value.complete,
        mission: value.mission,
      })
  )
    held('controls_unsupported', 'The controls in scope for this flight could not be read in a supported shape');
  return value.digest;
}

/** The retained request again with the digest of the controls just read, under a new key, in the checkpoint. */
async function prepareWithControls(
  store: OperationStore,
  plan: MissionDeparturePlan,
  prepared: OperationDeparturePreparation,
  controlsDigest: string,
  at: number,
): Promise<OperationDeparturePreparation> {
  const payload = JSON.stringify({ ...JSON.parse(prepared.request.payload), expectedControlsDigest: controlsDigest });
  const next = validateDeparturePreparation(
    {
      ...prepared,
      request: {
        key: `simulator:departure:${randomUUID()}`,
        payload,
        payloadSha256: sha256(payload),
        startedAt: new Date(at).toISOString(),
      },
    },
    plan,
  );
  await store.update((state) => {
    checkDepartureJob(state, plan);
    if (!same(state.departureRequests?.[plan.flightId], prepared))
      held('checkpoint_mismatch', 'The retained departure request changed before the controls were read again');
    state.departureRequests![plan.flightId] = structuredClone(next);
  });
  return next;
}

function definitive(error: unknown): { status: number; code: string } | undefined {
  if (
    !(error instanceof ApiError) ||
    !Number.isSafeInteger(error.status) ||
    error.status < 400 ||
    error.status >= 500 ||
    [401, 403, 404, 408, 425, 429].includes(error.status)
  )
    return undefined;
  const body = error.body as { error?: { code?: unknown } } | undefined;
  return typeof body?.error?.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(body.error.code)
    ? { status: error.status, code: body.error.code }
    : undefined;
}

async function submitBounded<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ReleasePending(
                'authorization_uncertain',
                'Authorization response is uncertain; recover only the retained request and key',
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runOperationDeparture(
  value: MissionDeparturePlan,
  statePath: string,
  store: OperationStore,
  api: OracleReader,
  submit: (payload: string, key: string) => Promise<MissionDepartureAuthorizationResponse>,
  now: () => number = Date.now,
  clock?: OperationActionClock,
  validateFreshPrincipal?: (principal: Principal) => void,
): Promise<OperationDepartureResult> {
  let journal: OperationDepartureJournal | undefined;
  let unlock: (() => Promise<void>) | undefined;
  let plan: MissionDeparturePlan | undefined;
  let terminal: OperationDepartureResult | undefined;
  let stage: 'recovery' | 'review' | 'submission' | 'consumption' | 'confirmation' = 'recovery';
  try {
    plan = validateMissionDeparturePlan(value);
    await store.update((state) => {
      terminal = recorded(state, plan!) ?? checkOperationDepartureSelection(state, plan!);
      if (terminal) return;
      if (!selectedJob(state, plan!)) {
        clock?.(state, wallClock(now()));
        terminal = cancelled(state, plan!);
        if (terminal) return;
        if (state.world.ordinaryDispatch?.flights.some((flight) => flight.attemptId === plan!.reservationId))
          (state.ordinaryDepartureJobs ??= {})[plan!.reservationId] = departureJob(plan!);
        else if (state.world.demoFlights?.some((flight) => flight.attemptId === plan!.reservationId))
          (state.demoDepartureJobs ??= {})[plan!.reservationId] = departureJob(plan!);
        else state.departureJob = departureJob(plan!);
      }
    });
    if (terminal) return terminal;
    unlock = await lockDepartureJournal(statePath);
    journal = await readDepartureJournal(statePath, plan);
    if (journal?.status === 'departed')
      held('checkpoint_mismatch', 'The companion departure confirmation has no authoritative world transition');
    const retained = store.state.departureRequests?.[plan.flightId];
    let prepared = retained ? validateDeparturePreparation(retained, plan) : undefined;
    if (journal && (!prepared || !same(preparationFromJournal(journal), prepared)))
      held('checkpoint_mismatch', 'The companion request differs from the authoritative world preparation');
    terminal = cancelled(store.state, plan);
    if (terminal) return terminal;
    if (!prepared) {
      stage = 'review';
      const current = await checkMissionDepartureAuthority(plan, api, true);
      validateFreshPrincipal?.(current);
      const release = await reviewRelease(plan, api);
      const controlsDigest = await readFlightControlsDigest(plan, api);
      await adoptSelectedPublicMission(plan, release.release.basis.mission, store, api, now, clock);
      const allocationId = randomUUID();
      const key = `simulator:departure:${randomUUID()}`;
      const reviewedPlan = plan;
      await store.update((state) => {
        checkDepartureJob(state, reviewedPlan);
        terminal = cancelled(state, reviewedPlan);
        if (terminal) return;
        if (!selectedJob(state, reviewedPlan)) held('checkpoint_mismatch', 'The selected departure job is missing');
        const at = wallClock(now());
        synchronize(state, at, reviewedPlan, clock);
        terminal = cancelled(state, reviewedPlan);
        if (terminal) return;
        if (
          state.departureRequests?.[reviewedPlan.flightId] ||
          state.world.departures?.some((row) => row.flightId === reviewedPlan.flightId)
        )
          held('departure_conflict', 'This flight already has an exact retained departure request');
        sourceMatches(state, reviewedPlan, release);
        const fit = operationReservationFit(state.world, reviewedPlan.reservationId, {
          marginMs: reviewedPlan.marginMs,
          handoffAllowanceMs: reviewedPlan.handoffAllowanceMs,
        });
        if (fit.status !== 'fits')
          held(
            'operation_does_not_fit',
            'The full held route, known holds and margin do not fit the exact mission interval',
          );
        if (
          at < Date.parse(release.release.departureWindow.start) ||
          at + reviewedPlan.handoffAllowanceMs + reviewedPlan.latencyMarginMs >=
            Date.parse(release.release.departureWindow.end)
        )
          held(
            'release_window_unavailable',
            'The current release window does not cover the bounded authorization handoff',
          );
        const allocation = allocateOperationDeparture(state.world, {
          id: allocationId,
          flightId: reviewedPlan.flightId,
          reservationId: reviewedPlan.reservationId,
          departureAttemptId: reviewedPlan.departureAttemptId,
          mission: reviewedPlan.mission,
          release: reviewedPlan.release,
          durationMs: reviewedPlan.allocationDurationMs,
        });
        const request = validateMissionDepartureRequest(
          {
            kind: 'mission.departure-authorize',
            flightId: reviewedPlan.flightId,
            aircraftId: reviewedPlan.aircraftId,
            release: reviewedPlan.release,
            departureAttemptId: reviewedPlan.departureAttemptId,
            allocation: { id: allocation.id, digest: canonicalDigest(allocation) },
            expectedPrincipalRevision: current.revision,
            expectedControlsDigest: controlsDigest,
          },
          reviewedPlan,
          { id: allocation.id, digest: canonicalDigest(allocation) },
        );
        const payload = JSON.stringify(request);
        prepared = validateDeparturePreparation(
          {
            version: 1,
            kind: 'operation-departure',
            planDigest: canonicalDigest(reviewedPlan),
            principalId: reviewedPlan.principalId,
            tenantId: reviewedPlan.tenantId,
            apiUrl: reviewedPlan.apiUrl,
            runId: reviewedPlan.runId,
            reservationId: reviewedPlan.reservationId,
            flightId: reviewedPlan.flightId,
            allocation,
            request: { key, payload, payloadSha256: sha256(payload), startedAt: new Date(at).toISOString() },
            release,
          },
          reviewedPlan,
        );
        (state.departureRequests ??= {})[reviewedPlan.flightId] = structuredClone(prepared);
      });
      if (terminal) return terminal;
    }
    if (!prepared) held('checkpoint_unavailable', 'The original departure preparation is unavailable');
    journal ??= { ...prepared, status: 'submitted' };
    if (journal.status === 'abandoned')
      return {
        status: 'abandoned',
        code: journal.rejection!.code,
        reason: 'The retained departure cannot obtain a replacement authorization',
        flightId: plan.flightId,
      };
    await saveDepartureJournal(statePath, journal, plan);
    if (!journal.authorization) {
      stage = 'submission';
      let response: MissionDepartureAuthorizationResponse | undefined;
      let startedAt = 0;
      for (let read = 1; !response; read++) {
        await checkMissionDepartureAuthority(plan, api, false);
        const original = preparationFromJournal(journal);
        const submissionPlan = plan;
        await store.update((state) => {
          terminal = checkSubmissionAllocation(state, submissionPlan, original, wallClock(now()), clock);
        });
        if (terminal) return terminal;
        startedAt = wallClock(now());
        if (checkSubmissionAllocation(structuredClone(store.state), submissionPlan, original, startedAt, clock)) {
          await store.update((state) => {
            terminal = checkSubmissionAllocation(state, submissionPlan, original, wallClock(now()), clock);
          });
          if (terminal) return terminal;
          held('checkpoint_mismatch', 'The cancelled reservation could not be retained before authorization');
        }
        try {
          const submitted = journal;
          response = await submitBounded(
            () => submit(submitted.request.payload, submitted.request.key),
            plan.handoffAllowanceMs,
          );
        } catch (error) {
          const rejection = definitive(error);
          if (!rejection) throw error;
          if (rejection.code === CONTROLS_CHANGED && read < DEPARTURE_CONTROLS_READS) {
            const controlsDigest = await readFlightControlsDigest(plan, api);
            const next = await prepareWithControls(store, plan, original, controlsDigest, wallClock(now()));
            journal = { ...next, status: 'submitted' };
            await saveDepartureJournal(statePath, journal, plan);
            continue;
          }
          journal.status = 'abandoned';
          journal.rejection = rejection;
          await saveDepartureJournal(statePath, journal, plan);
          return {
            status: 'abandoned',
            code: rejection.code,
            reason:
              rejection.code === CONTROLS_CHANGED
                ? `The controls in scope changed each of the ${DEPARTURE_CONTROLS_READS} times they were read before the departure command; no departure was recorded and the flight stays on the ground`
                : 'The retained authorization was definitively rejected; no replacement will be created',
            flightId: plan.flightId,
          };
        }
      }
      const receivedAt = wallClock(now());
      validateMissionDepartureResponse(
        response,
        JSON.parse(journal.request.payload),
        plan,
        { id: journal.allocation.id, digest: canonicalDigest(journal.allocation) },
        journal.release.release.basis.mission,
        journal.release,
        startedAt,
        receivedAt,
      );
      journal.authorization = structuredClone(response);
      journal.receivedAt = new Date(receivedAt).toISOString();
      journal.status = 'authorized';
      await saveDepartureJournal(statePath, journal, plan);
    }
    stage = 'consumption';
    const authorized = journal;
    const reviewedPlan = plan;
    if (validateFreshPrincipal) validateFreshPrincipal(await checkMissionDepartureAuthority(plan, api, false));
    let currentControls: OperationDepartureCurrentControls | undefined;
    if (store.state.world.ordinaryDispatch?.flights.some((flight) => flight.attemptId === reviewedPlan.reservationId)) {
      const readStartedAt = wallClock(now());
      const path = `/v1/flights/${encodeURIComponent(reviewedPlan.flightId)}`;
      const [avoidance, releaseValidity] = await Promise.all([
        api.json<MissionAvoidanceResponse>(`${path}/mission-avoidance`),
        api.json<MissionReleaseValidityResponse>(
          `${path}/mission-releases/${encodeURIComponent(reviewedPlan.release.id)}/validity`,
        ),
      ]);
      const readFinishedAt = wallClock(now());
      if (!avoidanceShape(avoidance) || !validityShape(releaseValidity))
        held('current_controls_unsupported', 'The final public control or release read is unsupported');
      const permit = authorized.authorization!.authorization.permit;
      if (
        avoidance.candidates.some((candidate) => candidate.context === 'pending') ||
        releaseValidity.status === 'pending'
      )
        throw new OracleReadError(
          'pending',
          'current_controls_pending',
          'The final control or release projection is not current; the original permit remains unconsumed',
        );
      if (
        avoidance.status !== 'outside' ||
        avoidance.candidateCompleteness.status !== 'complete' ||
        !same(avoidance.mission, reviewedPlan.mission) ||
        avoidance.contextDigest !== permit.contextDigest ||
        avoidance.candidates.some((candidate) => candidate.geometry !== 'outside' || candidate.context !== 'current') ||
        !same(releaseValidity.release, reviewedPlan.release) ||
        releaseValidity.status !== 'current' ||
        releaseValidity.processing !== 'completed' ||
        releaseValidity.currentContextDigest !== permit.contextDigest
      )
        held(
          'current_controls_changed',
          'The final current control or release basis differs from the issued permit; the flight remains grounded',
        );
      const { previewDigest, meta: _meta, ...preview } = avoidance;
      if (previewDigest !== canonicalDigest(preview))
        held('current_controls_changed', 'The final public control response does not match its retained digest');
      currentControls = {
        version: 'operation.departure-current-controls.1',
        readStartedAt: new Date(readStartedAt).toISOString(),
        readFinishedAt: new Date(readFinishedAt).toISOString(),
        avoidance: structuredClone(avoidance),
        avoidanceDigest: canonicalDigest(avoidance),
        releaseValidity: structuredClone(releaseValidity),
        releaseValidityDigest: canonicalDigest(releaseValidity),
      };
    }
    await store.update((state) => {
      checkDepartureJob(state, reviewedPlan);
      terminal = cancelled(state, reviewedPlan);
      if (terminal) return;
      const at = wallClock(now());
      synchronize(state, at, reviewedPlan, clock);
      terminal = cancelled(state, reviewedPlan);
      if (terminal) return;
      sourceMatches(state, reviewedPlan, authorized.release);
      if (!same(state.departureRequests?.[reviewedPlan.flightId], preparationFromJournal(authorized)))
        held('checkpoint_mismatch', 'The original request preparation changed before consumption');
      const result = authorized.authorization!.authorization;
      const permit = result.permit;
      if (
        at < Date.parse(permit.authorizedAt) ||
        at + reviewedPlan.latencyMarginMs >= Date.parse(permit.validUntil) ||
        at + reviewedPlan.latencyMarginMs >= Date.parse(authorized.allocation.endsAt) ||
        at < Date.parse(authorized.release.release.departureWindow.start) ||
        at + reviewedPlan.latencyMarginMs >= Date.parse(authorized.release.release.departureWindow.end)
      )
        held('permit_expired', 'The original unused permit no longer covers the live consumption latency margin');
      const fit = operationReservationFit(state.world, reviewedPlan.reservationId, { marginMs: reviewedPlan.marginMs });
      if (fit.status !== 'fits')
        held(
          'operation_does_not_fit',
          'The full current route and known holds no longer fit the exact mission interval',
        );
      const witness: MissionDepartureFitWitness = {
        version: 'mission.departure-fit.1',
        permit: { id: permit.id, digest: result.digest },
        mission: reviewedPlan.mission,
        aircraftId: reviewedPlan.aircraftId,
        evaluatedAt: new Date(at).toISOString(),
        remainingDurationMs: fit.nominalDurationMs!,
        holdAllowanceMs: fit.holdAllowanceMs!,
        marginMs: reviewedPlan.marginMs,
        requiredCompletionAt: fit.requiredCompletionAt!,
      };
      if (
        currentControls &&
        (currentControls.avoidanceDigest !== canonicalDigest(currentControls.avoidance) ||
          currentControls.releaseValidityDigest !== canonicalDigest(currentControls.releaseValidity))
      )
        held('current_controls_changed', 'The retained final public reads changed before physical consumption');
      try {
        consumeOperationDeparture(state.world, {
          allocation: authorized.allocation,
          caller: {
            apiUrl: reviewedPlan.apiUrl,
            tenantId: reviewedPlan.tenantId,
            principalId: reviewedPlan.principalId,
            planDigest: canonicalDigest(reviewedPlan),
            requestKey: authorized.request.key,
            payloadSha256: authorized.request.payloadSha256,
          },
          request: JSON.parse(authorized.request.payload),
          requestBytes: authorized.request.payload,
          permit,
          permitDigest: result.digest,
          fit: witness,
          ...(currentControls ? { currentControls } : {}),
        });
      } catch (error) {
        held(
          'consumption_refused',
          error instanceof Error ? error.message : 'The original departure allocation cannot be consumed',
        );
      }
    });
    if (terminal) return terminal;
    const result = recorded(store.state, plan)!;
    stage = 'confirmation';
    journal.status = 'departed';
    journal.consumed = { attemptId: result.attemptId!, departureAt: result.departureAt! };
    await saveDepartureJournal(statePath, journal, plan);
    return result;
  } catch (error) {
    if (plan) {
      try {
        await store.update(() => {});
        const previous = recorded(store.state, plan);
        if (previous) return previous;
        const cancellation = cancelled(store.state, plan);
        if (cancellation) return cancellation;
      } catch (recoveryError) {
        return {
          status: 'held',
          code: recoveryError instanceof ReleasePending ? recoveryError.code : 'checkpoint_uncertain',
          reason:
            recoveryError instanceof ReleasePending
              ? recoveryError.message
              : 'Recover the authoritative checkpoint before retrying this exact request',
          flightId: plan.flightId,
        };
      }
    }
    if (plan && journal?.authorization && stage === 'consumption' && error instanceof ReleasePending) {
      journal.status = 'abandoned';
      journal.rejection = { code: error.code };
      await saveDepartureJournal(statePath, journal, plan).catch(() => {});
      return { status: 'abandoned', code: error.code, reason: error.message, flightId: plan.flightId };
    }
    return {
      status: 'held',
      code: error instanceof ReleasePending || error instanceof OracleReadError ? error.code : `${stage}_unavailable`,
      reason:
        error instanceof ReleasePending || error instanceof OracleReadError
          ? error.message
          : 'Departure remains grounded; retain the checkpoint and exact request journal before retrying',
      flightId: plan?.flightId ?? value?.flightId ?? 'unknown',
    };
  } finally {
    await unlock?.();
  }
}
