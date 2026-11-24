import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

// Printing what would be sent is success: every command that prepares a person's decision exits 0 without --reason,
// under any credential, and says who sends it. Sending it with --reason under a credential that is not a person's is
// refused, and nothing is sent.

const folder = mkdtempSync(join(tmpdir(), 'ledger-cli-preparing-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** A fetch that answers from a table of method and path, and keeps what it was sent. */
function fakeApi(answers: Record<string, unknown>) {
  const sent: { method: string; path: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    sent.push({ method, path: url.pathname });
    const answer = answers[`${method} ${url.pathname}`];
    return new Response(JSON.stringify(answer ?? { error: { code: 'not_found', message: 'No such route' } }), {
      status: answer ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, sent };
}

async function cli(argv: string[], fetcher: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { LEDGER_TOKEN: 'ledger-service-test' },
    folders: [folder],
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetcher,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const service = {
  principal: {
    id: 'service-records-agent',
    tenantId: 'tenant-example-ridge-survey',
    name: 'Records agent',
    kind: 'service',
    capabilities: ['input:write', 'evidence:read', 'flight:read', 'sms:read', 'authority:write'],
    revision: 1,
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [],
  },
  organization: { id: 'tenant-example-ridge-survey', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
};
const blake = {
  id: 'person-blake',
  tenantId: service.principal.tenantId,
  name: 'Blake Example',
  kind: 'human',
  active: true,
  revision: 3,
  capabilities: ['sms:read'],
  commandLinkSources: [],
  missionSources: [],
  monitoringSources: [],
  observationGrants: [],
};
const groups = {
  shown: 'counted',
  order: 'fewest',
  groups: [
    {
      packId: 'ledger.part107',
      packTitle: 'Part 107',
      ruleId: 'ledger.part107.preflight',
      ruleTitle: 'Preflight assessment on record',
      paragraph: '§ 107.49',
      open: 1,
      subjects: 1,
      owned: 0,
      cleared: 0,
      oldestOpenedAt: '2026-11-20T17:00:00.000Z',
      aboutFrom: '2026-09-02T16:00:00.000Z',
      aboutUntil: '2026-09-02T16:00:00.000Z',
    },
  ],
  total: { findings: 1, rules: 1 },
  counts: { counted: 1, proposed: 0, relieved: 0 },
  attention: { unowned: 1, overdue: 0 },
  filters: { subjectKinds: ['flight'], packs: [], owners: [] },
  truncated: false,
  computedAt: '2026-11-23T17:00:00.000Z',
};
const findings = {
  ...groups,
  findings: [
    {
      id: 'finding-1',
      subject: { scope: 'source', kind: 'flight', id: 'RIDGE-F-1', sourceId: 'operator-records', name: 'RIDGE-F-1' },
      packId: 'ledger.part107',
      packTitle: 'Part 107',
      ruleId: 'ledger.part107.preflight',
      ruleTitle: 'Preflight assessment on record',
      paragraph: '§ 107.49',
      summary: 'No preflight assessment is recorded for the flight.',
      evaluationId: 'evaluation-1',
      aboutAt: '2026-09-02T16:00:00.000Z',
      cleared: false,
      mode: 'active',
      status: 'open',
      owner: null,
      openedAt: '2026-11-20T17:00:00.000Z',
      ageDays: 3,
    },
  ],
  matching: 1,
  page: { limit: 200, hasMore: false, nextCursor: null },
};
const document = {
  record: {
    id: 'sms-document-1',
    kind: 'document',
    reference: 'ERS-POL-1',
    title: 'Safety policy',
    confidentiality: 'ordinary',
    versionNumber: 2,
  },
  basis: { revision: 4, dependencyBasis: 'b'.repeat(64) },
  decisions: [],
};

const api = fakeApi({
  'GET /v1/me': service,
  'GET /v1/rule-packs': {
    packs: [{ packId: 'ledger.part107', version: 1, title: 'Part 107', origin: { kind: 'built_in' } }],
  },
  'GET /v1/rule-packs/ledger.part107/versions/1': {
    pack: {
      packId: 'ledger.part107',
      version: 1,
      title: 'Part 107',
      digest: 'd'.repeat(64),
      leaves: [{ id: 'ledger.part107.preflight', title: 'Preflight assessment', coverage: 'automated' }],
      bindings: [],
    },
  },
  'GET /v1/organization/coverage': { adoptions: [] },
  'GET /v1/organization/open-findings/groups': groups,
  'GET /v1/organization/open-findings': findings,
  'GET /v1/authority/principals': { principals: [{ ...blake, signInLinked: false }], hasMore: false },
  'GET /v1/authority/principals/person-blake': { principal: blake },
  'GET /v1/sign-in': { deploymentName: 'Ledger', issuers: [], developmentTokens: true },
  'GET /v1/sms/records': { records: [document.record] },
  'GET /v1/sms/records/sms-document-1': document,
  'GET /v1/sms/records/sms-document-1/signing': {
    available: true,
    intent: 'I, Records agent, adopt revision 2 of the safety policy “Safety policy”.',
    contentDigest: 'c'.repeat(64),
    basis: document.basis,
    reauthentication: 'local_fixture',
  },
});

const preparing: [string, string[], string][] = [
  [
    'packs adopt',
    ['packs', 'adopt', 'ledger.part107', '--mode', 'active', '--from', '2026-06-01', '--until', '2028-05-31'],
    "Not sent. An adoption is a person's decision, and this credential belongs to Records agent, a service. The person who decides runs this again",
  ],
  [
    'people add',
    ['people', 'add', '--name', 'Casey Example', '--preset', 'pilot'],
    "Not sent. Adding a person grants them authority, which is a person's decision, and this credential belongs to Records agent, a service. An administrator runs this again",
  ],
  [
    'people set',
    ['people', 'set', 'Blake Example', '--capability', 'sms:adopt'],
    "Not sent. Changing what someone may do grants or removes authority, which is a person's decision, and this credential belongs to Records agent, a service. An administrator runs this again",
  ],
  [
    'people token',
    ['people', 'token', 'person-blake'],
    "which is a person's decision, and this credential belongs to Records agent, a service. An administrator runs this again",
  ],
  [
    'findings take',
    ['findings', 'take', '--rule', 'preflight'],
    "Not sent. Taking and closing findings are a person's decisions, and this credential belongs to Records agent, a service. The person who decides runs this again",
  ],
  [
    'findings close',
    ['findings', 'close', '--rule', 'preflight', '--as', 'accepted'],
    "Not sent. Taking and closing findings are a person's decisions",
  ],
  [
    'safety review',
    ['safety', 'review', 'ERS-POL-1'],
    "Not sent. Reviewing a document revision is a person's decision, and this credential belongs to Records agent, a service. The person who decides runs this again",
  ],
  [
    'safety adopt',
    ['safety', 'adopt', 'document', 'ERS-POL-1'],
    "Not sent. Adopting the document is a person's decision, and this credential belongs to Records agent, a service.",
  ],
];

describe('A command that prepares a person’s decision, run with a service’s credential', () => {
  for (const [name, argv, line] of preparing) {
    it(`${name} prints it, exits 0 and says who sends it`, async () => {
      api.sent.length = 0;
      const printed = await cli(argv, api.fetcher);
      expect(printed.code, printed.err).toBe(0);
      expect(printed.out).toContain(line);
      expect(printed.out).toContain('with their own credential and --reason "<their reason>".');
      expect(api.sent.every((request) => request.method === 'GET')).toBe(true);
    });

    it(`${name} refuses to send it with a reason, exits 1 and sends nothing`, async () => {
      api.sent.length = 0;
      const refused = await cli([...argv, '--reason', 'Not a person'], api.fetcher);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(line);
      expect(api.sent.every((request) => request.method === 'GET')).toBe(true);
    });
  }
});
