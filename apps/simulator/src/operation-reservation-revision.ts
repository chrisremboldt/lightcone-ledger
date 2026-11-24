import { canonicalDigest } from '@ledger/integrity';
import {
  holdsOperationAttempt,
  reviseOperationReservation,
  type OperationReservationChange,
} from '@ledger/simulation-models/operation';
import { advanceLiveClock, type OperationReservationRevisionReceipt, type OperationStore } from './operation-state.js';
import type { OperationActionClock } from './operation-action-clock.js';

export type { OperationReservationRevisionReceipt } from './operation-state.js';

export interface OperationReservationRevisionPlan {
  version: 1;
  runId: string;
  tenant: 'alpha' | 'beta';
  reservationId: string;
  aircraftId: string;
  expectedPlan: { sourceRevision: number; digest: string };
  change: OperationReservationChange;
}

export interface OperationReservationRevisionResult extends OperationReservationRevisionReceipt {
  status: 'revised' | 'already-revised';
}

function invalid(reason: string): never {
  throw new Error(reason);
}

function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return (
    object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key))
  );
}

function id(value: unknown): value is string {
  return (
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function utc(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return false;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) && new Date(at).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function validateOperationReservationRevisionPlan(value: unknown): OperationReservationRevisionPlan {
  if (
    !keys(value, ['version', 'runId', 'tenant', 'reservationId', 'aircraftId', 'expectedPlan', 'change']) ||
    value.version !== 1 ||
    !id(value.runId) ||
    !['alpha', 'beta'].includes(String(value.tenant)) ||
    !id(value.reservationId) ||
    !id(value.aircraftId) ||
    !keys(value.expectedPlan, ['sourceRevision', 'digest']) ||
    !revision(value.expectedPlan.sourceRevision) ||
    !digest(value.expectedPlan.digest) ||
    !object(value.change) ||
    !Object.hasOwn(value.change, 'sourceRevision') ||
    !revision(value.change.sourceRevision) ||
    value.change.sourceRevision <= value.expectedPlan.sourceRevision ||
    Object.keys(value.change).some((key) => !['sourceRevision', 'route', 'operatingInterval'].includes(key)) ||
    (!Object.hasOwn(value.change, 'route') && !Object.hasOwn(value.change, 'operatingInterval')) ||
    (Object.hasOwn(value.change, 'route') && !object(value.change.route)) ||
    (Object.hasOwn(value.change, 'operatingInterval') && !object(value.change.operatingInterval))
  )
    return invalid(
      'Reservation revision requires one exact held identity, expected source digest and a higher explicit revision',
    );
  canonicalDigest(value);
  return structuredClone(value) as unknown as OperationReservationRevisionPlan;
}

function validateReceipt(value: unknown): asserts value is OperationReservationRevisionReceipt {
  if (
    !keys(value, ['version', 'planDigest', 'runId', 'reservationId', 'sourceRevision', 'sourceDigest', 'occurredAt']) ||
    value.version !== 'operation.reservation-revision.1' ||
    !digest(value.planDigest) ||
    !id(value.runId) ||
    !id(value.reservationId) ||
    !revision(value.sourceRevision) ||
    !digest(value.sourceDigest) ||
    !utc(value.occurredAt)
  )
    invalid('The retained reservation revision receipt is malformed or unsupported');
}

export async function runOperationReservationRevision(
  value: OperationReservationRevisionPlan,
  store: OperationStore,
  now: () => number = Date.now,
  clock?: OperationActionClock,
): Promise<OperationReservationRevisionResult> {
  const plan = validateOperationReservationRevisionPlan(value);
  const planDigest = canonicalDigest(plan);
  let result: OperationReservationRevisionResult | undefined;
  await store.update((state) => {
    if (state.world.config.runId !== plan.runId)
      invalid('Reservation revision run does not match the retained checkpoint');
    if (
      state.world.config.predeparture?.version === 'reserve-selected-await-release.1' &&
      !holdsOperationAttempt(state.world.config, plan.tenant, plan.reservationId)
    )
      invalid('Reservation revision must select the reservation pinned by this world');
    const previous = state.reservationRevision;
    if (previous !== undefined) {
      validateReceipt(previous);
      if (previous.runId !== plan.runId || Date.parse(previous.occurredAt) > state.world.now)
        invalid('The retained reservation revision receipt does not match this world');
      if (previous.planDigest === planDigest) {
        if (previous.reservationId !== plan.reservationId || previous.sourceRevision !== plan.change.sourceRevision)
          invalid('The retained reservation revision receipt differs from the exact plan');
        result = { status: 'already-revised', ...structuredClone(previous) };
        return;
      }
    }
    const at = now();
    if (
      !Number.isSafeInteger(at) ||
      !Number.isFinite(new Date(at).getTime()) ||
      state.clock.mode !== 'live' ||
      state.clock.paused ||
      !Number.isSafeInteger(state.clock.wallAt) ||
      state.world.now !== state.clock.wallAt ||
      at < state.clock.wallAt
    )
      invalid('Reservation revision requires a live, unpaused world aligned with a finite current wall clock');
    if (
      state.departureJob !== undefined ||
      (state.world.departureAllocations !== undefined &&
        (!Array.isArray(state.world.departureAllocations) || state.world.departureAllocations.length > 0)) ||
      (state.world.departures !== undefined &&
        (!Array.isArray(state.world.departures) || state.world.departures.length > 0)) ||
      (state.departureRequests !== undefined &&
        (!object(state.departureRequests) || Object.keys(state.departureRequests).length > 0))
    )
      invalid('Reservation revision is unavailable after a departure job has been selected');
    const reservation = state.world.reservations?.find((row) => row.id === plan.reservationId);
    if (
      !reservation ||
      reservation.phase !== 'awaiting-release' ||
      reservation.tenant !== plan.tenant ||
      reservation.aircraftId !== plan.aircraftId ||
      !holdsOperationAttempt(state.world.config, plan.tenant, reservation.id)
    )
      invalid('Reservation revision does not match the exact held tenant, reservation and aircraft');
    if (
      reservation.plan.sourceRevision !== plan.expectedPlan.sourceRevision ||
      canonicalDigest(reservation.plan) !== plan.expectedPlan.digest
    )
      invalid('Reservation revision expected plan is stale or differs from the retained source digest');
    if (clock) clock(state, at);
    else advanceLiveClock(state, at, false);
    const source = reviseOperationReservation(state.world, plan.reservationId, plan.change);
    const receipt: OperationReservationRevisionReceipt = {
      version: 'operation.reservation-revision.1',
      planDigest,
      runId: plan.runId,
      reservationId: plan.reservationId,
      sourceRevision: source.sourceRevision,
      sourceDigest: canonicalDigest(source),
      occurredAt: source.occurredAt,
    };
    state.reservationRevision = receipt;
    result = { status: 'revised', ...structuredClone(receipt) };
  });
  if (!result) return invalid('Reservation revision did not retain a committed result');
  return result;
}
