import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmulator, emulatorConfig } from '../src/server.js';

const config = { ...emulatorConfig({}), port: 0 };
const token = config.flightServiceToken!;
const BASE = '2026-11-20T16:00:00.000Z';

describe('the flight service stand-in on the emulator server', () => {
  const { server } = createEmulator(config);
  let origin: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const control = (method: string, path: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = (authorization = token) => fetch(`${origin}/api/v0/flights`, { headers: { authorization } });
  const ids = async () =>
    ((await (await list()).json()) as { data: { flights: { flight_id: string }[] } }).data.flights.map(
      (flight) => flight.flight_id,
    );

  it('serves three invented flights around the time it started, to the configured token only', async () => {
    const answer = await list();
    expect(answer.status).toBe(200);
    expect(answer.headers.get('x-ledger-simulation')).toBe('invented-flight-service');
    expect(await ids()).toEqual(['EXAMPLE-FLIGHT-0003', 'EXAMPLE-FLIGHT-0002', 'EXAMPLE-FLIGHT-0001']);
    expect((await list('another-token')).status).toBe(401);
    expect((await list(`Bearer ${token}`)).status).toBe(401);
  });

  it('is off on a host that is not a local development host until a token is configured', async () => {
    const hosted = {
      LEDGER_ENV: 'staging',
      EMULATOR_ADMIN_KEY: 'fixture-admin',
      PARTNER_API_KEY: 'fixture-partner',
      AIRSPACE_CLIENT_ID: 'fixture-client',
      AIRSPACE_CLIENT_SECRET: 'fixture-client-secret',
      AIRSPACE_API_KEY: 'fixture-api-key',
      AIRSPACE_USER_CLIENT_ID: 'fixture-user-client',
      AIRSPACE_CALLBACK_SECRET: 'fixture-callback',
    };
    expect(emulatorConfig(hosted).flightServiceToken).toBeUndefined();
    expect(emulatorConfig({ ...hosted, SKYDIO_API_TOKEN: 'fixture-flight-service' }).flightServiceToken).toBe(
      'fixture-flight-service',
    );
    const off = createEmulator({ ...emulatorConfig(hosted), port: 0 }).server;
    await new Promise<void>((resolve) => off.listen(0, '127.0.0.1', resolve));
    try {
      const answer = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/api/v0/flights`, {
        headers: { authorization: 'anything' },
      });
      expect(answer.headers.get('x-ledger-simulation')).not.toBe('invented-flight-service');
      expect(answer.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => off.close(() => resolve()));
    }
  });

  it('takes other flights, a rate limit and a reset through the simulation controls', async () => {
    expect((await fetch(`${origin}/_simulation/skydio/flights`, { method: 'PUT', body: '{}' })).status).toBe(403);
    await control('POST', '/_simulation/clock', { now: BASE });
    const flight = {
      flightId: 'EXAMPLE-FLIGHT-0101',
      vehicleSerial: 'EXAMPLE-VEHICLE-09',
      takeoff: '2026-11-20T15:00:00.000Z',
      landing: '2026-11-20T15:10:00.000Z',
      telemetryAt: '2026-11-20T15:30:00.000Z',
      home: { latitude: 44.5, longitude: -100.5, seaLevelMeters: 520 },
      sampleSeconds: 60,
    };
    const later = {
      ...flight,
      flightId: 'EXAMPLE-FLIGHT-0102',
      takeoff: '2026-11-20T17:00:00.000Z',
      landing: undefined,
    };
    const replaced = await control('PUT', '/_simulation/skydio/flights', { flights: [flight, later] });
    expect(await replaced.json()).toEqual({ flights: 2 });
    // A flight that has not taken off by the source clock is not listed.
    expect(await ids()).toEqual(['EXAMPLE-FLIGHT-0101']);
    const telemetry = await fetch(`${origin}/api/v1/flight/EXAMPLE-FLIGHT-0101/telemetry`, {
      headers: { authorization: token },
    });
    const body = (await telemetry.json()) as { data: { flight_telemetry: { aligned_telemetry: unknown[] } } };
    expect(body.data.flight_telemetry.aligned_telemetry).toHaveLength(11);
    expect((await control('PUT', '/_simulation/skydio/flights', { flights: [{ flightId: 'X' }] })).status).toBe(400);

    expect(
      (await control('POST', '/_simulation/skydio/rate-limit', { requests: 1, retryAfterSeconds: 30 })).status,
    ).toBe(200);
    const busy = await list();
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('30');
    expect((await list()).status).toBe(200);
    expect((await control('POST', '/_simulation/skydio/rate-limit', { requests: -1 })).status).toBe(400);

    await control('POST', '/_simulation/reset');
    expect(await ids()).toEqual(['EXAMPLE-FLIGHT-0003', 'EXAMPLE-FLIGHT-0002', 'EXAMPLE-FLIGHT-0001']);
  });
});
