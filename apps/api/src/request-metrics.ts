import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerPoolMetrics, type MetricsRegistry, type PoolFigures } from '@ledger/metrics';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * The route a request is counted under: the template it matched (`/v1/flights/:id`), never its path, which holds ids.
 * A request that matched no route is counted as `unmatched`.
 */
export function routeLabel(request: FastifyRequest): string {
  return request.routeOptions?.url ?? 'unmatched';
}

function methodLabel(method: string): string {
  return METHODS.has(method) ? method : 'OTHER';
}

export interface ApiMetrics {
  /** A request refused for being over its credential's limit, by the kind of credential. */
  limited(kind: string): void;
}

/** Counts the API's requests by method, route template and status class, with their durations. */
export function instrumentRequests(app: FastifyInstance, registry: MetricsRegistry, pool: PoolFigures): ApiMetrics {
  const requests = registry.counter('ledger_http_requests_total', 'Requests answered, by route template.', [
    'method',
    'route',
    'status_class',
  ]);
  const durations = registry.histogram(
    'ledger_http_request_duration_seconds',
    'How long requests took to answer, by route template. A live feed counts once, when it closes.',
    ['method', 'route', 'status_class'],
    DURATION_BUCKETS,
  );
  const limited = registry.counter(
    'ledger_http_requests_limited_total',
    'Requests refused with 429 because their credential was over its limit, by kind of credential.',
    ['kind'],
  );
  const observations = registry.counter(
    'ledger_observations_total',
    'Observations sent to the API: accepted (or an accepted one sent again), refused as they were, or failed.',
    ['outcome'],
  );
  for (const outcome of ['accepted', 'refused', 'failed']) observations.inc({ outcome }, 0);
  registerPoolMetrics(registry, 'api', pool);
  app.addHook('onResponse', async (request, reply) => {
    const labels = {
      method: methodLabel(request.method),
      route: routeLabel(request),
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    };
    requests.inc(labels);
    durations.observe(labels, reply.elapsedTime / 1000);
    if (labels.route === '/v1/inputs' && labels.method === 'POST' && isObservation(request.body))
      observations.inc({
        outcome: reply.statusCode < 300 ? 'accepted' : reply.statusCode < 500 ? 'refused' : 'failed',
      });
  });
  return { limited: (kind) => limited.inc({ kind }) };
}

function isObservation(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'observation';
}
