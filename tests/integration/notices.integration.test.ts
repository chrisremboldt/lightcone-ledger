import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  createEmulator,
  createSmtpStandIn,
  emulatorConfig,
  NoticeInbox,
  REFUSED_MAIL_DOMAIN,
} from '../../apps/emulators/src/index.js';
import {
  leaseNotices,
  processNoticeSchedule,
  sendLeasedNotice,
  type NoticeWorkerOptions,
} from '../../apps/workers/src/index.js';
import type {
  FindingTreatment,
  NoticeListResponse,
  NoticeSettingsResponse,
  NoticeWebhookResponse,
  NoticeWebhookSetResponse,
  PrincipalAuthorityListResponse,
  SubjectFindingListResponse,
  SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const CERTIFICATE_RULE = 'ledger.part107.107.12.b';

/** A received message's text, its quoted-printable soft breaks and escapes undone. */
function text(mail: { data: string }): string {
  return Buffer.from(
    mail.data
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  ).toString('utf8');
}
const PUBLIC_URL = 'https://ledger.example.org';

/**
 * Notices from the outbox to the stand-ins: a fictional organization whose findings about two people are assigned,
 * given actions and left overdue, with email through the emulators' mail server stand-in and calls to their webhook
 * receiver, sent by the workers' own functions over this organization's notices.
 */
describe('notices of what is someone’s or due', () => {
  let tenant: CoverageTenant;
  let other: CoverageTenant;
  let colleague: AuthContext;
  let people: Record<'avery' | 'blake', string>;
  let app: Awaited<ReturnType<typeof createApp>>;
  const pool = createPool();
  const workers = createPool(process.env.WORKER_DATABASE_URL);
  const inbox = new NoticeInbox();
  let emulator: Server;
  let smtp: NetServer;
  let webhookBase: string;
  let secret: string;
  let worker: NoticeWorkerOptions;

  // A local Ledger, where an http:// webhook such as the emulators' receiver is accepted, and email is written.
  const local = (principal: AuthContext, method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  async function person(id: string, name: string, capabilities: string[]): Promise<AuthContext> {
    const principal: AuthContext = {
      id: `${tenant.tenantId}:${id}`,
      tenantId: tenant.tenantId,
      name,
      kind: 'human',
      capabilities,
      revision: 1,
    };
    await tenant.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
      principal.id,
      tenant.tenantId,
      name,
      'human',
      capabilities,
    ]);
    await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${principal.id}`),
      principal.id,
    ]);
    return principal;
  }

  async function findingAbout(subjectId: string): Promise<SubjectFindingRecord> {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/findings?subjectKind=person&subjectId=${encodeURIComponent(subjectId)}&subjectScope=source&sourceId=${tenant.sourceId}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    const found = (read.json() as SubjectFindingListResponse).findings.find((item) => item.ruleId === CERTIFICATE_RULE);
    expect(found, subjectId).toBeDefined();
    return found!;
  }

  const treat = (
    by: AuthContext,
    finding: SubjectFindingRecord,
    treatment: Omit<FindingTreatment, 'findingId' | 'evaluationId'>,
    key = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ledger-dev-${by.id}`, 'idempotency-key': key },
      payload: {
        kind: 'finding.treat',
        treatment: { findingId: finding.id, evaluationId: finding.latestEvaluation.id, ...treatment },
        note: 'Fictional treatment for the notices test',
      },
    });

  async function notices(filter = ''): Promise<{ channel: string; kind: string; recipient_id: string; key: string }[]> {
    return (
      await tenant.admin.query(
        `SELECT channel,kind,recipient_id,key FROM notices WHERE tenant_id=$1 ${filter} ORDER BY created_at,id`,
        [tenant.tenantId],
      )
    ).rows;
  }

  /** Leases and sends every notice waiting to be sent, as often as asked. */
  async function sendWaiting(passes = 1): Promise<void> {
    for (let pass = 0; pass < passes; pass++)
      for (const lease of await leaseNotices(workers, { limit: 100 })) await sendLeasedNotice(workers, lease, worker);
  }

  /** Holds the organization's schedule lease as a worker would, for one pass. */
  async function scheduleLease() {
    await tenant.admin.query('INSERT INTO notice_schedules(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [
      tenant.tenantId,
    ]);
    const leased = await tenant.admin.query(
      `UPDATE notice_schedules SET lease_owner='test-owner',lease_until=clock_timestamp()+interval '1 minute',
         generation=generation+1 WHERE tenant_id=$1 RETURNING generation`,
      [tenant.tenantId],
    );
    return {
      tenant_id: tenant.tenantId,
      generation: String(leased.rows[0].generation),
      lease_owner: 'test-owner',
      worker_id: `${tenant.tenantId}:worker`,
    };
  }

  /** One periodic pass over the organization, as the worker makes it: its dated notices, and digests from the hour. */
  async function datedPass(digestHour = 24): Promise<number> {
    return (await processNoticeSchedule(workers, await scheduleLease(), { digestHour }))!;
  }

  beforeAll(async () => {
    tenant = await coverageTenant('notices');
    other = await coverageTenant('notices-other');
    people = { avery: `${tenant.prefix}-PILOT-AVERY`, blake: `${tenant.prefix}-PILOT-BLAKE` };
    const current = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(tenant.actor.id)}`,
    );
    tenant.actor.capabilities = [...current.json().principal.capabilities, 'decision:write'];
    const granted = await tenant.call(tenant.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: tenant.actor.id,
      expectedRevision: current.json().principal.revision,
      capabilities: tenant.actor.capabilities,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    colleague = await person('colleague', 'Avery Example', ['evidence:read', 'flight:read', 'decision:write']);
    await tenant.importRecords('person.certificate', [
      {
        subjectId: people.avery,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-1',
        recordedStatus: 'suspended',
      },
      {
        subjectId: people.blake,
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-2',
        recordedStatus: 'suspended',
      },
    ]);
    await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await tenant.settle();

    // Created after the organizations' own apps, so this one decides that email notices are written.
    app = await createApp({ pool, env: 'local', noticeEmail: true, objectStore: new MemoryObjectStore() });
    await app.ready();
    emulator = createEmulator(emulatorConfig({ EMULATOR_HOST: '127.0.0.1', LEDGER_ENV: 'local' }), {
      notices: inbox,
    }).server;
    await new Promise<void>((resolve) => emulator.listen(0, '127.0.0.1', resolve));
    webhookBase = `http://127.0.0.1:${(emulator.address() as AddressInfo).port}/_notices/webhook`;
    smtp = createSmtpStandIn(inbox);
    await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
    worker = {
      deployment: {
        smtp: {
          host: '127.0.0.1',
          port: (smtp.address() as AddressInfo).port,
          secure: false,
          user: null,
          password: null,
          from: 'ledger-notices@example.org',
        },
        publicUrl: PUBLIC_URL,
      },
      httpWebhooks: true,
      retryDelays: [0, 0, 0, 0],
    };
  });
  afterAll(async () => {
    // Nothing of these organizations is left waiting to be sent.
    if (tenant)
      await tenant.admin.query(
        `UPDATE notice_deliveries SET state='done',lease_owner=NULL,lease_until=NULL WHERE tenant_id=ANY($1::text[])`,
        [[tenant.tenantId, other?.tenantId].filter(Boolean)],
      );
    if (tenant) await settleOwnedWork([tenant.prefix, ...(other ? [other.prefix] : [])]);
    await app?.close();
    await new Promise((resolve) => (emulator ? emulator.close(resolve) : resolve(undefined)));
    await new Promise((resolve) => (smtp ? smtp.close(resolve) : resolve(undefined)));
    await tenant?.close();
    await other?.close();
    await pool.end();
    await workers.end();
  });

  it('keeps a person’s address and choices, and the People list says who has none', async () => {
    const own = await local(colleague, 'PUT', '/v1/notices/settings', {
      email: 'avery@example.org',
      choices: { due: true },
    });
    expect(own.statusCode, own.body).toBe(200);
    const read = await local(colleague, 'GET', '/v1/notices/settings');
    expect(read.json() as NoticeSettingsResponse).toEqual({
      settings: {
        email: 'avery@example.org',
        choices: { assigned: true, due: true, overdue: true, acknowledgement: true },
        digest: 'none',
      },
      emailAvailable: true,
    });
    const refused = await local(colleague, 'PUT', '/v1/notices/settings', { email: 'Avery <avery@example.org>' });
    expect(refused.statusCode).toBe(400);
    // Another person's address is set only by an administrator.
    const notMine = await local(colleague, 'PUT', `/v1/authority/principals/${tenant.actor.id}/notice-email`, {
      email: 'someone@example.org',
    });
    expect(notMine.statusCode).toBe(403);

    const listed = (
      await local(tenant.actor, 'GET', '/v1/authority/principals')
    ).json() as PrincipalAuthorityListResponse;
    expect(listed.principals.find((entry) => entry.id === colleague.id)?.noticeEmail).toBe('avery@example.org');
    expect(listed.principals.find((entry) => entry.id === tenant.actor.id)?.noticeEmail).toBeNull();
    // The journal says an address is kept, never the address.
    const journal = await tenant.admin.query(
      `SELECT payload::text AS payload FROM journal_events WHERE tenant_id=$1 AND event_type='notice.settings'`,
      [tenant.tenantId],
    );
    expect(journal.rows.length).toBe(1);
    expect(journal.rows[0].payload).not.toContain('example.org');
  });

  it('sets a webhook whose secret is shown once and never read back', async () => {
    // Outside a local Ledger an http:// address is refused.
    const plain = await tenant.call(tenant.actor, 'PUT', '/v1/notices/webhook', { url: webhookBase });
    expect(plain.statusCode, plain.body).toBe(400);
    expect(plain.json().error.code).toBe('invalid_webhook_address');
    const set = await local(tenant.actor, 'PUT', '/v1/notices/webhook', { url: webhookBase });
    expect(set.statusCode, set.body).toBe(200);
    const issued = set.json() as NoticeWebhookSetResponse;
    secret = issued.secret!;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(set.headers['cache-control']).toBe('private, no-store');

    const read = await local(tenant.actor, 'GET', '/v1/notices/webhook');
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(secret);
    expect((read.json() as NoticeWebhookResponse).webhook?.url).toBe(webhookBase);
    for (const url of ['/v1/notices', '/v1/authority/principals', '/v1/notices/settings'])
      expect((await local(tenant.actor, 'GET', url)).body).not.toContain(secret);
    const journal = await tenant.admin.query(`SELECT payload::text AS payload FROM journal_events WHERE tenant_id=$1`, [
      tenant.tenantId,
    ]);
    expect(journal.rows.some((row) => row.payload.includes(secret))).toBe(false);
    // The API's own role cannot read the secret back at all.
    await expect(
      withScope(pool, tenant.actor, (client) =>
        client.query('SELECT secret FROM notice_webhooks WHERE tenant_id=$1', [tenant.tenantId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Someone who does not manage people neither reads nor sets it.
    expect((await local(colleague, 'GET', '/v1/notices/webhook')).statusCode).toBe(403);
    expect((await local(colleague, 'PUT', '/v1/notices/webhook', { url: webhookBase })).statusCode).toBe(403);
  });

  it('writes one notice per person and channel when a finding is assigned, however often the command is sent', async () => {
    const finding = await findingAbout(people.avery);
    expect((await treat(tenant.actor, finding, { action: 'acknowledge' })).statusCode).toBe(201);
    const key = randomUUID();
    const assigned = await treat(tenant.actor, finding, { action: 'assign', assigneeId: colleague.id }, key);
    expect(assigned.statusCode, assigned.body).toBe(201);
    const again = await treat(tenant.actor, finding, { action: 'assign', assigneeId: colleague.id }, key);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().command.id).toBe(assigned.json().command.id);
    expect(await notices("AND kind='assigned'")).toEqual([
      expect.objectContaining({ channel: 'email', recipient_id: colleague.id }),
      expect.objectContaining({ channel: 'webhook', recipient_id: colleague.id }),
    ]);

    // A worker that lost its lease records nothing; the notice is sent once by the one that holds it.
    const [stale] = await leaseNotices(workers, { limit: 1 });
    expect(stale).toBeDefined();
    await tenant.admin.query(
      `UPDATE notice_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND notice_id=$2`,
      [stale!.tenant_id, stale!.notice_id],
    );
    expect(await sendLeasedNotice(workers, stale!, worker)).toBe(false);
    expect(
      (await tenant.admin.query('SELECT 1 FROM notice_attempts WHERE notice_id=$1', [stale!.notice_id])).rowCount,
    ).toBe(0);
    await sendWaiting();
    const listed = (await local(tenant.actor, 'GET', '/v1/notices')).json() as NoticeListResponse;
    expect(listed.notices.map((entry) => [entry.channel, entry.state, entry.attempts])).toEqual([
      ['webhook', 'sent', 1],
      ['email', 'sent', 1],
    ]);
    // The list names the finding by its rule's title and its subject's own id, and the person it was assigned to.
    for (const entry of listed.notices) {
      expect(entry.reference).toContain(people.avery);
      expect(entry.reference).not.toContain(finding.id);
      expect(entry.sentence).toBe(`${tenant.actor.name} assigned a finding to ${colleague.name}.`);
    }

    const mail = inbox.mail.find((item) => item.to.includes('avery@example.org'))!;
    expect(text(mail)).toContain('Fictional coverage operator');
    expect(text(mail)).toContain('assigned a finding to you');
    expect(text(mail)).toContain(
      `${PUBLIC_URL}/rules/findings/${tenant.sourceId}/person/${encodeURIComponent(people.avery)}`,
    );
    expect(text(mail)).not.toMatch(/<img|<html|https?:\/\/(?!ledger\.example\.org)/i);
    const call = inbox.calls.at(-1)!;
    const expected = `sha256=${createHmac('sha256', secret).update(`${call.headers['ledger-timestamp']}.${call.body}`).digest('hex')}`;
    expect(call.headers['ledger-signature']).toBe(expected);
    const body = JSON.parse(call.body);
    expect(body).toMatchObject({ kind: 'assigned', assigneeId: colleague.id, record: { id: finding.id } });
    expect(body.record.reference).toContain(people.avery);
    expect(body.record.title).toEqual(expect.any(String));
    expect(listed.notices[0]!.reference).toContain(body.record.title);
    expect(text(mail)).toContain(`${body.record.reference} · ${body.record.title}`);
    expect(call.body).not.toContain('@');
  });

  it('tells the owner once when an action is due within three days, and once when one is overdue', async () => {
    const today = (await databaseNow(tenant.admin)).slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const avery = await findingAbout(people.avery);
    expect((await treat(colleague, avery, { action: 'plan', dueOn: tomorrow })).statusCode).toBe(201);
    const blake = await findingAbout(people.blake);
    expect((await treat(colleague, blake, { action: 'assign', assigneeId: colleague.id })).statusCode).toBe(201);
    const owned = await findingAbout(people.blake);
    expect((await treat(colleague, owned, { action: 'plan', dueOn: '2000-01-01' })).statusCode).toBe(201);
    // The colleague assigned it to themselves: the webhook hears of it, the colleague gets no email.
    expect(await notices(`AND kind='assigned' AND key LIKE '%${blake.id}%'`)).toEqual([
      expect.objectContaining({ channel: 'webhook' }),
    ]);

    expect(await datedPass()).toBe(4);
    expect(await datedPass()).toBe(0);
    const dated = await notices("AND kind IN ('due','overdue')");
    expect(dated.map((row) => [row.kind, row.channel]).sort()).toEqual([
      ['due', 'email'],
      ['due', 'webhook'],
      ['overdue', 'email'],
      ['overdue', 'webhook'],
    ]);
    await sendWaiting();
    const due = inbox.mail.find((item) => text(item).includes('is due on'))!;
    expect(text(due)).toContain(
      `due on ${new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${tomorrow}T12:00:00Z`))}`,
    );
    expect(inbox.mail.some((item) => text(item).includes('was due on Saturday 1 January 2000'))).toBe(true);
  });

  it('writes the digest of a person who asks for one, once a day, and by email only', async () => {
    expect((await local(colleague, 'PUT', '/v1/notices/settings', { digest: 'daily' })).statusCode).toBe(200);
    // Before the digest hour, none is written.
    expect(await datedPass(24)).toBe(0);
    expect(await datedPass(0)).toBe(1);
    expect(await datedPass(0)).toBe(0);
    expect(await notices("AND kind='digest'")).toEqual([
      expect.objectContaining({ channel: 'email', recipient_id: colleague.id }),
    ]);
    await sendWaiting();
    const digest = inbox.mail.find((item) => text(item).includes('What is yours in'))!;
    expect(text(digest)).toContain('Overdue');
    expect(text(digest)).toContain('Due soon');
  });

  it('tells each owner of an action a signature sets, in the signature’s transaction', async () => {
    const safety = await person('safety', 'Blake Example', ['sms:read', 'sms:write', 'decision:write']);
    const executive = await person('executive', 'Casey Example', ['sms:read', 'sms:adopt', 'decision:write']);
    const today = (await databaseNow(tenant.admin)).slice(0, 10);
    const opened = await local(safety, 'POST', '/v1/commands', {
      kind: 'sms.record.open',
      record: {
        kind: 'assurance',
        schema: 'sms.assurance.1',
        title: 'Preflight records audit, RIDGE-AUD-1',
        ownerId: safety.id,
        body: {
          assuranceType: 'audit',
          performedOn: today,
          scope: 'Preflight records of the fictional survey crews.',
          examined: 'Ten flight records of RIDGE-AC-1.',
          findings: [{ id: 'F1', text: 'Two preflight assessments were signed after takeoff.' }],
          actions: [
            { id: 'A1', what: 'Brief the crews.', ownerId: colleague.id, dueOn: today, findingId: 'F1' },
            { id: 'A2', what: 'Check the other crews.', ownerId: executive.id, dueOn: today },
          ],
        },
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const id = opened.json().command.subject.id as string;
    const preview = await local(executive, 'GET', `/v1/sms/records/${id}/signing?meaning=assurance.sign`);
    expect(preview.statusCode, preview.body).toBe(200);
    const shown = preview.json();
    const grant = await local(executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${executive.id}`,
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const detail = (await local(safety, 'GET', `/v1/sms/records/${id}`)).json();
    const signed = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: {
        authorization: `Bearer ledger-dev-${executive.id}`,
        'idempotency-key': randomUUID(),
        'x-ledger-reauthentication': grant.json().grant,
      },
      payload: {
        kind: 'decision.record',
        subject: { kind: 'sms', id },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision: {
          kind: 'assurance.sign',
          versionNumber: detail.record.versionNumber,
          note: 'Signed as the record of what was done.',
          signature: { intent: shown.intent, contentDigest: shown.contentDigest, reviewed: true },
        },
      },
    });
    expect(signed.statusCode, signed.body).toBe(201);
    const set = await notices(`AND key LIKE 'action.assigned:${id}:%'`);
    // The colleague hears by email and the organization by its webhook; the signer set their own, so only the webhook.
    expect(set.map((row) => [row.recipient_id, row.channel]).sort()).toEqual(
      [
        [colleague.id, 'email'],
        [colleague.id, 'webhook'],
        [executive.id, 'webhook'],
      ].sort(),
    );
    const content = await tenant.admin.query(
      `SELECT content FROM notices WHERE tenant_id=$1 AND key LIKE $2 AND channel='email'`,
      [tenant.tenantId, `action.assigned:${id}:A1:%`],
    );
    expect(content.rows[0].content).toMatchObject({
      event: 'action.assigned',
      actionId: 'A1',
      dueOn: today,
      record: {
        label: 'Safety assurance record',
        title: 'Preflight records audit, RIDGE-AUD-1',
        path: `/safety/assurance/${id}`,
      },
    });
    await sendWaiting();
    expect(inbox.mail.some((item) => text(item).includes('set an action for you'))).toBe(true);
  });

  it('tries a failing mail server and webhook again, and gives up after the fifth attempt without failing the assignment', async () => {
    const changed = await local(tenant.actor, 'PUT', `/v1/authority/principals/${tenant.actor.id}/notice-email`, {
      email: `actor@${REFUSED_MAIL_DOMAIN}`,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const failing = await local(tenant.actor, 'PUT', '/v1/notices/webhook', { url: `${webhookBase}?status=500` });
    expect(failing.statusCode).toBe(200);
    const blake = await findingAbout(people.blake);
    const assigned = await treat(colleague, blake, { action: 'assign', assigneeId: tenant.actor.id });
    expect(assigned.statusCode, assigned.body).toBe(201);

    await sendWaiting(1);
    const actorsOwn = (response: { json: () => unknown }) => {
      const page = response.json() as NoticeListResponse;
      return { ...page, notices: page.notices.filter((entry) => entry.recipient.id === tenant.actor.id) };
    };
    let listed = actorsOwn(await local(tenant.actor, 'GET', '/v1/notices?state=failed'));
    expect(listed.notices.map((entry) => entry.channel).sort()).toEqual(['email', 'webhook']);
    expect(listed.notices.find((entry) => entry.channel === 'webhook')!.reason).toContain('answered 500');
    expect(listed.notices.find((entry) => entry.channel === 'email')!.reason).toContain('550');
    await sendWaiting(4);
    listed = actorsOwn(await local(tenant.actor, 'GET', '/v1/notices?state=given_up'));
    expect(listed.notices.map((entry) => [entry.channel, entry.attempts]).sort()).toEqual([
      ['email', 5],
      ['webhook', 5],
    ]);
    await sendWaiting(1);
    const attempts = await tenant.admin.query(
      `SELECT a.attempt,a.outcome FROM notice_attempts a JOIN notices n ON n.tenant_id=a.tenant_id AND n.id=a.notice_id
       WHERE n.tenant_id=$1 AND n.recipient_id=$2 ORDER BY n.channel,a.attempt`,
      [tenant.tenantId, tenant.actor.id],
    );
    expect(attempts.rows.map((row) => row.outcome)).toEqual([
      ...['failed', 'failed', 'failed', 'failed', 'given_up'],
      ...['failed', 'failed', 'failed', 'failed', 'given_up'],
    ]);
  });

  it('keeps each organization’s notices, settings and webhook to itself', async () => {
    const theirs = await local(other.actor, 'GET', '/v1/notices');
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect((theirs.json() as NoticeListResponse).notices).toEqual([]);
    expect(
      ((await local(other.actor, 'GET', '/v1/notices/webhook')).json() as NoticeWebhookResponse).webhook,
    ).toBeNull();
    const across = await local(other.actor, 'PUT', `/v1/authority/principals/${colleague.id}/notice-email`, {
      email: 'elsewhere@example.org',
    });
    expect(across.statusCode).toBe(404);
    for (const table of ['notices', 'notice_attempts', 'notice_settings', 'notice_deliveries'])
      expect(
        (
          await withScope(workers, { id: `${other.tenantId}:worker`, tenantId: other.tenantId }, (client) =>
            client.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [tenant.tenantId]),
          )
        ).rowCount,
        table,
      ).toBe(0);
    const secrets = await withScope(workers, { id: `${other.tenantId}:worker`, tenantId: other.tenantId }, (client) =>
      client.query('SELECT secret FROM notice_webhooks'),
    );
    expect(secrets.rowCount).toBe(0);
  });

  it('writes the dated notices only while holding the organization’s schedule lease', async () => {
    const lease = await scheduleLease();
    expect(await processNoticeSchedule(workers, { ...lease, generation: '0' })).toBeNull();
    // The first pass writes whatever became due since the last one; a second writes nothing again.
    expect(await processNoticeSchedule(workers, lease)).not.toBeNull();
    expect(await processNoticeSchedule(workers, lease)).toBeNull();
    expect(await processNoticeSchedule(workers, await scheduleLease())).toBe(0);
    const after = await tenant.admin.query(
      'SELECT lease_owner,available_at>clock_timestamp() AS later FROM notice_schedules WHERE tenant_id=$1',
      [tenant.tenantId],
    );
    expect(after.rows[0]).toEqual({ lease_owner: null, later: true });
  });
});
