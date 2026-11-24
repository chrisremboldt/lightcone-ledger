import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Value } from '@sinclair/typebox/value';
import {
  FLIGHT_PREDEPARTURE_LIMITS,
  FlightPredepartureConfigSchema,
  FlightPredepartureProgressSchema,
  FlightMissionParamsSchema,
  type FlightPredepartureConfig,
  type FlightPredepartureProgress,
  type FlightMissionParams,
} from '@ledger/contracts';
import { getFlightPredeparture, getFlightPredepartureProgress, recordFlightPredepartureProgress } from '@ledger/domain';
import { idempotent, withScope, type AuthContext, type Pool } from '@ledger/persistence';

export function flightPredepartureConfiguration(value: unknown): FlightPredepartureConfig | undefined {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > FLIGHT_PREDEPARTURE_LIMITS.bodyBytes)
      throw new Error('LEDGER_FLIGHT_PREDEPARTURE exceeds its configuration bound');
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('LEDGER_FLIGHT_PREDEPARTURE requires closed JSON configuration');
    }
  }
  if (
    !Value.Check(FlightPredepartureConfigSchema, parsed) ||
    new Set(parsed.tenants.map((row) => row.tenantId)).size !== parsed.tenants.length
  )
    throw new Error('LEDGER_FLIGHT_PREDEPARTURE requires unique exact tenant and source identities');
  return structuredClone(parsed);
}
export function registerFlightPredepartureRoutes(
  app: FastifyInstance,
  {
    pool,
    principal,
    config,
  }: { pool: Pool; principal: (request: FastifyRequest) => AuthContext; config?: FlightPredepartureConfig },
): void {
  app.get<{ Params: FlightMissionParams }>(
    '/v1/flights/:id/predeparture',
    { schema: { params: FlightMissionParamsSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => getFlightPredeparture(client, who, request.params.id, config),
        'flight:read',
        true,
      );
    },
  );
  app.post<{ Params: FlightMissionParams; Body: FlightPredepartureProgress }>(
    '/v1/flights/:id/predeparture/progress',
    {
      bodyLimit: FLIGHT_PREDEPARTURE_LIMITS.bodyBytes,
      schema: { params: FlightMissionParamsSchema, body: FlightPredepartureProgressSchema },
    },
    async (request, reply) => {
      const response = await withScope(
        pool,
        principal(request),
        async (client, who) => {
          const accepted = await idempotent(
            client,
            who,
            `/v1/flights/${encodeURIComponent(request.params.id)}/predeparture/progress`,
            String(request.headers['idempotency-key'] ?? ''),
            request.body,
            async () => {
              const id = await recordFlightPredepartureProgress(client, who, request.params.id, request.body, config);
              return { id, value: await getFlightPredepartureProgress(client, who, request.params.id, id) };
            },
            (id) => getFlightPredepartureProgress(client, who, request.params.id, id),
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
