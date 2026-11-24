import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FakeScenario =
  | 'valid'
  | 'malformed-advice'
  | 'oversized-advice'
  | 'stalled-turn'
  | 'extra-tool-request'
  | 'operation-output'
  | 'wrong-scope'
  | 'malformed-jsonl'
  | 'exit-during-turn'
  | 'wrong-thread'
  | 'wrong-turn'
  | 'operation-notification'
  | 'enabled-mcp'
  | 'enabled-feature'
  | 'fragmented-utf8'
  | 'oversized-protocol'
  | 'completed-then-tool'
  | 'misbound-final'
  | 'descendant-holds-pipes';

export interface FixtureMessage {
  direction: 'to-server' | 'from-server';
  message: { id?: number | string; method?: string; params?: unknown; result?: unknown };
}

interface ProviderRequest {
  method: string | undefined;
  path: string | undefined;
  body: {
    model?: string;
    input?: unknown;
    tools?: unknown[];
    text?: { format?: { type?: string; schema?: unknown } };
  };
  authorizationPresent: boolean;
}

interface Launch {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface FakeOptions {
  advice: unknown;
  scenario?: FakeScenario;
  outputBytes?: number;
}

export async function fakeAppServer(options: FakeOptions) {
  const root = await mkdtemp(join(tmpdir(), 'ledger-investigator-fixture-'));
  const providerRequests: ProviderRequest[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 524288) throw new Error('Fixture provider request exceeded its bound');
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest['body'];
      providerRequests.push({
        method: request.method,
        path: request.url,
        body,
        authorizationPresent: request.headers.authorization !== undefined,
      });
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'fixture-response',
          model: 'configured-model',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify(options.advice) }],
            },
          ],
        }),
      );
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', () => {
      provider.removeListener('error', reject);
      resolve();
    });
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture provider did not bind a loopback port');
  const providerUrl = `http://127.0.0.1:${address.port}`;
  let turnStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    turnStarted = resolve;
  });
  const launches: Array<{
    args: string[];
    cwd: string;
    environmentNames: string[];
    child: ReturnType<typeof spawn>;
    auditPath: string;
    transcriptPath: string;
    descendantPath: string;
  }> = [];
  return {
    providerRequests,
    launches,
    spawnServer(launch: Launch) {
      const auditPath = join(root, `environment-${launches.length}.json`);
      const transcriptPath = join(root, `protocol-${launches.length}.jsonl`);
      const descendantPath = join(root, `descendant-${launches.length}.json`);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../fixtures/fake-app-server.mjs', import.meta.url)),
          '--fixture-provider-url',
          providerUrl,
          '--fixture-scenario',
          options.scenario ?? 'valid',
          '--fixture-audit-file',
          auditPath,
          '--fixture-transcript-file',
          transcriptPath,
          '--fixture-output-bytes',
          String(options.outputBytes ?? 131073),
          '--fixture-descendant-file',
          descendantPath,
          ...launch.args,
        ],
        {
          cwd: launch.cwd,
          env: launch.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
          windowsHide: true,
          shell: false,
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        let newline = output.indexOf('\n');
        while (newline !== -1) {
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          try {
            const message = JSON.parse(line) as { result?: { turn?: { status?: string } } };
            if (message.result?.turn?.status === 'inProgress') turnStarted();
          } catch {}
          newline = output.indexOf('\n');
        }
      });
      launches.push({
        args: [...launch.args],
        cwd: launch.cwd,
        environmentNames: Object.keys(launch.env).sort(),
        child,
        auditPath,
        transcriptPath,
        descendantPath,
      });
      return child;
    },
    turnStarted: started,
    async descendantPid(index: number): Promise<number> {
      const record = JSON.parse(await readFile(launches[index]!.descendantPath, 'utf8')) as { pid: number };
      return record.pid;
    },
    async transcript(index: number): Promise<FixtureMessage[]> {
      const text = await readFile(launches[index]!.transcriptPath, 'utf8');
      return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as FixtureMessage);
    },
    async environmentAudit(index: number): Promise<{ names: string[]; forbiddenCanaryPresent: boolean }> {
      return JSON.parse(await readFile(launches[index]!.auditPath, 'utf8')) as {
        names: string[];
        forbiddenCanaryPresent: boolean;
      };
    },
    async close(): Promise<void> {
      for (const { child } of launches) {
        if (process.platform !== 'win32' && child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        } else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}
