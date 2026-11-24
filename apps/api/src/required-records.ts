import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import { adoptedRequiredRecords, recordkeepingPlanDraft } from '@ledger/domain';
import { withScope, type AuthContext, type Pool } from '@ledger/persistence';

/** A route schema with the summary and description the API reference shows. */
const documented = (schema: FastifySchema & { summary: string; description: string }): FastifySchema => schema;

interface RequiredRecordRouteOptions {
  pool: Pool;
  principal: (request: FastifyRequest) => AuthContext;
}

/** The records the adopted packs require, and a recordkeeping plan drafted from them. Reads only. */
export function registerRequiredRecordRoutes(app: FastifyInstance, options: RequiredRecordRouteOptions): void {
  const { pool, principal } = options;
  app.get(
    '/v1/organization/required-records',
    {
      schema: documented({
        summary: 'List the records the adopted rule packs require',
        description:
          'Each record your adopted rule packs say must be kept: the paragraph quoted, who the text says keeps it, the Ledger records that hold it with how many are on file and the earliest and latest time they are about, and the retention in the text’s own words. It never says a requirement is met. Requires evidence:read. Private, no-store.',
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => adoptedRequiredRecords(client, who.tenantId),
        'evidence:read',
        true,
      );
    },
  );
  app.get(
    '/v1/organization/recordkeeping-plan/draft',
    {
      schema: documented({
        summary: 'Draft a recordkeeping plan from the required records',
        description:
          'A recordkeeping plan drafted from the required records as read now: a controlled document body of the recordkeeping plan type, ready to open with sms.record.open, and the blanks only your organization can fill. Records nothing. Requires evidence:read. Private, no-store.',
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        async (client, who) => recordkeepingPlanDraft(await adoptedRequiredRecords(client, who.tenantId)),
        'evidence:read',
        true,
      );
    },
  );
}
