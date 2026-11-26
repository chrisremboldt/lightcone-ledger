import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

/** Browse records by subject, and the safety registers by owner, a page at a time with keyset cursors. */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Lists in another order, past the first page', () => {
  let tenant: CoverageTenant;
  let colleague: AuthContext;

  async function pages(url: string, key: string, id: (entry: any) => string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await tenant.call(
        tenant.actor,
        'GET',
        `${url}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      seen.push(...body[key].map(id));
      cursor = body.page?.nextCursor ?? body.nextCursor ?? null;
    } while (cursor && seen.length < 20);
    return seen;
  }

  beforeAll(async () => {
    tenant = await coverageTenant('list-orders');
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'sms:read', 'sms:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    colleague = {
      id: `${tenant.tenantId}:colleague`,
      tenantId: tenant.tenantId,
      name: 'Avery Example',
      kind: 'human',
      capabilities: ['sms:read', 'sms:write'],
      revision: 1,
    };
    await tenant.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      colleague.id,
      tenant.tenantId,
      colleague.name,
      'human',
      colleague.capabilities,
    ]);
    await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${colleague.id}`),
      colleague.id,
    ]);
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('orders browse records by subject id, the most recent first within one, across pages', async () => {
    const id = (name: string) => `${tenant.prefix}-PILOT-${name}`;
    await tenant.importRecords(
      'person.certificate',
      ['CASEY', 'AVERY', 'BLAKE', 'AVERY'].map((name, index) => ({
        subjectId: id(name),
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: `RP-${name}-${index}`,
        recordedStatus: 'held',
      })),
    );
    const url = '/v1/operator-records?recordType=person.certificate';
    const newest = await pages(`${url}&order=newest`, 'records', (entry) => entry.subject.id);
    expect(newest).toHaveLength(4);
    const bySubject = await pages(`${url}&order=subject`, 'records', (entry) => entry.subject.id);
    expect(bySubject).toEqual([id('AVERY'), id('AVERY'), id('BLAKE'), id('CASEY')]);
    const whole = await tenant.call(tenant.actor, 'GET', `${url}&order=subject`);
    expect(whole.json().records.map((entry: { observationId: string }) => entry.observationId)).toEqual(
      await pages(`${url}&order=subject`, 'records', (entry) => entry.observationId),
    );
    // A cursor of one order is not one of the other.
    const first = await tenant.call(tenant.actor, 'GET', `${url}&order=subject&limit=1`);
    const mixed = await tenant.call(
      tenant.actor,
      'GET',
      `${url}&limit=1&cursor=${encodeURIComponent(first.json().page.nextCursor)}`,
    );
    expect(mixed.statusCode).toBe(400);
  });

  it('orders the hazard register by owner, across pages', async () => {
    const open = (title: string, ownerId: string) =>
      tenant.call(tenant.actor, 'POST', '/v1/commands', {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title,
          ownerId,
          body: {
            description: 'Identified directly.',
            consequence: 'A fictional consequence.',
            source: { kind: 'manual_identification' },
          },
        },
      });
    const ids: Record<string, string> = {};
    for (const [title, owner] of [
      ['Fictional hazard one', tenant.actor.id],
      ['Fictional hazard two', colleague.id],
      ['Fictional hazard three', tenant.actor.id],
    ] as const) {
      const opened = await open(title, owner);
      expect(opened.statusCode, opened.body).toBe(201);
      ids[title] = opened.json().command.subject.id;
    }
    const byOwner = await pages('/v1/sms/records?kind=hazard&order=owner', 'records', (entry) => entry.id);
    // Avery Example before Fictional coverage operator; one owner's records by id.
    expect(byOwner[0]).toBe(ids['Fictional hazard two']);
    expect(byOwner.slice(1)).toEqual([ids['Fictional hazard one']!, ids['Fictional hazard three']!].sort());
  });
});
