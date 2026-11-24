import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  adapterEnvironment,
  adapterRequested,
  emulatorsRequested,
  runtimePlan,
  simulatorRuntimeMode,
} from '../../infra/scripts/runtime-config.mjs';
import { createRuntimeProcesses } from '../../infra/scripts/runtime-processes.mjs';
import { startCoreServices } from '../../infra/scripts/supervise.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const infra = join(root, 'infra');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The environment the image's final stage sets: what a production start runs with before the deployer's own. */
function imageEnvironment(): Record<string, string> {
  const finalStage = read('infra/Dockerfile')
    .split(/^FROM /m)
    .at(-1)!;
  const env: Record<string, string> = {};
  for (const line of finalStage.split('\n').filter((value) => value.startsWith('ENV ')))
    for (const [, name, value] of line.slice(4).matchAll(/([A-Z0-9_]+)=(\S+)/g)) env[name!] = value!;
  return env;
}

/** What a deployment adds: its database, storage and sign-in, and no emulator credential, real or dummy. */
const deployment = {
  DATABASE_URL: 'postgresql://ledger_app:secret@db.example.invalid:5432/ledger',
  WORKER_DATABASE_URL: 'postgresql://ledger_worker:secret@db.example.invalid:5432/ledger',
  S3_BUCKET: 'ledger',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  CORS_ORIGINS: 'https://ledger.example.invalid',
};

/** Each service of a compose file, with the lines of its definition. */
function composeServices(text: string): Map<string, string> {
  const services = new Map<string, string>();
  const block = /^services:\n((?:(?: {2,}.*)?\n)*)/m.exec(`${text}\n`)?.[1] ?? '';
  let current: string | undefined;
  for (const line of block.split('\n')) {
    const name = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line)?.[1];
    if (name) services.set((current = name), '');
    else if (current) services.set(current, `${services.get(current)}${line}\n`);
  }
  return services;
}

describe('a production start', () => {
  it('runs the API and the workers, and no emulator or simulator', () => {
    const env = { ...imageEnvironment(), ...deployment };
    expect(env).toMatchObject({ NODE_ENV: 'production', LEDGER_ENV: 'staging', LEDGER_WEB_DIR: '/app/apps/web/dist' });
    for (const name of Object.keys(env))
      expect(name).not.toMatch(/^(?:LEDGER_EMULATORS|SIMULATOR_|DJI_|EMULATOR_|AIRSPACE_|PARTNER_)/);
    expect(simulatorRuntimeMode(env)).toBe('off');
    expect(emulatorsRequested(env)).toBe(false);
    expect(runtimePlan(env)).toEqual(['api', 'workers']);
    expect(adapterRequested(env)).toBe(false);
  });

  it('starts an adapter process only when one is named, and gives it no database or storage setting', () => {
    const env = { ...imageEnvironment(), ...deployment };
    const named = {
      ...env,
      LEDGER_ADAPTER: 'dji-cloud-api-osd-position',
      LEDGER_API_CREDENTIAL: 'ledger-service-fictional',
      LEDGER_CREDENTIAL_LABEL: 'Fictional hangar adapter',
      ADAPTER_BROKER_PASSWORD: 'fictional',
    };
    expect(runtimePlan(named)).toEqual(['api', 'workers', 'adapter']);
    const given = adapterEnvironment(named);
    expect(given).toMatchObject({
      LEDGER_ADAPTER: 'dji-cloud-api-osd-position',
      LEDGER_API_URL: 'http://127.0.0.1:4000',
      LEDGER_API_CREDENTIAL: 'ledger-service-fictional',
      ADAPTER_BROKER_PASSWORD: 'fictional',
    });
    for (const name of Object.keys(given)) expect(name).not.toMatch(/^(?:DATABASE_|WORKER_DATABASE|S3_|CORS_)/);
    const supervisor = read('infra/scripts/supervise.mjs');
    expect(supervisor).toMatch(/if \(adapterRequested\(env\)\)\s+processes\.start\('adapter'/);
  });

  it('keeps the API and the workers running when the adapter process exits', async () => {
    class Child extends EventEmitter {
      kill() {
        this.emit('exit', 0, 'SIGTERM');
        return true;
      }
    }
    const children = new Map<string, Child>();
    const log = vi.fn();
    const processes = createRuntimeProcesses({
      spawnProcess: vi.fn((file: string) => children.get(file)!),
      env: {},
      log,
      adapterDrainMs: 20,
      serviceDrainMs: 20,
    });
    for (const name of ['api', 'workers', 'adapter']) {
      children.set(name, new Child());
      processes.start(name, name, []);
    }
    children.get('adapter')!.emit('exit', 1, null);
    expect(processes.stopping).toBe(false);
    expect(log).toHaveBeenCalledWith({ event: 'adapter_exit', process: 'adapter', code: 1, signal: null });
    expect(await processes.stop()).toBe(0);
  });

  it('starts the emulators and the simulator only when asked', () => {
    const env = { ...imageEnvironment(), ...deployment };
    expect(runtimePlan({ ...env, LEDGER_EMULATORS: '1' })).toEqual(['api', 'emulators', 'workers']);
    expect(runtimePlan({ ...env, SIMULATOR_RUNTIME_MODE: 'trickle' })).toEqual([
      'api',
      'emulators',
      'workers',
      'simulator',
    ]);
    expect(runtimePlan({ ...env, LEDGER_EMULATORS: '0' })).toEqual(['api', 'workers']);
    expect(() => emulatorsRequested({ LEDGER_EMULATORS: 'yes' })).toThrow('LEDGER_EMULATORS must be 0 or 1');
  });

  it('is what the image entrypoint runs, and the supervisor follows the same rule', async () => {
    const dockerfile = read('infra/Dockerfile');
    expect(dockerfile).toMatch(/^ENTRYPOINT \["node", "infra\/scripts\/runtime-entrypoint\.mjs"\]$/m);
    expect(dockerfile).toMatch(/^CMD \["supervise"\]$/m);
    expect(read('infra/scripts/runtime-entrypoint.mjs')).toContain("const mode = process.argv[2] ?? 'supervise';");
    const supervisor = read('infra/scripts/supervise.mjs');
    expect(supervisor).toContain(
      'startCoreServices(processes, waitForHttpReady, { emulators: emulatorsRequested(env) })',
    );
    expect(supervisor.match(/processes\.start\('emulators'/g)).toHaveLength(1);
    expect(supervisor).toMatch(/if \(mode === 'trickle'\)\s+processes\.start\('simulator'/);
    expect(supervisor).toMatch(/if \(mode === 'world'\) await startHostedWorld/);

    const processes = { start: vi.fn(), stopping: false, signal: new AbortController().signal };
    const waitForReady = vi.fn(async () => undefined);
    const env = { ...imageEnvironment(), ...deployment };
    await startCoreServices(processes, waitForReady, { emulators: emulatorsRequested(env) });
    expect(processes.start.mock.calls.map(([name]) => name)).toEqual(['api', 'workers']);
    expect(waitForReady.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:4000/readyz']);
  });

  it('keeps every emulator or simulator in a compose file behind a profile', () => {
    const files = readdirSync(infra).filter((name) => /^compose.*\.ya?ml$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      for (const [name, definition] of composeServices(read(`infra/${file}`))) {
        if (!/emulator|simulator|SIMULATOR_RUNTIME_MODE|LEDGER_EMULATORS=1/i.test(`${name}\n${definition}`)) continue;
        expect(definition, `${file}: ${name} starts by default`).toMatch(/^ {4}profiles:/m);
      }
  });
});
