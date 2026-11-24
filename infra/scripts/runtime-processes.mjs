import { spawn } from 'node:child_process';
import { isWorldReady, isWorldStopped } from './runtime-readiness.mjs';

function running(record) {
  return !record.exited;
}

async function waitForExit(records, timeoutMs) {
  if (records.every((record) => !running(record))) return true;
  let timer;
  try {
    return await Promise.race([
      Promise.all(records.map((record) => record.done)).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRuntimeProcesses({
  spawnProcess = spawn,
  env = process.env,
  log = (event) => console.error(JSON.stringify(event)),
  worldDrainMs = 90_000,
  serviceDrainMs = 10_000,
  brokerDrainMs = 5_000,
  // Longer than the adapter process's own shutdown wait, so it can submit what it holds while the API still runs.
  adapterDrainMs = 15_000,
} = {}) {
  const records = [];
  let stopping = false;
  let shutdown;
  let exitCode = 0;
  const controller = new AbortController();
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function signal(records, selectedSignal) {
    for (const record of records.filter(running)) {
      try {
        record.requestedSignal = selectedSignal;
        record.child.kill(selectedSignal);
      } catch {
        exitCode = 1;
        log({ event: 'process_signal_failed', process: record.name, signal: selectedSignal });
      }
    }
  }

  function requestWorldStop(record) {
    if (!record.world || !record.child.connected) {
      signal([record], 'SIGTERM');
      return;
    }
    try {
      record.child.send({ event: 'operation_world_stop', runId: env.SIMULATOR_WORLD_RUN_ID }, (error) => {
        if (error && running(record)) signal([record], 'SIGTERM');
      });
    } catch {
      signal([record], 'SIGTERM');
    }
  }

  async function drain(group, timeoutMs) {
    const selected = records.filter((record) => record.group === group && running(record));
    if (!selected.length) return;
    if (group === 'generator') for (const record of selected) requestWorldStop(record);
    else signal(selected, 'SIGTERM');
    if (await waitForExit(selected, timeoutMs)) return;
    exitCode = 1;
    log({ event: 'process_drain_timeout', processes: selected.filter(running).map((record) => record.name) });
    signal(selected, 'SIGKILL');
    await waitForExit(selected, 1_000);
  }

  function stop(code = 0) {
    if (code) exitCode = code;
    if (shutdown) return shutdown;
    stopping = true;
    controller.abort();
    shutdown = (async () => {
      await drain('generator', worldDrainMs);
      await drain('adapter', adapterDrainMs);
      await drain('service', serviceDrainMs);
      await drain('broker', brokerDrainMs);
      resolveClosed(exitCode);
      return exitCode;
    })();
    return shutdown;
  }

  return {
    closed,
    stop,
    signal: controller.signal,
    get stopping() {
      return stopping;
    },
    resumeWorld() {
      const record = records.find((record) => record.world && record.ready && running(record));
      if (stopping || !record?.child.connected) return false;
      try {
        record.child.send({ event: 'operation_world_resume', runId: env.SIMULATOR_WORLD_RUN_ID }, (error) => {
          if (error && running(record)) void stop(1);
        });
        return true;
      } catch {
        void stop(1);
        return false;
      }
    },
    start(name, file, args, vars = {}, inherit = true, ipc = false) {
      if (stopping) throw new Error('Runtime is stopping');
      const child = spawnProcess(file, args, {
        env: inherit ? { ...env, ...vars } : vars,
        stdio: ipc ? ['ignore', 'inherit', 'inherit', 'ipc'] : 'inherit',
      });
      let resolveDone;
      const record = {
        name,
        child,
        group: ['world', 'simulator'].includes(name)
          ? 'generator'
          : name === 'adapter'
            ? 'adapter'
            : name.endsWith('mqtt')
              ? 'broker'
              : 'service',
        exited: false,
        requestedSignal: null,
        world: name === 'world' && ipc,
        ready: false,
        stopReport: null,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
      records.push(record);
      function exited(code, selectedSignal) {
        if (record.exited) return;
        record.exited = true;
        resolveDone();
        if (
          stopping &&
          (code ||
            (record.world ? !record.stopReport?.drained : !record.requestedSignal) ||
            (selectedSignal && selectedSignal !== record.requestedSignal))
        )
          exitCode ||= code || 1;
        // An adapter that stops (a refused credential, an unreadable source) says why in its own log; the API and
        // the workers keep running without it.
        if (!stopping && record.group === 'adapter')
          log({ event: 'adapter_exit', process: name, code, signal: selectedSignal });
        else if (!stopping) {
          log({ event: 'process_exit', process: name, code, signal: selectedSignal });
          void stop(code || 1);
        }
      }
      child.once('exit', exited);
      child.once('error', () => exited(1, null));
      if (record.world) {
        child.on('message', (value) => {
          if (isWorldReady(value, env.SIMULATOR_WORLD_RUN_ID)) {
            if (!stopping) record.ready = true;
            else if (running(record) && !record.stopReport) requestWorldStop(record);
          }
          if (!record.stopReport && isWorldStopped(value, env.SIMULATOR_WORLD_RUN_ID)) {
            record.stopReport = { pending: value.pending, drained: value.drained };
            if (!value.drained) exitCode ||= 1;
            log({ event: 'world_stop_report', runId: value.runId, ...record.stopReport });
          }
        });
        child.once('disconnect', () => {
          if (!running(record) || record.stopReport) return;
          if (stopping) signal([record], 'SIGTERM');
          else void stop(1);
        });
      }
      return child;
    },
  };
}
