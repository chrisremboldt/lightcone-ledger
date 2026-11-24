import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rolePresetList } from '@ledger/contracts';
import { Value } from '@sinclair/typebox/value';
import {
  DevelopmentTokenParamsSchema,
  DevelopmentTokenRequestSchema,
  type DevelopmentTokenParams,
} from '@ledger/contracts/development-tokens';
import { issueDevelopmentToken } from '@ledger/domain';
import { DomainError, withScope, type AuthContext, type Pool } from '@ledger/persistence';

type Environment = 'local' | 'test' | 'staging';

/** The role presets people are added from, and a development token for a person on a local or test database. */
export function registerPeopleRoutes(
  app: FastifyInstance,
  dependencies: { pool: Pool; env: Environment; principal: (request: FastifyRequest) => AuthContext },
): void {
  const { pool, env, principal } = dependencies;
  app.get('/v1/authority/presets', async (request) =>
    withScope(pool, principal(request), async () => rolePresetList(), 'authority:write', true),
  );
  app.post<{ Params: DevelopmentTokenParams }>(
    '/v1/authority/principals/:id/development-token',
    { schema: { params: DevelopmentTokenParamsSchema } },
    async (request, reply) => {
      const caller = principal(request);
      // The body is optional: the People screen sends none, the command line sends the administrator's reason.
      const body = request.body ?? {};
      if (!Value.Check(DevelopmentTokenRequestSchema, body))
        throw new DomainError(400, 'invalid_request', 'The body may hold only note, the reason the token is issued');
      const note = body.note?.trim();
      const issued = await withScope(
        pool,
        caller,
        (client, who) => issueDevelopmentToken(client, who, request.params.id, env !== 'staging', note),
        'authority:write',
        false,
        undefined,
        // Issuing for oneself replaces one's own token: take one's own row FOR UPDATE from the start.
        request.params.id === caller.id ? 'UPDATE' : 'SHARE',
      );
      return reply.code(201).header('Cache-Control', 'private, no-store').send(issued);
    },
  );
}
