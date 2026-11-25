import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LocalReauthenticationSchema,
  REAUTHENTICATION_HEADER,
  SmsExportCreateSchema,
  SmsFindingPromotionParamsSchema,
  SmsRecordParamsSchema,
  SmsRegisterQuerySchema,
  SmsSigningPreviewQuerySchema,
  type LocalReauthentication,
  type LocalReauthenticationResponse,
  type ReauthenticationEvidence,
  type SmsControlTypeListResponse,
  type SmsExportCreate,
  type SmsRegisterQuery,
  type SmsSigningPreviewQuery,
} from '@ledger/contracts';
import {
  adoptedDocumentPurposes,
  getFindingPromotion,
  getSmsHome,
  getSmsProgram,
  getSmsRecord,
  getSmsRecordContent,
  getSmsRegister,
  getSmsSigningPreview,
  type SmsRegisterPage,
  listControlTypes,
  readSmsAttachmentObject,
  type Reauthenticate,
} from '@ledger/domain';
import { createSmsExport, getSmsExport, renderSmsPacket, type SmsPacketBundle } from '@ledger/evidence';
import { sha256 } from '@ledger/integrity';
import {
  authenticate,
  DomainError,
  idempotent,
  readBoundedObject,
  withScope,
  type AuthContext,
  type ObjectStore,
  type Pool,
  type PoolClient,
} from '@ledger/persistence';

export interface RequestIdentity {
  token?: string;
  issuer?: string;
  subject?: string;
  expiresAt?: number;
  /** When the person last signed in at the identity provider, in seconds since the epoch. */
  authTime?: number;
}
type Environment = 'local' | 'test' | 'staging';
/** How recent a confirmation must be for a signature: a local grant's lifetime, or a provider sign-in's age. */
export const FRESH_CONFIRMATION_SECONDS = 300;
// A provider's clock may run a little ahead of the database's.
const AUTH_TIME_TOLERANCE_SECONDS = 30;

/** The register query without its kind and without the parameters left out, as getSmsRegister takes it. */
function registerPage({ kind: _kind, ...page }: SmsRegisterQuery): SmsRegisterPage {
  return Object.fromEntries(Object.entries(page).filter(([, value]) => value !== undefined)) as SmsRegisterPage;
}

function isLocalFixture(identity: RequestIdentity, env: Environment): boolean {
  return (env === 'local' || env === 'test') && Boolean(identity.token?.startsWith('ledger-dev-'));
}

export function reauthenticationMethod(identity: RequestIdentity, env: Environment) {
  return isLocalFixture(identity, env) ? ('local_fixture' as const) : ('openid_connect' as const);
}

/** Verifies a fresh re-authentication inside the signing transaction; nothing it reads is retained or logged. */
export function reauthenticator(
  client: PoolClient,
  who: AuthContext,
  request: FastifyRequest,
  identity: RequestIdentity,
  env: Environment,
): Reauthenticate {
  return async (): Promise<ReauthenticationEvidence> => {
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    if (identity.issuer && identity.subject) {
      const age = identity.authTime === undefined ? undefined : now.getTime() / 1000 - identity.authTime;
      if (age === undefined || age > FRESH_CONFIRMATION_SECONDS || age < -AUTH_TIME_TOLERANCE_SECONDS)
        throw new DomainError(
          403,
          'reauthentication_required',
          'Sign in again with your identity provider to confirm it is you, then sign within five minutes',
          { method: 'openid_connect' },
        );
      return {
        method: 'openid_connect',
        verifiedAt: now.toISOString(),
        authenticatedAt: new Date(identity.authTime! * 1000).toISOString(),
      };
    }
    if (!isLocalFixture(identity, env))
      throw new DomainError(403, 'reauthentication_unavailable', 'Only a signed-in person can sign');
    const grant = request.headers[REAUTHENTICATION_HEADER];
    if (typeof grant !== 'string' || !grant)
      throw new DomainError(403, 'reauthentication_required', 'Confirm it is you before signing', {
        method: 'local_fixture',
      });
    const spent = (
      await client.query<{ id: string; used_at: Date }>(
        `UPDATE reauthentication_grants SET used_at=clock_timestamp()
         WHERE tenant_id=$1 AND principal_id=$2 AND secret_sha256=$3 AND used_at IS NULL AND expires_at>clock_timestamp()
         RETURNING id,used_at`,
        [who.tenantId, who.id, sha256(grant)],
      )
    ).rows[0];
    if (!spent)
      throw new DomainError(
        403,
        'reauthentication_required',
        'Your confirmation expired or was already used; confirm it is you again',
        { method: 'local_fixture' },
      );
    return { method: 'local_fixture', verifiedAt: spent.used_at.toISOString(), grantId: spent.id };
  };
}

export function registerSmsRoutes(
  app: FastifyInstance,
  dependencies: {
    pool: Pool;
    store: ObjectStore;
    env: Environment;
    principal: (request: FastifyRequest) => AuthContext;
    identity: (request: FastifyRequest) => RequestIdentity;
    key: (request: FastifyRequest) => string;
    boundedOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  },
): void {
  const { pool, store, env, principal, identity, key, boundedOperation } = dependencies;
  const read = <T>(
    request: FastifyRequest,
    capability: string | undefined,
    operation: (client: PoolClient, who: AuthContext) => Promise<T>,
  ) => withScope(pool, principal(request), operation, capability, true);
  const privately = {
    onSend: async (
      _request: FastifyRequest,
      reply: { header: (name: string, value: string) => unknown },
      payload: unknown,
    ) => {
      reply.header('Cache-Control', 'private, no-store');
      return payload;
    },
  };

  app.get('/v1/sms/program', privately, async (request) => read(request, undefined, getSmsProgram));
  app.get('/v1/sms/home', privately, async (request) => read(request, 'sms:read', getSmsHome));
  app.get('/v1/sms/control-types', privately, async (request) =>
    read(request, 'sms:read', async (): Promise<SmsControlTypeListResponse> => ({ controlTypes: listControlTypes() })),
  );
  app.get('/v1/organization/document-purposes', privately, async (request) =>
    read(request, 'sms:read', (client, who) => adoptedDocumentPurposes(client, who.tenantId)),
  );
  app.get<{ Querystring: SmsRegisterQuery }>(
    '/v1/sms/records',
    { ...privately, schema: { querystring: SmsRegisterQuerySchema } },
    async (request) =>
      read(request, 'sms:read', (client, who) =>
        getSmsRegister(client, who, request.query.kind, registerPage(request.query)),
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/sms/records/:id',
    { ...privately, schema: { params: SmsRecordParamsSchema } },
    async (request) => read(request, 'sms:read', (client, who) => getSmsRecord(client, who, request.params.id)),
  );
  app.get<{ Params: { id: string }; Querystring: SmsSigningPreviewQuery }>(
    '/v1/sms/records/:id/signing',
    { ...privately, schema: { params: SmsRecordParamsSchema, querystring: SmsSigningPreviewQuerySchema } },
    async (request) =>
      read(request, 'sms:read', (client, who) =>
        getSmsSigningPreview(
          client,
          who,
          request.params.id,
          request.query.meaning,
          reauthenticationMethod(identity(request), env),
        ),
      ),
  );
  app.get<{ Params: { findingId: string } }>(
    '/v1/sms/findings/:findingId/promotion',
    { ...privately, schema: { params: SmsFindingPromotionParamsSchema } },
    async (request) =>
      read(request, 'sms:write', (client, who) => getFindingPromotion(client, who, request.params.findingId)),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/sms/records/:id/content',
    { ...privately, schema: { params: SmsRecordParamsSchema } },
    async (request) =>
      withScope(
        pool,
        principal(request),
        (client, who) => getSmsRecordContent(client, who, request.params.id),
        'sms:read',
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/sms/attachments/:id/content',
    { schema: { params: SmsRecordParamsSchema } },
    async (request, reply) => {
      const object = await withScope(
        pool,
        principal(request),
        (client, who) => readSmsAttachmentObject(client, who, request.params.id),
        'sms:read',
      );
      const bytes = await readBoundedObject(store, object.objectKey, { maxBytes: object.byteLength, timeoutMs: 10000 });
      if (bytes.byteLength !== object.byteLength || sha256(bytes) !== object.sha256)
        throw new DomainError(409, 'artifact_integrity_failure', 'Retained bytes do not match the attachment digest');
      return reply
        .type(object.contentType)
        .header('X-Content-SHA256', object.sha256)
        .header('Content-Disposition', `attachment; filename="ledger-attachment-${request.params.id}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(Buffer.from(bytes));
    },
  );
  app.post<{ Body: SmsExportCreate }>(
    '/v1/sms/exports',
    { schema: { body: SmsExportCreateSchema } },
    async (request, reply) => {
      const result = await boundedOperation(() =>
        withScope(
          pool,
          principal(request),
          async (client, who) =>
            (
              await idempotent(
                client,
                who,
                '/v1/sms/exports',
                key(request),
                request.body,
                async () => {
                  const record = await createSmsExport(client, who, request.body, store);
                  return { id: record.id, value: record };
                },
                async (id) => (await getSmsExport(client, id)).record,
              )
            ).value,
          'evidence:read',
        ),
      );
      return reply.code(201).send({ export: result });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1/sms/exports/:id',
    { ...privately, schema: { params: SmsRecordParamsSchema } },
    async (request) =>
      read(request, 'evidence:read', async (client) => ({
        export: (await getSmsExport(client, request.params.id)).record,
      })),
  );
  async function retainedExport(request: FastifyRequest<{ Params: { id: string } }>) {
    const { record, objectKey, organization } = await read(request, 'evidence:read', async (client, who) => ({
      ...(await getSmsExport(client, request.params.id)),
      organization: (await client.query<{ name: string }>('SELECT name FROM tenants WHERE id=$1', [who.tenantId]))
        .rows[0].name,
    }));
    const bytes = await readBoundedObject(store, objectKey, { maxBytes: record.byteLength, timeoutMs: 10000 });
    if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.bundleSha256)
      throw new DomainError(409, 'export_integrity_failure', 'Retained export bytes do not match their record');
    return { record, bytes, organization };
  }
  app.get<{ Params: { id: string } }>(
    '/v1/sms/exports/:id/packet',
    { schema: { params: SmsRecordParamsSchema } },
    async (request, reply) =>
      boundedOperation(async () => {
        const { record, bytes, organization } = await retainedExport(request);
        const bundle = JSON.parse(Buffer.from(bytes).toString('utf8')) as SmsPacketBundle;
        return reply
          .type('text/html; charset=utf-8')
          .header('X-Manifest-SHA256', record.manifestDigest)
          .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'private, no-store')
          .header('Content-Disposition', `attachment; filename="ledger-sms-packet-${record.id}.html"`)
          .send(renderSmsPacket(bundle, organization));
      }),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/sms/exports/:id/content',
    { schema: { params: SmsRecordParamsSchema } },
    async (request, reply) =>
      boundedOperation(async () => {
        const { record, bytes } = await retainedExport(request);
        return reply
          .type('application/json')
          .header('X-Evidence-Format', record.format)
          .header('X-Content-SHA256', record.bundleSha256)
          .header('X-Manifest-SHA256', record.manifestDigest)
          .header('Cache-Control', 'private, no-store')
          .header('Content-Disposition', `attachment; filename="ledger-sms-export-${record.id}.json"`)
          .send(Buffer.from(bytes));
      }),
  );

  if (env !== 'local' && env !== 'test') return;
  app.post<{ Body: LocalReauthentication }>(
    '/v1/local/reauthentications',
    { schema: { body: LocalReauthenticationSchema } },
    async (request, reply) => {
      const current = identity(request);
      if (!isLocalFixture(current, env))
        throw new DomainError(403, 'local_reauthentication_only', 'Local confirmation is only for fixture identities');
      const confirmed = await authenticate(pool, { token: request.body.credential });
      const who = principal(request);
      if (!confirmed || confirmed.id !== who.id || confirmed.tenantId !== who.tenantId)
        throw new DomainError(
          401,
          'reauthentication_failed',
          'That credential does not belong to the signed-in person',
        );
      const grant = randomBytes(32).toString('base64url');
      const response = await withScope(pool, who, async (client, scoped): Promise<LocalReauthenticationResponse> => {
        const row = (
          await client.query<{ expires_at: Date }>(
            `INSERT INTO reauthentication_grants(id,tenant_id,principal_id,method,secret_sha256,issued_at,expires_at)
             VALUES($1,$2,$3,'local_fixture',$4,clock_timestamp(),clock_timestamp()+make_interval(secs=>$5))
             RETURNING expires_at`,
            [randomUUID(), scoped.tenantId, scoped.id, sha256(grant), FRESH_CONFIRMATION_SECONDS],
          )
        ).rows[0];
        return { grant, expiresAt: row.expires_at.toISOString() };
      });
      return reply.code(201).header('Cache-Control', 'private, no-store').send(response);
    },
  );
}
