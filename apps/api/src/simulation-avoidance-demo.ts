import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import {
  HazardParamsSchema,
  SIMULATION_AVOIDANCE_DEMO_LIMITS,
  SimulationAvoidanceDemoConfigSchema,
  SimulationAvoidanceDemoControlQuerySchema,
  SimulationAvoidanceDemoParamsSchema,
  SimulationAvoidanceDemoPrepareSchema,
  SimulationAvoidanceDemoProgressSchema,
  SimulationAvoidanceDemoQuerySchema,
  SimulationAvoidanceDemoPreparationQuerySchema,
  type HazardParams,
  type SimulationAvoidanceDemoConfig,
  type SimulationAvoidanceDemoControlQuery,
  type SimulationAvoidanceDemoParams,
  type SimulationAvoidanceDemoPrepare,
  type SimulationAvoidanceDemoProgress,
  type SimulationAvoidanceDemoQuery,
  type SimulationAvoidanceDemoPreparationQuery,
} from '@ledger/contracts';
import {
  getHazardSimulationAvoidanceDemos,
  getSimulationAvoidanceDemo,
  getSimulationAvoidanceDemoProgress,
  getSimulationAvoidanceDemoRequests,
  getSimulationAvoidanceDemoPreparationContext,
  prepareSimulationAvoidanceDemo,
  recordSimulationAvoidanceDemoProgress,
} from '@ledger/domain';
import { idempotent, withScope, type AuthContext, type Pool } from '@ledger/persistence';

export function simulationAvoidanceDemoConfiguration(value: unknown): SimulationAvoidanceDemoConfig | undefined {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > SIMULATION_AVOIDANCE_DEMO_LIMITS.bodyBytes)
      throw new Error('LEDGER_SIMULATION_AVOIDANCE_DEMO exceeds its configuration bound');
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('LEDGER_SIMULATION_AVOIDANCE_DEMO requires closed JSON configuration');
    }
  }
  if (
    !Value.Check(SimulationAvoidanceDemoConfigSchema, parsed) ||
    new Set(parsed.tenants.map((row) => row.tenantId)).size !== parsed.tenants.length
  )
    throw new Error('LEDGER_SIMULATION_AVOIDANCE_DEMO requires unique exact tenant and source identities');
  return structuredClone(parsed);
}

export function registerSimulationAvoidanceDemoRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    principal: (request: FastifyRequest) => AuthContext;
    config?: SimulationAvoidanceDemoConfig;
  },
): void {
  const { pool, principal, config } = dependencies;
  const key = (request: FastifyRequest) => String(request.headers['idempotency-key'] ?? '');
  const privateRead = <T>(request: FastifyRequest, operation: Parameters<typeof withScope<T>>[2]) =>
    withScope(pool, principal(request), operation, 'flight:read', true);
  app.get<{ Params: HazardParams; Querystring: SimulationAvoidanceDemoControlQuery }>(
    '/v1/hazards/:id/avoidance-demos',
    { schema: { params: HazardParamsSchema, querystring: SimulationAvoidanceDemoControlQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return privateRead(request, (client, who) =>
        getHazardSimulationAvoidanceDemos(client, who, request.params.id, request.query, config),
      );
    },
  );
  app.get<{ Querystring: SimulationAvoidanceDemoQuery }>(
    '/v1/simulation/avoidance-demos/requests',
    { schema: { querystring: SimulationAvoidanceDemoQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return privateRead(request, (client, who) =>
        getSimulationAvoidanceDemoRequests(client, who, request.query, config),
      );
    },
  );
  app.get<{ Params: SimulationAvoidanceDemoParams }>(
    '/v1/simulation/avoidance-demos/:cycleId',
    { schema: { params: SimulationAvoidanceDemoParamsSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return privateRead(request, (client, who) =>
        getSimulationAvoidanceDemo(client, who, request.params.cycleId, config),
      );
    },
  );
  app.post<{ Params: SimulationAvoidanceDemoParams; Body: SimulationAvoidanceDemoPreparationQuery }>(
    '/v1/simulation/avoidance-demos/:cycleId/preparation-context',
    {
      bodyLimit: SIMULATION_AVOIDANCE_DEMO_LIMITS.bodyBytes,
      schema: { params: SimulationAvoidanceDemoParamsSchema, body: SimulationAvoidanceDemoPreparationQuerySchema },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return privateRead(request, (client, who) =>
        getSimulationAvoidanceDemoPreparationContext(client, who, request.params.cycleId, request.body, config),
      );
    },
  );
  app.post<{ Params: HazardParams; Body: SimulationAvoidanceDemoPrepare }>(
    '/v1/hazards/:id/avoidance-demos',
    {
      bodyLimit: SIMULATION_AVOIDANCE_DEMO_LIMITS.bodyBytes,
      schema: { params: HazardParamsSchema, body: SimulationAvoidanceDemoPrepareSchema },
    },
    async (request, reply) => {
      const response = await withScope(
        pool,
        principal(request),
        async (client, who) => {
          const accepted = await idempotent(
            client,
            who,
            `/v1/hazards/${encodeURIComponent(request.params.id)}/avoidance-demos`,
            key(request),
            request.body,
            async () => {
              const id = await prepareSimulationAvoidanceDemo(client, who, request.params.id, request.body, config);
              return { id, value: await getSimulationAvoidanceDemo(client, who, id, config) };
            },
            (id) => getSimulationAvoidanceDemo(client, who, id, config),
          );
          return accepted.value;
        },
        'flight:read',
      );
      reply.header('Cache-Control', 'private, no-store');
      return reply.code(201).send(response);
    },
  );
  app.post<{ Params: SimulationAvoidanceDemoParams; Body: SimulationAvoidanceDemoProgress }>(
    '/v1/simulation/avoidance-demos/:cycleId/progress',
    {
      bodyLimit: SIMULATION_AVOIDANCE_DEMO_LIMITS.bodyBytes,
      schema: { params: SimulationAvoidanceDemoParamsSchema, body: SimulationAvoidanceDemoProgressSchema },
    },
    async (request, reply) => {
      const response = await withScope(
        pool,
        principal(request),
        async (client, who) => {
          const accepted = await idempotent(
            client,
            who,
            `/v1/simulation/avoidance-demos/${request.params.cycleId}/progress`,
            key(request),
            request.body,
            async () => {
              const id = await recordSimulationAvoidanceDemoProgress(
                client,
                who,
                request.params.cycleId,
                request.body,
                config,
              );
              return { id, value: await getSimulationAvoidanceDemoProgress(client, who, request.params.cycleId, id) };
            },
            (id) => getSimulationAvoidanceDemoProgress(client, who, request.params.cycleId, id),
          );
          return accepted.value;
        },
        'flight:read',
      );
      reply.header('Cache-Control', 'private, no-store');
      return reply.code(201).send(response);
    },
  );
}
