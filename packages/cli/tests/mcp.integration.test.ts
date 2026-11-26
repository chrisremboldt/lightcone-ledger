import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { setUpCredential } from '../../../apps/api/src/credential-setup.js';
import { parseOrganizationSetup, setUpOrganization } from '../../../apps/api/src/organization-setup.js';
import { createPool, MemoryObjectStore } from '../../../packages/persistence/src/index.js';
import { settleOwnedWork } from '../../../tests/integration/worker-queue.js';
import { runCli } from '../src/index.js';

// pnpm ledger mcp, started as an MCP client starts it, against the integration test database: the handshake, the
// tools listed, the worked example's records imported through a tool under an agent's credential, and every reading
// tool called. The adoption is prepared by a tool and sent by the person, with their own credential and reason.

const checkout = join(import.meta.dirname, '..', '..', '..');
const example = join(checkout, 'examples', 'first-operator');
const run = randomUUID().slice(0, 8);
const tenantId = `tenant-mcp-${run}`;
const importOrder = [
  'aircraft.identity',
  'aircraft.inspection',
  'aircraft.time-in-service',
  'person.standing',
  'person.certificate',
  'person.training',
  'organization.procedure',
  'organization.operating-area',
  'flight.plan',
  'operation.role-assignment',
  'flight.preflight-assessment',
  'flight.record',
] as const;

interface Shown {
  lines: string[];
  data: Record<string, unknown>;
  refused: boolean;
  personRuns?: string;
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('The MCP server against Ledger', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  let app: Awaited<ReturnType<typeof createApp>>;
  let apiUrl: string;
  let person: string;
  let client: Client;

  /** Calls a tool and returns its structured result, failing with its text when it reports an error. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<Shown> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
    const shown = result.structuredContent as unknown as Shown;
    expect(Array.isArray(shown.lines)).toBe(true);
    return shown;
  }

  async function ledger(credential: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { LEDGER_API_URL: apiUrl, LEDGER_TOKEN: credential },
      folders: [example],
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('The API should listen on a port');
    apiUrl = `http://127.0.0.1:${address.port}`;
    const created = await setUpOrganization(
      admin,
      parseOrganizationSetup([
        '--name',
        'Example Ridge Survey',
        '--time-zone',
        'America/Denver',
        '--admin',
        'Avery Example',
        '--id',
        `mcp-${run}`,
      ]),
      'local',
      [],
    );
    if (!created.created || !created.developmentToken) throw new Error('The organization should be new');
    person = created.developmentToken;
    const issued = await setUpCredential(admin, {
      tenantId,
      principal: 'Records agent',
      label: 'Coding agent on the office computer',
      add: {
        kind: 'service',
        capabilities: ['input:write', 'evidence:read', 'flight:read'],
        observationGrants: [{ sourceId: 'operator-records', observationType: 'operator.record' }],
      },
    });
    // As an MCP client starts it: a command, its folder, and the credential in the environment.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(checkout, 'packages', 'cli', 'src', 'main.ts'), 'mcp'],
      cwd: example,
      env: { PATH: process.env.PATH ?? '', LEDGER_API_URL: apiUrl, LEDGER_TOKEN: issued.credential.secret },
      stderr: 'pipe',
    });
    client = new Client({ name: 'ledger-mcp-integration', version: '1.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close();
    await settleOwnedWork([tenantId]);
    await app?.close();
    await pool.end();
    await admin.end();
  });

  it('lists the tools, imports under the agent’s credential, leaves the adoption to the person and reads it all back', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of ['record_types', 'check_records', 'coverage', 'list_findings', 'show_finding', 'subject_file'])
      expect(names).toContain(name);

    expect((await call('who_am_i')).lines.join('\n')).toContain('Signed in as Records agent');
    expect((await call('record_types')).lines.join('\n')).toContain('flight.record');
    expect((await call('record_columns', { recordType: 'flight.plan' })).lines.join('\n')).toContain(
      'places the record in time',
    );

    const unfixed = await call('check_records', {
      recordType: 'flight.plan',
      file: 'records/flight.plan.unfixed.csv',
    });
    expect(unfixed.refused).toBe(true);
    expect(unfixed.lines.join('\n')).toContain('2 rows: 0 can be recorded');
    const mapped = await call('check_records', {
      recordType: 'flight.record',
      file: 'records/flight-log.export.csv',
      mapping: 'records/flight-log.mapping.yaml',
    });
    expect(mapped.lines.join('\n')).toContain('3 rows: 3 can be recorded (0 of them incomplete)');

    for (const type of importOrder) {
      const imported = await call('import_records', { recordType: type, file: `records/${type}.csv` });
      expect(imported.lines.join('\n'), type).toContain('recorded as Records agent');
      expect(imported.refused, `${type}: ${imported.lines.join('\n')}`).toBe(false);
    }
    expect((await call('list_records', { recordType: 'aircraft.identity' })).lines.join('\n')).toContain('RIDGE-AC-1');

    const adoption = { packId: 'ledger.part107', mode: 'active', from: '2026-06-01', until: '2028-05-31' };
    const prepared = await call('prepare_adoption', adoption);
    expect(prepared.lines.join('\n')).toContain("Not sent. An adoption is a person's decision");
    expect(prepared.personRuns).toBe(
      'pnpm ledger packs adopt ledger.part107 --mode active --from 2026-06-01 --until 2028-05-31 --reason "<their reason>"',
    );
    expect((await call('adopted_packs')).data.adoptions).toEqual([]);

    // The person runs the command the tool gave, with their own credential and reason.
    const command = prepared.personRuns!.replace(' --reason "<their reason>"', '').split(' ').slice(2);
    const sent = await ledger(
      person,
      ...command,
      '--reason',
      'Avery Example adopts the rules the operation works under.',
    );
    expect(sent.code, `${sent.out}\n${sent.err}`).toBe(0);
    await settleOwnedWork([tenantId]);

    const adopted = await call('adopted_packs');
    expect(adopted.lines.join('\n')).toMatch(/ledger\.part107\s+\d+\s+active/);
    expect((await call('list_packs')).lines.join('\n')).toContain('ledger.part107');
    expect((await call('show_pack', { packId: 'ledger.part107' })).lines.join('\n')).toContain('Rule');
    const covered = await call('coverage', { pack: 'ledger.part107' });
    expect(covered.lines.join('\n')).toContain('ledger.part107');
    await call('coverage', { pack: 'ledger.part107', result: 'attention' });

    const grouped = await call('list_findings');
    expect(grouped.lines.join('\n')).toContain('Not on file is not a finding');
    const every = await call('list_findings', { all: true });
    const findings = every.data.findings as {
      id: string;
      evaluationId: string;
      ruleId: string;
      subject: { kind: string; id: string };
    }[];
    expect(findings.length).toBeGreaterThan(0);

    const one = findings[0]!;
    const shown = await call('show_finding', { finding: one.id });
    expect(shown.lines[0]).toContain(`Finding ${one.id} about`);
    expect(shown.lines.join('\n')).toContain(`Latest evaluation ${one.evaluationId}`);
    const evaluations = shown.data.evaluations as {
      evaluation: { id: string; evidence: { observationId: string }[] };
      records: { id: string }[];
      notOnFile: unknown[];
    }[];
    expect(evaluations[0]!.evaluation.id).toBe(one.evaluationId);
    // The records it read are the observations its evidence cites, each read back.
    expect(evaluations[0]!.records.map((record) => record.id)).toEqual(
      evaluations[0]!.evaluation.evidence.map((item) => item.observationId),
    );
    expect(evaluations[0]!.records.length + evaluations[0]!.notOnFile.length).toBeGreaterThan(0);
    const bySubject = await call('show_finding', {
      finding: one.id,
      subjectKind: one.subject.kind,
      subjectId: one.subject.id,
    });
    expect(bySubject.lines[0]).toBe(shown.lines[0]);

    const file = await call('subject_file', { subjectKind: 'aircraft', subjectId: 'RIDGE-AC-1' });
    expect(file.lines.join('\n')).toContain('Records on file about it');
    expect(file.lines.join('\n')).toContain('aircraft.identity');

    // A tool reads no more than the credential may: this one may not read who may do what.
    const people = await client.callTool({ name: 'list_people', arguments: {} });
    expect(people.isError).toBe(true);
    expect(JSON.stringify(people.content)).toContain('Capability authority:write is required');

    const take = await call('prepare_findings_decision', { action: 'take', rule: one.ruleId });
    expect(take.lines.join('\n')).toContain("Not sent. Taking and closing findings are a person's decisions");
    expect(take.personRuns).toBe(`pnpm ledger findings take --rule ${one.ruleId} --reason "<their reason>"`);
    const after = await call('show_finding', { finding: one.id });
    expect(after.lines.join('\n')).toContain('No decision about it is recorded.');

    expect((await call('draft_recordkeeping_plan')).lines.join('\n')).toContain('Not opened.');
  }, 240_000);
});
