import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmulator, emulatorConfig } from '../src/server.js';
import { validatePayload } from '../src/schema.js';
import { PkceClient } from '../../../packages/adapters/src/index.js';

const config = { ...emulatorConfig({}), port: 0 };
const { server } = createEmulator(config);
let base: string;
let userToken: string;
const operation = {
  name: 'Fictional test operation',
  pilotId: 'fictional-pilot',
  boundary: {
    type: 'Polygon',
    coordinates: [
      [
        [-83, 42],
        [-83, 42.01],
        [-82.99, 42.01],
        [-83, 42],
      ],
    ],
  },
  minAltitude: 0,
  maxAltitude: 200,
  startTime: '2026-10-01T14:00:00Z',
  endTime: '2026-10-01T14:30:00Z',
  aircraftId: 'fictional-aircraft',
  timezone: 'America/Chicago',
  altitudeUnit: 'ALTITUDE_UNIT_FEET',
  altitudeReference: 'ALTITUDE_REFERENCE_AGL',
  flightType: 'FLIGHT_TYPE_COMMERCIAL',
};

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const pkce = new PkceClient({
    authorizationUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    clientId: config.userClientId,
    redirectUri: config.userRedirectUris[0]!,
    scopes: [
      'operation:read',
      'operation:create',
      'operation:update',
      'operation:delete',
      'laanc:read',
      'laanc:create',
      'laanc:update',
      'laanc:delete',
    ],
  });
  const request = pkce.authorize('s'.repeat(43), 'fixed-state');
  const redirect = await fetch(request.url, { redirect: 'manual' });
  const location = new URL(redirect.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe(request.state);
  userToken = await pkce.exchange(location.searchParams.get('code')!, request.verifier);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(method: string, path: string, body?: unknown, token = userToken) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('AirHub published-wire conformance', () => {
  it('exercises parent, candidate, authorization, rescission and acknowledgment with public enum validation', async () => {
    const created = await request('POST', '/v1/operations', operation);
    expect(created.status).toBe(200);
    const id = created.body.id as string;
    const path = `/v1/operations/${id}/laanc`;
    const child = await request('POST', path, {
      license: 'LICENSE_PART_107',
      fixedAltitude: false,
      pointOfContact: {
        firstName: 'Synthetic',
        lastName: 'Pilot',
        phoneNumber: '+15555550123',
        emailAddress: 'pilot@example.invalid',
      },
    });
    expect(child.status, JSON.stringify(child.body)).toBe(200);
    expect(validatePayload('POST', path, child.body, 'response').valid).toBe(true);
    const hash = child.body.operation.candidates[0].hashCode;
    const submitted = await request('POST', `${path}/authorizations/${hash}`, { justification: 'Synthetic scenario' });
    expect(submitted.status).toBe(200);
    const authorizationId = submitted.body.authorization.id;
    const rescind = await fetch(
      `${base}/_simulation/airspace/operations/${id}/authorizations/${authorizationId}/status`,
      {
        method: 'POST',
        headers: { 'x-emulator-admin': config.adminKey, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'STATUS_RESCINDED', occurredAt: '2026-10-01T14:07:00Z' }),
      },
    );
    expect(rescind.status).toBe(200);
    const read = await request('GET', path);
    expect(read.body.operation.authorizations[0].status).toBe('STATUS_RESCINDED');
    expect(validatePayload('GET', path, read.body, 'response').valid).toBe(true);
    expect((await request('PATCH', `${path}/authorizations/${authorizationId}/rescindack`)).status).toBe(200);
    expect((await request('GET', `${path}/authorizations/${authorizationId}`)).body.authorization.status).toBe(
      'STATUS_RESCIND_ACK',
    );
    expect((await request('GET', '/v1/laanc-temp/rescinded-invalid-operations')).status).toBe(404);
  });
});
