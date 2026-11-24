import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import {
  RecordSubjectParamsSchema,
  RecordSubjectQuerySchema,
  RecordSubjectsQuerySchema,
  type RecordSubjectParams,
  type RecordSubjectQuery,
  type RecordSubjectsQuery,
} from '@ledger/contracts';
import { getRecordSubjectFile, listRecordSubjects } from '@ledger/domain';
import { withScope, type AuthContext, type Pool } from '@ledger/persistence';

/** A route schema with the summary and description the API reference shows. */
const documented = (schema: FastifySchema & { summary: string; description: string }): FastifySchema => schema;

interface RecordSubjectRouteOptions {
  pool: Pool;
  principal: (request: FastifyRequest) => AuthContext;
}

/** The organization's subjects as its records show them, and one subject's file. Reads only. */
export function registerRecordSubjectRoutes(app: FastifyInstance, options: RecordSubjectRouteOptions): void {
  const { pool, principal } = options;
  app.get<{ Querystring: RecordSubjectsQuery }>(
    '/v1/operator-records/subjects',
    {
      schema: documented({
        summary: 'List the subjects your records are about',
        description:
          'People, aircraft, flights, sites or components of one kind that your records are about, by your own id, with the name the latest personnel file, aircraft identity or flight plan gives each, how many records are about it and how many findings about it are open. Requires evidence:read. Private, no-store.',
        querystring: RecordSubjectsQuerySchema,
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => listRecordSubjects(client, who, request.query),
        'evidence:read',
        true,
      );
    },
  );
  app.get<{ Params: RecordSubjectParams; Querystring: RecordSubjectQuery }>(
    '/v1/operator-records/subjects/:kind/:id',
    {
      schema: documented({
        summary: 'Read one subject’s file',
        description:
          'Every record about one subject, grouped by record type with what replaced what, the rules that have evaluated it with the latest result of each, and its open findings. The id is your own id for the subject; for your own organization, use the organization id. Requires evidence:read. Private, no-store.',
        params: RecordSubjectParamsSchema,
        querystring: RecordSubjectQuerySchema,
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => getRecordSubjectFile(client, who, request.params.kind, request.params.id, request.query),
        'evidence:read',
        true,
      );
    },
  );
}
