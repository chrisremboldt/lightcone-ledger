import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brokerCommand, prepareBroker, waitForBroker } from './mqtt-runtime.mjs';
import {
  adapterEnvironment,
  adapterRequested,
  emulatorsRequested,
  hostedWorldEnvironment,
  refusedOwnerConnection,
  simulatorRuntimeMode,
  withoutOwnerConnection,
} from './runtime-config.mjs';
import { createRuntimeProcesses } from './runtime-processes.mjs';
import { waitForHttpReady, waitForWorldReady } from './runtime-readiness.mjs';

export async function startCoreServices(processes, waitForReady = waitForHttpReady, { emulators = false } = {}) {
  if (processes.stopping) return;
  // The development tools drive the fictional world, which adopts the example packs; a production start offers none.
  const packs = emulators ? { LEDGER_EXAMPLE_PACKS: process.env.LEDGER_EXAMPLE_PACKS || '1' } : {};
  processes.start('api', process.execPath, ['apps/api/dist/main.js'], packs);
  await waitForReady(
    'http://127.0.0.1:4000/readyz',
    (value) => value?.status === 'ready' && value.role === 'ledger_app',
    processes.signal,
  );
  if (processes.stopping) return;
  if (emulators) await startEmulators(processes, waitForReady);
  if (processes.stopping) return;
  // Two processes cannot listen on one port: the workers serve their metrics where LEDGER_WORKER_METRICS_LISTEN says,
  // or not at all, while the API serves its own at LEDGER_METRICS_LISTEN.
  processes.start('workers', process.execPath, ['apps/workers/dist/main.js'], {
    ...packs,
    LEDGER_METRICS_LISTEN: process.env.LEDGER_WORKER_METRICS_LISTEN ?? '',
  });
}

async function startEmulators(processes, waitForReady) {
  processes.start('emulators', process.execPath, ['apps/emulators/dist/index.js'], {
    HOST: '127.0.0.1',
    EMULATOR_HOST: '127.0.0.1',
    EMULATOR_PORT: '4002',
  });
  await waitForReady(
    'http://127.0.0.1:4002/healthz',
    (value) => value?.status === 'ok' && value.simulation === true,
    processes.signal,
  );
}

export async function startHostedWorld(
  processes,
  env,
  loadHostedOperation = () => import('../../apps/simulator/dist/hosted-operation.js'),
) {
  if (processes.stopping) return;
  const { prepareHostedOperation } = await loadHostedOperation();
  if (processes.stopping) return;
  const worldEnv = hostedWorldEnvironment(env);
  const { configPath, readinessBinding } = await prepareHostedOperation(worldEnv);
  if (processes.stopping) return;
  const broker = brokerCommand();
  processes.start('world-mqtt', broker.file, [...broker.args, '-c', configPath], {}, false);
  await waitForBroker(readinessBinding, { url: 'mqtt://127.0.0.1:1884', signal: processes.signal });
  if (processes.stopping) return;
  const child = processes.start(
    'world',
    process.execPath,
    ['apps/simulator/dist/hosted-operation.js'],
    { ...worldEnv, SIMULATOR_AUTORUN: '0' },
    false,
    true,
  );
  const ready = await waitForWorldReady(child, env.SIMULATOR_WORLD_RUN_ID, processes.signal);
  if (processes.stopping) return;
  console.log(
    JSON.stringify({
      event: 'world_ready',
      runId: ready.runId,
      paused: ready.paused,
      pending: ready.pending,
      supervisorPid: process.pid,
      worldPid: child.pid,
    }),
  );
  return ready;
}

export async function superviseRuntime(env = process.env) {
  const refused = refusedOwnerConnection(env);
  if (refused.length) {
    console.error(
      JSON.stringify({
        event: 'owner_connection_refused',
        variables: refused,
        message:
          "The image does not start with the database owner's connection. Only migrations and the setup commands " +
          'use it: keep it in ledger-owner.env, which the ledger service is never given (docs/guides/deploy.md).',
      }),
    );
    return 1;
  }
  const mode = simulatorRuntimeMode(env);
  const processes = createRuntimeProcesses({ env: withoutOwnerConnection(env) });
  let phase = 'fixed_mqtt';
  const stop = () => void processes.stop();
  const resume = () => {
    if (processes.resumeWorld())
      console.log(JSON.stringify({ event: 'world_resume_requested', runId: env.SIMULATOR_WORLD_RUN_ID }));
    else console.error(JSON.stringify({ event: 'world_resume_unavailable' }));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGUSR2', resume);
  try {
    if (env.DJI_MQTT_ENABLED === '1') {
      const broker = await prepareBroker(env);
      if (processes.stopping) return await processes.closed;
      processes.start('mqtt', broker.file, broker.args, {}, false);
      await waitForBroker(broker.bindings[0], { signal: processes.signal });
      console.log(
        JSON.stringify({ event: 'mqtt_ready', version: '2.0.22', listener: '127.0.0.1:1883', uid: process.getuid() }),
      );
    }
    if (processes.stopping) return await processes.closed;
    phase = 'dependency_readiness';
    await startCoreServices(processes, waitForHttpReady, { emulators: emulatorsRequested(env) });
    if (processes.stopping) return await processes.closed;
    console.log(JSON.stringify({ event: 'runtime_dependencies_ready', supervisorPid: process.pid }));
    if (adapterRequested(env))
      processes.start('adapter', process.execPath, ['apps/adapter-host/dist/main.js'], adapterEnvironment(env), false);
    phase = 'simulator';
    if (mode === 'trickle')
      processes.start('simulator', process.execPath, ['apps/simulator/dist/trickle.js'], {
        SIMULATOR_AUTORUN: '1',
        LEDGER_API_URL: 'http://127.0.0.1:4000',
        EMULATOR_BASE_URL: 'http://127.0.0.1:4002',
      });
    if (mode === 'world') await startHostedWorld(processes, env);
    return await processes.closed;
  } catch (error) {
    if (!processes.stopping)
      console.error(
        JSON.stringify({
          event: 'runtime_start_failed',
          phase,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
    return await processes.stop(processes.stopping ? 0 : 1);
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('SIGUSR2', resume);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await superviseRuntime();
