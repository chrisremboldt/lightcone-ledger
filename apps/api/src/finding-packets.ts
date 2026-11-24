import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  FindingPacketCreateSchema,
  FindingPacketParamsSchema,
  FindingPacketQuerySchema,
  type FindingPacketCreate,
  type FindingPacketParams,
  type FindingPacketQuery,
} from '@ledger/contracts';
import { createFindingPacket, getFindingPacket, getFindingPacketContent, listFindingPackets } from '@ledger/evidence';
import { idempotent, withScope, type AuthContext, type ObjectStore, type Pool } from '@ledger/persistence';

interface FindingPacketRouteOptions {
  pool: Pool;
  store: ObjectStore;
  principal: (request: FastifyRequest) => AuthContext;
  key: (request: FastifyRequest) => string;
  boundedOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}

export function registerFindingPacketRoutes(app: FastifyInstance, options: FindingPacketRouteOptions): void {
  const { pool, store, principal, key, boundedOperation } = options;
  app.post<{ Body: FindingPacketCreate }>(
    '/v1/finding-packets',
    { schema: { body: FindingPacketCreateSchema } },
    async (request, reply) => {
      const accepted = await boundedOperation(() =>
        withScope(
          pool,
          principal(request),
          async (client, who) =>
            idempotent(
              client,
              who,
              '/v1/finding-packets',
              key(request),
              request.body,
              async () => {
                const record = await createFindingPacket(client, who, request.body, store, key(request));
                return { id: record.id, value: record };
              },
              (id) => getFindingPacket(client, who, id),
            ),
          'evidence:read',
        ),
      );
      return reply
        .header('X-Evidence-Format', accepted.value.format)
        .code(201)
        .send({ record: accepted.value, requestId: request.id });
    },
  );
  app.get<{ Querystring: FindingPacketQuery }>(
    '/v1/finding-packets',
    { schema: { querystring: FindingPacketQuerySchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        async (client, who) => ({ ...(await listFindingPackets(client, who, request.query)), requestId: request.id }),
        'evidence:read',
      ),
  );
  app.get<{ Params: FindingPacketParams }>(
    '/v1/finding-packets/:id',
    { schema: { params: FindingPacketParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        async (client, who) => ({
          record: await getFindingPacket(client, who, request.params.id),
          requestId: request.id,
        }),
        'evidence:read',
      ),
  );
  app.get<{ Params: FindingPacketParams }>(
    '/v1/finding-packets/:id/content',
    { schema: { params: FindingPacketParamsSchema } },
    async (request, reply) =>
      boundedOperation(async () => {
        const { record, bytes } = await withScope(
          pool,
          principal(request),
          async (client, who) => getFindingPacketContent(client, who, request.params.id, store),
          'evidence:read',
        );
        return reply
          .type('application/json')
          .header('X-Evidence-Format', record.format)
          .header('X-Content-SHA256', record.packetSha256)
          .header('X-Manifest-SHA256', record.manifestDigest)
          .header('Cache-Control', 'private, no-store')
          .header('Content-Disposition', `attachment; filename="ledger-finding-packet-${record.id}.json"`)
          .send(Buffer.from(bytes));
      }),
  );
}
