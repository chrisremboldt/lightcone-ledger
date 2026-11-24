import { operationAdditiveFlight } from './operation-ordinary-dispatch.js';
import { validateOperationCapacity } from './operation-capacity.js';
import type { OperationConfig, OperationTenant, OperationWorld } from './operation.js';

export type OperationPredeparture =
  | { version: 'reserve-await-release.1'; tenant: OperationTenant }
  | { version: 'reserve-selected-await-release.1'; tenant: 'alpha'; attemptId: string };

export function holdsOperationAttempt(
  config: Pick<OperationConfig, 'predeparture'>,
  tenant: OperationTenant,
  attemptId: string,
): boolean {
  const profile = config.predeparture;
  if (profile?.version === 'reserve-await-release.1') return profile.tenant === tenant;
  return (
    profile?.version === 'reserve-selected-await-release.1' &&
    profile.tenant === 'alpha' &&
    tenant === 'alpha' &&
    profile.attemptId === attemptId
  );
}

export function validateOperationPredeparture(config: OperationConfig): void {
  const profile = config.predeparture;
  if (profile === undefined) return;
  if (profile?.version === 'reserve-await-release.1') {
    if (profile.tenant !== 'alpha' && profile.tenant !== 'beta')
      throw new Error('Unknown predeparture profile or tenant');
    if (!config.capacity) throw new Error('Predeparture reservations require finite operation capacity');
    return;
  }
  if (
    !profile ||
    typeof profile !== 'object' ||
    Array.isArray(profile) ||
    Object.getPrototypeOf(profile) !== Object.prototype ||
    Object.keys(profile).sort().join(',') !== 'attemptId,tenant,version' ||
    profile.version !== 'reserve-selected-await-release.1' ||
    profile.tenant !== 'alpha' ||
    typeof profile.attemptId !== 'string' ||
    profile.attemptId.length > 200 ||
    typeof config.runId !== 'string' ||
    config.runId.length === 0 ||
    config.runId.length > 40 ||
    /[^A-Za-z0-9-]/.test(config.runId)
  )
    throw new Error('Selected predeparture requires one exact Alpha attempt in this fresh run');
  const prefix = `intent-${config.runId}-alpha-`;
  const suffix = profile.attemptId.startsWith(prefix) ? profile.attemptId.slice(prefix.length) : '';
  const selected = /^(0|[1-9]\d*):attempt:1$/.exec(suffix);
  if (!selected || selected[0] !== suffix || !Number.isSafeInteger(Number(selected[1])))
    throw new Error('Selected predeparture requires one exact Alpha attempt in this fresh run');
  if (!config.capacity) throw new Error('Predeparture reservations require finite operation capacity');
  validateOperationCapacity(config.capacity);
}

export function holdsWorldOperationAttempt(
  world: Pick<OperationWorld, 'config' | 'demoFlights' | 'ordinaryDispatch'>,
  tenant: OperationTenant,
  attemptId: string,
): boolean {
  return (
    holdsOperationAttempt(world.config, tenant, attemptId) ||
    Boolean(world.demoFlights?.some((flight) => flight.tenant === tenant && flight.attemptId === attemptId)) ||
    Boolean(
      world.ordinaryDispatch?.flights.some((flight) => flight.tenant === tenant && flight.attemptId === attemptId),
    )
  );
}

export function operationDepartureResources(world: OperationWorld, attemptId: string) {
  return world.resources ?? (operationAdditiveFlight(world, attemptId) ? world.demoResources : undefined);
}
