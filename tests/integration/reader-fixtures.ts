import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { rolePresetList } from '../../packages/contracts/src/index.js';
import type { createApp } from '../../apps/api/src/index.js';

type App = Awaited<ReturnType<typeof createApp>>;

/** The seeded dispatcher of an organization, who keeps its records and manages its people. */
export const dispatcher = (tenant: 'alpha' | 'beta') => `ledger-dev-${tenant}-operator`;

export function caller(app: () => App) {
  const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app().inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function read<T = any>(token: string, url: string): Promise<T> {
    const response = await call(token, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  /** Imports one of the fixture record files, its ids made unique to this run. */
  async function importRecords(token: string, recordType: string, run: string): Promise<void> {
    const bytes = Buffer.from(
      readFileSync(join(import.meta.dirname, 'fixtures', 'ridge-records', `${recordType}.csv`), 'utf8').replaceAll(
        'RIDGE-',
        `${run}-RIDGE-`,
      ),
    );
    const created = await call(token, 'POST', '/v1/uploads', {
      contentType: 'text/csv',
      byteLength: bytes.byteLength,
      filename: `${recordType}.csv`,
    });
    expect(created.statusCode, created.body).toBe(201);
    const uploadId = created.json().upload.id as string;
    const stored = await call(token, 'PUT', `/v1/uploads/${uploadId}/content`, bytes, {
      'content-type': 'application/octet-stream',
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(token, 'POST', `/v1/uploads/${uploadId}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const committed = await call(token, 'POST', '/v1/operator-records/imports', {
      artifactId: finalized.json().artifact.id,
      recordType,
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary.refused).toBe(0);
  }
  /** Produces the records of one aircraft with its original file, as the Produce records screen does. */
  async function produce(token: string, aircraftId: string): Promise<any> {
    const produced = await call(token, 'POST', '/v1/record-productions', {
      subjects: [{ kind: 'aircraft', id: aircraftId }],
      includeOriginals: true,
      reason: 'Aircraft records asked for at an inspection',
      requestedBy: 'Inspector, regional office',
    });
    expect(produced.statusCode, produced.body).toBe(201);
    return produced.json().record;
  }
  /** Adds a person from the Reader preset on the People screen and issues them a development token. */
  async function addReader(token: string, name: string): Promise<{ id: string; token: string }> {
    const reader = rolePresetList().presets.find((preset) => preset.key === 'reader')!;
    const added = await call(token, 'POST', '/v1/commands', {
      kind: 'person.add',
      name,
      principalKind: 'human',
      capabilities: reader.capabilities,
      observationGrants: reader.observationGrants,
    });
    expect(added.statusCode, added.body).toBe(201);
    const id = String(added.json().command.payload.principalId);
    const issued = await call(token, 'POST', `/v1/authority/principals/${id}/development-token`);
    expect(issued.statusCode, issued.body).toBe(201);
    return { id, token: issued.json().developmentToken.token as string };
  }
  return { call, read, importRecords, produce, addReader };
}
