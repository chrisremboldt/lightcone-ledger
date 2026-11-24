import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DecisionPacketCreateSchema,
  DecisionPacketParamsSchema,
  DecisionPacketQuerySchema,
  type DecisionPacketCreate,
  type DecisionPacketQuery,
} from '@ledger/contracts';
import { getDecisionPacket, getDecisionPacketObject, listDecisionPackets } from '@ledger/evidence';
import { sha256 } from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  withScope,
  type AuthContext,
  type ObjectStore,
  type Pool,
} from '@ledger/persistence';

interface PacketRouteOptions {
  pool: Pool;
  store: ObjectStore;
  principal: (request: FastifyRequest) => AuthContext;
  key: (request: FastifyRequest) => string;
  boundedOperation: <T>(operation: () => Promise<T>) => Promise<T>;
}
export function registerDecisionPacketRoutes(app: FastifyInstance, options: PacketRouteOptions): void {
  const { pool, store, principal, boundedOperation } = options;
  // The older format is no longer issued: findings are packaged as finding packets. Packets already issued stay
  // readable below and verify with their own verifier.
  app.post<{ Body: DecisionPacketCreate }>(
    '/v1/decision-packets',
    { schema: { body: DecisionPacketCreateSchema } },
    async (request) => {
      if (!principal(request).capabilities.includes('evidence:read'))
        throw new DomainError(403, 'capability_required', 'Decision packets require evidence:read');
      throw new DomainError(
        410,
        'decision_packet_retired',
        'Decision packets are no longer issued. Issue a finding packet for the finding this decision treats; decision packets issued earlier stay readable and verifiable.',
      );
    },
  );
  app.get<{ Querystring: DecisionPacketQuery }>(
    '/v1/decision-packets',
    { schema: { querystring: DecisionPacketQuerySchema } },
    async (request) => {
      return withScope(
        pool,
        principal(request),
        async (client) => ({ ...(await listDecisionPackets(client, request.query)), requestId: request.id }),
        'evidence:read',
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1/decision-packets/:id',
    { schema: { params: DecisionPacketParamsSchema } },
    async (request) => {
      return withScope(
        pool,
        principal(request),
        async (client) => ({ record: await getDecisionPacket(client, request.params.id), requestId: request.id }),
        'evidence:read',
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1/decision-packets/:id/content',
    { schema: { params: DecisionPacketParamsSchema } },
    async (request, reply) =>
      boundedOperation(async () => {
        const { record, bytes } = await withScope(
          pool,
          principal(request),
          async (client) => {
            const { record, key } = await getDecisionPacketObject(client, request.params.id);
            let bytes: Uint8Array;
            try {
              bytes = await readBoundedObject(store, key, { maxBytes: record.byteLength, timeoutMs: 10000 });
            } catch {
              throw new DomainError(
                409,
                'decision_packet_bytes_unavailable',
                'Retained packet bytes are unavailable within their byte/time bounds',
              );
            }
            if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.packetSha256)
              throw new DomainError(
                409,
                'decision_packet_integrity_failure',
                'Retained packet bytes differ from their immutable record',
              );
            return { record, bytes };
          },
          'evidence:read',
        );
        return reply
          .type('application/json')
          .header('X-Evidence-Format', record.format)
          .header('X-Content-SHA256', record.packetSha256)
          .header('X-Manifest-SHA256', record.manifestDigest)
          .header('Cache-Control', 'private, no-store')
          .header('Content-Disposition', `attachment; filename="ledger-decision-packet-${record.id}.json"`)
          .send(Buffer.from(bytes));
      }),
  );
}
