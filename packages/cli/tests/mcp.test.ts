import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { tools } from '../src/mcp-tools.js';
import { gutmaMessage } from '../../flight-logs/tests/encoders.js';

// The MCP server offers the client's own commands as tools. A tool takes no credential and no reason, and a tool for
// a person's decision prepares it, sends nothing and gives the command the person runs.

const checkout = join(import.meta.dirname, '..', '..', '..');
const folder = mkdtempSync(join(tmpdir(), 'ledger-mcp-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

/** Every property name a schema describes, at any depth. */
function propertyNames(schema: TSchema): string[] {
  const own = Object.entries((schema.properties ?? {}) as Record<string, TSchema>);
  return [
    ...own.flatMap(([name, inner]) => [name, ...propertyNames(inner)]),
    ...(schema.items ? propertyNames(schema.items as TSchema) : []),
  ];
}

/** A fetch that answers from a table of method and path, and keeps what it was sent. */
function fakeApi(answers: Record<string, unknown>) {
  const sent: { method: string; path: string; body?: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    sent.push({ method, path: url.pathname, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
    const answer = answers[`${method} ${url.pathname}`];
    return new Response(JSON.stringify(answer ?? { error: { code: 'not_found', message: 'No such route' } }), {
      status: answer ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, sent };
}

const avery = {
  principal: {
    id: 'person-avery',
    tenantId: 'tenant-example-ridge-survey',
    name: 'Avery Example',
    kind: 'human',
    capabilities: ['input:write', 'evidence:read', 'flight:read', 'pack:adopt', 'authority:write'],
    revision: 1,
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [],
  },
  organization: { id: 'tenant-example-ridge-survey', name: 'Example Ridge Survey', timeZone: 'America/Denver' },
};

const api = fakeApi({
  'GET /v1/me': avery,
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
  'GET /v1/authority/principals': { principals: [], hasMore: false },
});

async function connected(fetcher: typeof fetch) {
  const server = createMcpServer({
    connection: { apiUrl: 'http://ledger.invalid', token: 'ledger-person-test', from: 'the environment' },
    folder,
    fetcher,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('The MCP server', () => {
  it('describes each input closed, and no tool takes a credential or a reason', () => {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.input.additionalProperties, tool.name).toBe(false);
      const names = propertyNames(tool.input).map((name) => name.toLowerCase());
      for (const forbidden of ['reason', 'note', 'token', 'credential', 'password', 'secret'])
        expect(names, `${tool.name} takes ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('marks reading tools read-only and the tools that keep or write anything as not', () => {
    const readOnly = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations.readOnlyHint]));
    for (const name of ['check_records', 'import_records', 'read_flight_log']) expect(readOnly[name], name).toBe(false);
    for (const tool of tools.filter((item) => item.name.startsWith('prepare_')))
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
    for (const name of ['record_types', 'coverage', 'list_findings', 'show_finding', 'subject_file', 'list_people'])
      expect(readOnly[name], name).toBe(true);
    expect(tools.every((tool) => tool.annotations.openWorldHint === false)).toBe(true);
  });

  it('prepares a person’s decision under a person’s own credential, sends nothing and gives the command', async () => {
    const client = await connected(api.fetcher);
    const adoption = await client.callTool({
      name: 'prepare_adoption',
      arguments: { packId: 'ledger.part107', mode: 'active', from: '2026-06-01', until: '2028-05-31' },
    });
    expect(adoption.isError, JSON.stringify(adoption.content)).toBeFalsy();
    const shown = adoption.structuredContent as { lines: string[]; personRuns?: string; data: { sent: boolean } };
    expect(shown.data.sent).toBe(false);
    expect(shown.lines.join('\n')).toContain('Not sent. A person adopts it by running this again with --reason');
    expect(shown.personRuns).toBe(
      'pnpm ledger packs adopt ledger.part107 --mode active --from 2026-06-01 --until 2028-05-31 --reason "<their reason>"',
    );
    const person = await client.callTool({
      name: 'prepare_person_addition',
      arguments: { name: "Casey O'Example", preset: 'pilot' },
    });
    expect(person.isError, JSON.stringify(person.content)).toBeFalsy();
    expect((person.structuredContent as { personRuns?: string }).personRuns).toBe(
      `pnpm ledger people add --name 'Casey O'\\''Example' --preset pilot --reason "<their reason>"`,
    );
    expect(api.sent.length).toBeGreaterThan(0);
    expect(api.sent.filter((request) => request.method !== 'GET')).toEqual([]);
    await client.close();
  });

  it('refuses a reason, a credential or any argument a tool does not describe, and sends nothing', async () => {
    const quiet = fakeApi({ 'GET /v1/me': avery });
    const client = await connected(quiet.fetcher);
    for (const [name, extra] of [
      ['prepare_adoption', { packId: 'ledger.part107', reason: 'Avery adopts it' }],
      ['prepare_findings_decision', { action: 'take', rule: 'preflight', note: 'Taken' }],
      ['import_records', { recordType: 'flight.record', file: 'flights.csv', token: 'ledger-dev-other' }],
      ['who_am_i', { credential: 'ledger-dev-other' }],
    ] as const)
      await expect(client.callTool({ name, arguments: extra }), name).rejects.toThrow(/does not take these arguments/);
    expect(quiet.sent).toEqual([]);
    await client.close();
  });

  it('reads a GUTMA flight log as the command line does, writes the CSV beside it and sends nothing', async () => {
    const quiet = fakeApi({});
    const client = await connected(quiet.fetcher);
    writeFileSync(join(folder, 'ridge-export.json'), JSON.stringify(gutmaMessage()));
    const read = await client.callTool({ name: 'read_flight_log', arguments: { log: 'ridge-export.json' } });
    expect(read.isError, JSON.stringify(read.content)).toBeFalsy();
    const shown = read.structuredContent as { lines: string[]; data: { reading: { format: string } } };
    expect(shown.data.reading.format).toBe('gutma');
    expect(shown.lines.join('\n')).toContain('ridge-export.json: GUTMA flight log');
    expect(readFileSync(join(folder, 'ridge-export.flight.record.csv'), 'utf8')).toContain('2026-11-10T16:05:12Z');
    writeFileSync(
      join(folder, 'forced.json'),
      JSON.stringify({ exchange: { message: gutmaMessage().exchange.message } }),
    );
    const forced = await client.callTool({
      name: 'read_flight_log',
      arguments: { log: 'forced.json', format: 'gutma', out: 'forced.csv' },
    });
    expect(forced.isError, JSON.stringify(forced.content)).toBeFalsy();
    expect(existsSync(join(folder, 'forced.csv'))).toBe(true);
    await expect(
      client.callTool({ name: 'read_flight_log', arguments: { log: 'ridge-export.json', format: 'kml' } }),
    ).rejects.toThrow();
    expect(quiet.sent).toEqual([]);
    await client.close();
  });

  it('speaks the protocol on standard input and output as pnpm ledger mcp', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(checkout, 'packages', 'cli', 'src', 'main.ts'), 'mcp'],
      cwd: checkout,
      env: { PATH: process.env.PATH ?? '', LEDGER_API_URL: 'http://127.0.0.1:9', LEDGER_TOKEN: 'ledger-unused' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('ledger');
    expect(client.getInstructions()).toContain('calls no language model');
    const { tools: listed } = await client.listTools();
    expect(listed.map((tool) => tool.name).sort()).toEqual(tools.map((tool) => tool.name).sort());
    expect(listed.find((tool) => tool.name === 'coverage')?.annotations?.readOnlyHint).toBe(true);
    const presets = await client.callTool({ name: 'role_presets', arguments: {} });
    expect(presets.isError).toBeFalsy();
    expect((presets.structuredContent as { lines: string[] }).lines.join('\n')).toContain('pilot');
    // Nothing listens there: the tool says so and the server goes on.
    const unreachable = await client.callTool({ name: 'record_types', arguments: {} });
    expect(unreachable.isError).toBe(true);
    expect(JSON.stringify(unreachable.content)).toContain('Could not reach Ledger');
    await client.close();
  });
});
