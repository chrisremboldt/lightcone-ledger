import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOperation, type OperationLifecycle } from './operation.js';
import { operationTarget } from './operation-target.js';

type BrokerPrepared = Parameters<NonNullable<OperationLifecycle['onBrokerPrepared']>>[0];
export type HostedOperationMessage =
  | { event: 'operation_world_ready'; runId: string; paused: boolean; pending: number }
  | { event: 'operation_world_stopped'; runId: string; pending: number; drained: boolean };
type Sender = (message: HostedOperationMessage) => void | Promise<void>;
interface ProcessEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

function hostedEnvironment(env: NodeJS.ProcessEnv, mode: 'broker' | 'live'): NodeJS.ProcessEnv {
  const captured: NodeJS.ProcessEnv = { ...env, SIMULATOR_WORLD_MODE: mode };
  if (operationTarget(captured, resolve(captured.SIMULATOR_WORLD_STATE ?? '')).environment !== 'staging')
    throw new Error('The hosted producer requires the isolated staging target');
  return captured;
}

export async function prepareHostedOperation(env: NodeJS.ProcessEnv): Promise<{
  configPath: string;
  readinessBinding: { username: string; password: string };
}> {
  const captured = hostedEnvironment(env, 'broker');
  const result: { prepared?: BrokerPrepared } = {};
  await runOperation(captured, {
    onBrokerPrepared(value) {
      if (result.prepared || value.runId !== captured.SIMULATOR_WORLD_RUN_ID)
        throw new Error('Hosted broker preparation returned an unexpected bundle');
      result.prepared = value;
    },
  });
  const prepared = result.prepared;
  const adapter = prepared && Object.values(prepared.bindings)[0]?.adapter;
  if (!prepared || typeof prepared.configPath !== 'string' || !adapter?.username || !adapter.password)
    throw new Error('Hosted broker preparation did not retain its readiness binding');
  return {
    configPath: prepared.configPath,
    readinessBinding: { username: adapter.username, password: adapter.password },
  };
}

function sendIpc(message: HostedOperationMessage): void {
  if (!process.connected || !process.send) return;
  try {
    process.send(message, () => {});
  } catch {
    // A parent can disconnect between the channel check and send.
  }
}

function pendingCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function runHostedOperation(
  env: NodeJS.ProcessEnv = process.env,
  sender: Sender = sendIpc,
  events: ProcessEvents = process,
): Promise<void> {
  const controller = new AbortController();
  let resume: (() => Promise<void>) | undefined;
  let resuming: Promise<void> | undefined;
  let resumeFailure: Error | undefined;
  let stopped = false;
  const runId = env.SIMULATOR_WORLD_RUN_ID;
  const stop = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const requestResume = () => {
    if (!resume || resuming || stopped || controller.signal.aborted) return;
    resuming = Promise.resolve()
      .then(async () => {
        if (!stopped && !controller.signal.aborted) await resume?.();
      })
      .catch(() => {
        resumeFailure = new Error('The hosted producer could not resume');
        process.exitCode = 1;
        stop();
      })
      .finally(() => {
        resuming = undefined;
      });
  };
  const message = (value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, 'event') ||
      !Object.hasOwn(value, 'runId')
    )
      return;
    const control = value as { event: unknown; runId: unknown };
    if (control.runId !== runId) return;
    if (control.event === 'operation_world_stop') stop();
    else if (control.event === 'operation_world_resume') requestResume();
  };
  events.on('SIGTERM', stop);
  events.on('SIGINT', stop);
  events.on('SIGUSR2', requestResume);
  events.on('message', message);
  events.on('disconnect', stop);
  if (events === process && process.send && !process.connected) stop();
  try {
    const captured = hostedEnvironment(env, 'live');
    await runOperation(captured, {
      signal: controller.signal,
      async onReady(state, resumeOperation) {
        if (stopped || controller.signal.aborted) return;
        if (state.runId !== runId || typeof state.paused !== 'boolean' || !pendingCount(state.pending))
          throw new Error('The hosted producer returned an unexpected readiness state');
        resume = resumeOperation;
        await sender({
          event: 'operation_world_ready',
          runId: state.runId,
          paused: state.paused,
          pending: state.pending,
        });
      },
      async onStopped(outcome) {
        if (
          outcome.runId !== runId ||
          typeof outcome.drained !== 'boolean' ||
          !pendingCount(outcome.pending) ||
          outcome.drained !== (outcome.pending === 0)
        )
          throw new Error('The hosted producer returned an unexpected stopped state');
        stopped = true;
        resume = undefined;
        if (!outcome.drained) process.exitCode = 1;
        await sender({
          event: 'operation_world_stopped',
          runId: outcome.runId,
          pending: outcome.pending,
          drained: outcome.drained,
        });
      },
    });
    if (resumeFailure) throw resumeFailure;
  } finally {
    events.removeListener('SIGTERM', stop);
    events.removeListener('SIGINT', stop);
    events.removeListener('SIGUSR2', requestResume);
    events.removeListener('message', message);
    events.removeListener('disconnect', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('Hosted producer arguments are unsupported');
    await runHostedOperation();
  } catch {
    console.error('Hosted world producer failed');
    process.exitCode = 1;
  }
}
