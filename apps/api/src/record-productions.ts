import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';
import {
  RecordLinkCreateSchema,
  RecordLinkParamsSchema,
  RecordLinkRevokeSchema,
  SharedRecordsFileRequestSchema,
  SharedRecordsRequestSchema,
  type RecordLinkCreate,
  type RecordLinkParams,
  type RecordLinkRevoke,
  type SharedRecordsFileRequest,
  type SharedRecordsRequest,
  RecordProductionCreateSchema,
  RecordProductionParamsSchema,
  RecordProductionQuerySchema,
  type RecordProductionCreate,
  type RecordProductionParams,
  type RecordProductionQuery,
} from '@ledger/contracts';
import {
  createRecordLink,
  createRecordProduction,
  getRecordProduction,
  getRecordProductionContent,
  listRecordLinks,
  listRecordProductions,
  openSharedRecords,
  openSharedRecordsArchive,
  openSharedRecordsFile,
  revokeRecordLink,
} from '@ledger/evidence';
import { DomainError, idempotent, withScope, type AuthContext, type ObjectStore, type Pool } from '@ledger/persistence';

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
const SHARED = '/v1/shared-records';

/**
 * The routes the page of a link reads, without signing in. Each takes the link's secret in its body, so the secret is
 * in no address and no log line.
 */
export const SHARED_RECORDS_PATHS: readonly string[] = [SHARED, `${SHARED}/file`, `${SHARED}/archive`];

/** What every answer to the page of a link carries: kept by no cache, sent to no other site, listed by no search. */
const sharedHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
} as const;

/** A file name a browser saves safely: the set's own path with its folders flattened. */
/** Sets those headers first, so a refusal carries them as well as an answer. */
const sharedRoute = {
  onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.headers(sharedHeaders);
  },
};

const savedName = (path: string) => path.replace(/[^A-Za-z0-9._@-]+/g, '_');

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

  registerRecordLinkRoutes(app, options);
}

/** Links to one produced set: made, listed and revoked by someone who may produce records, opened without signing in. */
function registerRecordLinkRoutes(app: FastifyInstance, options: RecordProductionRouteOptions): void {
  const { pool, store, principal, key, boundedOperation } = options;
  app.post<{ Params: RecordProductionParams; Body: RecordLinkCreate }>(
    `${ENDPOINT}/:id/links`,
    {
      schema: documented({
        summary: 'Make a link to one produced set',
        description:
          'A link that opens this produced set to someone who does not sign in, until it expires (7 days unless given, 90 at most) or is revoked. Its secret is 256 random bits, returned once; Ledger keeps only its SHA-256. Recorded with who made it and the note. Requires evidence:read and an Idempotency-Key.',
        params: RecordProductionParamsSchema,
        body: RecordLinkCreateSchema,
      }),
    },
    async (request, reply) => {
      const made = await withScope(
        pool,
        principal(request),
        async (client, who) =>
          (
            await idempotent(
              client,
              who,
              `${ENDPOINT}/links`,
              key(request),
              { productionId: request.params.id, ...request.body },
              async () => {
                const value = await createRecordLink(client, who, request.params.id, request.body);
                return { id: value.link.id, value };
              },
              async () => {
                // The secret exists only in the first answer; a retry cannot be shown it again.
                throw new DomainError(
                  409,
                  'record_link_secret_not_repeated',
                  'This link was already made and its secret was shown once. Revoke it and make another.',
                );
              },
            )
          ).value,
        'evidence:read',
      );
      return reply.code(201).header('Cache-Control', 'private, no-store').send(made);
    },
  );
  app.get<{ Params: RecordProductionParams }>(
    `${ENDPOINT}/:id/links`,
    {
      schema: documented({
        summary: 'List the links to one produced set',
        description:
          'Every link made to this set, newest first: who it is for, who made it and when, when it expires, whether it was revoked, by whom and why, and each time it was opened. Never a secret. Requires evidence:read.',
        params: RecordProductionParamsSchema,
      }),
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => listRecordLinks(client, who, request.params.id),
        'evidence:read',
        true,
      );
    },
  );
  app.post<{ Params: RecordLinkParams; Body: RecordLinkRevoke }>(
    '/v1/record-production-links/:id/revoke',
    {
      schema: documented({
        summary: 'Revoke a link to a produced set',
        description:
          'The link opens nothing from now on. Recorded with who revoked it and why. Requires evidence:read.',
        params: RecordLinkParamsSchema,
        body: RecordLinkRevokeSchema,
      }),
    },
    async (request, reply) => {
      const revoked = await withScope(
        pool,
        principal(request),
        (client, who) => revokeRecordLink(client, who, request.params.id, request.body.reason),
        'evidence:read',
      );
      return reply.header('Cache-Control', 'private, no-store').send(revoked);
    },
  );

  app.post<{ Body: SharedRecordsRequest }>(
    SHARED,
    {
      ...sharedRoute,
      schema: documented({
        summary: 'Open the produced set a link opens',
        description:
          'No sign-in: the secret from the link finds the set. The organization’s name, what the set is and its files. Each opening is kept, with its time and nothing about who opened it. Expired, revoked and unknown links all answer 404 record_link_not_in_use.',
        body: SharedRecordsRequestSchema,
      }),
    },
    async (request, reply) => {
      const shown = await boundedOperation(() => openSharedRecords(pool, store, request.body.secret));
      return reply.send(shown);
    },
  );
  app.post<{ Body: SharedRecordsFileRequest }>(
    `${SHARED}/file`,
    {
      ...sharedRoute,
      schema: documented({
        summary: 'Read one file of the set a link opens',
        description:
          'No sign-in. One file of the set by its path, checked against the SHA-256 its manifest lists. The opening is kept.',
        body: SharedRecordsFileRequestSchema,
      }),
    },
    async (request, reply) => {
      const { file, bytes } = await boundedOperation(() =>
        openSharedRecordsFile(pool, store, request.body.secret, request.body.path),
      );
      return reply
        .type(file.contentType)
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
        .header('Content-Disposition', `attachment; filename="${savedName(file.path)}"`)
        .send(bytes);
    },
  );
  app.post<{ Body: SharedRecordsRequest }>(
    `${SHARED}/archive`,
    {
      ...sharedRoute,
      schema: documented({
        summary: 'Download the whole set a link opens',
        description:
          'No sign-in. The kept .zip, checked against its recorded SHA-256. X-Manifest-SHA256 is the digest of manifest.json. The opening is kept.',
        body: SharedRecordsRequestSchema,
      }),
    },
    async (request, reply) => {
      const { production, bytes } = await boundedOperation(() =>
        openSharedRecordsArchive(pool, store, request.body.secret),
      );
      return reply
        .type('application/zip')
        .header('X-Content-SHA256', production.archiveSha256)
        .header('X-Manifest-SHA256', production.manifestSha256)
        .header(
          'Content-Disposition',
          `attachment; filename="records-${production.producedAt.slice(0, 10)}-${production.id}.zip"`,
        )
        .send(Buffer.from(bytes));
    },
  );
}
