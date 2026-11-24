import type { OperationConfig, OperationTenant, OperationWorld } from './operation.js';

export interface OperationCapacity {
  id: string;
  demandIntervalMs: Record<OperationTenant, number>;
  flightPeople: Record<OperationTenant, number>;
  turnaroundCrews: Record<OperationTenant, number>;
  chargers: Record<OperationTenant, number>;
  launchPads: Record<OperationTenant, number>;
}

export type OperationResourceKind = 'flightPeople' | 'turnaroundCrews' | 'chargers' | 'launchPads';
export interface OperationResourceSlot {
  id: string;
  tenant: OperationTenant;
  availableAt: number;
  aircraftId?: string;
}
export type OperationResourcePools = Record<OperationResourceKind, OperationResourceSlot[]> & {
  turnaroundQueue: string[];
  chargeQueue: string[];
};

const tenants = ['alpha', 'beta'] as const;
const resourceKinds = ['flightPeople', 'turnaroundCrews', 'chargers', 'launchPads'] as const;

export function operationCapacityPreset(
  preset: 'illustrative-25.1' | 'alpha-25.1',
): Pick<OperationConfig, 'fleet' | 'capacity'> {
  if (preset === 'alpha-25.1')
    return {
      fleet: { alpha: 25, beta: 25 },
      capacity: {
        id: preset,
        demandIntervalMs: { alpha: 8_000, beta: 30_000 },
        flightPeople: { alpha: 25, beta: 16 },
        turnaroundCrews: { alpha: 4, beta: 3 },
        chargers: { alpha: 8, beta: 6 },
        launchPads: { alpha: 2, beta: 1 },
      },
    };
  if (preset !== 'illustrative-25.1') throw new Error('Unknown world capacity preset');
  return {
    fleet: { alpha: 25, beta: 25 },
    capacity: {
      id: preset,
      demandIntervalMs: { alpha: 24_000, beta: 30_000 },
      flightPeople: { alpha: 16, beta: 16 },
      turnaroundCrews: { alpha: 4, beta: 3 },
      chargers: { alpha: 8, beta: 6 },
      launchPads: { alpha: 2, beta: 1 },
    },
  };
}

export function validateOperationCapacity(capacity: OperationCapacity): void {
  if (!/^[A-Za-z0-9.-]{1,60}$/.test(capacity.id)) throw new Error('World capacity requires a short stable identity');
  for (const tenant of tenants) {
    if (!Number.isSafeInteger(capacity.demandIntervalMs?.[tenant]) || capacity.demandIntervalMs[tenant] < 1000)
      throw new Error('World capacity demand intervals must be at least one second');
    for (const kind of resourceKinds) {
      const count = capacity[kind]?.[tenant];
      if (!Number.isSafeInteger(count) || count < 1 || count > 50)
        throw new Error(`World capacity ${kind} must contain 1–50 slots per operator`);
    }
  }
}

export function createOperationResources(config: OperationConfig, start: number): OperationResourcePools {
  const capacity = config.capacity!;
  const pools: OperationResourcePools = {
    flightPeople: [],
    turnaroundCrews: [],
    chargers: [],
    launchPads: [],
    turnaroundQueue: [],
    chargeQueue: [],
  };
  for (const kind of resourceKinds) {
    for (const tenant of tenants) {
      for (let index = 0; index < capacity[kind][tenant]; index++) {
        const suffix = `${tenant}-${String(index + 1).padStart(2, '0')}`;
        pools[kind].push({
          id: `${config.runId}-${kind === 'flightPeople' ? 'person' : kind}-${suffix}`,
          tenant,
          availableAt: start,
        });
      }
    }
  }
  return pools;
}

export function availableResource(
  world: OperationWorld,
  kind: OperationResourceKind,
  tenant: OperationTenant,
): OperationResourceSlot | undefined {
  return world.resources![kind].find(
    (slot) => slot.tenant === tenant && slot.availableAt <= world.now && (kind === 'launchPads' || !slot.aircraftId),
  );
}

export function occupyResource(slot: OperationResourceSlot, aircraftId: string, until: number): void {
  slot.aircraftId = aircraftId;
  slot.availableAt = until;
}

export function releaseResource(world: OperationWorld, kind: OperationResourceKind, aircraftId: string): void {
  const slot = world.resources![kind].find((candidate) => candidate.aircraftId === aircraftId);
  if (!slot) throw new Error(`Aircraft has no assigned ${kind} resource`);
  slot.availableAt = world.now;
  delete slot.aircraftId;
}

export function capacityStatus(world: OperationWorld) {
  if (!world.resources || !world.config.capacity) return {};
  const pools = world.resources;
  const predeparture = world.config.predeparture !== undefined;
  const tenantStatus = (tenant: OperationTenant) => {
    const orders = world.demand.filter(
      (demand) =>
        demand.tenant === tenant &&
        !demand.attemptId &&
        !demand.cancellation &&
        (!demand.window || Date.parse(demand.window.start) <= world.now),
    ).length;
    const aircraft = world.aircraft.filter((aircraft) => aircraft.tenant === tenant);
    const ready = aircraft.filter((aircraft) => aircraft.phase === 'ready' && aircraft.maintenanceUntil <= world.now);
    const reservedAircraft = aircraft.filter((aircraft) => aircraft.phase === 'reserved');
    const reservedAircraftIds = new Set(reservedAircraft.map((aircraft) => aircraft.id));
    const resources = Object.fromEntries(
      resourceKinds.map((kind) => {
        const slots = pools[kind].filter((slot) => slot.tenant === tenant);
        return [
          kind,
          {
            total: slots.length,
            busy: slots.filter(
              (slot) =>
                slot.availableAt > world.now ||
                (predeparture && kind === 'flightPeople' && slot.aircraftId !== undefined),
            ).length,
            ...(predeparture && kind === 'flightPeople'
              ? {
                  reserved: slots.filter(
                    (slot) => slot.aircraftId !== undefined && reservedAircraftIds.has(slot.aircraftId),
                  ).length,
                }
              : {}),
          },
        ];
      }),
    );
    return {
      airborne: aircraft.filter((row) => row.phase === 'flying').length,
      held: reservedAircraft.length,
      queued: orders,
      resources: predeparture
        ? {
            ...resources,
            aircraft: {
              total: aircraft.length,
              busy: aircraft.filter((aircraft) => aircraft.phase !== 'ready' || aircraft.maintenanceUntil > world.now)
                .length,
              reserved: reservedAircraft.length,
            },
          }
        : resources,
      waiting: {
        orders,
        aircraft: ready.length ? 0 : orders,
        flightPeople: availableResource(world, 'flightPeople', tenant) ? 0 : orders,
        launchPads: availableResource(world, 'launchPads', tenant) ? 0 : orders,
        maintenance:
          ready.length || !aircraft.some((row) => row.phase === 'ready' && row.maintenanceUntil > world.now)
            ? 0
            : orders,
        turnaround: aircraft.filter((row) => row.phase === 'waiting-turnaround').length,
        charging: aircraft.filter((row) => row.phase === 'waiting-charge').length,
        ...(predeparture
          ? {
              release: (world.reservations ?? []).filter(
                (reservation) => reservation.tenant === tenant && reservation.phase === 'awaiting-release',
              ).length,
            }
          : {}),
      },
    };
  };
  return {
    capacity: { id: world.config.capacity.id, tenants: { alpha: tenantStatus('alpha'), beta: tenantStatus('beta') } },
  };
}
