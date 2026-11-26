import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiError, LedgerClient } from '@ledger/contracts/client';
import { RefusalError, UsageError, type Context } from './commands.js';
import type { Connection } from './config.js';
import { refusalWords } from './format.js';
import { tools, type LedgerTool, type ToolFiles, type ToolResult } from './mcp-tools.js';

/**
 * pnpm ledger mcp: the client's reading commands, checks and imports as Model Context Protocol tools, on standard
 * input and output, under the client's own credential. Ledger calls no language model; the agent that calls these
 * tools is the operator's own.
 */

export const MCP_INSTRUCTIONS = [
  'Ledger keeps an organization’s records and checks them against the rules it has adopted. It calls no language model, and a check reports what is on file and what is not, never a verdict.',
  'Every tool runs under the credential of the command-line client that started this server (who_am_i says whose).',
  'Tools named prepare_* print a person’s decision (an adoption, a grant, taking or closing findings, a signature) and send nothing. Show the person what was prepared and the command in personRuns; the person runs it themselves with their own credential and their own reason. Never ask for a person’s credential or reason.',
  'import_records records rows under this credential, as the client does. Check a file with check_records first.',
].join('\n');

/** The one shape every tool returns: the lines a person reads, the API's data, and the command a person runs. */
const outputSchema = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'string' }, description: 'What the command-line client prints.' },
    data: { description: 'The data the client prints with --json.' },
    refused: {
      type: 'boolean',
      description: 'True when Ledger recorded nothing for some of what was asked, such as a refused row.',
    },
    personRuns: {
      type: 'string',
      description: 'For a person’s decision that was prepared and not sent: the command the person runs to send it.',
    },
  },
  required: ['lines', 'data', 'refused'],
} as const;

export function toolList(): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input as Tool['inputSchema'],
    outputSchema: outputSchema as unknown as Tool['outputSchema'],
    annotations: { title: tool.title, ...tool.annotations },
  }));
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function success(said: readonly string[], result: ToolResult): CallToolResult {
  const { output, personRuns } = result;
  const lines = [...said, ...output.lines];
  const text = [...lines, ...(personRuns ? ['', `The person runs, with their own credential: ${personRuns}`] : [])];
  return {
    content: [{ type: 'text', text: text.join('\n') }],
    structuredContent: {
      lines,
      data: output.data ?? null,
      refused: output.refused === true,
      ...(personRuns ? { personRuns } : {}),
    },
  };
}

/** Checks a call's arguments against the tool's input: an argument it does not describe is refused, as a flag is. */
function inputOf(tool: LedgerTool, args: unknown): Record<string, unknown> {
  const input = args ?? {};
  if (Value.Check(tool.input, input)) return input as Record<string, unknown>;
  const first = [...Value.Errors(tool.input, input)][0];
  const where = first?.path ? ` at ${first.path}` : '';
  throw new McpError(
    ErrorCode.InvalidParams,
    `${tool.name} does not take these arguments${where}: ${first?.message ?? 'they do not match its input'}. Nothing was done.`,
  );
}

export interface McpServerOptions {
  connection: Connection;
  /** The folder relative paths are read from: where the server was started. */
  folder: string;
  /** Replaces fetch, as a test does to call the API in process. */
  fetcher?: typeof fetch;
}

export function createMcpServer(options: McpServerOptions): Server {
  const client = new LedgerClient(options.connection.apiUrl, options.connection.token, options.fetcher);
  const files: ToolFiles = { path: (relative) => resolve(options.folder, relative), folder: options.folder };
  const server = new Server(
    { name: 'ledger', title: 'Lightcone Ledger', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `There is no tool ${request.params.name}.`);
    const input = inputOf(tool, request.params.arguments);
    const said: string[] = [];
    const context: Context = { client, say: (line) => said.push(line) };
    try {
      return success(said, await tool.run(context, input as never, files));
    } catch (error) {
      if (error instanceof UsageError || error instanceof RefusalError) return failure(error.message);
      if (error instanceof ApiError) return failure(refusalWords(error));
      return failure(`Could not reach Ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return server;
}

/** Serves the tools on the given streams until the client closes them. */
export async function serveMcp(options: McpServerOptions & { input: Readable; output: Writable }): Promise<void> {
  const server = createMcpServer(options);
  const closed = new Promise<void>((resolveClosed) => {
    server.onclose = () => resolveClosed();
  });
  options.input.once('end', () => void server.close());
  await server.connect(new StdioServerTransport(options.input, options.output));
  await closed;
}
