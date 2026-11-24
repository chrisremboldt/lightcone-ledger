import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationLifecycle } from '../src/operation.js';
import { prepareHostedOperation, runHostedOperation } from '../src/hosted-operation.js';

const mocks = vi.hoisted(() => ({ runOperation: vi.fn() }));
vi.mock('../src/operation.js', () => ({ runOperation: mocks.runOperation }));

const runId = 'hosted-entry-test';
const statePath = `/data/ledger/worlds/${runId}/world.json`;
const staging = {
  LEDGER_ENV: 'staging',
  LEDGER_SIMULATION_TARGET: 'isolated',
  FLY_APP_NAME: 'ledger-staging',
  LEDGER_API_URL: 'http://127.0.0.1:4000',
  EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
  SIMULATOR_CALLBACK_HOST: '127.0.0.1',
  SIMULATOR_WORLD_CALLBACK_PORT: '4003',
  SIMULATOR_WORLD_MQTT_PORT: '1884',
  SIMULATOR_WORLD_MQTT_URL: 'mqtt://127.0.0.1:1884',
  SIMULATOR_WORLD_BROKER_PROFILE: 'hosted.2',
  SIMULATOR_WORLD_STATE: statePath,
  SIMULATOR_WORLD_RUN_ID: runId,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  mocks.runOperation.mockReset();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe('hosted operation entrypoint', () => {
  it('returns only the retained broker path and first adapter credential without printing preparation', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prepared = {
      runId,
      bindingsPath: `${statePath}.broker/bindings.json`,
      configPath: `${statePath}.broker/mosquitto.conf`,
      dataDirectory: `${statePath}.broker/data`,
      bindings: {
        first: {
          device: { username: 'device-first', password: 'private-first-device-fixture' },
          adapter: { username: 'adapter-first', password: 'private-first-adapter-fixture' },
        },
        second: {
          device: { username: 'device-second', password: 'private-second-device-fixture' },
          adapter: { username: 'adapter-second', password: 'private-second-adapter-fixture' },
        },
      },
    };
    mocks.runOperation.mockImplementation(async (env: NodeJS.ProcessEnv, lifecycle: OperationLifecycle) => {
      expect(env.SIMULATOR_WORLD_MODE).toBe('broker');
      await lifecycle.onBrokerPrepared?.(prepared);
    });
    await expect(prepareHostedOperation(staging)).resolves.toEqual({
      configPath: prepared.configPath,
      readinessBinding: prepared.bindings.first.adapter,
    });
    expect(mocks.runOperation).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
    await expect(prepareHostedOperation({ ...staging, LEDGER_ENV: 'local' })).rejects.toThrow();
    expect(mocks.runOperation).toHaveBeenCalledTimes(1);
  });

  it('installs early stop handlers, suppresses readiness after abort and keeps handlers through core cleanup', async () => {
    const events = new EventEmitter();
    const sender = vi.fn();
    const started = deferred();
    const cleanup = deferred();
    const resume = vi.fn(async () => {});
    let signal: AbortSignal | undefined;
    let aborts = 0;
    mocks.runOperation.mockImplementation(async (env: NodeJS.ProcessEnv, lifecycle: OperationLifecycle) => {
      expect(env.SIMULATOR_WORLD_MODE).toBe('live');
      signal = lifecycle.signal;
      signal!.addEventListener('abort', () => aborts++);
      events.emit('SIGTERM');
      started.resolve();
      await lifecycle.onReady?.({ runId, paused: true, pending: 0 }, resume);
      await cleanup.promise;
      await lifecycle.onStopped?.({ runId, pending: 0, drained: true });
    });
    const running = runHostedOperation(staging, sender, events);
    await started.promise;
    expect(signal!.aborted).toBe(true);
    for (const event of ['SIGTERM', 'SIGINT', 'SIGUSR2', 'message', 'disconnect'])
      expect(events.listenerCount(event)).toBe(1);
    events.emit('SIGTERM');
    events.emit('SIGINT');
    events.emit('disconnect');
    events.emit('message', { event: 'operation_world_stop', runId });
    events.emit('SIGUSR2');
    expect(aborts).toBe(1);
    expect(resume).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    cleanup.resolve();
    await running;
    expect(sender.mock.calls).toEqual([[{ event: 'operation_world_stopped', runId, pending: 0, drained: true }]]);
    expect(events.eventNames()).toEqual([]);
  });

  it('scopes IPC controls, coalesces resume and reports an undrained stop without exposing credentials', async () => {
    const events = new EventEmitter();
    const localPause = vi.fn();
    events.on('SIGUSR1', localPause);
    const sender = vi.fn();
    const ready = deferred();
    const resumed = deferred();
    const finishResume = deferred();
    const resume = vi.fn(async () => {
      resumed.resolve();
      await finishResume.promise;
    });
    let signal: AbortSignal | undefined;
    mocks.runOperation.mockImplementation(async (_env: NodeJS.ProcessEnv, lifecycle: OperationLifecycle) => {
      signal = lifecycle.signal;
      events.emit('SIGUSR2');
      await lifecycle.onReady?.({ runId, paused: true, pending: 3 }, resume);
      ready.resolve();
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      await lifecycle.onStopped?.({ runId, pending: 3, drained: false });
    });
    const running = runHostedOperation(staging, sender, events);
    await ready.promise;
    expect(sender.mock.calls).toEqual([[{ event: 'operation_world_ready', runId, paused: true, pending: 3 }]]);
    expect(resume).not.toHaveBeenCalled();
    for (const message of [
      { event: 'operation_world_stop', runId: 'another-run' },
      { event: 'operation_world_resume', runId: 'another-run' },
      { event: 'operation_world_stop', runId, extra: true },
      { event: 'operation_world_resume', runId, extra: true },
      { event: 'stop', runId },
      ['operation_world_stop', runId],
      null,
    ])
      events.emit('message', message);
    expect(signal!.aborted).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    events.emit('message', { event: 'operation_world_resume', runId });
    events.emit('SIGUSR2');
    await resumed.promise;
    expect(resume).toHaveBeenCalledTimes(1);
    finishResume.resolve();
    events.emit('message', { event: 'operation_world_stop', runId });
    events.emit('SIGUSR2');
    await running;
    expect(sender.mock.calls).toEqual([
      [{ event: 'operation_world_ready', runId, paused: true, pending: 3 }],
      [{ event: 'operation_world_stopped', runId, pending: 3, drained: false }],
    ]);
    expect(process.exitCode).toBe(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(events.eventNames()).toEqual(['SIGUSR1']);
    expect(localPause).not.toHaveBeenCalled();
  });
});
