import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FindingsByMonthQuerySchema,
  ReportIndicatorParamsSchema,
  ReportMonthQuerySchema,
  ReportPeriodQuerySchema,
  type FindingsByMonthQuery,
  type ReportIndicatorParams,
  type ReportMonthQuery,
  type ReportPeriodQuery,
} from '@ledger/contracts';
import {
  getFindingsByMonth,
  getFlightTimeByAircraft,
  getIndicatorHistory,
  getOccurrencesByMonth,
  getPeriodSummary,
  listReportIndicators,
} from '@ledger/domain';
import { withScope, type AuthContext, type Pool, type PoolClient } from '@ledger/persistence';

/** The paths of the reports: reads only, each counted by the database under the reader's own scope. */
export const REPORT_PATHS = [
  '/v1/reports/summary',
  '/v1/reports/findings-by-month',
  '/v1/reports/indicators',
  '/v1/reports/indicators/:indicatorId/versions/:version',
  '/v1/reports/flight-time',
  '/v1/reports/occurrences',
] as const;

/**
 * A summary of a period, findings per month by rule, indicators over time, and a month's flight time by aircraft and
 * occurrences (docs/design/reports.md).
 */
export function registerReportRoutes(
  app: FastifyInstance,
  options: { pool: Pool; principal: (request: FastifyRequest) => AuthContext },
): void {
  const { pool, principal } = options;
  // The summary checks each part's capability itself, so a reader of one part is not refused the whole page.
  const read = <T>(
    request: FastifyRequest,
    capability: string | undefined,
    operation: (client: PoolClient, who: AuthContext) => Promise<T>,
  ) => withScope(pool, principal(request), operation, capability, true);
  app.get<{ Querystring: ReportPeriodQuery }>(
    REPORT_PATHS[0],
    { schema: { querystring: ReportPeriodQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, undefined, (client, who) => getPeriodSummary(client, who, request.query));
    },
  );
  app.get<{ Querystring: FindingsByMonthQuery }>(
    REPORT_PATHS[1],
    { schema: { querystring: FindingsByMonthQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => getFindingsByMonth(client, who, request.query));
    },
  );
  app.get(REPORT_PATHS[2], async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return read(request, 'evidence:read', (client, who) => listReportIndicators(client, who));
  });
  app.get<{ Params: ReportIndicatorParams }>(
    REPORT_PATHS[3],
    { schema: { params: ReportIndicatorParamsSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) =>
        getIndicatorHistory(client, who, request.params.indicatorId, Number(request.params.version)),
      );
    },
  );
  // Like the summary, each of these names its part as not the reader's own instead of refusing the page.
  app.get<{ Querystring: ReportMonthQuery }>(
    REPORT_PATHS[4],
    { schema: { querystring: ReportMonthQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, undefined, (client, who) => getFlightTimeByAircraft(client, who, request.query));
    },
  );
  app.get<{ Querystring: ReportMonthQuery }>(
    REPORT_PATHS[5],
    { schema: { querystring: ReportMonthQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, undefined, (client, who) => getOccurrencesByMonth(client, who, request.query));
    },
  );
}
