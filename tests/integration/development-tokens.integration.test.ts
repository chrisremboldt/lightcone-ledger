import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { parseOrganizationSetup, setUpOrganization } from '../../apps/api/src/organization-setup.js';
import {
  developmentTokenReport,
  parseDevelopmentTokenSetup,
  setUpDevelopmentToken,
} from '../../apps/api/src/development-token-setup.js';
import { setUpCredential } from '../../apps/api/src/credential-setup.js';
import {
  rolePresetList,
  rolePresets,
  type CommandResponse,
  type DocumentBodyV2,
  type SmsDecisionInput,
  type SmsHomeResponse,
  type SmsRecordDetailResponse,
  type SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';
import type { DevelopmentTokenResponse } from '../../packages/contracts/src/development-tokens.js';
import { runCli } from '../../packages/cli/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { databaseNow, settleOwnedWork } from './worker-queue.js';

const run = randomUUID().slice(0, 8);
const preset = (key: string) => rolePresets.find((entry) => entry.key === key)!;

/**
 * Several people try Ledger on one local database: an organization made as `pnpm org:create` makes it, whose
 * administrator adds two more people and issues each a development token, through the routes the People screen and
 * the signing screen use.
 */
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Development tokens for every person of a local Ledger', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const store = new MemoryObjectStore();
  const setup = parseOrganizationSetup([
    '--',
    '--name',
    `Example Ridge Survey ${run}`,
    '--time-zone',
    'America/Denver',
    '--admin',
    'Avery Example',
    '--id',
    `development-tokens-${run}`,
  ]);
  let app: Awaited<ReturnType<typeof createApp>>;
  let administrator: string;
  let administratorId: string;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    const created = await setUpOrganization(admin, setup, 'local', []);
    if (!created.created) throw new Error('The organization should be new');
    administrator = created.developmentToken!;
    administratorId = created.administratorId;
  });
  afterAll(async () => {
    await settleOwnedWork([setup.tenantId], { objectStore: store });
    await app?.close();
    await pool.end();
    await admin.end();
  });

  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...headers },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function read<T>(token: string, url: string): Promise<T> {
    const response = await call(token, 'GET', url);
    expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    return response.json() as T;
  }
  async function command(token: string, payload: unknown, headers = {}): Promise<CommandResponse['command']> {
    const response = await call(token, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command;
  }
  /** The People screen's action beside a person. */
  async function issue(token: string, principalId: string): Promise<DevelopmentTokenResponse> {
    const response = await call(token, 'POST', `/v1/authority/principals/${principalId}/development-token`);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    return response.json();
  }
  const detail = (token: string, id: string) => read<SmsRecordDetailResponse>(token, `/v1/sms/records/${id}`);
  async function decide(token: string, id: string, decision: SmsDecisionInput) {
    const shown = await detail(token, id);
    return call(token, 'POST', '/v1/commands', {
      kind: 'decision.record',
      subject: { kind: 'sms', id },
      expectedRevision: shown.basis.revision,
      expectedDependencyBasis: shown.basis.dependencyBasis,
      decision,
    });
  }
  /** Signs as the signing screen does: the exact content shown, after confirming it is them with their own token. */
  async function sign(token: string, id: string, meaning: 'document.adopt' | 'assurance.sign', note: string) {
    const shown = await read<SmsSigningPreviewResponse>(token, `/v1/sms/records/${id}/signing?meaning=${meaning}`);
    expect(shown.available, shown.reason).toBe(true);
    expect(shown.reauthentication).toBe('local_fixture');
    const confirmed = await call(token, 'POST', '/v1/local/reauthentications', { credential: token });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const current = await detail(token, id);
    return command(
      token,
      {
        kind: 'decision.record',
        subject: { kind: 'sms', id },
        expectedRevision: shown.basis.revision,
        expectedDependencyBasis: shown.basis.dependencyBasis,
        decision: {
          kind: meaning,
          note,
          versionNumber: current.record.versionNumber,
          signature: { intent: shown.intent!, contentDigest: shown.contentDigest!, reviewed: true },
        },
      },
      { 'x-ledger-reauthentication': confirmed.json().grant },
    );
  }

  /** fetch, answered by the API in this process, for the command-line client. */
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(response.rawPayload.byteLength ? response.rawPayload : null, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  }) as typeof fetch;
  async function ledger(credential: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { LEDGER_API_URL: 'http://ledger.invalid', LEDGER_TOKEN: credential },
      folders: [process.cwd()],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      fetcher,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('lists the role presets with what each grants', async () => {
    expect(await read(administrator, '/v1/authority/presets')).toEqual(rolePresetList());
  });

  it('lets an administrator give two more people tokens, with which they sign, close and acknowledge', async () => {
    // The second person is added on the People screen from a preset, with adoption authority ticked.
    const added = await command(administrator, {
      kind: 'person.add',
      name: 'Blake Example',
      principalKind: 'human',
      capabilities: [...preset('safety').capabilities, 'sms:adopt'],
      observationGrants: rolePresetList().presets.find((entry) => entry.key === 'safety')!.observationGrants,
    });
    const blakeId = String(added.payload.principalId);
    // The third from the command line, which sends the addition only with a person's credential and a reason.
    const shown = await ledger(
      administrator,
      'people',
      'add',
      '--name',
      'Casey Example',
      '--preset',
      'pilot',
      '--capability',
      'decision:write',
    );
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('Not sent.');
    const sent = await ledger(
      administrator,
      'people',
      'add',
      '--name',
      'Casey Example',
      '--preset',
      'pilot',
      '--capability',
      'decision:write',
      '--reason',
      'Pilot on the north ridge lines',
      '--json',
    );
    expect(sent.code, sent.err).toBe(0);
    const caseyId = JSON.parse(sent.out).principalId as string;
    expect(JSON.parse(sent.out).command.payload).toMatchObject({
      note: 'Pilot on the north ridge lines',
      capabilities: [...preset('pilot').capabilities, 'decision:write'],
    });
    const listed = await ledger(administrator, 'people', 'list');
    expect(listed.code, listed.err).toBe(0);
    expect(listed.out).toContain('Casey Example');
    expect(listed.out).toContain(blakeId);

    // Neither can sign in until a token is issued; the issue is recorded with who issued it and for whom, never the token.
    const blake = (await issue(administrator, blakeId)).developmentToken.token;
    const caseyIssue = await issue(administrator, caseyId);
    const casey = caseyIssue.developmentToken.token;
    expect(caseyIssue.replacedCredentialIds).toEqual([]);
    expect(blake).toMatch(/^ledger-dev-[A-Za-z0-9_-]{32}$/);
    expect((await read<{ principal: { id: string } }>(blake, '/v1/me')).principal.id).toBe(blakeId);
    expect((await read<{ principal: { id: string } }>(casey, '/v1/me')).principal.id).toBe(caseyId);
    const recorded = await admin.query<{ actor_id: string; payload: Record<string, unknown> }>(
      "SELECT actor_id,payload FROM command_records WHERE tenant_id=$1 AND kind='development-token.issue' ORDER BY recorded_at",
      [setup.tenantId],
    );
    expect(recorded.rows.map((row) => [row.actor_id, row.payload.principalId])).toEqual([
      [administratorId, blakeId],
      [administratorId, caseyId],
    ]);
    const journal = await admin.query<{ text: string }>(
      'SELECT payload::text AS text FROM journal_events WHERE tenant_id=$1',
      [setup.tenantId],
    );
    for (const row of journal.rows) {
      expect(row.text).not.toContain(blake);
      expect(row.text).not.toContain(casey);
    }

    // The administrator writes the safety policy and hands it to Blake, who may adopt it, to sign.
    const policyBody: DocumentBodyV2 = {
      origin: 'authored',
      documentType: 'safety_policy',
      revisionLabel: 'Revision 1',
      summary: 'Our commitment to safe ridge survey work.',
      text: 'We plan each ridge line with the crew, stop work when the link is in doubt, and report every concern.',
      changeReason: 'Initial issue',
    };
    const policy = await command(administrator, {
      kind: 'sms.record.open',
      record: {
        kind: 'document',
        schema: 'sms.document.2',
        title: 'Safety policy',
        ownerId: administratorId,
        body: policyBody,
      },
    });
    const policyId = policy.subject!.id;
    const reviewed = await decide(administrator, policyId, {
      kind: 'document.review',
      versionNumber: 1,
      attachmentIds: [],
      note: 'Reviewed the text of revision 1.',
    });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const adoption = await sign(blake, policyId, 'document.adopt', 'Our policy from today.');
    expect(adoption.actorId).toBe(blakeId);
    const issued = await decide(administrator, policyId, {
      kind: 'document.issue',
      versionNumber: 1,
      adoptionId: adoption.id,
      recipientIds: [caseyId],
      note: 'Issued to everyone who flies.',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const effective = (await detail(casey, policyId)).documentControl!.effectiveIssue!;
    await command(casey, {
      kind: 'sms.document.acknowledge',
      recordId: policyId,
      issueId: effective.id,
      contentDigest: effective.contentDigest,
    });
    expect((await read<SmsHomeResponse>(casey, '/v1/sms/home')).reading).toContainEqual(
      expect.objectContaining({ recordId: policyId, acknowledgedAt: expect.any(String) }),
    );

    // An audit with an action Casey owns: Blake signs it, which sets the action, and Casey closes it.
    const now = Date.parse(await databaseNow(admin));
    const day = (offset: number) => new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
    const audit = await command(administrator, {
      kind: 'sms.record.open',
      record: {
        kind: 'assurance',
        schema: 'sms.assurance.1',
        title: 'Preflight records audit, RIDGE-AUD-1',
        ownerId: administratorId,
        body: {
          assuranceType: 'audit',
          // A day behind the UTC date is never in the future in the organization's own zone, whatever the hour.
          performedOn: day(-2),
          completedOn: day(-1),
          scope: 'Preflight records of the ridge survey crews.',
          examined: 'Ten flight records of RIDGE-AC-1 and their preflight assessments.',
          findings: [{ id: 'F1', text: 'Two preflight assessments were signed after takeoff.' }],
          actions: [
            {
              id: 'A1',
              what: 'Brief the crews on signing before takeoff.',
              ownerId: caseyId,
              dueOn: day(7),
              findingId: 'F1',
            },
          ],
        },
      },
    });
    const auditId = audit.subject!.id;
    await sign(blake, auditId, 'assurance.sign', 'Signed as the record of what was done.');
    const closed = await decide(casey, auditId, { kind: 'action.close', actionId: 'A1', note: 'Briefed both crews.' });
    expect(closed.statusCode, closed.body).toBe(201);
    expect((await detail(administrator, auditId)).assurance!.actions[0]).toMatchObject({
      state: 'closed',
      closed: { by: { id: caseyId } },
    });

    // A new token replaces the earlier one at once; the issue says which it replaced.
    const replaced = await issue(administrator, caseyId);
    expect(replaced.replacedCredentialIds).toEqual([caseyIssue.developmentToken.credentialId]);
    const refused = await call(casey, 'GET', '/v1/me');
    expect(refused.statusCode, refused.body).toBe(401);
    expect((await read<{ principal: { id: string } }>(replaced.developmentToken.token, '/v1/me')).principal.id).toBe(
      caseyId,
    );
  });

  it('changes what a person may do and issues their token from the command line, keeping each reason', async () => {
    const added = await command(administrator, {
      kind: 'person.add',
      name: 'Dana Example',
      principalKind: 'human',
      capabilities: [...preset('safety').capabilities],
    });
    const danaId = String(added.payload.principalId);

    // Printed first, with what Dana may do now and after; sent only with the administrator's reason.
    const shown = await ledger(administrator, 'people', 'set', 'Dana Example', '--capability', 'risk:accept:high');
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain(`Person: Dana Example (${danaId}), person`);
    expect(shown.out).toContain('Adds: risk:accept:high');
    expect(shown.out).toContain('Removes: nothing');
    expect(shown.out).toContain('Not sent. An administrator changes it by running this again with --reason');
    const changed = await ledger(
      administrator,
      'people',
      'set',
      'Dana Example',
      '--capability',
      'risk:accept:high',
      '--remove-capability',
      'sms:configure',
      '--reason',
      'Dana accepts high risk from 1 December',
    );
    expect(changed.code, changed.err).toBe(0);
    const dana = await read<{ principal: { capabilities: string[]; revision: number } }>(
      administrator,
      `/v1/authority/principals/${danaId}`,
    );
    expect(dana.principal.capabilities).toContain('risk:accept:high');
    expect(dana.principal.capabilities).not.toContain('sms:configure');
    const update = await admin.query<{ actor_id: string; payload: Record<string, unknown> }>(
      "SELECT actor_id,payload FROM command_records WHERE tenant_id=$1 AND kind='authority.update' AND payload->>'principalId'=$2",
      [setup.tenantId, danaId],
    );
    expect(update.rows).toEqual([
      {
        actor_id: administratorId,
        payload: expect.objectContaining({ note: 'Dana accepts high risk from 1 December' }),
      },
    ]);

    // The token is issued with the reason kept, printed once for Dana, and acts as Dana.
    const issued = await ledger(
      administrator,
      'people',
      'token',
      danaId,
      '--reason',
      'Dana tries the safety screens on this computer',
    );
    expect(issued.code, issued.err).toBe(0);
    const token = /^ {2}(ledger-dev-[A-Za-z0-9_-]{32})$/m.exec(issued.out)![1]!;
    expect((await read<{ principal: { id: string } }>(token, '/v1/me')).principal.id).toBe(danaId);
    const recorded = await admin.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM command_records WHERE tenant_id=$1 AND kind='development-token.issue' AND payload->>'principalId'=$2",
      [setup.tenantId, danaId],
    );
    expect(recorded.rows.map((row) => row.payload.note)).toEqual(['Dana tries the safety screens on this computer']);
    expect(JSON.stringify(recorded.rows)).not.toContain(token);

    // With Dana's own credential, who is not an administrator, the change is refused by Ledger.
    const byDana = await ledger(
      token,
      'people',
      'set',
      'Dana Example',
      '--capability',
      'sms:adopt',
      '--reason',
      'Mine',
    );
    expect(byDana.code).toBe(1);
    expect(byDana.err).toContain('Ledger refused this (403');
  });

  it('refuses a token for a source or service, for a person of another organization, and to someone without authority', async () => {
    const people = await read<{ principals: { id: string; name: string }[] }>(
      administrator,
      '/v1/authority/principals',
    );
    const casey = people.principals.find((entry) => entry.name === 'Casey Example')!;
    const service = await setUpCredential(admin, {
      tenantId: setup.tenantId,
      principal: 'Records agent',
      label: 'The coding agent',
      add: { kind: 'service', capabilities: ['authority:write'], observationGrants: [] },
    });
    const forService = await call(
      administrator,
      'POST',
      `/v1/authority/principals/${service.principal.id}/development-token`,
    );
    expect(forService.statusCode).toBe(400);
    expect(forService.json().error.code).toBe('development_token_for_people');
    const byService = await call(
      service.credential.secret,
      'POST',
      `/v1/authority/principals/${casey.id}/development-token`,
    );
    expect(byService.statusCode).toBe(403);
    const foreign = await call(
      administrator,
      'POST',
      '/v1/authority/principals/principal-alpha-operator/development-token',
    );
    expect(foreign.statusCode).toBe(404);
  });

  it('replaces a lost token from the installer command, recorded under the first administrator', async () => {
    const options = parseDevelopmentTokenSetup(['--organization', setup.tenantId, '--for', 'Avery Example']);
    const result = await setUpDevelopmentToken(admin, options, 'local');
    expect(result.person).toEqual({ id: administratorId, name: 'Avery Example' });
    expect(result.administrator).toEqual({ id: administratorId, name: 'Avery Example' });
    expect(result.issued.replacedCredentialIds).toHaveLength(1);
    expect(developmentTokenReport(result)).toContain(result.issued.developmentToken.token);
    expect((await call(administrator, 'GET', '/v1/me')).statusCode).toBe(401);
    administrator = result.issued.developmentToken.token;
    expect((await call(administrator, 'GET', '/v1/me')).statusCode).toBe(200);
    await expect(setUpDevelopmentToken(admin, options, 'staging')).rejects.toThrow(
      'a person signs in through the identity provider',
    );
  });

  it('refuses development tokens with LEDGER_ENV=staging, saying a person signs in through the identity provider', async () => {
    const staging = await createApp({
      pool,
      env: 'staging',
      objectStore: store,
      signIn: {
        deploymentName: 'Example Ridge Survey',
        issuers: [{ issuer: 'https://identity.example.invalid', clientId: 'ledger-web' }],
      },
      identityProvider: { fetch: (async () => Promise.reject(new Error('No provider in this test'))) as typeof fetch },
    });
    try {
      await staging.ready();
      // The web app offers development tokens only when the API's sign-in settings say so: here they do not.
      const signIn = await staging.inject({ method: 'GET', url: '/v1/sign-in' });
      expect(signIn.json()).toMatchObject({ deploymentName: 'Example Ridge Survey', developmentTokens: false });
      expect((await app.inject({ method: 'GET', url: '/v1/sign-in' })).json()).toMatchObject({
        developmentTokens: true,
      });
      const people = await read<{ principals: { id: string; name: string }[] }>(
        administrator,
        '/v1/authority/principals',
      );
      const casey = people.principals.find((entry) => entry.name === 'Casey Example')!;
      const service = await setUpCredential(admin, {
        tenantId: setup.tenantId,
        principal: 'Records agent',
        label: 'Staging check',
      });
      const refused = await staging.inject({
        method: 'POST',
        url: `/v1/authority/principals/${casey.id}/development-token`,
        headers: { authorization: `Bearer ${service.credential.secret}` },
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toMatchObject({ code: 'development_tokens_disabled' });
      expect(refused.json().error.message).toContain('a person signs in through the identity provider');
      // And a development token is not accepted there at all.
      const token = await staging.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${administrator}` },
      });
      expect(token.statusCode).toBe(401);
    } finally {
      await staging.close();
    }
  });
});
