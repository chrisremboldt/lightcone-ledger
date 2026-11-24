import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  OPERATOR_RECORD_SOURCE_ID,
  OperatorRecordImportRequestSchema,
  OperatorRecordQuerySchema,
  OperatorRecordTemplateParamsSchema,
  OperatorRecordTemplateQuerySchema,
  recordCsvTemplate,
  recordJsonTemplate,
  type OperatorRecordImportRequest,
  type OperatorRecordQuery,
  type OperatorRecordTemplateParams,
  type OperatorRecordTemplateQuery,
} from '@ledger/contracts';
import {
  commitOperatorRecordImport,
  listOperatorRecords,
  listOperatorRecordTypes,
  previewOperatorRecordImport,
  requireOperatorRecordDefinition,
} from '@ledger/domain';
import { withScope, type AuthContext, type ObjectStore, type Pool } from '@ledger/persistence';

interface OperatorRecordRouteOptions {
  pool: Pool;
  store: ObjectStore;
  principal: (request: FastifyRequest) => AuthContext;
}

const privately = {
  async onSend(
    _request: FastifyRequest,
    reply: { header: (name: string, value: string) => unknown },
    payload: unknown,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  },
};

/** Import, entry and reading of operator records. Every write goes through generic observation intake. */
export function registerOperatorRecordRoutes(app: FastifyInstance, options: OperatorRecordRouteOptions): void {
  const { pool, store, principal } = options;
  app.get('/v1/operator-records/types', async (request) =>
    withScope(
      pool,
      principal(request),
      async () => ({ types: listOperatorRecordTypes(), sourceId: OPERATOR_RECORD_SOURCE_ID }),
      'evidence:read',
    ),
  );
  app.get<{ Params: OperatorRecordTemplateParams; Querystring: OperatorRecordTemplateQuery }>(
    '/v1/operator-records/types/:recordType/versions/:version/template',
    { schema: { params: OperatorRecordTemplateParamsSchema, querystring: OperatorRecordTemplateQuerySchema } },
    async (request, reply) => {
      const definition = await withScope(
        pool,
        principal(request),
        async () => requireOperatorRecordDefinition(request.params.recordType, Number(request.params.version)),
        'evidence:read',
      );
      const json = request.query.format === 'json';
      return reply
        .type(json ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
        .header(
          'Content-Disposition',
          `attachment; filename="${definition.recordType}-v${definition.recordVersion}.${json ? 'json' : 'csv'}"`,
        )
        .header('X-Content-Type-Options', 'nosniff')
        .send(json ? recordJsonTemplate(definition) : recordCsvTemplate(definition));
    },
  );
  app.post<{ Body: OperatorRecordImportRequest }>(
    '/v1/operator-records/imports/preview',
    { schema: { body: OperatorRecordImportRequestSchema }, ...privately },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => previewOperatorRecordImport(client, who, store, request.body),
        'input:write',
        true,
      ),
  );
  app.post<{ Body: OperatorRecordImportRequest }>(
    '/v1/operator-records/imports',
    { schema: { body: OperatorRecordImportRequestSchema }, ...privately },
    async (request, reply) => {
      const result = await withScope(
        pool,
        principal(request),
        (client, who) => commitOperatorRecordImport(client, who, store, request.body),
        'input:write',
      );
      // 201 only when the commit created a record; a file whose every row was refused or already recorded creates none.
      return reply.code(result.summary.recorded > 0 ? 201 : 200).send(result);
    },
  );
  app.get<{ Querystring: OperatorRecordQuery }>(
    '/v1/operator-records',
    { schema: { querystring: OperatorRecordQuerySchema }, ...privately },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => listOperatorRecords(client, who, request.query),
        'evidence:read',
        true,
      ),
  );
}
