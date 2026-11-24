import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import {
  RecordProductionCreateSchema,
  RecordProductionParamsSchema,
  RecordProductionQuerySchema,
  type RecordProductionCreate,
  type RecordProductionParams,
  type RecordProductionQuery,
} from '@ledger/contracts';
import {
  createRecordProduction,
  getRecordProduction,
  getRecordProductionContent,
  listRecordProductions,
} from '@ledger/evidence';
import { idempotent, withScope, type AuthContext, type ObjectStore, type Pool } from '@ledger/persistence';

/** A route schema with the summary and description the API reference shows. */
const documented = (schema: FastifySchema & { summary: string; description: string }): FastifySchema => schema;

interface RecordProductionRouteOptions {
  pool: Pool;
  store: ObjectStore;
  principal: (request: FastifyRequest) => AuthContext;
  key: (request: FastifyRequest) => string;
  boundedOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

const ENDPOINT = '/v1/record-productions';

/** Producing records on request: a recorded command, its list, and the kept file. */
export function registerRecordProductionRoutes(app: FastifyInstance, options: RecordProductionRouteOptions): void {
  const { pool, store, principal, key, boundedOperation } = options;
  app.post<{ Body: RecordProductionCreate }>(
    ENDPOINT,
    {
      schema: documented({
        summary: 'Produce records on request',
        description:
          'Produces the records chosen by subjects, record types and dates as one .zip: a CSV per record type in the import template’s columns with when and by whom each record was recorded and what replaced it, a printable index.html, and manifest.json with the SHA-256 of every file. Original files are listed, and included when asked. Safety reports and restricted attachments are never included. Recorded as a journal event with the reason and who asked. Requires evidence:read and an Idempotency-Key.',
        body: RecordProductionCreateSchema,
      }),
    },
    async (request, reply) => {
      const accepted = await boundedOperation(() =>
        withScope(
          pool,
          principal(request),
          async (client, who) =>
            idempotent(
              client,
              who,
              ENDPOINT,
              key(request),
              request.body,
              async () => {
                const record = await createRecordProduction(client, who, request.body, store, key(request));
                return { id: record.id, value: record };
              },
              (id) => getRecordProduction(client, who, id),
            ),
          'evidence:read',
        ),
      );
      return reply.code(201).send({ record: accepted.value });
    },
  );
  app.get<{ Querystring: RecordProductionQuery }>(
    ENDPOINT,
    {
      schema: documented({
        summary: 'List produced records',
        description:
          'Every production of records, newest first: who produced it, when, why, who asked and the selection. Requires evidence:read.',
        querystring: RecordProductionQuerySchema,
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => listRecordProductions(client, who, request.query),
        'evidence:read',
        true,
      );
    },
  );
  app.get<{ Params: RecordProductionParams }>(
    `${ENDPOINT}/:id`,
    {
      schema: documented({
        summary: 'Read one production of records',
        description:
          'Who produced the file, when, why, who asked, the selection, the counts and the digests to keep. Requires evidence:read.',
        params: RecordProductionParamsSchema,
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        async (client, who) => ({ record: await getRecordProduction(client, who, request.params.id) }),
        'evidence:read',
        true,
      );
    },
  );
  app.get<{ Params: RecordProductionParams }>(
    `${ENDPOINT}/:id/content`,
    {
      schema: documented({
        summary: 'Download a production of records',
        description:
          'The kept .zip, checked against its recorded SHA-256 before it is sent. X-Manifest-SHA256 is the digest of manifest.json to keep apart and verify with. Requires evidence:read.',
        params: RecordProductionParamsSchema,
      }),
    },
    async (request, reply) =>
      boundedOperation(async () => {
        const { record, bytes } = await withScope(
          pool,
          principal(request),
          (client, who) => getRecordProductionContent(client, who, request.params.id, store),
          'evidence:read',
          true,
        );
        return reply
          .type('application/zip')
          .header('X-Evidence-Format', record.format)
          .header('X-Content-SHA256', record.archiveSha256)
          .header('X-Manifest-SHA256', record.manifestSha256)
          .header('Cache-Control', 'private, no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Disposition',
            `attachment; filename="records-${record.producedAt.slice(0, 10)}-${record.id}.zip"`,
          )
          .send(Buffer.from(bytes));
      }),
  );
}
