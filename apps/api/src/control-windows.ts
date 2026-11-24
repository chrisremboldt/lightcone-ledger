import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ControlIndicatorRecordSchema,
  ControlIndicatorResultParamsSchema,
  ControlIndicatorReviewParamsSchema,
  ControlIndicatorReviewSchema,
  type ControlIndicatorRecord,
  type ControlIndicatorReviewParams,
  type ControlIndicatorResultParams,
  type ControlIndicatorReview,
  ControlWindowIndicatorParamsSchema,
  ControlWindowOpenSchema,
  ControlWindowParamsSchema,
  ControlWindowQuerySchema,
  ControlWindowReviseSchema,
  type ControlWindowIndicatorParams,
  type ControlWindowOpen,
  type ControlWindowParams,
  type ControlWindowQuery,
  type ControlWindowRevise,
} from '@ledger/contracts';
import {
  getControlIndicatorResult,
  getControlIndicatorReview,
  listControlWindowIndicatorResults,
  recordControlWindowIndicator,
  reviewControlIndicatorResult,
  calculateControlWindowIndicator,
  getControlWindow,
  listControlWindows,
  openControlWindow,
  reviseControlWindow,
} from '@ledger/domain';
import { withScope, type AuthContext, type Pool } from '@ledger/persistence';

const PATH = '/v1/control-windows';

/** Opening, revising and reading windows over which an accepted control is monitored, and their indicators. */
export function registerControlWindowRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    principal: (request: FastifyRequest) => AuthContext;
    key: (request: FastifyRequest) => string;
  },
): void {
  const { pool, principal, key } = dependencies;
  app.post<{ Body: ControlWindowOpen }>(PATH, { schema: { body: ControlWindowOpenSchema } }, async (request, reply) => {
    const { window } = await withScope(
      pool,
      principal(request),
      (client, who) => openControlWindow(client, who, request.body, key(request)),
      'monitoring:write',
    );
    return reply.code(201).send({ window });
  });
  app.post<{ Params: ControlWindowParams; Body: ControlWindowRevise }>(
    `${PATH}/:windowId/revisions`,
    { schema: { params: ControlWindowParamsSchema, body: ControlWindowReviseSchema } },
    async (request, reply) => {
      const { window } = await withScope(
        pool,
        principal(request),
        (client, who) => reviseControlWindow(client, who, request.params.windowId, request.body, key(request)),
        'monitoring:write',
      );
      return reply.code(201).send({ window });
    },
  );
  app.get<{ Querystring: ControlWindowQuery }>(
    PATH,
    { schema: { querystring: ControlWindowQuerySchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => listControlWindows(client, who, request.query),
        'evidence:read',
        true,
      ),
  );
  app.get<{ Params: ControlWindowParams }>(
    `${PATH}/:windowId`,
    { schema: { params: ControlWindowParamsSchema } },
    async (request) => ({
      window: await withScope(
        pool,
        principal(request),
        (client, who) => getControlWindow(client, who, request.params.windowId),
        'evidence:read',
        true,
      ),
    }),
  );
  app.get<{ Params: ControlWindowIndicatorParams }>(
    `${PATH}/:windowId/indicators/:indicatorId/versions/:version`,
    { schema: { params: ControlWindowIndicatorParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) =>
          calculateControlWindowIndicator(client, who, request.params.windowId, {
            id: request.params.indicatorId,
            version: Number(request.params.version),
          }),
        'evidence:read',
        true,
      ),
  );
  app.post<{ Params: ControlWindowParams; Body: ControlIndicatorRecord }>(
    `${PATH}/:windowId/indicator-results`,
    { schema: { params: ControlWindowParamsSchema, body: ControlIndicatorRecordSchema } },
    async (request, reply) => {
      const { response } = await withScope(
        pool,
        principal(request),
        (client, who) => recordControlWindowIndicator(client, who, request.params.windowId, request.body, key(request)),
        'decision:write',
      );
      return reply.code(201).send(response);
    },
  );
  app.get<{ Params: ControlWindowParams }>(
    `${PATH}/:windowId/indicator-results`,
    { schema: { params: ControlWindowParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => listControlWindowIndicatorResults(client, who, request.params.windowId),
        'evidence:read',
        true,
      ),
  );
  app.get<{ Params: ControlIndicatorResultParams }>(
    '/v1/control-indicator-results/:resultId',
    { schema: { params: ControlIndicatorResultParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => getControlIndicatorResult(client, who, request.params.resultId),
        'evidence:read',
        true,
      ),
  );
  app.post<{ Body: ControlIndicatorReview }>(
    '/v1/control-indicator-reviews',
    { schema: { body: ControlIndicatorReviewSchema } },
    async (request, reply) => {
      const { response } = await withScope(
        pool,
        principal(request),
        (client, who) => reviewControlIndicatorResult(client, who, request.body, key(request)),
        'decision:write',
      );
      return reply.code(201).send(response);
    },
  );
  app.get<{ Params: ControlIndicatorReviewParams }>(
    '/v1/control-indicator-reviews/:reviewId',
    { schema: { params: ControlIndicatorReviewParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => getControlIndicatorReview(client, who, request.params.reviewId),
        'evidence:read',
        true,
      ),
  );
}
