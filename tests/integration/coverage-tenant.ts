import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import type {
  AdoptionParameterValues,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  RulePackVersion,
} from '../../packages/contracts/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { runOwnedWork } from './worker-queue.js';

/**
 * A fictional organization of its own that imports operator records and adopts packs through the public API, with
 * its worker run over its own work only.
 */
export interface CoverageTenant {
  prefix: string;
  tenantId: string;
  sourceId: string;
  actor: AuthContext;
  operator: AuthContext;
  admin: ReturnType<typeof createPool>;
  call: (
    principal: AuthContext,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => ReturnType<Awaited<ReturnType<typeof createApp>>['inject']>;
  importRecords: (recordType: string, records: Record<string, unknown>[]) => Promise<string[]>;
  /** Retains a file as the records principal uploads it, and returns its artifact id. */
  upload: (bytes: Buffer, contentType?: string) => Promise<string>;
  adopt: (
    pack: RulePackVersion,
    mode: PackAdoptionCommand['mode'],
    extra?: Partial<PackAdoptionCommand>,
  ) => Promise<string>;
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

export async function coverageTenant(label: string): Promise<CoverageTenant> {
  const prefix = `${label}-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional coverage operator' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
  };
  const operator: AuthContext = {
    ...base,
    id: `${tenantId}:records`,
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  const app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
  await app.ready();

  const call: CoverageTenant['call'] = (principal, method, url, payload, headers = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  async function upload(bytes: Buffer, contentType = 'application/json'): Promise<string> {
    const created = await call(operator, 'POST', '/v1/uploads', {
      contentType,
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${operator.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(operator, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function importRecords(recordType: string, records: Record<string, unknown>[]): Promise<string[]> {
    const artifactId = await upload(Buffer.from(JSON.stringify({ recordType, recordVersion: 1, records })));
    const committed = await call(operator, 'POST', '/v1/operator-records/imports', {
      artifactId,
      recordType,
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary, recordType).toMatchObject({ recorded: records.length, refused: 0 });
    return committed.json().rows.map((row: { observationId: string }) => row.observationId);
  }

  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await runOwnedWork(admin, workerPool, [prefix])) continue;
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }

  /** Every adoption parameter a pack asks for, with a value valid for it. */
  function parametersFor(pack: RulePackVersion): AdoptionParameterValues | undefined {
    const values: AdoptionParameterValues = {};
    for (const leaf of pack.leaves)
      if ('adoptionParameters' in leaf && leaf.adoptionParameters.length)
        values[leaf.id] = Object.fromEntries(
          leaf.adoptionParameters.map((parameter) => [
            parameter.name,
            parameter.options?.[0] ??
              (parameter.valueType === 'string'
                ? 'UTC'
                : parameter.valueType === 'boolean'
                  ? true
                  : (parameter.minimum ?? 1)),
          ]),
        );
    return Object.keys(values).length ? values : undefined;
  }

  async function adopt(
    pack: RulePackVersion,
    mode: PackAdoptionCommand['mode'],
    extra: Partial<PackAdoptionCommand> = {},
  ): Promise<string> {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const started = Date.now();
    const command = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(started - 60_000).toISOString(), end: new Date(started + 86_400_000).toISOString() },
      'Fictional review of what the records support.',
      mode,
    );
    const parameters = parametersFor(pack);
    const adopted = await call(actor, 'POST', '/v1/commands', {
      ...command,
      ...(parameters ? { parameters } : {}),
      ...extra,
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    return adopted.json().command.id as string;
  }

  await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional coverage operator']);
  const worker = {
    ...base,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read', 'input:write'],
  };
  for (const principal of [actor, operator, worker]) {
    await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principal.id,
      tenantId,
      principal.name,
      principal.kind,
      principal.capabilities,
    ]);
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${principal.id}`),
      principal.id,
    ]);
  }
  const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(operator.id)}`);
  expect(current.statusCode, current.body).toBe(200);
  const granted = await call(actor, 'POST', '/v1/commands', {
    kind: 'authority.update',
    principalId: operator.id,
    expectedRevision: current.json().principal.revision,
    capabilities: current.json().principal.capabilities,
    observationGrants: [{ sourceId, observationType: 'operator.record' }],
  });
  expect(granted.statusCode, granted.body).toBe(201);

  return {
    prefix,
    tenantId,
    sourceId,
    actor,
    operator,
    admin,
    call,
    importRecords,
    upload,
    adopt,
    settle,
    async close() {
      await app.close();
      await pool.end();
      await admin.end();
      await workerPool.end();
    },
  };
}

/** Training records for each of the people, and nothing else about them. */
export function trainingRecords(people: readonly string[]): Record<string, unknown>[] {
  return people.map((subjectId, index) => ({
    subjectId,
    trainingKind: 'initial',
    courseTitle: 'Fictional delivery operations initial course',
    completedOn: `2026-0${index + 1}-15`,
    evidenceReference: `TRN-FICT-${index + 1}`,
  }));
}
