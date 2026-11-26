import type { FastifyInstance, FastifyReply, FastifyRequest, FastifySchema } from 'fastify';
import {
  PROGRAM_VIEW_PATH,
  ProgramGrantCreateSchema,
  ProgramGrantParamsSchema,
  ProgramGrantRevokeSchema,
  ProgramOperatorAddSchema,
  ProgramOperatorParamsSchema,
  ProgramOperatorRemoveSchema,
  ProgramViewRequestSchema,
  type ProgramGrantCreate,
  type ProgramGrantParams,
  type ProgramGrantRevoke,
  type ProgramOperatorAdd,
  type ProgramOperatorParams,
  type ProgramOperatorRemove,
  type ProgramViewRequest,
} from '@ledger/contracts';
import {
  addProgramOperator,
  askProgramRead,
  listProgramOperatorAnswers,
  listProgramOperators,
  removeProgramOperator,
} from '@ledger/domain';
import { createProgramGrant, listProgramGrants, readProgramView, revokeProgramGrant } from '@ledger/evidence';
import { DomainError, idempotent, withScope, type AuthContext, type Pool } from '@ledger/persistence';

/** A route schema with the summary and description the API reference shows. */
const documented = (schema: FastifySchema & { summary: string; description: string }): FastifySchema => schema;

type Environment = 'local' | 'test' | 'staging';

/** The route an operator's Ledger answers a grant on, without signing in. Its secret is in the body. */
export const PROGRAM_VIEW_PATHS: readonly string[] = [PROGRAM_VIEW_PATH];

/** What every answer of the unsigned read carries, refusals included: kept by no cache, sent nowhere, listed nowhere. */
const unsignedRoute = {
  onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.headers({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
    });
  },
};

const GRANTS = '/v1/program-grants';
const OPERATORS = '/v1/program-operators';

/**
 * A program owner's view of the operators it contracts (docs/design/program-owner-view.md): an operator's grants and
 * the read they open, and the operators a program owner follows. Calls to another Ledger are made by the workers only.
 */
export function registerProgramViewRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    env: Environment;
    principal: (request: FastifyRequest) => AuthContext;
    key: (request: FastifyRequest) => string;
  },
): void {
  const { pool, env, principal, key } = dependencies;
  // Only a local Ledger reads an operator at an http:// address.
  const httpAllowed = env === 'local';
  const privately = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store');

  app.post<{ Body: ProgramGrantCreate }>(
    GRANTS,
    {
      schema: documented({
        summary: 'Make a grant to a program owner',
        description:
          'A grant that answers its secret with counts only: the coverage of named adopted packs by rule and result, the open findings by rule with the oldest one’s age, and links to named produced sets. 90 days unless given, a year at most. Its secret is 256 random bits, returned once; Ledger keeps only its SHA-256. Requires authority:write and an Idempotency-Key.',
        body: ProgramGrantCreateSchema,
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
              GRANTS,
              key(request),
              request.body,
              async () => {
                const value = await createProgramGrant(client, who, request.body);
                return { id: value.grant.id, value };
              },
              async () => {
                // The secret exists only in the first answer; a retry cannot be shown it again.
                throw new DomainError(
                  409,
                  'program_grant_secret_not_repeated',
                  'This grant was already made and its secret was shown once. Revoke it and make another.',
                );
              },
            )
          ).value,
        'authority:write',
      );
      return privately(reply).code(201).send(made);
    },
  );
  app.get(
    GRANTS,
    {
      schema: documented({
        summary: 'List the grants to program owners',
        description:
          'Every grant, newest first: for whom, what it covers, who made it and when, when it expires, whether it was revoked, by whom and why, and each read. Never a secret. Requires authority:write.',
      }),
    },
    async (request, reply) => {
      privately(reply);
      return withScope(
        pool,
        principal(request),
        (client, who) => listProgramGrants(client, who),
        'authority:write',
        true,
      );
    },
  );
  app.post<{ Params: ProgramGrantParams; Body: ProgramGrantRevoke }>(
    `${GRANTS}/:id/revoke`,
    {
      schema: documented({
        summary: 'Revoke a grant to a program owner',
        description:
          'The grant answers nothing from now on, and the links made with it open nothing. Recorded with who revoked it and why. Requires authority:write.',
        params: ProgramGrantParamsSchema,
        body: ProgramGrantRevokeSchema,
      }),
    },
    async (request, reply) => {
      const revoked = await withScope(
        pool,
        principal(request),
        (client, who) => revokeProgramGrant(client, who, request.params.id, request.body.reason),
        'authority:write',
      );
      return privately(reply).send(revoked);
    },
  );
  app.post<{ Body: ProgramViewRequest }>(
    PROGRAM_VIEW_PATH,
    {
      ...unsignedRoute,
      schema: documented({
        summary: 'Read what a grant shows',
        description:
          'No sign-in: the grant’s secret finds the grant. One document of counts: the organization’s name, when it was made, the grant’s expiry and the parts granted. Each read is kept with its time and the parts read, nothing about who read it. Expired, revoked and unknown secrets all answer 404 program_grant_not_in_use.',
        body: ProgramViewRequestSchema,
      }),
    },
    async (request, reply) => reply.send(await readProgramView(pool, request.body.secret)),
  );

  app.get(
    OPERATORS,
    {
      schema: documented({
        summary: 'List the operators you follow',
        description:
          'Each operator you follow, in alphabetical order of your name for it: when it was last read, what came of it, and the last answer its Ledger gave with when it was read. Never the secret. Requires evidence:read.',
      }),
    },
    async (request, reply) => {
      privately(reply);
      return withScope(
        pool,
        principal(request),
        (client, who) => listProgramOperators(client, who, httpAllowed),
        'evidence:read',
        true,
      );
    },
  );
  app.post<{ Body: ProgramOperatorAdd }>(
    OPERATORS,
    {
      schema: documented({
        summary: 'Follow an operator',
        description:
          'Your name for the operator, the address of its Ledger (https:// outside a local Ledger) and the secret it gave you. The secret is kept for the workers and never returned. The operator is read within the hour, and hourly after. Requires authority:write.',
        body: ProgramOperatorAddSchema,
      }),
    },
    async (request, reply) => {
      const added = await withScope(
        pool,
        principal(request),
        (client, who) => addProgramOperator(client, who, request.body, httpAllowed),
        'authority:write',
      );
      return privately(reply).code(201).send(added);
    },
  );
  app.get<{ Params: ProgramOperatorParams }>(
    `${OPERATORS}/:id/answers`,
    {
      schema: documented({
        summary: 'List what an operator’s Ledger answered',
        description:
          'Every read of the operator, newest first, at most 200: when, what came of it, the digest of each answer kept and the reason of each failure. Requires evidence:read.',
        params: ProgramOperatorParamsSchema,
      }),
    },
    async (request, reply) => {
      privately(reply);
      return withScope(
        pool,
        principal(request),
        (client, who) => listProgramOperatorAnswers(client, who, request.params.id),
        'evidence:read',
        true,
      );
    },
  );
  app.post<{ Params: ProgramOperatorParams }>(
    `${OPERATORS}/:id/read`,
    {
      schema: documented({
        summary: 'Ask for a fresh read of an operator',
        description:
          'The operator’s read falls due now; a worker makes it as it makes the hourly one. Requires evidence:read.',
        params: ProgramOperatorParamsSchema,
      }),
    },
    async (request, reply) => {
      const asked = await withScope(
        pool,
        principal(request),
        (client, who) => askProgramRead(client, who, request.params.id),
        'evidence:read',
      );
      return privately(reply).code(202).send(asked);
    },
  );
  app.post<{ Params: ProgramOperatorParams; Body: ProgramOperatorRemove }>(
    `${OPERATORS}/:id/remove`,
    {
      schema: documented({
        summary: 'Stop following an operator',
        description:
          'The operator is read no more. Its answers are kept and its secret is erased. Recorded with who removed it and why. Requires authority:write.',
        params: ProgramOperatorParamsSchema,
        body: ProgramOperatorRemoveSchema,
      }),
    },
    async (request, reply) => {
      const removed = await withScope(
        pool,
        principal(request),
        (client, who) => removeProgramOperator(client, who, request.params.id, request.body.reason),
        'authority:write',
      );
      return privately(reply).send(removed);
    },
  );
}
