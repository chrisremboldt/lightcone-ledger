import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  HazardMonitoringHistoryQuerySchema,
  HazardParamsSchema,
  type HazardMonitoringHistoryQuery,
  type HazardParams,
} from '@ledger/contracts';
import { getHazardMonitoringHistory } from '@ledger/domain';
import { withScope, type AuthContext, type Pool } from '@ledger/persistence';

export function registerAssuranceHistoryRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    principal: (request: FastifyRequest) => AuthContext;
  },
): void {
  const { pool, principal } = dependencies;
  app.get<{ Params: HazardParams; Querystring: HazardMonitoringHistoryQuery }>(
    '/v1/hazards/:id/monitoring-windows',
    { schema: { params: HazardParamsSchema, querystring: HazardMonitoringHistoryQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => getHazardMonitoringHistory(client, who, request.params.id, request.query),
        'flight:read',
        true,
      );
    },
  );
}
