import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { locate, yards } from '@ledger/simulation-models/places';
import { CONTINUING_MODEL, routeBytes, routePoint, type ContinuingRoute } from '../src/continuing-telemetry-model.js';

const legacy: ContinuingRoute = {
  version: CONTINUING_MODEL,
  tenant: 'alpha',
  intentId: 'legacy',
  flightId: 'legacy-flight',
  sourceSessionId: 'legacy-session',
  startedAt: '2026-10-01T12:00:00.000Z',
  seed: 71031,
};

describe('continuing flight route', () => {
  it('flies from the fleet map yard to the destination named by the flight', () => {
    const label = 'Prescription drop · Oakview';
    const origin = yards['tenant-alpha']!;
    const destination = locate(label, origin).coordinate;
    const route: ContinuingRoute = { ...legacy, path: { label, origin, destination } };
    expect(routePoint(route, 0)).toMatchObject({ latitude: origin.latitude, longitude: origin.longitude });
    expect(routePoint(route, 30).latitude).toBeCloseTo((origin.latitude + destination.latitude) / 2, 10);
    expect(routePoint(route, 30).longitude).toBeCloseTo((origin.longitude + destination.longitude) / 2, 10);
    expect(routePoint(route, 60)).toMatchObject(destination);
  });

  it('keeps original source bytes for checkpointed routes without a path', () => {
    const hash = createHash('sha256');
    for (let index = 0; index <= 60; index++) hash.update(routeBytes(legacy, index));
    expect(hash.digest('hex')).toBe('69e00bcd7fba35d663868cc7dae8932f8ec73c64117d65de5bd38286bba609ca');
  });
});
