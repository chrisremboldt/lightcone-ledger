import { appendFileSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const values = new Map();
const overrides = [];
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === '-c' || key === '--config') overrides.push(process.argv[++index]);
  else if (key.startsWith('--fixture-')) values.set(key, process.argv[++index]);
}
const scenario = values.get('--fixture-scenario') ?? 'valid';
const providerUrl = values.get('--fixture-provider-url');
const config = {
  model: 'configured-model',
  model_provider: 'configured-provider',
  web_search: 'auto',
  project_doc_max_bytes: 10000,
  analytics: { enabled: true },
  feedback: { enabled: true },
  mcp_servers: { test_mcp: { enabled: true } },
  features: { shell_tool: true, image_generation: true, browser_use: true },
};
for (const override of overrides) {
  const split = override.indexOf('=');
  if (split < 1) throw new Error('Fixture received an invalid config override');
  const path = override.slice(0, split).split('.');
  let target = config;
  for (const name of path.slice(0, -1)) target = target[name] ??= {};
  target[path.at(-1)] = JSON.parse(override.slice(split + 1));
}
if (config.mcp_servers.test_mcp.enabled === false) {
  if (scenario === 'enabled-mcp') config.mcp_servers.test_mcp.enabled = true;
  if (scenario === 'enabled-feature') config.features.shell_tool = true;
}

const auditFile = values.get('--fixture-audit-file');
if (auditFile) {
  const forbiddenName = values.get('--fixture-forbidden-env-name') ?? 'LEDGER_INVESTIGATOR_TEST_CANARY';
  await writeFile(
    auditFile,
    JSON.stringify({
      names: Object.keys(process.env).sort(),
      forbiddenCanaryPresent: Object.hasOwn(process.env, forbiddenName),
    }),
  );
}

const threadId = 'thr-test';
const turnId = 'turn-test';
let threadParams = {};
let interrupted = false;
const transcriptFile = values.get('--fixture-transcript-file');
const record = (direction, message) => {
  if (transcriptFile) appendFileSync(transcriptFile, `${JSON.stringify({ direction, message })}\n`);
};
const send = (message) => {
  record('from-server', message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const result = (request, value) => send({ id: request.id, result: value });
const notify = (method, params) => send({ method, params });

function manifest() {
  const tools = [];
  if (config.features.shell_tool) {
    tools.push({ type: 'function', name: 'shell', parameters: { type: 'object' } });
    tools.push({ type: 'function', name: 'apply_patch', parameters: { type: 'object' } });
  }
  if (config.web_search !== 'disabled') tools.push({ type: 'web_search' });
  if (config.features.image_generation) tools.push({ type: 'image_generation' });
  if (config.features.browser_use) tools.push({ type: 'function', name: 'browser', parameters: { type: 'object' } });
  for (const [name, server] of Object.entries(config.mcp_servers))
    if (server.enabled !== false)
      tools.push({ type: 'function', name: `mcp__${name}__fixture`, parameters: { type: 'object' } });
  for (const tool of threadParams.dynamicTools ?? [])
    tools.push({ type: 'function', name: tool.name, parameters: tool.inputSchema });
  return tools;
}

async function completeTurn(params) {
  if (scenario === 'stalled-turn') return;
  if (scenario === 'oversized-protocol') {
    process.stdout.write(`${'x'.repeat(Number(values.get('--fixture-output-bytes') ?? 131073))}\n`);
    return;
  }
  if (scenario === 'exit-during-turn') {
    process.exitCode = 2;
    process.stdin.destroy();
    return;
  }
  const response = await fetch(`${providerUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      input: params.input,
      text: params.outputSchema ? { format: { type: 'json_schema', schema: params.outputSchema } } : undefined,
      tools: manifest(),
    }),
  });
  if (!response.ok) throw new Error(`Fixture provider returned ${response.status}`);
  const payload = await response.json();
  let text = payload.output[0].content[0].text;
  if (scenario === 'malformed-advice') text = '{"summary":';
  if (scenario === 'oversized-advice') text = JSON.stringify({ summary: 'x'.repeat(32769) });
  if (scenario === 'wrong-scope') {
    const advice = JSON.parse(text);
    advice.citations = ['uncollected-other-tenant-receipt'];
    text = JSON.stringify(advice);
  }
  if (scenario === 'operation-output') {
    const advice = JSON.parse(text);
    advice.operation = { method: 'POST', path: '/v1/commands' };
    text = JSON.stringify(advice);
  }
  if (scenario === 'malformed-jsonl') {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (scenario === 'extra-tool-request') {
    send({
      id: 'fixture-tool-request',
      method: 'item/tool/call',
      params: { threadId, turnId, callId: 'fixture-call', tool: 'shell', arguments: { command: 'never-run' } },
    });
    return;
  }
  if (scenario === 'wrong-thread' || scenario === 'wrong-turn') {
    notify('item/agentMessage/delta', {
      threadId: scenario === 'wrong-thread' ? 'other-thread' : threadId,
      turnId: scenario === 'wrong-turn' ? 'other-turn' : turnId,
      itemId: 'fixture-advice',
      delta: text,
    });
    return;
  }
  if (scenario === 'operation-notification') {
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'commandExecution', id: 'fixture-operation', command: 'never-run' },
    });
    return;
  }
  if (scenario === 'descendant-holds-pipes') {
    const pidFile = values.get('--fixture-descendant-file');
    const descendant = spawn(
      process.execPath,
      [fileURLToPath(new URL('./holding-descendant.mjs', import.meta.url)), pidFile],
      {
        env: {},
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    descendant.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await access(pidFile);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  if (interrupted) return;
  const item = { type: 'agentMessage', id: 'fixture-advice', text, phase: 'final_answer' };
  const messages = [
    { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: item.id, delta: text } },
    { method: 'item/completed', params: { threadId, turnId, item } },
    {
      method: 'turn/completed',
      params: {
        threadId,
        turn: {
          id: turnId,
          status: 'completed',
          items: scenario === 'misbound-final' ? [{ ...item, text: 'A different final message' }] : [],
          error: null,
        },
      },
    },
  ];
  if (scenario === 'completed-then-tool') {
    messages.push({
      id: 'fixture-tool-request',
      method: 'item/tool/call',
      params: { threadId, turnId, callId: 'fixture-call', tool: 'shell', arguments: { command: 'never-run' } },
    });
    for (const message of messages) record('from-server', message);
    process.stdout.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    return;
  }
  for (const message of messages) {
    if (scenario !== 'fragmented-utf8') {
      send(message);
      continue;
    }
    record('from-server', message);
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    const split = bytes.findIndex((byte) => byte >= 128) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(bytes.subarray(split));
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  record('to-server', request);
  if (!Object.hasOwn(request, 'id')) continue;
  if (request.method === 'initialize')
    result(request, { userAgent: 'ledger-investigator-fixture/1', platformFamily: 'unix', platformOs: 'fixture' });
  else if (request.method === 'config/read')
    result(request, {
      config,
      origins: {},
      layers: null,
    });
  else if (request.method === 'thread/start') {
    threadParams = request.params;
    result(request, {
      thread: { id: threadId, ephemeral: true, environments: [] },
      model: config.model,
      modelProvider: config.model_provider,
      reasoningEffort: 'ultra',
      cwd: threadParams.cwd,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: { type: 'readOnly' },
      instructionSources: [],
      runtimeWorkspaceRoots: [],
    });
  } else if (request.method === 'turn/start') {
    result(request, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    void completeTurn(request.params).catch(() => {
      notify('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'failed', items: [], error: { message: 'Fixture provider failed' } },
      });
    });
  } else if (request.method === 'turn/interrupt') {
    interrupted = true;
    result(request, {});
  } else result(request, {});
}
