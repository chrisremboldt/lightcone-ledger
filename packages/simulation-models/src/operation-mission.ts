import type { OperationAttempt } from './operation.js';

export interface OperationRoutePlanning {
  version: 'mission.route-planning.1';
  requiredLocations: Array<{ role: 'launch' | 'service' | 'return'; position: [number, number] }>;
  cruiseMetersPerSecond: number;
  ascentMs: number;
  serviceMs: number;
  descentMs: number;
  holdAllowanceMs: number;
  handoffAllowanceMs: number;
  marginMs: number;
  customerInterval: { start: string; end: string };
  resourceInterval: { start: string; end: string };
}

export interface OperationMissionSource {
  sourceRevision: number;
  occurredAt: string;
  sourceMissionId: string;
  aircraftId: string;
  route: {
    coordinateReference: 'WGS84';
    coordinateOrder: 'longitude_latitude';
    segmentInterpolation: 'linear_longitude_latitude';
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  };
  lateralToleranceMeters: number;
  altitude: { minimum: number; maximum: number; unit: 'm'; reference: 'AGL' };
  operatingInterval: { start: string; end: string };
  routePlanning?: OperationRoutePlanning;
}

export function operationMissionSource(
  attempt: Pick<OperationAttempt, 'id' | 'aircraftId' | 'origin' | 'destination' | 'departure' | 'landing'>,
): OperationMissionSource {
  return plannedOperationMissionSource(attempt, {
    sourceRevision: 1,
    occurredAt: attempt.departure,
    operatingInterval: { start: attempt.departure, end: attempt.landing },
  });
}

export function plannedOperationMissionSource(
  identity: Pick<OperationAttempt, 'id' | 'aircraftId' | 'origin' | 'destination'>,
  plan: Pick<OperationMissionSource, 'sourceRevision' | 'occurredAt' | 'operatingInterval'>,
): OperationMissionSource {
  return {
    sourceRevision: plan.sourceRevision,
    occurredAt: plan.occurredAt,
    sourceMissionId: `${identity.id}:mission`,
    aircraftId: identity.aircraftId,
    route: {
      coordinateReference: 'WGS84',
      coordinateOrder: 'longitude_latitude',
      segmentInterpolation: 'linear_longitude_latitude',
      geometry: {
        type: 'LineString',
        coordinates: [
          [identity.origin.longitude, identity.origin.latitude],
          [identity.destination.longitude, identity.destination.latitude],
          [identity.origin.longitude, identity.origin.latitude],
        ],
      },
    },
    lateralToleranceMeters: 30,
    altitude: { minimum: 0, maximum: 60, unit: 'm', reference: 'AGL' },
    operatingInterval: { ...plan.operatingInterval },
  };
}
