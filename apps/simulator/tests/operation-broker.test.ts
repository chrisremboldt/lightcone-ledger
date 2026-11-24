import { createHash, pbkdf2Sync } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperation } from '../../../packages/simulation-models/src/operation.js';
import { loadOperationBindings, prepareOperationBroker } from '../src/operation-broker.js';
import { runOperation } from '../src/operation.js';
import { readOperationCheckpoint } from '../src/operation-state.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const createWorld = (runId = 'broker-test') =>
  createOperation({
    runId,
    start: '2026-10-15T14:00:00.000Z',
    fleet: { alpha: 2, beta: 1 },
  });

describe('isolated operation broker configuration', () => {
  it('retains the initial world when preparing a broker before live startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-bootstrap-'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const path = join(directory, 'world.json');
      const env = {
        SIMULATOR_WORLD_MODE: 'broker',
        SIMULATOR_WORLD_RUN_ID: 'broker-bootstrap',
        SIMULATOR_WORLD_STATE: path,
      };
      await runOperation(env);
      const initial = await readOperationCheckpoint(path);
      expect(initial).toBeDefined();
      expect(initial!.clock.mode).toBe('live');
      expect(initial!.world.now).toBe(Date.parse(initial!.world.config.start));
      await runOperation(env);
      const resumed = await readOperationCheckpoint(path);
      expect(resumed!.world.config).toEqual(initial!.world.config);
      expect(JSON.stringify(resumed!.world.config)).toBe(JSON.stringify(initial!.world.config));
      expect(Object.hasOwn(resumed!.world.config, 'profile')).toBe(false);
      expect(Object.hasOwn(resumed!.world.config, 'capacity')).toBe(false);
      const retainedBindings = await readFile(`${path}.broker/bindings.json`, 'utf8');
      await expect(
        runOperation({ ...env, SIMULATOR_WORLD_PROFILE: 'telemetry-delivery-interruption' }),
      ).rejects.toThrow('configuration is retained');
      await expect(runOperation({ ...env, SIMULATOR_WORLD_CAPACITY: 'illustrative-25.1' })).rejects.toThrow(
        'configuration is retained',
      );
      expect(await readFile(`${path}.broker/bindings.json`, 'utf8')).toBe(retainedBindings);
      await expect(loadOperationBindings(`${path}.broker/bindings.json`, resumed!.world)).resolves.toBeDefined();
      expect(output.mock.calls.every(([value]) => !String(value).includes('password'))).toBe(true);
    } finally {
      output.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['illustrative-25.1', 'alpha-25.1'] as const)(
    'retains fresh %s capacity and broker bindings on resume',
    async (capacity) => {
      const directory = await mkdtemp(join(tmpdir(), 'ledger-world-capacity-bootstrap-'));
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const path = join(directory, 'world.json');
        const env = {
          SIMULATOR_WORLD_MODE: 'broker',
          SIMULATOR_WORLD_RUN_ID: 'capacity-bootstrap',
          SIMULATOR_WORLD_STATE: path,
          SIMULATOR_WORLD_CAPACITY: capacity,
          SIMULATOR_WORLD_PROFILE: 'telemetry-delivery-interruption',
        };
        await runOperation(env);
        const initial = await readOperationCheckpoint(path);
        expect(initial!.world.config.fleet).toEqual({ alpha: 25, beta: 25 });
        expect(initial!.world.resources!.flightPeople).toHaveLength(capacity === 'alpha-25.1' ? 41 : 32);
        expect(initial!.world.resources!.chargers).toHaveLength(14);
        const retainedConfig = JSON.stringify(initial!.world.config);
        const retainedBindings = await readFile(`${path}.broker/bindings.json`, 'utf8');
        await runOperation({
          SIMULATOR_WORLD_MODE: 'broker',
          SIMULATOR_WORLD_RUN_ID: env.SIMULATOR_WORLD_RUN_ID,
          SIMULATOR_WORLD_STATE: path,
        });
        const resumed = await readOperationCheckpoint(path);
        expect(JSON.stringify(resumed!.world.config)).toBe(retainedConfig);
        expect(await readFile(`${path}.broker/bindings.json`, 'utf8')).toBe(retainedBindings);
        await expect(loadOperationBindings(`${path}.broker/bindings.json`, resumed!.world)).resolves.toBeDefined();
        await expect(
          runOperation({
            ...env,
            SIMULATOR_WORLD_CAPACITY: capacity === 'alpha-25.1' ? 'illustrative-25.1' : 'alpha-25.1',
          }),
        ).rejects.toThrow('configuration is retained');
        expect(await readFile(`${path}.broker/bindings.json`, 'utf8')).toBe(retainedBindings);
        expect(output.mock.calls.every(([value]) => !String(value).includes('password'))).toBe(true);
      } finally {
        output.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('retains private credentials and exact device ACLs across restart with native Mosquitto password hashes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-broker-'));
    try {
      const world = createWorld();
      const target = join(directory, 'broker');
      const prepared = await prepareOperationBroker(world, target, 18885);
      const before = await readFile(prepared.bindingsPath, 'utf8');
      const bundle = JSON.parse(before);
      expect(Object.keys(bundle)).toEqual(['version', 'runId', 'port', 'binding', 'mqttBindings', 'files', 'sha256']);
      expect(bundle.version).toBe(1);
      expect(Object.keys(prepared)).toEqual(['bindings', 'bindingsPath', 'configPath']);
      expect(bundle.binding).toBe(
        digest(
          JSON.stringify({
            version: 1,
            config: world.config,
            aircraft: world.aircraft.map(({ id, tenant }) => ({ id, tenant })),
            port: 18885,
          }),
        ),
      );
      const acl = await readFile(join(target, 'acl'), 'utf8');
      const passwords = await readFile(join(target, 'passwords'), 'utf8');
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      for (const name of await readdir(target)) expect((await stat(join(target, name))).mode & 0o777).toBe(0o600);
      for (const aircraft of world.aircraft) {
        const credentials = prepared.bindings[aircraft.id]!;
        expect(acl).toContain(`user ${credentials.device.username}\ntopic write thing/product/${aircraft.id}/osd\n`);
        expect(acl).toContain(`user ${credentials.adapter.username}\ntopic read thing/product/${aircraft.id}/osd\n`);
        const line = passwords.split('\n').find((entry) => entry.startsWith(`${credentials.device.username}:`))!;
        const [, marker, rounds, salt, expected] = line.split(':')[1]!.split('$');
        expect(marker).toBe('7');
        expect(rounds).toBe('101');
        expect(
          pbkdf2Sync(credentials.device.password, Buffer.from(salt!, 'base64'), 101, 64, 'sha512').toString('base64'),
        ).toBe(expected);
        expect(passwords).not.toContain(credentials.device.password);
        expect(passwords).not.toContain(credentials.adapter.password);
      }
      expect(acl).not.toMatch(/[+#]/);
      expect(acl.split('\n').filter((line) => line.startsWith('topic '))).toHaveLength(world.aircraft.length * 2);
      const config = await readFile(prepared.configPath, 'utf8');
      expect(config).toBe(
        [
          'user root',
          'listener 1883 0.0.0.0',
          'allow_anonymous false',
          'password_file /mosquitto/config/operation/passwords',
          'acl_file /mosquitto/config/operation/acl',
          'persistence true',
          'persistence_location /mosquitto/data/',
          'autosave_interval 1',
          'max_packet_size 40000',
          'message_size_limit 32768',
          'max_inflight_messages 20',
          'max_queued_messages 200',
          'max_queued_bytes 8388608',
          'max_connections 16',
          'memory_limit 67108864',
          'connection_messages false',
          'log_dest stdout',
          '',
        ].join('\n'),
      );
      const maximum = Number(config.match(/^max_connections (\d+)$/m)![1]);
      expect(maximum).toBeGreaterThanOrEqual(world.aircraft.length * 2 + 4);

      const restarted = await prepareOperationBroker(world, target, 18885);
      expect(await readFile(restarted.bindingsPath, 'utf8')).toBe(before);
      expect(await readFile(join(target, 'passwords'), 'utf8')).toBe(passwords);
      const loaded = await loadOperationBindings(prepared.bindingsPath, world);
      expect(digest(JSON.stringify(loaded))).toBe(digest(JSON.stringify(prepared.bindings)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a changed run, port or retained policy without replacing credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-broker-'));
    try {
      const world = createWorld();
      const target = join(directory, 'broker');
      const prepared = await prepareOperationBroker(world, target, 18885);
      const original = await readFile(prepared.bindingsPath, 'utf8');
      await expect(prepareOperationBroker(createWorld('another-run'), target, 18885)).rejects.toThrow(
        'does not match this world',
      );
      await expect(prepareOperationBroker(world, target, 18886)).rejects.toThrow('different port or configuration');
      await writeFile(join(target, 'acl'), 'topic read #\n');
      await expect(prepareOperationBroker(world, target, 18885)).rejects.toThrow('retained acl commitment changed');
      expect(await readFile(prepared.bindingsPath, 'utf8')).toBe(original);
      expect(await readFile(join(target, 'acl'), 'utf8')).toBe('topic read #\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a private hosted loopback broker and its mutable persistence across restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-hosted-broker-'));
    try {
      const world = createWorld();
      const target = join(directory, 'broker');
      const options = { profile: 'hosted.2' as const };
      const prepared = await prepareOperationBroker(world, target, 1884, options);
      expect(prepared.dataDirectory).toBe(join(target, 'data'));
      const retained = await Promise.all(
        ['bindings.json', 'passwords', 'acl', 'mosquitto.conf'].map((name) => readFile(join(target, name), 'utf8')),
      );
      const bundle = JSON.parse(retained[0]!);
      expect(bundle).toMatchObject({
        version: 2,
        profile: 'hosted.2',
        port: 1884,
        dataDirectory: prepared.dataDirectory,
      });
      expect(bundle.binding).toBe(
        digest(
          JSON.stringify({
            version: 2,
            profile: 'hosted.2',
            config: world.config,
            aircraft: world.aircraft.map(({ id, tenant }) => ({ id, tenant })),
            port: 1884,
            directory: target,
            dataDirectory: prepared.dataDirectory,
          }),
        ),
      );
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect((await stat(prepared.dataDirectory!)).mode & 0o777).toBe(0o700);
      for (const name of ['bindings.json', 'passwords', 'acl', 'mosquitto.conf'])
        expect((await stat(join(target, name))).mode & 0o777).toBe(0o600);
      expect(retained[3]).toContain('listener 1884 127.0.0.1\n');
      expect(retained[3]).toContain(`password_file ${join(target, 'passwords')}\n`);
      expect(retained[3]).toContain(`acl_file ${join(target, 'acl')}\n`);
      expect(retained[3]).toContain(`persistence_location ${prepared.dataDirectory}/\n`);
      expect(retained[3]).not.toMatch(/user root|0\.0\.0\.0|\/mosquitto\//);
      for (const aircraft of world.aircraft) {
        const credentials = prepared.bindings[aircraft.id]!;
        expect(retained[2]).toContain(
          `user ${credentials.device.username}\ntopic write thing/product/${aircraft.id}/osd\n`,
        );
        expect(retained[2]).toContain(
          `user ${credentials.adapter.username}\ntopic read thing/product/${aircraft.id}/osd\n`,
        );
      }
      expect(retained[2]).not.toMatch(/[+#]/);
      const persistence = join(prepared.dataDirectory!, 'mosquitto.db');
      await writeFile(persistence, 'mutable broker persistence', { mode: 0o600 });
      expect(await prepareOperationBroker(world, target, 1884, options)).toEqual(prepared);
      await expect(loadOperationBindings(prepared.bindingsPath, world, { ...options, port: 1884 })).resolves.toEqual(
        prepared.bindings,
      );
      expect(await readFile(persistence, 'utf8')).toBe('mutable broker persistence');
      expect(
        await Promise.all(
          ['bindings.json', 'passwords', 'acl', 'mosquitto.conf'].map((name) => readFile(join(target, name), 'utf8')),
        ),
      ).toEqual(retained);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses hosted profile, path, port and policy mismatches without replacing retained files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-hosted-broker-'));
    try {
      const world = createWorld();
      const target = join(directory, 'broker');
      const options = { profile: 'hosted.2' as const };
      const prepared = await prepareOperationBroker(world, target, 1884, options);
      const original = await readFile(prepared.bindingsPath, 'utf8');
      await expect(loadOperationBindings(prepared.bindingsPath, world)).rejects.toThrow('explicit hosted.2');
      await expect(prepareOperationBroker(world, target, 1884)).rejects.toThrow('explicit hosted.2');
      await expect(prepareOperationBroker(createWorld('another-run'), target, 1884, options)).rejects.toThrow(
        'does not match this world',
      );
      await expect(prepareOperationBroker(world, target, 1885, options)).rejects.toThrow('does not match this world');
      await expect(loadOperationBindings(prepared.bindingsPath, world, { ...options, port: 1885 })).rejects.toThrow(
        'does not match this world',
      );
      const legacy = await prepareOperationBroker(world, join(directory, 'legacy'), 1884);
      await expect(loadOperationBindings(legacy.bindingsPath, world, { ...options, port: 1884 })).rejects.toThrow(
        'version 2',
      );
      const copied = join(directory, 'copied');
      await cp(target, copied, { recursive: true });
      await expect(
        loadOperationBindings(join(copied, 'bindings.json'), world, { ...options, port: 1884 }),
      ).rejects.toThrow('does not match this world');
      await expect(prepareOperationBroker(world, join(directory, 'unsafe broker'), 1884, options)).rejects.toThrow(
        'hosted paths',
      );
      await chmod(prepared.dataDirectory!, 0o755);
      await expect(loadOperationBindings(prepared.bindingsPath, world, { ...options, port: 1884 })).rejects.toThrow(
        'private',
      );
      await chmod(prepared.dataDirectory!, 0o700);
      const movedData = `${prepared.dataDirectory}-retained`;
      await rename(prepared.dataDirectory!, movedData);
      await symlink(movedData, prepared.dataDirectory!, 'dir');
      await expect(loadOperationBindings(prepared.bindingsPath, world, { ...options, port: 1884 })).rejects.toThrow(
        'symlink',
      );
      await unlink(prepared.dataDirectory!);
      await rename(movedData, prepared.dataDirectory!);
      await writeFile(join(target, 'acl'), 'topic read #\n');
      await expect(loadOperationBindings(prepared.bindingsPath, world, { ...options, port: 1884 })).rejects.toThrow(
        'retained acl commitment changed',
      );
      expect(await readFile(prepared.bindingsPath, 'utf8')).toBe(original);
      expect(await readFile(join(target, 'acl'), 'utf8')).toBe('topic read #\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
