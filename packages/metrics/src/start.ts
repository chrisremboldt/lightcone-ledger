import { registerProcessMetrics } from './collectors.js';
import { MetricsRegistry } from './registry.js';
import { metricsListen, refuseSharedPort, serveMetrics, type MetricsServer } from './server.js';

export interface RunningMetrics {
  readonly registry: MetricsRegistry;
  readonly server: MetricsServer;
}

/**
 * Starts the process's metrics listener when `LEDGER_METRICS_LISTEN` names one; undefined when it is unset, and the
 * process then measures nothing. `servicePort` is the port the process serves the API on, which the metrics may not
 * share.
 */
export async function startMetrics(
  env: NodeJS.ProcessEnv,
  options: { servicePort?: number } = {},
): Promise<RunningMetrics | undefined> {
  const listen = metricsListen(env.LEDGER_METRICS_LISTEN);
  if (!listen) return undefined;
  if (options.servicePort !== undefined) refuseSharedPort(listen, options.servicePort);
  const registry = new MetricsRegistry();
  registerProcessMetrics(registry);
  return { registry, server: await serveMetrics(registry, listen) };
}
