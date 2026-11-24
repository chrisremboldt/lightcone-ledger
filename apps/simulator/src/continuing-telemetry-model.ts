import { createHash } from 'node:crypto';
import { djiOsdBytes, type DjiWorldPoint } from '@ledger/emulators';
import type { Coordinate } from '@ledger/simulation-models/places';

export const CONTINUING_MODEL = 'continuing-dji-route.1';
export const ROUTE_DURATION_MS = 120_000;
export const SOURCE_INTERVAL_MS = 2_000;
export const SEGMENT_INTERVAL_MS = 15_000;
export const DRAIN_MARGIN_MS = 30_000;
export type SimulationTenant = 'alpha' | 'beta';
export type TelemetryFault = 'duplicate' | 'late' | 'reconnect';
export interface ContinuingRoute {
  version: typeof CONTINUING_MODEL;
  tenant: SimulationTenant;
  intentId: string;
  flightId: string;
  sourceSessionId: string;
  startedAt: string;
  seed: number;
  path?: { label: string; origin: Coordinate; destination: Coordinate };
}
const clamp = (number: number) => Math.max(0, Math.min(1, number));
const smooth = (number: number) => number * number * (3 - 2 * number);

export function routePoint(route: ContinuingRoute, index: number): DjiWorldPoint {
  if (
    route.version !== CONTINUING_MODEL ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > ROUTE_DURATION_MS / SOURCE_INTERVAL_MS ||
    !Number.isFinite(Date.parse(route.startedAt))
  )
    throw new Error('Invalid continuing route or source observation');
  const second = (index * SOURCE_INTERVAL_MS) / 1000;
  const progress = clamp((second - 20) / 80),
    angle = Math.PI * 2 * smooth(progress);
  if (route.path) {
    const { origin, destination } = route.path;
    const latitudeDistance = destination.latitude - origin.latitude;
    const longitudeDistance = destination.longitude - origin.longitude;
    const distance =
      Math.hypot(
        latitudeDistance,
        longitudeDistance * Math.cos(((origin.latitude + destination.latitude) * Math.PI) / 360),
      ) * 111_320;
    const travel = smooth(progress);
    return {
      occurredAt: new Date(Date.parse(route.startedAt) + index * SOURCE_INTERVAL_MS).toISOString(),
      latitude: origin.latitude + latitudeDistance * travel,
      longitude: origin.longitude + longitudeDistance * travel,
      height: 200 + 40 * Math.min(smooth(clamp(second / 20)), smooth(clamp((120 - second) / 20))),
      horizontalSpeed: (distance * 6 * progress * (1 - progress)) / 80,
    };
  }
  const offset = Math.abs(route.seed % 100) * 0.000001;
  const latitude = (route.tenant === 'alpha' ? 41.88 : 41.87) + offset;
  const longitude = route.tenant === 'alpha' ? -87.63 : -87.65;
  const radius = 80;
  const east = radius * (1 - Math.cos(angle)),
    north = radius * Math.sin(angle);
  const speed = second > 20 && second < 100 ? (radius * Math.PI * 2 * 6 * progress * (1 - progress)) / 80 : 0;
  const height = 200 + 40 * Math.min(smooth(clamp(second / 20)), smooth(clamp((120 - second) / 20)));
  return {
    occurredAt: new Date(Date.parse(route.startedAt) + index * SOURCE_INTERVAL_MS).toISOString(),
    latitude: latitude + north / 111_320,
    longitude: longitude + east / (111_320 * Math.cos((latitude * Math.PI) / 180)),
    height,
    horizontalSpeed: speed,
  };
}
export function routeBytes(route: ContinuingRoute, index: number): Uint8Array {
  return djiOsdBytes(routePoint(route, index), `DJI-${route.tenant.toUpperCase()}-GATEWAY`, {
    tid: `${route.sourceSessionId}:${index}`,
    bid: `${route.sourceSessionId}:osd:${index}`,
  });
}
export const sourceDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function continuingExpectations(route: ContinuingRoute, emittedIndices: readonly number[]) {
  const indices = [...new Set(emittedIndices)].sort((left, right) => left - right);
  const latest = indices.length ? routePoint(route, indices.at(-1)!) : null;
  return {
    sourceSessionId: route.sourceSessionId,
    sampleCount: indices.length,
    originalDigests: indices.map((index) => sourceDigest(routeBytes(route, index))).sort(),
    latest,
    fidelity: 'synthetic_contract' as const,
    sequenceBasis: 'adapter_capture' as const,
  };
}
