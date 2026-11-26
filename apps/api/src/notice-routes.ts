import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  NoticeEmailParamsSchema,
  NoticeEmailUpdateSchema,
  NoticeListQuerySchema,
  NoticeSettingsUpdateSchema,
  NoticeWebhookUpdateSchema,
  type NoticeEmailParams,
  type NoticeEmailUpdate,
  type NoticeListQuery,
  type NoticeSettingsUpdate,
  type NoticeWebhookUpdate,
} from '@ledger/contracts';
import {
  getNoticeSettings,
  getNoticeWebhook,
  listNotices,
  setNoticeWebhook,
  updateNoticeSettings,
} from '@ledger/domain';
import { DomainError, withScope, type AuthContext, type Pool } from '@ledger/persistence';

type Environment = 'local' | 'test' | 'staging';

function requirePerson(principal: AuthContext): void {
  if (principal.kind !== 'human')
    throw new DomainError(403, 'person_required', 'Notices are chosen by a person, for themselves');
}

/**
 * Notices (docs/design/notices.md): each person's own choices, an administrator's list of every notice and the
 * organization's webhook. A webhook's secret is returned once, by the request that makes it.
 */
export function registerNoticeRoutes(
  app: FastifyInstance,
  dependencies: { pool: Pool; env: Environment; principal: (request: FastifyRequest) => AuthContext },
): void {
  const { pool, env, principal } = dependencies;
  // Only a local Ledger posts to an http:// webhook, such as the emulators' receiver.
  const httpAllowed = env === 'local';
  app.get('/v1/notices/settings', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withScope(pool, principal(request), (client, who) => getNoticeSettings(client, who), undefined, true);
  });
  app.put<{ Body: NoticeSettingsUpdate }>(
    '/v1/notices/settings',
    { schema: { body: NoticeSettingsUpdateSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(pool, principal(request), async (client, who) => {
        requirePerson(who);
        return updateNoticeSettings(client, who, who.id, request.body);
      });
    },
  );
  app.put<{ Params: NoticeEmailParams; Body: NoticeEmailUpdate }>(
    '/v1/authority/principals/:id/notice-email',
    { schema: { params: NoticeEmailParamsSchema, body: NoticeEmailUpdateSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => updateNoticeSettings(client, who, request.params.id, { email: request.body.email }),
        'authority:write',
      );
    },
  );
  app.get<{ Querystring: NoticeListQuery }>(
    '/v1/notices',
    { schema: { querystring: NoticeListQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => listNotices(client, who, request.query),
        'authority:write',
        true,
      );
    },
  );
  app.get('/v1/notices/webhook', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return withScope(
      pool,
      principal(request),
      (client, who) => getNoticeWebhook(client, who, httpAllowed),
      'authority:write',
      true,
    );
  });
  app.put<{ Body: NoticeWebhookUpdate }>(
    '/v1/notices/webhook',
    { schema: { body: NoticeWebhookUpdateSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return withScope(
        pool,
        principal(request),
        (client, who) => setNoticeWebhook(client, who, request.body.url, httpAllowed),
        'authority:write',
      );
    },
  );
}
