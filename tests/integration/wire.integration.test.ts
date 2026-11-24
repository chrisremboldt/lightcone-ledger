import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, test } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApp } from '../../apps/api/src/index.js';
import { createPool, createObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { openApiDocument } from '../../packages/contracts/src/openapi.js';
import { LedgerClient } from '../../packages/contracts/src/client.js';
import { settleOwnedWork } from './worker-queue.js';

const pool = createPool();
const admin = createPool(process.env.DATABASE_ADMIN_URL);
let app: Awaited<ReturnType<typeof createApp>>;
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
for (const [path, methods] of Object.entries(openApiDocument.paths))
  for (const [method, operation] of Object.entries(methods))
    for (const [status, response] of Object.entries(operation.responses)) {
      const schema = (response as any).content?.['application/json']?.schema;
      if (schema) validators.set(`${method} ${path} ${status}`, ajv.compile(schema));
    }
beforeAll(async () => {
  app = await createApp({ pool, env: 'test', objectStore: createObjectStore() });
  await app.ready();
});
afterAll(async () => {
  await settleOwnedWork(['tenant-alpha']);
  await app.close();
  await pool.end();
  await admin.end();
});
const headers = { authorization: 'Bearer ledger-dev-alpha-operator' };
function verify(method: string, path: string, status: number, value: unknown) {
  const validator = validators.get(`${method} ${path} ${status}`);
  expect(validator, `published schema for ${method} ${path} ${status}`).toBeDefined();
  expect(validator!(value), JSON.stringify(validator!.errors)).toBe(true);
}
test('actual HTTP responses conform to the published OpenAPI and retain byte evidence', async () => {
  const key = `wire-${randomUUID()}`;
  const created = await app.inject({
    method: 'POST',
    url: '/v1/flights',
    headers: { ...headers, 'idempotency-key': key },
    payload: { originationKey: key, label: 'Contract flight' },
  });
  expect(created.statusCode).toBe(201);
  verify('post', '/v1/flights', 201, created.json());
  const flightId = created.json().flight.id;
  for (const [url, path] of [
    ['/v1/me', '/v1/me'],
    ['/v1/flights', '/v1/flights'],
    [`/v1/flights/${flightId}`, '/v1/flights/{id}'],
    [`/v1/flights/${flightId}/timeline`, '/v1/flights/{id}/timeline'],
    ['/v1/orders', '/v1/orders'],
    ['/v1/receipts', '/v1/receipts'],
    ['/v1/sources', '/v1/sources'],
  ]) {
    const result = await app.inject({ method: 'GET', url: url!, headers });
    expect(result.statusCode).toBe(200);
    verify('get', path!, 200, result.json());
    expect(result.headers['x-request-id']).toBeTruthy();
  }
  const bytes = Buffer.from('original flight evidence\n');
  const upload = await app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: { ...headers, 'idempotency-key': `${key}:upload` },
    payload: { byteLength: bytes.length, contentType: 'text/plain' },
  });
  expect(upload.statusCode).toBe(201);
  verify('post', '/v1/uploads', 201, upload.json());
  const id = upload.json().upload.id;
  const stored = await app.inject({
    method: 'PUT',
    url: `/v1/uploads/${id}/content`,
    headers: { ...headers, 'idempotency-key': `${key}:bytes`, 'content-type': 'application/octet-stream' },
    payload: bytes,
  });
  expect(stored.statusCode).toBe(200);
  verify('put', '/v1/uploads/{id}/content', 200, stored.json());
  const finalized = await app.inject({
    method: 'POST',
    url: `/v1/uploads/${id}/finalize`,
    headers: { ...headers, 'idempotency-key': `${key}:finalize` },
  });
  expect(finalized.statusCode).toBe(201);
  verify('post', '/v1/uploads/{id}/finalize', 201, finalized.json());
  const artifact = finalized.json().artifact;
  const retained = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/content`, headers });
  expect(retained.rawPayload).toEqual(bytes);
  const input = await app.inject({
    method: 'POST',
    url: '/v1/inputs',
    headers: { ...headers, 'idempotency-key': `${key}:input` },
    payload: {
      sourceId: key,
      kind: 'flight.observation',
      occurredAt: new Date().toISOString(),
      subject: { flightId },
      payload: { activity: 'active' },
      artifactId: artifact.id,
    },
  });
  expect(input.statusCode).toBe(201);
  verify('post', '/v1/inputs', 201, input.json());
  const receipt = await app.inject({ method: 'GET', url: `/v1/receipts/${input.json().receipt.id}`, headers });
  verify('get', '/v1/receipts/{id}', 200, receipt.json());
  const denied = await app.inject({
    method: 'GET',
    url: `/v1/flights/${flightId}`,
    headers: { authorization: 'Bearer ledger-dev-beta-operator' },
  });
  expect(denied.statusCode).toBe(404);
  verify('get', '/v1/flights/{id}', 404, denied.json());
});

test('an expired finalized upload recovers the exact artifact and rejects replacement bytes', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const ledger = new LedgerClient(address, 'ledger-dev-alpha-operator');
  const key = `wire-upload-recovery-${randomUUID()}`;
  const bytes = Buffer.from('retained native departure report\n');
  const first = await ledger.upload(bytes, 'text/plain', key);
  await withScope(admin, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client) => {
    await client.query("UPDATE uploads SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [
      first.artifact.uploadId,
    ]);
  });
  const recovered = await ledger.upload(bytes, 'text/plain', key);
  expect(recovered.artifact).toEqual(first.artifact);
  expect(await ledger.evidence(recovered.artifact.id)).toEqual(new Uint8Array(bytes));
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  await expect(ledger.upload(changed, 'text/plain', key)).rejects.toMatchObject({ status: 409 });
  await withScope(admin, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client) => {
    const rows = await client.query('SELECT id FROM artifacts WHERE upload_id=$1', [first.artifact.uploadId]);
    expect(rows.rows.map((row) => row.id)).toEqual([first.artifact.id]);
  });
});
