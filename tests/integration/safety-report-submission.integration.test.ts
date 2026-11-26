import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import type {
  CommandResponse,
  PrincipalAuthorityEntry,
  ReportBody,
  SafetyReportLinkIssued,
  SafetyReportLinkList,
  SmsHomeResponse,
  SmsRecordContentResponse,
  SmsRecordDetailResponse,
  SmsRegisterResponse,
} from '../../packages/contracts/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);

/**
 * People submit safety reports themselves: signed in, with or without their name, and through a reporting link without
 * signing in. These tests show what is and is not kept (docs/design/report-submission.md).
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('People submit safety reports themselves', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const logged: string[] = [];
  const setup = parseOrganizationSetup([
    '--',
    '--name',
    `Example Ridge Survey ${run}`,
    '--time-zone',
    'America/Denver',
    '--admin',
    'Avery Example',
    '--id',
    `report-submission-${run}`,
  ]);
  const channelId = `safety-reports-${setup.tenantId}`;
  let app: Awaited<ReturnType<typeof createApp>>;
  let administrator: string;

  beforeAll(async () => {
    app = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      logger: { level: 'info', stream: { write: (line: string) => logged.push(line) } },
    });
    await app.ready();
    const created = await setUpOrganization(admin, setup, 'local', []);
    if (!created.created) throw new Error('The organization should be new');
    administrator = created.developmentToken!;
    // The administrator is cleared to read reports for these tests, as a person granting it on the People screen does.
    await changeAuthority(administrator, created.administratorId, ['sms:report:read']);
  });
  afterAll(async () => {
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
  });

  const call = (
    token: string | null,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function read<T>(token: string, url: string): Promise<T> {
    const response = await call(token, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  async function command(token: string, payload: unknown): Promise<CommandResponse['command']> {
    const response = await call(token, 'POST', '/v1/commands', payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command;
  }
  async function changeAuthority(token: string, id: string, add: string[]) {
    const people = await read<{ principals: PrincipalAuthorityEntry[] }>(token, '/v1/authority/principals');
    const person = people.principals.find((entry) => entry.id === id)!;
    await command(token, {
      kind: 'authority.update',
      principalId: id,
      expectedRevision: person.revision,
      capabilities: [...new Set([...person.capabilities, ...add])],
      active: person.active,
      observationGrants: person.observationGrants ?? [],
    });
  }
  /** A person with no permission in the safety records, as the People screen adds one; given a test credential. */
  async function addPerson(name: string) {
    const added = await command(administrator, {
      kind: 'person.add',
      name,
      principalKind: 'human',
      capabilities: ['flight:read'],
    });
    const id = String(added.payload.principalId);
    const token = `ledger-dev-${run}-${randomUUID().slice(0, 8)}`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), id]);
    // Whatever the projections write about the new person is written before anything is compared.
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    return { id, name, token };
  }
  /** How many rows of each table hold the text anywhere, read as the database owner. */
  async function rowsHolding(text: string): Promise<Record<string, number>> {
    const tables = await admin.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`,
    );
    const found: Record<string, number> = {};
    for (const { name } of tables.rows) {
      const count = (
        await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${name}" t WHERE strpos(t::text,$1)>0`, [
          text,
        ])
      ).rows[0]!.n;
      if (count) found[name] = count;
    }
    return found;
  }
  const reports = async () => (await read<SmsRegisterResponse>(administrator, '/v1/sms/records?kind=report')).records;
  async function reportContent(id: string) {
    const content = await read<SmsRecordContentResponse>(administrator, `/v1/sms/records/${id}/content`);
    return content.versions[0]!.body as ReportBody;
  }
  const receiptStatus = (code: string) => call(null, 'POST', '/v1/safety-reports/receipt', { code });
  /** The log lines of one request, parsed. */
  const linesOf = (requestId: string) =>
    logged.map((line) => JSON.parse(line) as Record<string, any>).filter((line) => line.reqId === requestId);

  it('keeps nothing that names a signed-in person who submits without their name', async () => {
    const person = await addPerson(`Quinn Example ${run}`);
    const narrative = `Loose prop guard on RIDGE-AC-1 before the morning flight ${run}`;
    const before = { id: await rowsHolding(person.id), name: await rowsHolding(person.name) };
    const submitted = await call(person.token, 'POST', '/v1/safety-reports', {
      whatWasSeen: narrative,
      where: 'Ridge pad 2',
      named: false,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const code = submitted.json().receipt.code as string;
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
    expect(submitted.headers['cache-control']).toBe('private, no-store');
    await settleOwnedWork([setup.tenantId], { objectStore: store });

    // Every table, searched for the person's id and name: no row written since holds either.
    expect(await rowsHolding(person.id)).toEqual(before.id);
    expect(await rowsHolding(person.name)).toEqual(before.name);
    // The text is only in the protected content.
    expect(Object.keys(await rowsHolding(narrative))).toEqual(['sms_restricted_record_versions']);

    const event = (
      await admin.query<{ principal_id: string; payload: Record<string, unknown> }>(
        `SELECT principal_id,payload FROM journal_events WHERE tenant_id=$1 AND event_type='sms.record.open'
         ORDER BY received_at DESC LIMIT 1`,
        [setup.tenantId],
      )
    ).rows[0]!;
    expect(event.principal_id).toBe(channelId);
    const listed = (await reports()).find((record) => record.id === event.payload.recordId)!;
    expect(listed).toMatchObject({ status: 'received', owner: { id: channelId, name: 'Safety reporting channel' } });
    const body = await reportContent(listed.id);
    expect(body).toMatchObject({
      narrative,
      siteReference: 'Ridge pad 2',
      received: { channel: 'submitted_signed_in' },
    });
    expect(body.reporter).toBeUndefined();

    // The request log line has the method and path, and no address.
    const lines = linesOf(submitted.headers['x-request-id'] as string);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.req?.remoteAddress).toBeUndefined();

    // The receipt code tells only whether the report is received or closed.
    const status = await receiptStatus(code);
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toEqual({ status: 'received' });
    expect((await receiptStatus(code.toLowerCase().replaceAll('-', ' '))).json()).toEqual({ status: 'received' });
    expect((await receiptStatus('AAAA-BBBB-CCCC-DDDD-EEEE')).statusCode).toBe(404);
    const detail = await read<SmsRecordDetailResponse>(administrator, `/v1/sms/records/${listed.id}`);
    await command(administrator, {
      kind: 'decision.record',
      subject: { kind: 'sms', id: listed.id },
      expectedRevision: detail.basis.revision,
      expectedDependencyBasis: detail.basis.dependencyBasis,
      decision: { kind: 'record.close', note: 'Prop guard replaced and the crew briefed.' },
    });
    expect((await receiptStatus(code)).json()).toEqual({ status: 'closed' });

    // The person cannot read reports, and cannot make the channel act for them.
    expect((await call(person.token, 'GET', `/v1/sms/records/${listed.id}/content`)).statusCode).toBe(403);
  });

  it('records a report a device sends twice under its key once, refuses another under it, and keeps no person beside it', async () => {
    const person = await addPerson(`Rowan Example ${run}`);
    const key = `device-report-${randomUUID()}`;
    const narrative = `Battery case latch cracked on RIDGE-AC-1 ${run}`;
    const writtenAt = '2026-11-25T14:03:00.000Z';
    const before = await rowsHolding(person.id);
    const report = { whatWasSeen: narrative, where: 'Ridge pad 2', named: false, writtenAt };
    const first = await call(person.token, 'POST', '/v1/safety-reports', report, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ receipt: { code: expect.stringMatching(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/) } });

    // The first answer was lost: the device sends the same report under the same key.
    const again = await call(person.token, 'POST', '/v1/safety-reports', report, { 'idempotency-key': key });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('safety_report_already_received');
    expect(again.body).not.toContain(first.json().receipt.code);
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    expect(await rowsHolding(narrative)).toEqual({ sms_restricted_record_versions: 1 });

    // Another report under the same key is refused and records nothing.
    const different = `${narrative}, and the strap too`;
    const other = await call(
      person.token,
      'POST',
      '/v1/safety-reports',
      { ...report, whatWasSeen: different },
      {
        'idempotency-key': key,
      },
    );
    expect(other.statusCode, other.body).toBe(409);
    expect(other.json().error.code).toBe('idempotency_conflict');
    expect(await rowsHolding(different)).toEqual({});

    // The key is kept under the reporting channel; nothing kept names the person.
    const kept = await admin.query<{ principal_id: string; effect_id: string }>(
      'SELECT principal_id,effect_id FROM idempotency_keys WHERE tenant_id=$1 AND producer_key=$2',
      [setup.tenantId, key],
    );
    expect(kept.rows).toHaveLength(1);
    expect(kept.rows[0]!.principal_id).toBe(channelId);
    expect(await rowsHolding(person.id)).toEqual(before);
    const body = await reportContent(kept.rows[0]!.effect_id);
    expect(body).toMatchObject({ narrative, received: { channel: 'submitted_signed_in', writtenAt } });
    expect(Date.parse(body.received.receivedAt!)).toBeGreaterThan(Date.parse(writtenAt));
  });

  it('puts the name of a person who chooses it in the protected content only', async () => {
    const person = await addPerson(`Sage Example ${run}`);
    const before = { id: await rowsHolding(person.id), name: await rowsHolding(person.name) };
    const submitted = await call(person.token, 'POST', '/v1/safety-reports', {
      whatWasSeen: `Charger cable frayed at the Ridge site trailer ${run}`,
      contact: 'Crew radio channel 3',
      named: true,
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    const after = await rowsHolding(person.name);
    expect({ ...after, sms_restricted_record_versions: undefined }).toEqual({
      ...before.name,
      sms_restricted_record_versions: undefined,
    });
    expect(after.sms_restricted_record_versions).toBe(1);
    expect(await rowsHolding(person.id)).toEqual(before.id);
    const [latest] = await reports();
    expect((await reportContent(latest!.id)).reporter).toEqual({ name: person.name, contact: 'Crew radio channel 3' });
  });

  it('takes a report through a reporting link with no principal, address or browser kept or logged', async () => {
    const nobody = await addPerson(`Reese Example ${run}`);
    expect((await call(nobody.token, 'POST', '/v1/sms/report-links', { label: 'Not mine to issue' })).statusCode).toBe(
      403,
    );
    const key = randomUUID();
    const issuing = await call(
      administrator,
      'POST',
      '/v1/sms/report-links',
      { label: 'Ridge site trailer' },
      { 'idempotency-key': key },
    );
    expect(issuing.statusCode, issuing.body).toBe(201);
    const issued = issuing.json() as SafetyReportLinkIssued;
    expect(issued.link).toMatchObject({ label: 'Ridge site trailer', inForce: true, expiresAt: null });
    const again = await call(
      administrator,
      'POST',
      '/v1/sms/report-links',
      { label: 'Ridge site trailer' },
      { 'idempotency-key': key },
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('report_link_token_not_repeated');
    expect(Object.keys(await rowsHolding(issued.token))).toEqual([]);

    const browser = `ReporterBrowser/${run}`;
    const address = '203.0.113.77';
    const narrative = `Bird strike near the Ridge tower, aircraft RIDGE-AC-2 landed ${run}`;
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/safety-report-links/submissions',
      remoteAddress: address,
      headers: { 'user-agent': browser },
      payload: { token: issued.token, whatWasSeen: narrative, occurredAt: await databaseNow(pool) },
    });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const code = submitted.json().receipt.code as string;
    await settleOwnedWork([setup.tenantId], { objectStore: store });

    // The request log: method and path, and nothing about the sender.
    const lines = linesOf(submitted.headers['x-request-id'] as string);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const text = JSON.stringify(line);
      expect(text).not.toContain(address);
      expect(text).not.toContain(browser);
      expect(text).not.toContain(issued.token);
    }
    expect(lines.find((line) => line.req)?.req).toEqual({
      method: 'POST',
      url: '/v1/safety-report-links/submissions',
    });
    // Other requests keep their address as before.
    const health = await app.inject({ method: 'GET', url: '/healthz', remoteAddress: address });
    expect(linesOf(health.headers['x-request-id'] as string).find((line) => line.req)?.req.remoteAddress).toBe(address);

    // Nothing kept anywhere holds the address, the browser or the token.
    expect(await rowsHolding(address)).toEqual({});
    expect(await rowsHolding(browser)).toEqual({});
    expect(await rowsHolding(issued.token)).toEqual({});
    const event = (
      await admin.query<{ principal_id: string; payload: Record<string, unknown> }>(
        `SELECT principal_id,payload FROM journal_events WHERE tenant_id=$1 AND event_type='sms.record.open'
         ORDER BY received_at DESC LIMIT 1`,
        [setup.tenantId],
      )
    ).rows[0]!;
    expect(event.principal_id).toBe(channelId);
    expect(JSON.stringify(event.payload)).not.toContain('report-link-');
    const body = await reportContent(String(event.payload.recordId));
    expect(body).toMatchObject({ narrative, received: { channel: 'submitted_link' } });
    expect((await receiptStatus(code)).json()).toEqual({ status: 'received' });

    // The Safety home names the link in force; the list shows who issued it.
    const home = await read<SmsHomeResponse>(administrator, '/v1/sms/home');
    expect(home.reportLinks).toEqual([{ label: 'Ridge site trailer', expiresAt: null }]);
    const links = await read<SafetyReportLinkList>(administrator, '/v1/sms/report-links');
    expect(links.links[0]).toMatchObject({ id: issued.link.id, issuedBy: { name: 'Avery Example' } });
    expect(JSON.stringify(links)).not.toContain(issued.token);
  });

  it('takes at most 20 reports through a link in an hour, and none once it is revoked or expired', async () => {
    const issued = (
      await call(administrator, 'POST', '/v1/sms/report-links', { label: 'Hangar crew room poster' })
    ).json() as SafetyReportLinkIssued;
    const send = (token = issued.token) =>
      call(null, 'POST', '/v1/safety-report-links/submissions', {
        token,
        whatWasSeen: `Ladder left by the hangar door ${run}`,
      });
    for (let sent = 0; sent < 20; sent++) expect((await send()).statusCode).toBe(201);
    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('report_link_busy');

    const revoked = await call(administrator, 'POST', `/v1/sms/report-links/${issued.link.id}/revoke`);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().link).toMatchObject({ inForce: false, revokedBy: { name: 'Avery Example' } });
    const afterRevoke = await send();
    expect(afterRevoke.statusCode).toBe(404);
    expect(afterRevoke.json().error).toMatchObject({
      code: 'report_link_not_in_use',
      message: 'This reporting link is not in use',
    });
    const unknown = await send(`ledger-report-${'A'.repeat(43)}`);
    expect(unknown.json().error.code).toBe('report_link_not_in_use');

    const now = Date.parse(await databaseNow(pool));
    expect(
      (
        await call(administrator, 'POST', '/v1/sms/report-links', {
          label: 'Already over',
          expiresAt: new Date(now - 1000).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    const expiring = (
      await call(administrator, 'POST', '/v1/sms/report-links', {
        label: 'Ridge open day',
        expiresAt: new Date(now + 1500).toISOString(),
      })
    ).json() as SafetyReportLinkIssued;
    expect((await send(expiring.token)).statusCode).toBe(201);
    while (Date.parse(await databaseNow(pool)) <= now + 1500) await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await send(expiring.token)).json().error.code).toBe('report_link_not_in_use');
    await settleOwnedWork([setup.tenantId], { objectStore: store });
  });

  it('keeps the reporting channel from signing in, holding authority or being listed as a person', async () => {
    const people = await read<{ principals: PrincipalAuthorityEntry[] }>(administrator, '/v1/authority/principals');
    expect(people.principals.map((entry) => entry.id)).not.toContain(channelId);
    const refused = await call(administrator, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: channelId,
      expectedRevision: 1,
      capabilities: ['sms:report:read'],
      active: true,
      observationGrants: [],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('reporting_channel_fixed');
    await expect(
      admin.query("UPDATE principals SET capabilities='{sms:read}' WHERE id=$1", [channelId]),
    ).rejects.toThrow(/principals_intake_holds_nothing/);
    const token = `ledger-dev-${run}-channel`;
    await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(token), channelId]);
    expect((await call(token, 'GET', '/v1/me')).statusCode).toBe(401);
    // A person recording a report as received cannot claim it was submitted to Ledger.
    const claimed = await call(administrator, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'report',
        schema: 'sms.report.1',
        title: 'Told in person',
        ownerId: people.principals.find((entry) => entry.name === 'Avery Example')!.id,
        body: { narrative: 'Heard at the briefing.', received: { channel: 'submitted_link' } },
      },
    });
    expect(claimed.statusCode).toBe(400);
    expect(claimed.json().error.code).toBe('report_channel_submitted');
  });
  it('logs the report page and the files it loads without an address when the API serves the web app', async () => {
    const webDir = await mkdtemp(join(tmpdir(), 'ledger-web-'));
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Ledger</title>');
    await writeFile(join(webDir, 'assets', 'app.js'), 'export {};');
    const served: string[] = [];
    const web = await createApp({
      pool,
      env: 'test',
      objectStore: store,
      webDir,
      logger: { level: 'info', stream: { write: (line: string) => served.push(line) } },
    });
    try {
      await web.ready();
      const address = '198.51.100.23';
      const browser = `ReportPageBrowser/${run}`;
      const requestLine = (requestId: string) =>
        served
          .map((line) => JSON.parse(line) as Record<string, any>)
          .filter((line) => line.reqId === requestId)
          .find((line) => line.req)?.req;
      for (const url of ['/report', '/assets/app.js']) {
        const opened = await web.inject({
          method: 'GET',
          url,
          remoteAddress: address,
          headers: { 'user-agent': browser },
        });
        expect(opened.statusCode, url).toBe(200);
        expect(requestLine(opened.headers['x-request-id'] as string)).toEqual({ method: 'GET', url });
      }
      const text = served.join('\n');
      expect(text).not.toContain(address);
      expect(text).not.toContain(browser);
      // A signed-in request to the API keeps its address as before.
      const me = await web.inject({
        method: 'GET',
        url: '/v1/me',
        remoteAddress: address,
        headers: { authorization: `Bearer ${administrator}` },
      });
      expect(me.statusCode).toBe(200);
      expect(requestLine(me.headers['x-request-id'] as string).remoteAddress).toBe(address);
    } finally {
      await web.close();
      await rm(webDir, { recursive: true, force: true });
    }
  });
});
