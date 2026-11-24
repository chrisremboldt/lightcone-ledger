import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { appendEvent, createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import type { Input, SourceCapability } from '../../packages/contracts/src/index.js';
import { settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Source declarations', () => {
  const pool = createPool();
  const prefix = `source-declaration-${randomUUID()}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork(['tenant-alpha', 'tenant-beta']);
    if (app) await app.close();
    await pool.end();
  });

  const headers = (tenant = 'alpha', role = 'operator') => ({
    authorization: `Bearer ledger-dev-${tenant}-${role}`,
  });
  async function submit(input: Input, key: string, tenant = 'alpha', role = 'operator') {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: { ...headers(tenant, role), 'idempotency-key': `${prefix}:${key}` },
      payload: input,
    });
    expect(response.statusCode, response.body).toBe(201);
  }
  async function sources(tenant = 'alpha') {
    const response = await app.inject({ method: 'GET', url: '/v1/sources', headers: headers(tenant) });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().capabilities as SourceCapability[]).filter((item) => item.sourceId === prefix);
  }

  it('reads deduplicated declarations immediately, retaining changes and tenant boundaries', async () => {
    const schemaDigest = 'a'.repeat(64);
    const input: Input = {
      sourceId: prefix,
      kind: 'source.observation',
      occurredAt: '2026-10-15T12:00:00Z',
      subject: {},
      fidelity: 'documented_schema_conformant',
      payload: { schemaDigest, limitations: ['First limitation'] },
    };
    await submit(input, 'first');
    await submit({ ...input, payload: { ...input.payload, observation: 'another reading' } }, 'repeat');
    await submit({ ...input, payload: { ...input.payload, limitations: ['Second limitation'] } }, 'changed');
    await submit(
      { ...input, fidelity: 'synthetic_contract', payload: { schemaDigest: 'b'.repeat(64) } },
      'actor',
      'alpha',
      'actor',
    );
    await submit({ ...input, kind: 'airspace.status' }, 'other-kind');
    await submit({ ...input, payload: { limitations: ['Beta only'] } }, 'other-tenant', 'beta');

    const alpha = await sources();
    expect(alpha).toHaveLength(3);
    const documented = alpha.find(
      (item) => item.capability === 'source.observation' && item.fidelity === 'documented_schema_conformant',
    );
    expect(documented).toMatchObject({ schemaDigest });
    expect(documented?.limitations).toEqual(
      expect.arrayContaining([
        'Producer limitation (principal-alpha-operator): First limitation',
        'Producer limitation (principal-alpha-operator): Second limitation',
      ]),
    );
    expect(alpha.find((item) => item.fidelity === 'synthetic_contract')).toMatchObject({
      schemaDigest: 'b'.repeat(64),
      limitations: expect.arrayContaining([expect.stringContaining('principal-alpha-actor')]),
    });
    expect(JSON.stringify(alpha)).not.toContain('Beta only');
    expect(JSON.stringify(await sources('beta'))).toContain('Beta only');

    await withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client) => {
      const retained = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM source_declarations WHERE source_id=$1',
        [prefix],
      );
      expect(retained.rows).toHaveLength(4);
      expect(retained.rows.every((row) => row.tenant_id === 'tenant-alpha')).toBe(true);
    });

    await expect(
      withScope(pool, { id: 'principal-alpha-operator', tenantId: 'tenant-alpha' }, async (client, principal) => {
        await appendEvent(client, principal, {
          type: 'source.observation',
          stream: `${prefix}:rollback`,
          sourceId: prefix,
          payload: { payload: { limitations: ['Rolled back declaration'] } },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(JSON.stringify(await sources())).not.toContain('Rolled back declaration');
  });
});
