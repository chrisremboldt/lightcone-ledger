import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rolePresets } from '@ledger/contracts';
import { runCli } from '../src/index.js';

const folder = mkdtempSync(join(tmpdir(), 'ledger-cli-people-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A fetch that answers from a table of method and path, and keeps what it was sent. */
function fakeApi(answers: Record<string, { status?: number; body: unknown }>) {
  const sent: { method: string; path: string; body?: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
    });
    const answer = answers[`${init.method ?? 'GET'} ${url.pathname}`];
    return new Response(JSON.stringify(answer?.body ?? { error: { code: 'not_found', message: 'No such route' } }), {
      status: answer ? (answer.status ?? 200) : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function cli(argv: string[], fetcher: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { LEDGER_TOKEN: 'ledger-dev-test' },
    folders: [folder],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetcher,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const administrator = {
  principal: {
    id: 'person-avery',
    tenantId: 'tenant-example-ridge-survey',
    name: 'Avery Example',
    kind: 'human',
    capabilities: ['authority:write'],
    revision: 1,
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [],
  },
  organization: { id: 'tenant-example-ridge-survey', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
};
const service = {
  ...administrator,
  principal: { ...administrator.principal, id: 'service-agent', name: 'Records agent', kind: 'service' },
};
const safety = rolePresets.find((preset) => preset.key === 'safety')!;

describe('pnpm ledger people', () => {
  it('lists everyone with what each may do', async () => {
    const api = fakeApi({
      'GET /v1/authority/principals': {
        body: {
          principals: [
            {
              ...administrator.principal,
              active: true,
              capabilities: ['authority:write', 'sms:adopt'],
              observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
              signInLinked: false,
            },
            {
              ...administrator.principal,
              id: 'person-blake',
              name: 'Blake Example',
              active: false,
              capabilities: [],
              signInLinked: true,
            },
          ],
          hasMore: false,
        },
      },
    });
    const listed = await cli(['people', 'list'], api.fetcher);
    expect(listed.code, listed.err).toBe(0);
    const lines = listed.out.split('\n');
    expect(lines[0]).toMatch(/^Name\s+Id\s+Kind\s+Status\s+Sign-in account\s+May\s+May record$/);
    const words = listed.out.replace(/\s+/g, ' ');
    expect(words).toContain(
      'Avery Example person-avery person active none tied authority:write, sms:adopt operator.record under operator-records Blake Example',
    );
    expect(words).toContain('Blake Example person-blake person inactive tied nothing');
    expect(api.sent).toEqual([{ method: 'GET', path: '/v1/authority/principals' }]);
  });

  it('lists each preset with exactly what it grants', async () => {
    const listed = await cli(['people', 'presets'], fakeApi({}).fetcher);
    expect(listed.code, listed.err).toBe(0);
    for (const preset of rolePresets) expect(listed.out).toContain(preset.title);
    expect(listed.out).toContain('operator.record under operator-records');
  });

  it('prints the addition from a preset and sends nothing without a reason', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: administrator } });
    const shown = await cli(
      ['people', 'add', '--name', 'Casey Example', '--preset', 'safety', '--capability', 'sms:adopt'],
      api.fetcher,
    );
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toBe(
      [
        'Person: Casey Example',
        'Preset: Safety manager (safety)',
        `May: ${[...safety.capabilities, 'sms:adopt'].join(', ')}`,
        'May record: operator.record under operator-records',
        'Sign-in account: none tied. On a local Ledger an administrator issues them a development token on the People screen.',
        'Reason: none given',
        'Recorded as Avery Example (person-avery).',
        'Not sent. An administrator adds them by running this again with --reason "<their reason>"; the reason is kept with the addition.',
      ].join('\n'),
    );
    expect(api.sent.some((item) => item.method === 'POST')).toBe(false);
  });

  it('sends the addition with a person’s credential and their reason, kept as its note', async () => {
    const api = fakeApi({
      'GET /v1/me': { body: administrator },
      'POST /v1/commands': {
        status: 201,
        body: {
          command: {
            id: 'command-1',
            kind: 'person.add',
            actorId: 'person-avery',
            recordedAt: '2026-11-20T16:00:00.000Z',
            payload: { principalId: 'person-casey' },
          },
          meta: {},
        },
      },
    });
    const sent = await cli(
      [
        'people',
        'add',
        '--name',
        'Casey Example',
        '--capability',
        'sms:read',
        '--capability',
        'briefing:ack',
        '--grant',
        'operator-records:operator.record',
        '--sign-in-subject',
        'casey-subject',
        '--reason',
        'Chief pilot from 1 November',
      ],
      api.fetcher,
    );
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out).toContain('Preset: none; the capabilities are given one by one');
    expect(sent.out).toContain('Sign-in account: subject casey-subject, at the identity provider you sign in through');
    expect(sent.out).toContain('Added. Casey Example is person-casey. The addition is recorded.');
    expect(api.sent.find((item) => item.method === 'POST')).toEqual({
      method: 'POST',
      path: '/v1/commands',
      body: {
        kind: 'person.add',
        name: 'Casey Example',
        principalKind: 'human',
        capabilities: ['sms:read', 'briefing:ack'],
        observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
        signIn: { subject: 'casey-subject' },
        note: 'Chief pilot from 1 November',
      },
    });
  });

  it('refuses to add a person with a service’s credential, even with a reason, and says why', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: service } });
    const refused = await cli(
      ['people', 'add', '--name', 'Casey Example', '--preset', 'pilot', '--reason', 'Joins the crew'],
      api.fetcher,
    );
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Person: Casey Example');
    expect(refused.err).toContain(
      "Not sent. Adding a person grants them authority, which is a person's decision, and this credential belongs to Records agent, a service.",
    );
    expect(api.sent.some((item) => item.method === 'POST')).toBe(false);
  });

  it('names what is missing or unknown before sending anything', async () => {
    const api = fakeApi({ 'GET /v1/me': { body: administrator } });
    const unnamed = await cli(['people', 'add', '--preset', 'pilot'], api.fetcher);
    expect(unnamed).toMatchObject({ code: 2, err: '--name is required: the person’s full name.' });
    const nothing = await cli(['people', 'add', '--name', 'Casey Example'], api.fetcher);
    expect(nothing.code).toBe(2);
    expect(nothing.err).toContain('Give a preset with --preset, capabilities with --capability, or both.');
    const preset = await cli(['people', 'add', '--name', 'Casey Example', '--preset', 'chief'], api.fetcher);
    expect(preset.err).toContain('chief is not a preset. Presets: dispatcher (Dispatcher), pilot (Pilot)');
    const capability = await cli(['people', 'add', '--name', 'Casey Example', '--capability', 'fly'], api.fetcher);
    expect(capability.err).toContain('fly is not a capability.');
    const unread = await cli(['people', 'list', '--preset', 'pilot'], api.fetcher);
    expect(unread.code).toBe(2);
    expect(unread.err).toContain('people list does not read --preset');
    expect(api.sent).toEqual([]);
  });

  const blake = {
    ...administrator.principal,
    id: 'person-blake',
    name: 'Blake Example',
    active: true,
    revision: 4,
    capabilities: ['sms:read', 'sms:configure'],
    observationGrants: [],
  };
  const people = {
    'GET /v1/me': { body: administrator },
    'GET /v1/authority/principals': {
      body: {
        principals: [
          { ...administrator.principal, active: true, signInLinked: false },
          { ...blake, signInLinked: false },
        ],
        hasMore: false,
      },
    },
    'GET /v1/authority/principals/person-blake': { body: { principal: blake } },
  };

  it('prints what a person may do now and after, and sends the change only with a reason, kept as its note', async () => {
    const shown = await cli(
      ['people', 'set', 'blake example', '--preset', 'pilot', '--remove-capability', 'sms:configure'],
      fakeApi(people).fetcher,
    );
    expect(shown.code, shown.err).toBe(0);
    const pilot = rolePresets.find((preset) => preset.key === 'pilot')!;
    const after = [...new Set(['sms:read', ...pilot.capabilities])];
    expect(shown.out).toContain('Person: Blake Example (person-blake), person');
    expect(shown.out).toContain('May now: sms:read, sms:configure');
    expect(shown.out).toContain(`Adds: ${after.filter((capability) => capability !== 'sms:read').join(', ')}`);
    expect(shown.out).toContain('Removes: sms:configure');
    expect(shown.out).toContain(`May after: ${after.join(', ')}`);
    expect(shown.out).toContain(
      'Not sent. An administrator changes it by running this again with --reason "<their reason>"; the reason is kept with the change.',
    );
    const api = fakeApi({
      ...people,
      'POST /v1/commands': {
        status: 201,
        body: {
          command: { id: 'command-2', kind: 'authority.update', actorId: 'person-avery', recordedAt: '', payload: {} },
        },
      },
    });
    const sent = await cli(
      [
        'people',
        'set',
        'person-blake',
        '--capability',
        'risk:accept:high',
        '--reason',
        'Accepts high risk from 1 December',
      ],
      api.fetcher,
    );
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out).toContain(
      'Changed. What Blake Example may do is recorded as changed, with the reason, as command-2.',
    );
    expect(api.sent.find((item) => item.method === 'POST')!.body).toEqual({
      kind: 'authority.update',
      principalId: 'person-blake',
      expectedRevision: 4,
      capabilities: ['sms:read', 'sms:configure', 'risk:accept:high'],
      note: 'Accepts high risk from 1 December',
    });
  });

  it('says when nothing changes, and names what cannot be removed or found, sending nothing', async () => {
    const api = fakeApi(people);
    const same = await cli(['people', 'set', 'Blake Example', '--capability', 'sms:read'], api.fetcher);
    expect(same.code, same.err).toBe(0);
    expect(same.out).toContain('Nothing changes: Blake Example already may do exactly this. Nothing was sent.');
    const unheld = await cli(['people', 'set', 'Blake Example', '--remove-capability', 'sms:adopt'], api.fetcher);
    expect(unheld).toMatchObject({ code: 2, err: expect.stringContaining('they do not hold it') });
    const nobody = await cli(['people', 'set', 'Jordan Example', '--capability', 'sms:adopt'], api.fetcher);
    expect(nobody.code).toBe(1);
    expect(nobody.err).toContain('No one here is named Jordan Example.');
    const nothing = await cli(['people', 'set', 'Blake Example'], api.fetcher);
    expect(nothing.code).toBe(2);
    expect(nothing.err).toContain('Say what changes');
    expect(api.sent.some((item) => item.method === 'POST')).toBe(false);
  });

  it('issues a person a development token only with a reason, printing it once', async () => {
    const local = {
      ...people,
      'GET /v1/sign-in': { body: { deploymentName: 'Ledger', issuers: [], developmentTokens: true } },
    };
    const shown = await cli(['people', 'token', 'Blake Example'], fakeApi(local).fetcher);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('Issues: a development token for them, shown once.');
    expect(shown.out).toContain('Not sent. An administrator issues it by running this again with --reason');
    const api = fakeApi({
      ...local,
      'POST /v1/authority/principals/person-blake/development-token': {
        status: 201,
        body: {
          developmentToken: {
            credentialId: 'credential-2',
            principalId: 'person-blake',
            token: `ledger-dev-${'a'.repeat(32)}`,
          },
          replacedCredentialIds: ['credential-1'],
          commandId: 'command-3',
        },
      },
    });
    const issued = await cli(['people', 'token', 'Blake Example', '--reason', 'Tries the safety screens'], api.fetcher);
    expect(issued.code, issued.err).toBe(0);
    expect(issued.out).toContain('Issued, as command-3; their earlier token no longer works.');
    expect(issued.out).toContain(`  ledger-dev-${'a'.repeat(32)}`);
    expect(api.sent.find((item) => item.method === 'POST')!.body).toEqual({ note: 'Tries the safety screens' });

    const deployed = fakeApi({
      ...people,
      'GET /v1/sign-in': { body: { deploymentName: 'Ledger', issuers: [], developmentTokens: false } },
    });
    const refused = await cli(['people', 'token', 'Blake Example', '--reason', 'Tries it'], deployed.fetcher);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      'Not sent. This Ledger takes no development tokens: Blake Example signs in through the identity provider',
    );
    expect(deployed.sent.some((item) => item.method === 'POST')).toBe(false);
  });
});
