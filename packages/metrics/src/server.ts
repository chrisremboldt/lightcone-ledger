import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MetricsRegistry } from './registry.js';

export interface MetricsListen {
  host: string;
  port: number;
}

/**
 * Where the metrics listener listens, from `LEDGER_METRICS_LISTEN`: a port alone (loopback), or `host:port`
 * (`[address]:port` for IPv6). Undefined when it is unset or empty: the metrics are off.
 */
export function metricsListen(value: string | undefined): MetricsListen | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const match = /^(?:(\[[0-9a-fA-F:.]+\]|[^:[\]]+):)?(\d{1,5})$/.exec(text);
  const port = match ? Number(match[2]) : NaN;
  if (!match || !(port >= 0 && port <= 65535))
    throw new Error(
      `LEDGER_METRICS_LISTEN must be a port (9464) or an address and a port (127.0.0.1:9464); it is ${text}`,
    );
  const host = match[1]?.replace(/^\[|\]$/g, '') ?? '127.0.0.1';
  return { host, port };
}

/** Refuses a metrics port that is the port serving the API and the web app, so a proxy cannot publish it with them. */
export function refuseSharedPort(listen: MetricsListen | undefined, servicePort: number): void {
  if (listen && listen.port !== 0 && listen.port === servicePort)
    throw new Error(
      `LEDGER_METRICS_LISTEN names port ${listen.port}, which serves the API; give the metrics a port of their own`,
    );
}

export interface MetricsServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Serves `GET /metrics` on a listener of its own, and nothing else. */
export async function serveMetrics(registry: MetricsRegistry, listen: MetricsListen): Promise<MetricsServer> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== '/metrics' || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response
        .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Only GET /metrics is served here\n');
      return;
    }
    registry.render().then(
      (text) => {
        response.writeHead(200, { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : text);
      },
      () => response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Metrics unavailable\n'),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    host: address.address,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
