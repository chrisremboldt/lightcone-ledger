import type {
  FlightPredepartureProgress,
  FlightPredepartureProgressResponse,
  FlightPredepartureReferences,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import type { MissionDeparturePlan } from './mission-departure-plan.js';
import type { MissionReleasePlan } from './mission-release-plan.js';
import type { OperationCheckpoint } from './operation-state.js';

export interface OperationOrdinaryFlightState {
  version: 'operation.ordinary-source.1';
  reservationId: string;
  tenant: 'alpha' | 'beta';
  sourcePrincipalId: string;
  automaticReleasePrincipalId: string;
  publicRevision: number;
  needsHumanReview: boolean;
  flightId?: string;
  references?: FlightPredepartureReferences;
  progress?: FlightPredepartureProgressResponse;
  pendingProgress?: { body: string; key: string };
  rejectedProgress?: Array<{ body: string; key: string; status: number; code: string; rejectedAt: string }>;
  automaticReleasePlan?: MissionReleasePlan;
  departurePlan?: MissionDeparturePlan;
  terminalConfirmed?: boolean;
}

const same = (left: unknown, right: unknown) => canonicalDigest(left) === canonicalDigest(right);

export function selectOrdinaryMission(
  flight: OperationOrdinaryFlightState,
  mission: FlightPredepartureReferences['mission'],
): void {
  if (flight.departurePlan) throw new Error('A selected ordinary departure keeps its exact mission and request');
  if (!same(flight.references?.mission ?? null, mission))
    flight.references = { mission: structuredClone(mission), briefings: [] };
}

export function selectOrdinaryRelease(
  flight: OperationOrdinaryFlightState,
  release: NonNullable<FlightPredepartureReferences['release']>,
): void {
  if (flight.departurePlan || !flight.references)
    throw new Error('Ordinary release selection requires an unpinned exact mission');
  if (!same(flight.references.release ?? null, release)) flight.references.briefings = [];
  flight.references.release = structuredClone(release);
}

export function validateOperationOrdinarySources(state: OperationCheckpoint): void {
  const flights = Object.values(state.ordinaryFlights ?? {});
  if (flights.length > state.world.aircraft.length)
    throw new Error('Ordinary source jobs exceed the finite aircraft pool');
  for (const [id, flight] of Object.entries(state.ordinaryFlights ?? {})) {
    const registration = state.world.ordinaryDispatch?.flights.find((row) => row.attemptId === flight.reservationId);
    if (
      !registration ||
      id !== flight.reservationId ||
      registration.tenant !== flight.tenant ||
      flight.version !== 'operation.ordinary-source.1' ||
      !flight.sourcePrincipalId ||
      !flight.automaticReleasePrincipalId ||
      !Number.isSafeInteger(flight.publicRevision) ||
      flight.publicRevision < 0 ||
      flight.publicRevision > 256 ||
      typeof flight.needsHumanReview !== 'boolean' ||
      (flight.references && !flight.flightId) ||
      (flight.progress &&
        (flight.progress.progress.flightId !== flight.flightId ||
          flight.progress.digest !== canonicalDigest(flight.progress.progress)))
    )
      throw new Error('Ordinary source job changed its retained execution or public commitment');
    const job = state.ordinaryDepartureJobs?.[id];
    if (
      job &&
      (!flight.departurePlan ||
        job.reservationId !== id ||
        job.flightId !== flight.flightId ||
        job.departureAttemptId !== flight.departurePlan.departureAttemptId ||
        job.planDigest !== canonicalDigest(flight.departurePlan))
    )
      throw new Error('Ordinary departure job changed its exact source plan');
    if (flight.pendingProgress) {
      const request = JSON.parse(flight.pendingProgress.body) as FlightPredepartureProgress;
      if (
        request.expectedRevision !== flight.publicRevision ||
        !flight.pendingProgress.key.startsWith('simulator:predeparture-progress:')
      )
        throw new Error('Unknown ordinary progress changed its original recovery identity');
    }
  }
  if (Object.keys(state.ordinaryDepartureJobs ?? {}).some((id) => !state.ordinaryFlights?.[id]))
    throw new Error('Ordinary departure jobs require a retained registered source flight');
}

export function validateOperationOrdinaryTransition(
  previous: OperationCheckpoint,
  next: OperationCheckpoint,
  retiredId?: string,
): void {
  const before = previous.world.ordinaryDispatch;
  const after = next.world.ordinaryDispatch;
  if (
    before &&
    (!after ||
      before.version !== after.version ||
      before.activatedAt !== after.activatedAt ||
      before.planningLeadMs !== after.planningLeadMs)
  )
    throw new Error('Ordinary dispatch activation cannot be removed or changed on a retained world');
  for (const registration of before?.flights ?? []) {
    const retained = after?.flights.find((row) => row.attemptId === registration.attemptId);
    if (!retained && registration.attemptId !== retiredId)
      throw new Error('Ordinary registration cannot disappear before terminal archival');
    if (retained && !same(registration, retained))
      throw new Error('Ordinary physical identity and customer promise cannot change');
  }
  for (const [id, flight] of Object.entries(previous.ordinaryFlights ?? {})) {
    const retained = next.ordinaryFlights?.[id];
    if (!retained) {
      if (id !== retiredId || !flight.terminalConfirmed || flight.pendingProgress)
        throw new Error('Ordinary source history cannot disappear before terminal archival');
      continue;
    }
    if (
      retained.reservationId !== flight.reservationId ||
      retained.tenant !== flight.tenant ||
      retained.sourcePrincipalId !== flight.sourcePrincipalId ||
      retained.automaticReleasePrincipalId !== flight.automaticReleasePrincipalId ||
      (flight.flightId && retained.flightId !== flight.flightId) ||
      (flight.needsHumanReview && !retained.needsHumanReview) ||
      retained.publicRevision < flight.publicRevision ||
      (flight.departurePlan && !same(flight.departurePlan, retained.departurePlan ?? null)) ||
      (flight.automaticReleasePlan && !same(flight.automaticReleasePlan, retained.automaticReleasePlan ?? null)) ||
      (flight.pendingProgress && retained.pendingProgress && !same(flight.pendingProgress, retained.pendingProgress)) ||
      (retained.rejectedProgress?.length ?? 0) > 16 ||
      (flight.rejectedProgress ?? []).some((request, index) => !same(request, retained.rejectedProgress?.[index]))
    )
      throw new Error('Ordinary review, source identity or unknown request cannot be replaced');
    const previousJob = previous.ordinaryDepartureJobs?.[id];
    if (previousJob && !same(previousJob, next.ordinaryDepartureJobs?.[id] ?? null))
      throw new Error('An ordinary departure job cannot replace its original request plan');
    const previousRequest = flight.flightId ? previous.departureRequests?.[flight.flightId] : undefined;
    if (previousRequest && !same(previousRequest, next.departureRequests?.[flight.flightId!] ?? null))
      throw new Error('An ordinary physical departure request must keep its original bytes and key');
    for (const collection of ['departureAllocations', 'departures'] as const) {
      const original = previous.world[collection]?.find((row) => row.reservationId === id);
      if (original && !same(original, next.world[collection]?.find((row) => row.reservationId === id) ?? null))
        throw new Error('Ordinary physical allocation and once-only departure history cannot change');
    }
  }
}
