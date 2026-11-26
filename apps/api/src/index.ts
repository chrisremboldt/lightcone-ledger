import { registerFlightPredepartureRoutes, flightPredepartureConfiguration } from './flight-predeparture.js';
import type { FlightPredepartureConfig } from '@ledger/contracts';
import { isWebAppRequest, registerWebApp } from './web-app.js';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import {
  CommandSchema,
  ExportCreateSchema,
  SubjectExportCreateSchema,
  FlightCreateSchema,
  FlightQuerySchema,
  InputSchema,
  ObservationQuerySchema,
  RuleEvaluationParamsSchema,
  SubjectRecordQuerySchema,
  AdoptionCoverageParamsSchema,
  RuleCoverageSubjectsParamsSchema,
  RuleCoverageSubjectsQuerySchema,
  SubjectsOnRecordQuerySchema,
  OpenFindingsQuerySchema,
  OpenFindingGroupsQuerySchema,
  type OpenFindingsQuery,
  type OpenFindingGroupsQuery,
  type AdoptionCoverageParams,
  type RuleCoverageSubjectsParams,
  type RuleCoverageSubjectsQuery,
  type SubjectsOnRecordQuery,
  UploadCreateSchema,
  TimelineQuerySchema,
  TelemetryQuerySchema,
  MissionRouteSuggestionRequestSchema,
  OrderQuerySchema,
  ReceiptQuerySchema,
  RulePackVersionParamsSchema,
  RuleSourceParamsSchema,
  FlightRuleSelectionParamsSchema,
  FlightRuleSelectionRecordParamsSchema,
  OrganizationPeopleQuerySchema,
  AuthorityPrincipalParamsSchema,
  PrincipalAuthorityListQuerySchema,
  CredentialListQuerySchema,
  AcceptedAreaControlParamsSchema,
  FlightMissionParamsSchema,
  FlightMissionRevisionParamsSchema,
  FlightCommandLinkBaselineParamsSchema,
  MonitoringWindowParamsSchema,
  FlightMissionAvoidanceParamsSchema,
  FlightMissionReleaseParamsSchema,
  FlightMissionReleaseFindingsParamsSchema,
  FlightControlsParamsSchema,
  FlightMissionBriefingParamsSchema,
  type TimelineQuery,
  type TelemetryQuery,
  type MissionRouteSuggestionRequest,
  type OrderQuery,
  type ReceiptQuery,
  type RulePackVersionParams,
  type RuleSourceParams,
  type FlightRuleSelectionParams,
  type FlightRuleSelectionRecordParams,
  type OrganizationPeopleQuery,
  type AuthorityPrincipalParams,
  type PrincipalAuthorityListQuery,
  type CredentialListQuery,
  type AcceptedAreaControlParams,
  type FlightMissionParams,
  type FlightMissionRevisionParams,
  type FlightCommandLinkBaselineParams,
  type MonitoringWindowParams,
  type FlightMissionAvoidanceParams,
  type FlightMissionReleaseParams,
  type FlightMissionReleaseFindingsParams,
  type FlightControlsParams,
  type FlightMissionBriefingParams,
  type Artifact,
  type Command,
  type IssuedCredential,
  type ExportCreate,
  type ExportRecord,
  type SubjectExportCreate,
  type FlightCreate,
  type FlightQuery,
  type FlightWatchMessage,
  type Input,
  type ObservationQuery,
  type RuleEvaluationParams,
  type SubjectRecordQuery,
  type Upload,
  type UploadCreate,
  type SimulationAvoidanceDemoConfig,
  readsOnly,
  requestShapeRefusal,
  type SchemaError,
} from '@ledger/contracts';
import {
  assertApplicationRole,
  authenticate,
  signInAccountTied,
  createObjectStore,
  createPool,
  DomainError,
  idempotent,
  isDatabaseUnavailable,
  readBoundedObject,
  seededFictionalOrganizationIds,
  untilDatabaseReachable,
  withScope,
  type AuthContext,
  type ObjectStore,
  type Pool,
  type PoolClient,
} from '@ledger/persistence';
import {
  acceptCommand,
  acceptInput,
  commandCapability,
  createFlight,
  getCommand,
  getFlight,
  getFlights,
  getFindings,
  getObservationGrants,
  getOrders,
  getReceipt,
  getReceipts,
  getRulePackVersion,
  listRulePackVersions,
  getRuleSource,
  getOrganizationCoverage,
  getAdoptionRuleCoverage,
  listRuleCoverageSubjects,
  listSubjectsOnRecord,
  listOpenFindings,
  listOpenFindingGroups,
  getFlightsOnRecord,
  getOrganizationPeople,
  getOrganizationDecisions,
  getFlightRuleSelection,
  getFlightRuleSelectionRecord,
  getFlightMission,
  getFlightMissionRevision,
  getCommandLinkBaseline,
  getMonitoringWindow,
  getMissionAvoidance,
  getMissionRouteSuggestion,
  getMissionRelease,
  getMissionReleaseValidity,
  getMissionReleaseFindings,
  getFlightControls,
  getMissionDepartureAuthorization,
  getMissionBriefing,
  getMissionBriefingAcknowledgements,
  getPrincipalAuthority,
  getOrganizationSummary,
  listPrincipalAuthority,
  listCredentials,
  getAcceptedAreaControl,
  listObservations,
  getRuleEvaluation,
  inputSubjectsOf,
  flightFindingReadContext,
  summaryWordingOf,
  listRuleEvaluations,
  listSubjectFindings,
  getTimeline,
  requireRow,
  responseMeta,
  configureNoticeChannels,
  noticeDeployment,
} from '@ledger/domain';
import { sha256 } from '@ledger/integrity';
import { examplePacksEnabled, packOffered, registerPackFolder, registerStandardPacks } from '@ledger/standard-packs';
import { readSourceCapabilities } from './sources.js';
import {
  createExport as issueExport,
  getExport,
  getExportObject,
  createSubjectExport,
  getSubjectExport,
  getSubjectExportObject,
  listSubjectExports,
} from '@ledger/evidence';
import { liveChanges, liveCursor, parseLiveCursor, telemetrySnapshot } from './telemetry.js';
import { registerDecisionPacketRoutes } from './decision-packets.js';
import { registerFindingPacketRoutes } from './finding-packets.js';
import { registerAssuranceHistoryRoutes } from './assurance-history.js';
import {
  registerSimulationAvoidanceDemoRoutes,
  simulationAvoidanceDemoConfiguration,
} from './simulation-avoidance-demo.js';
import { reauthenticator, registerSmsRoutes, type RequestIdentity } from './sms.js';
import {
  createTokenVerifier,
  publicSignInConfiguration,
  signInSettings,
  type SignInSettings,
  type TokenVerifierOptions,
} from './openid-connect.js';
import { registerOperatorRecordRoutes } from './operator-records.js';
import { registerRecordSubjectRoutes } from './operator-record-subjects.js';
import { registerRequiredRecordRoutes } from './required-records.js';
import { registerRecordProductionRoutes, SHARED_RECORDS_PATHS } from './record-productions.js';
import { PROGRAM_VIEW_PATHS, registerProgramViewRoutes } from './program-view-routes.js';
import { registerReportRoutes } from './report-routes.js';
import { registerControlWindowRoutes } from './control-windows.js';
import { registerPeopleRoutes } from './people-routes.js';
import { registerNoticeRoutes } from './notice-routes.js';
import {
  registerSafetyReportRoutes,
  UNATTRIBUTED_PATHS,
  UNAUTHENTICATED_REPORT_PATHS,
} from './safety-report-submission.js';
import type { MetricsRegistry } from '@ledger/metrics';
import { instrumentRequests } from './request-metrics.js';
import {
  RequestLimiter,
  requestLimitRefusal,
  requestLimitSettings,
  type RequestLimitSettings,
} from './request-limit.js';

export interface AppOptions {
  db?: Pool;
  pool?: Pool;
  objectStore?: ObjectStore;
  env?: 'local' | 'test' | 'staging';
  logger?: FastifyServerOptions['logger'];
  simulationAvoidanceDemo?: SimulationAvoidanceDemoConfig;
  flightPredeparture?: FlightPredepartureConfig;
  /** The folder of the organization's pack files; defaults to LEDGER_PACKS_DIR. */
  packsDir?: string;
  /** The built web app to serve from the API's origin; defaults to LEDGER_WEB_DIR. Unset: the API serves none. */
  webDir?: string;
  /** The OpenID Connect issuers and deployment name; defaults to the LEDGER_OIDC_* and LEDGER_DEPLOYMENT_NAME variables. */
  signIn?: SignInSettings;
  /** Overrides how the API reaches identity providers, for tests. */
  identityProvider?: Pick<TokenVerifierOptions, 'fetch' | 'keyRefetchCooldownMs'>;
  /** Whether email notices are written; defaults to whether LEDGER_SMTP_HOST configures a mail server. */
  noticeEmail?: boolean;
  /** Called with every route as it is registered, before any; a test reads the whole route table through it. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
  /** The process's metrics; unset, the API measures nothing. */
  metrics?: MetricsRegistry;
  /** The request limit per credential; defaults to the LEDGER_REQUEST_* variables. */
  requestLimit?: RequestLimitSettings;
}
/** What a credential's bucket is kept under: a digest of the token, or of the account a sign-in token names. */
function credentialKey(bearer: string, identity: RequestIdentity): string {
  return sha256(identity.issuer && identity.subject ? `${identity.issuer}\n${identity.subject}` : bearer);
}
/**
 * The routes other than reads that a principal who holds only reads may still send (docs/design/shared-links.md):
 * reporting a safety concern, which Ledger takes from anyone; a read sent as a POST, which checks its own
 * capabilities; a person's own choice of which notices reach them, which changes no record; and the commands, of which
 * such a principal may send only an acknowledgement of what was issued to them.
 */
export const OPEN_TO_READERS: ReadonlySet<string> = new Set([
  'POST /v1/safety-reports',
  'PUT /v1/notices/settings',
  'POST /v1/flights/:id/mission/route-suggestion',
  'POST /v1/commands',
]);
/** The commands a principal who holds only reads may send: acknowledging a document or a briefing issued to them. */
export const ACKNOWLEDGEMENT_COMMANDS: readonly string[] = ['sms.document.acknowledge', 'mission.briefing-acknowledge'];
const readsOnlyRefusal = () =>
  new DomainError(
    403,
    'reads_only',
    'You may read records here and change nothing. Ask the person who manages authority in your organization.',
  );
/** What a request is answered while the database cannot be reached: it may not have been completed. */
const DATABASE_UNAVAILABLE = {
  code: 'database_unavailable',
  message:
    'Ledger cannot reach its database right now, so this request may not have been completed. Try it again in a moment.',
};
type AuthRequest = FastifyRequest & {
  ledgerPrincipal: AuthContext;
  ledgerIdentity: RequestIdentity;
};
function token(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (!value?.startsWith('Bearer '))
    throw new DomainError(401, 'unauthenticated', 'A verified bearer credential is required');
  return value.slice(7);
}
/**
 * Refuses a verified sign-in whose account is tied to no one, showing the person only their own account (the issuer and
 * subject of the token they presented) to pass to an administrator. An account tied to someone is refused as before.
 */
async function refuseUntiedAccount(pool: Pool, identity: RequestIdentity): Promise<void> {
  if (!identity.issuer || !identity.subject) return;
  if (await signInAccountTied(pool, { issuer: identity.issuer, subject: identity.subject })) return;
  throw new DomainError(
    401,
    'sign_in_account_not_tied',
    'You signed in, but this account is not tied to anyone in Ledger. Give your administrator the sign-in provider ' +
      'and account below. On the People screen they add you with them as your sign-in provider and account ' +
      '(subject); if you are listed under another account, they deactivate that entry and add you again. Then sign in ' +
      'again.',
    { issuer: identity.issuer, subject: identity.subject },
  );
}
/** A person is tied only to an issuer the API accepts tokens from, once any is configured. */
function refuseUnconfiguredIssuer(command: Command, signIn: SignInSettings): void {
  const issuer = command.kind === 'person.add' ? command.signIn?.issuer : undefined;
  if (issuer && signIn.issuers.length && !signIn.issuers.some((setting) => setting.issuer === issuer))
    throw new DomainError(
      400,
      'sign_in_issuer_unknown',
      'This deployment does not accept sign-in from that issuer; choose one of its configured issuers',
    );
}
/**
 * What the request log keeps of a request, as Fastify's own line does, except for the requests a person using a
 * reporting link or a link to produced records makes: the safety report routes, the routes the shared records page
 * reads, the read a program grant opens, and the web app's own files when the API serves them (those pages and the
 * files they load). Those keep only the method and path, never an address, port or user agent
 * (docs/design/report-submission.md, docs/design/shared-links.md, docs/design/program-owner-view.md).
 */
function requestLogLine(request: FastifyRequest, servesWebApp: boolean) {
  const path = request.url.split('?')[0]!;
  if (
    UNATTRIBUTED_PATHS.has(path) ||
    SHARED_RECORDS_PATHS.includes(path) ||
    PROGRAM_VIEW_PATHS.includes(path) ||
    (servesWebApp && isWebAppRequest(request.method, request.url))
  )
    return { method: request.method, url: path };
  return {
    method: request.method,
    url: request.url,
    version: request.headers?.['accept-version']?.toString(),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
function loggerOptions(logger: AppOptions['logger'], servesWebApp: boolean): FastifyServerOptions['logger'] {
  if (!logger) return false;
  const base = logger === true ? {} : logger;
  return {
    ...base,
    serializers: { ...base.serializers, req: (request: FastifyRequest) => requestLogLine(request, servesWebApp) },
  };
}
function key(request: FastifyRequest): string {
  return String(request.headers['idempotency-key'] ?? '');
}
async function taskTrace(
  client: PoolClient,
  eventId: string,
): Promise<{ taskId: string; eventId: string; streamId: string; streamSequence: string }> {
  const row = (
    await client.query('SELECT id,event_id,stream_id,stream_sequence FROM work_items WHERE event_id=$1', [eventId])
  ).rows[0];
  return {
    taskId: row.id,
    eventId: row.event_id,
    streamId: row.stream_id,
    streamSequence: String(row.stream_sequence),
  };
}
function traceAccepted(request: FastifyRequest, trace: Record<string, unknown>): void {
  try {
    request.log.info(trace, 'Committed Ledger acceptance');
  } catch {}
}
function upload(row: Record<string, any>): Upload {
  return {
    id: row.id,
    status: row.status,
    contentType: row.content_type,
    byteLength: row.byte_length,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
    expiresAt: row.expires_at.toISOString(),
    confidentiality: row.confidentiality,
  };
}
function artifact(row: Record<string, any>): Artifact {
  return {
    id: row.id,
    uploadId: row.upload_id,
    sha256: row.sha256,
    byteLength: row.byte_length,
    contentType: row.content_type,
    key: row.object_key,
    confidentiality: row.confidentiality ?? 'ordinary',
  };
}
async function restrictedArtifact(client: PoolClient, id: string): Promise<Artifact> {
  const row = (await client.query('SELECT * FROM restricted_artifacts WHERE id=$1', [id])).rows[0];
  if (!row) throw new DomainError(404, 'not_found', 'Record was not found within your scope');
  return artifact(row);
}
/**
 * A briefing lists the controls it covers. The earlier command named one `control`; every sender now lists them, so
 * that form is refused with its own reason rather than a schema error.
 */
async function refuseSingleControlBriefing(request: FastifyRequest): Promise<void> {
  const body = request.body as { kind?: unknown; control?: unknown } | null;
  if (body?.kind === 'mission.brief' && body.control !== undefined)
    throw new DomainError(
      400,
      'briefing_controls_required',
      'A briefing lists the controls it covers as controls; a single control is no longer accepted',
    );
}

function rejectCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectCredentials(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const credentialNames = new Set([
    'authorization',
    'cookie',
    'password',
    'clientsecret',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'secretaccesskey',
  ]);
  for (const [name, item] of Object.entries(value)) {
    if (credentialNames.has(name.replaceAll('_', '').replaceAll('-', '').toLowerCase()))
      throw new DomainError(400, 'credential_payload', 'Credential fields must be excluded at the adapter boundary');
    rejectCredentials(item);
  }
}
export async function createApp(options: AppOptions = {}) {
  registerStandardPacks({ examples: examplePacksEnabled() });
  registerPackFolder(options.packsDir ?? process.env.LEDGER_PACKS_DIR);
  const flightPredeparture = flightPredepartureConfiguration(
    options.flightPredeparture ?? process.env.LEDGER_FLIGHT_PREDEPARTURE,
  );
  const simulationAvoidanceDemo = simulationAvoidanceDemoConfiguration(
    options.simulationAvoidanceDemo ?? process.env.LEDGER_SIMULATION_AVOIDANCE_DEMO,
  );
  const env = (options.env ??
    process.env.LEDGER_ENV ??
    (process.env.NODE_ENV === 'production' ? 'staging' : 'local')) as NonNullable<AppOptions['env']>;
  if (!['local', 'test', 'staging'].includes(env)) throw new Error('LEDGER_ENV must be local, test or staging');
  if (env !== 'staging' && process.env.NODE_ENV === 'production')
    throw new Error('Development authentication cannot run in production');
  // Email notices need a mail server and the address links open at; a start with one and not the other is refused.
  configureNoticeChannels({ email: options.noticeEmail ?? Boolean(noticeDeployment(process.env).smtp) });
  const pool = options.pool ?? options.db ?? createPool();
  const ownPool = !options.pool && !options.db;
  const store = options.objectStore ?? createObjectStore();
  const webDir = options.webDir ?? (process.env.LEDGER_WEB_DIR || undefined);
  const app = Fastify({
    logger: loggerOptions(options.logger, webDir !== undefined),
    bodyLimit: 10 * 1024 * 1024,
    genReqId: () => randomUUID(),
    // Scalar values are one schema with a list of types: with type coercion on, an anyOf of single types would turn
    // a value into the first branch's type. A list of types leaves a value of any listed type as it is.
    // verbose keeps each failure's schema and value, so a refusal can name what was expected.
    ajv: { customOptions: { removeAdditional: false, allowUnionTypes: true, verbose: true } },
    schemaErrorFormatter: (errors, part) => new Error(requestShapeRefusal(errors as SchemaError[], part)),
  });
  if (options.onRoute) {
    const onRoute = options.onRoute;
    app.addHook('onRoute', (route) => onRoute({ method: route.method, url: route.url }));
  }
  const apiMetrics = options.metrics ? instrumentRequests(app, options.metrics, pool) : undefined;
  const limits = options.requestLimit ?? requestLimitSettings(process.env, env);
  const limiter = limits.enabled ? new RequestLimiter(limits) : undefined;
  // The API starts while its database is still starting or restarting, and answers 503 until it is back.
  app.addHook('onReady', async () =>
    untilDatabaseReachable(
      () => assertApplicationRole(pool),
      (error, delayMs) =>
        app.log.warn({ code: error.code ?? 'unknown', retryInMs: delayMs }, 'Waiting for the database'),
    ),
  );
  const origins = (process.env.WEB_ORIGINS ?? process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: origins,
    methods: ['GET', 'HEAD', 'POST', 'PUT'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Last-Event-ID', 'X-Ledger-Reauthentication'],
    exposedHeaders: ['X-Request-Id', 'X-Content-SHA256', 'X-Manifest-SHA256', 'X-Evidence-Format'],
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  if (webDir) registerWebApp(app, webDir);
  app.decorateRequest('ledgerPrincipal', null);
  app.decorateRequest('ledgerIdentity', null);
  const signIn = options.signIn ?? signInSettings(env);
  if (env === 'staging' && !signIn.issuers.length)
    throw new Error(
      'People sign in through OpenID Connect outside local and test: set LEDGER_OIDC_ISSUER and LEDGER_OIDC_CLIENT_ID',
    );
  const verifier = signIn.issuers.length
    ? createTokenVerifier({ issuers: signIn.issuers, env, origins, ...options.identityProvider })
    : null;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    if (
      request.url.startsWith('/healthz') ||
      request.url.startsWith('/readyz') ||
      request.url.startsWith('/openapi.json') ||
      request.url === '/v1/sign-in' ||
      (request.method === 'POST' && UNAUTHENTICATED_REPORT_PATHS.includes(request.url)) ||
      (request.method === 'POST' && SHARED_RECORDS_PATHS.includes(request.url)) ||
      (request.method === 'POST' && PROGRAM_VIEW_PATHS.includes(request.url)) ||
      request.method === 'OPTIONS' ||
      (webDir && isWebAppRequest(request.method, request.url))
    )
      return;
    const bearer = token(request);
    let principal: AuthContext | null = null;
    let identity: AuthRequest['ledgerIdentity'] = {};
    if (bearer.startsWith('ledger-dev-')) {
      if (env !== 'local' && env !== 'test')
        throw new DomainError(401, 'development_auth_disabled', 'Development credentials are disabled');
      identity = { token: bearer };
      principal = await authenticate(pool, identity);
    } else if (bearer.startsWith('ledger-service-')) {
      identity = { token: bearer };
      principal = await authenticate(pool, identity);
      if (principal?.kind === 'human') principal = null;
    } else if (verifier) {
      identity = await verifier.verify(bearer);
      principal = await authenticate(pool, identity);
      if (!principal) await refuseUntiedAccount(pool, identity);
    }
    if (!principal)
      throw new DomainError(401, 'unauthenticated', 'Credential is invalid or has no current Ledger membership');
    const waitSeconds = limiter?.admit(credentialKey(bearer, identity), principal.kind);
    if (waitSeconds !== undefined) {
      apiMetrics?.limited(principal.kind ?? 'unknown');
      reply.header('Retry-After', String(waitSeconds));
      throw requestLimitRefusal(waitSeconds, limiter!.settingsFor(principal.kind));
    }
    // Before the body is read: a principal who holds only reads sends nothing that changes a record.
    if (
      readsOnly(principal.capabilities) &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !OPEN_TO_READERS.has(`${request.method} ${request.routeOptions.url}`)
    )
      throw readsOnlyRefusal();
    (request as AuthRequest).ledgerPrincipal = principal;
    (request as AuthRequest).ledgerIdentity = identity;
  });
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    if (!(error instanceof DomainError) && isDatabaseUnavailable(error)) {
      request.log.warn({ code: (error as any).code ?? 'unknown', requestId: request.id }, 'Database unavailable');
      return reply.code(503).header('Retry-After', '5').send({ error: DATABASE_UNAVAILABLE, requestId: request.id });
    }
    if (error instanceof DomainError)
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        requestId: request.id,
      });
    const status = error.statusCode ?? 500;
    if (status >= 500)
      request.log.error(
        {
          name: error.name,
          code: (error as any).code ?? 'unknown',
          requestId: request.id,
          databasePool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        },
        'Request failed',
      );
    return reply.code(status).send({
      error: {
        code: error.validation
          ? 'invalid_request'
          : status === 413
            ? 'input_too_large'
            : status >= 500
              ? 'internal_error'
              : 'invalid_request',
        message: status >= 500 ? 'The request could not be completed' : error.message,
      },
      requestId: request.id,
    });
  });
  const principal = (request: FastifyRequest) => (request as AuthRequest).ledgerPrincipal;
  const read = <T>(
    request: FastifyRequest,
    capability: string | undefined,
    operation: (client: PoolClient, who: AuthContext) => Promise<T>,
  ) => withScope(pool, principal(request), operation, capability, true);
  /** A read of the organization's rules: open to whoever reads flights or reads evidence. */
  const readRules = <T>(request: FastifyRequest, operation: (client: PoolClient, who: AuthContext) => Promise<T>) =>
    read(request, undefined, async (client, who) => {
      if (!who.capabilities.includes('flight:read') && !who.capabilities.includes('evidence:read'))
        throw new DomainError(403, 'capability_required', 'Reading the rules requires flight:read or evidence:read');
      return operation(client, who);
    });
  let exportOperations = 0;
  const boundedExport = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (exportOperations >= 2)
      throw new DomainError(429, 'export_busy', 'Two bounded export operations are already active; retry this request');
    exportOperations++;
    try {
      return await operation();
    } finally {
      exportOperations--;
    }
  };
  registerDecisionPacketRoutes(app, { pool, store, principal, key, boundedOperation: boundedExport });
  registerFindingPacketRoutes(app, { pool, store, principal, key, boundedOperation: boundedExport });
  registerAssuranceHistoryRoutes(app, { pool, principal });
  registerOperatorRecordRoutes(app, { pool, store, principal });
  registerRecordSubjectRoutes(app, { pool, principal });
  registerRequiredRecordRoutes(app, { pool, principal });
  registerRecordProductionRoutes(app, { pool, store, principal, key, boundedOperation: boundedExport });
  registerControlWindowRoutes(app, { pool, principal, key });
  registerReportRoutes(app, { pool, principal });
  registerPeopleRoutes(app, { pool, env, principal });
  registerNoticeRoutes(app, { pool, env, principal });
  registerProgramViewRoutes(app, { pool, env, principal, key });
  registerSafetyReportRoutes(app, { pool, store, principal, key });
  registerFlightPredepartureRoutes(app, { pool, principal, config: flightPredeparture });
  registerSimulationAvoidanceDemoRoutes(app, { pool, principal, config: simulationAvoidanceDemo });
  registerSmsRoutes(app, {
    pool,
    store,
    env,
    principal,
    identity: (request) => (request as AuthRequest).ledgerIdentity,
    key,
    boundedOperation: boundedExport,
  });
  const watches = new Set<() => void>();
  const principalWatches = new Map<string, number>();
  app.addHook('preClose', async () => {
    for (const close of watches) close();
  });
  app.get('/healthz', async () => ({ status: 'ok', simulation: true }));
  app.get('/v1/sign-in', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return publicSignInConfiguration(signIn, verifier, env);
  });
  app.get('/readyz', async () => {
    let result;
    try {
      result = await pool.query(
        'SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
      );
    } catch {
      throw new DomainError(503, DATABASE_UNAVAILABLE.code, DATABASE_UNAVAILABLE.message);
    }
    if (result.rows[0]?.rolsuper || result.rows[0]?.rolbypassrls || result.rows[0]?.role !== 'ledger_app')
      throw new DomainError(503, 'unsafe_database_role', 'API requires its non-owner application database role');
    return { status: 'ready', role: 'ledger_app' };
  });
  app.get('/openapi.json', async () => {
    const document = await import('@ledger/contracts/openapi');
    return document.openApiDocument;
  });
  app.get('/v1/me', async (request) =>
    withScope(pool, principal(request), async (client, who) => ({
      principal: {
        id: who.id,
        tenantId: who.tenantId,
        name: who.name,
        kind: who.kind,
        capabilities: who.capabilities,
        commandLinkSources: who.commandLinkSources ?? [],
        missionSources: who.missionSources ?? [],
        monitoringSources: who.monitoringSources ?? [],
        observationGrants: await getObservationGrants(client, who.tenantId, who.id),
        revision: who.revision,
      },
      organization: await getOrganizationSummary(client, who.tenantId),
    })),
  );
  app.get<{ Querystring: PrincipalAuthorityListQuery }>(
    '/v1/authority/principals',
    {
      schema: { querystring: PrincipalAuthorityListQuerySchema },
      async onSend(_request, reply, payload) {
        reply.header('Cache-Control', 'private, no-store');
        return payload;
      },
    },
    async (request) =>
      read(request, 'authority:write', (client, who) => listPrincipalAuthority(client, who, request.query)),
  );
  app.get<{ Querystring: CredentialListQuery }>(
    '/v1/authority/credentials',
    {
      schema: { querystring: CredentialListQuerySchema },
      async onSend(_request, reply, payload) {
        reply.header('Cache-Control', 'private, no-store');
        return payload;
      },
    },
    async (request) => read(request, 'authority:write', (client, who) => listCredentials(client, who, request.query)),
  );
  app.get<{ Params: AuthorityPrincipalParams }>(
    '/v1/authority/principals/:id',
    {
      schema: { params: AuthorityPrincipalParamsSchema },
      async onSend(_request, reply, payload) {
        reply.header('Cache-Control', 'private, no-store');
        return payload;
      },
    },
    async (request) =>
      read(request, 'authority:write', (client, who) => getPrincipalAuthority(client, who, request.params.id)),
  );
  app.get('/v1/rule-packs', async (request) =>
    readRules(request, async (_client, who) => {
      const organization = { fictional: seededFictionalOrganizationIds.includes(who.tenantId) };
      return { packs: listRulePackVersions().filter((pack) => packOffered(pack.packId, organization)) };
    }),
  );
  app.get<{ Params: RulePackVersionParams }>(
    '/v1/rule-packs/:packId/versions/:version',
    { schema: { params: RulePackVersionParamsSchema } },
    async (request) =>
      readRules(request, async () => {
        const pack = getRulePackVersion(request.params.packId, request.params.version);
        if (!pack) throw new DomainError(404, 'rule_pack_not_found', 'The requested rule pack version was not found');
        return { pack };
      }),
  );
  app.get<{ Querystring: OrganizationPeopleQuery }>(
    '/v1/organization/people',
    { schema: { querystring: OrganizationPeopleQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'flight:read', (client, who) =>
        getOrganizationPeople(client, who, request.query, request.id),
      );
    },
  );
  app.get('/v1/organization/coverage', async (request) =>
    readRules(request, async (client, who) => {
      const coverage = await getOrganizationCoverage(client, who);
      return { ...coverage, meta: { ...coverage.meta, requestId: request.id } };
    }),
  );
  app.get<{ Params: AdoptionCoverageParams }>(
    '/v1/organization/coverage/adoptions/:adoptionId',
    { schema: { params: AdoptionCoverageParamsSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) =>
        getAdoptionRuleCoverage(client, who, request.params.adoptionId),
      );
    },
  );
  app.get<{ Params: RuleCoverageSubjectsParams; Querystring: RuleCoverageSubjectsQuery }>(
    '/v1/organization/coverage/adoptions/:adoptionId/rules/:leafId/subjects',
    { schema: { params: RuleCoverageSubjectsParamsSchema, querystring: RuleCoverageSubjectsQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) =>
        listRuleCoverageSubjects(client, who, request.params.adoptionId, request.params.leafId, request.query),
      );
    },
  );
  app.get<{ Querystring: OpenFindingsQuery }>(
    '/v1/organization/open-findings',
    { schema: { querystring: OpenFindingsQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listOpenFindings(client, who, request.query));
    },
  );
  app.get<{ Querystring: OpenFindingGroupsQuery }>(
    '/v1/organization/open-findings/groups',
    { schema: { querystring: OpenFindingGroupsQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listOpenFindingGroups(client, who, request.query));
    },
  );
  app.get('/v1/organization/flights-on-record', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return read(request, 'evidence:read', (client, who) => getFlightsOnRecord(client, who));
  });
  app.get<{ Querystring: SubjectsOnRecordQuery }>(
    '/v1/organization/subjects',
    { schema: { querystring: SubjectsOnRecordQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listSubjectsOnRecord(client, who, request.query));
    },
  );
  app.get('/v1/organization/decisions', async (request) =>
    read(request, 'flight:read', async (client, who) => {
      const history = await getOrganizationDecisions(client, who, true);
      return { ...history, meta: { ...history.meta, requestId: request.id } };
    }),
  );
  app.get<{ Params: MonitoringWindowParams }>(
    '/v1/organization/monitoring-windows/:monitoringId',
    { schema: { params: MonitoringWindowParamsSchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) => getMonitoringWindow(client, who, request.params.monitoringId)),
  );
  app.get<{ Params: RuleSourceParams }>(
    '/v1/rule-sources/:sourceId/content',
    { schema: { params: RuleSourceParamsSchema } },
    async (request, reply) => {
      const source = await readRules(request, async () => {
        const retained = await getRuleSource(request.params.sourceId);
        if (!retained) throw new DomainError(404, 'rule_source_not_found', 'The retained rule source was not found');
        return retained;
      });
      return reply
        .type(source.contentType)
        .header('X-Content-SHA256', source.sha256)
        .header('Content-Disposition', `attachment; filename="${source.filename}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-store')
        .send(Buffer.from(source.bytes));
    },
  );
  app.post<{ Body: UploadCreate }>('/v1/uploads', { schema: { body: UploadCreateSchema } }, async (request, reply) => {
    const result = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          '/v1/uploads',
          key(request),
          request.body,
          async () => {
            const id = randomUUID();
            const confidentiality = request.body.confidentiality ?? 'ordinary';
            const row = (
              await client.query(
                'INSERT INTO uploads(id,tenant_id,principal_id,content_type,byte_length,filename,object_key,confidentiality) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                [
                  id,
                  who.tenantId,
                  who.id,
                  request.body.contentType,
                  request.body.byteLength,
                  request.body.filename ?? null,
                  confidentiality === 'ordinary'
                    ? `${who.tenantId}/${id}/content`
                    : `${who.tenantId}/restricted/${id}/content`,
                  confidentiality,
                ],
              )
            ).rows[0];
            return { id, value: upload(row) };
          },
          async (id) => upload(await requireRow(client, 'uploads', id)),
        );
        return { upload: accepted.value, meta: await responseMeta(client, request.id, who, accepted.value.id) };
      },
      'input:write',
    );
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/v1/uploads/:id', async (request) =>
    read(request, 'evidence:read', async (client, who) => ({
      upload: upload(await requireRow(client, 'uploads', request.params.id)),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.put<{ Params: { id: string }; Body: Buffer }>('/v1/uploads/:id/content', async (request, reply) => {
    if (!Buffer.isBuffer(request.body))
      throw new DomainError(400, 'bytes_required', 'Upload content must use application/octet-stream');
    const data = request.body;
    const digest = sha256(data);
    const pending = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const row = await requireRow(client, 'uploads', request.params.id);
        if (row.principal_id !== who.id)
          throw new DomainError(403, 'upload_owner_required', 'Only this upload producer can write content');
        if (row.byte_length !== data.byteLength)
          throw new DomainError(400, 'byte_length_mismatch', 'Uploaded byte length differs from the declared length');
        if (row.expires_at < Date.now()) throw new DomainError(410, 'upload_expired', 'Upload session expired');
        return row;
      },
      'input:write',
    );
    try {
      await store.putIfAbsent(pending.object_key, data, pending.content_type);
    } catch (error: any) {
      if (String(error.message).includes('different content'))
        throw new DomainError(409, 'immutable_object_conflict', 'Upload already contains different bytes');
      throw error;
    }
    const result = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          `/v1/uploads/${pending.id}/content`,
          key(request),
          { sha256: digest, byteLength: data.byteLength },
          async () => {
            const row = await requireRow(client, 'uploads', pending.id, true);
            if (row.sha256 && row.sha256 !== digest)
              throw new DomainError(409, 'immutable_object_conflict', 'Upload already contains different bytes');
            const next = (
              await client.query(
                "UPDATE uploads SET status=CASE WHEN status='finalized' THEN status ELSE 'stored' END,sha256=$1 WHERE id=$2 RETURNING *",
                [digest, pending.id],
              )
            ).rows[0];
            return { id: pending.id, value: upload(next) };
          },
          async (id) => upload(await requireRow(client, 'uploads', id)),
        );
        return { upload: accepted.value, meta: await responseMeta(client, request.id, who, pending.id) };
      },
      'input:write',
    );
    return reply.send(result);
  });
  app.post<{ Params: { id: string } }>('/v1/uploads/:id/finalize', async (request, reply) => {
    const pending = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const row = await requireRow(client, 'uploads', request.params.id);
        if (row.principal_id !== who.id)
          throw new DomainError(403, 'upload_owner_required', 'Only this upload producer can finalize content');
        return row;
      },
      'input:write',
    );
    let bytes: Uint8Array;
    try {
      bytes = await store.get(pending.object_key);
    } catch {
      throw new DomainError(409, 'upload_incomplete', 'Immutable upload content is not available');
    }
    if (bytes.byteLength !== pending.byte_length)
      throw new DomainError(409, 'byte_length_mismatch', 'Stored content length is invalid');
    const digest = sha256(bytes);
    const result = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          `/v1/uploads/${pending.id}/finalize`,
          key(request),
          { uploadId: pending.id },
          async () => {
            const row = await requireRow(client, 'uploads', pending.id, true);
            if (row.sha256 && row.sha256 !== digest)
              throw new DomainError(409, 'digest_mismatch', 'Stored content failed integrity verification');
            const ordinary = row.confidentiality === 'ordinary';
            if (row.artifact_id)
              return {
                id: row.artifact_id,
                value: ordinary
                  ? artifact(await requireRow(client, 'artifacts', row.artifact_id))
                  : await restrictedArtifact(client, row.artifact_id),
              };
            const id = randomUUID();
            const value = (
              ordinary
                ? await client.query(
                    'INSERT INTO artifacts(id,tenant_id,upload_id,object_key,sha256,byte_length,content_type,object_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                    [id, who.tenantId, row.id, row.object_key, digest, bytes.byteLength, row.content_type, digest],
                  )
                : await client.query(
                    'INSERT INTO restricted_artifacts(id,tenant_id,upload_id,object_key,sha256,byte_length,content_type,confidentiality) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
                    [
                      id,
                      who.tenantId,
                      row.id,
                      row.object_key,
                      digest,
                      bytes.byteLength,
                      row.content_type,
                      row.confidentiality,
                    ],
                  )
            ).rows[0];
            await client.query("UPDATE uploads SET status='finalized',sha256=$1,artifact_id=$2 WHERE id=$3", [
              digest,
              id,
              row.id,
            ]);
            return { id, value: artifact(value) };
          },
          async (id) =>
            pending.confidentiality === 'ordinary'
              ? artifact(await requireRow(client, 'artifacts', id))
              : restrictedArtifact(client, id),
        );
        return { artifact: accepted.value, meta: await responseMeta(client, request.id, who, accepted.value.id) };
      },
      'input:write',
    );
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/v1/artifacts/:id/content', async (request, reply) => {
    const row = await read(request, 'evidence:read', async (client) =>
      requireRow(client, 'artifacts', request.params.id),
    );
    const bytes = await store.get(row.object_key);
    if (bytes.byteLength !== row.byte_length || sha256(bytes) !== row.sha256)
      throw new DomainError(409, 'artifact_integrity_failure', 'Retained bytes do not match the receipt commitment');
    return reply
      .type(row.content_type)
      .header('X-Content-SHA256', row.sha256)
      .header('Cache-Control', 'private, no-store')
      .send(Buffer.from(bytes));
  });
  app.get<{ Params: { id: string } }>('/v1/artifacts/:id', async (request) =>
    read(request, 'evidence:read', async (client, who) => ({
      artifact: artifact(await requireRow(client, 'artifacts', request.params.id)),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.post<{ Body: Input }>('/v1/inputs', { schema: { body: InputSchema } }, async (request, reply) => {
    rejectCredentials(request.body);
    const accepted = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          '/v1/inputs',
          key(request),
          request.body,
          async () => {
            const receipt = await acceptInput(client, who, request.body, { objectStore: store });
            return { id: receipt.id, value: receipt };
          },
          (id) => getReceipt(client, id),
        );
        return {
          response: {
            receipt: accepted.value,
            meta: await responseMeta(client, request.id, who, accepted.value.id, accepted.value.flightId),
          },
          trace: {
            event: 'input.accepted',
            requestId: request.id,
            tenantId: who.tenantId,
            principalId: who.id,
            receiptId: accepted.value.id,
            ...(await taskTrace(client, accepted.value.eventId)),
            replayed: accepted.replayed,
          },
        };
      },
      'input:write',
    );
    traceAccepted(request, accepted.trace);
    return reply.code(201).send(accepted.response);
  });
  app.get<{ Querystring: ObservationQuery }>(
    '/v1/observations',
    { schema: { querystring: ObservationQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listObservations(client, who, request.query));
    },
  );
  app.get<{ Querystring: SubjectRecordQuery }>(
    '/v1/evaluations',
    { schema: { querystring: SubjectRecordQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listRuleEvaluations(client, who, request.query));
    },
  );
  app.get<{ Params: RuleEvaluationParams }>(
    '/v1/evaluations/:id',
    { schema: { params: RuleEvaluationParamsSchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', async (client, who) => {
        const evaluation = await getRuleEvaluation(client, who, request.params.id);
        return {
          evaluation,
          inputSubjects: await inputSubjectsOf(client, who.tenantId, [evaluation]),
          summaryWording: summaryWordingOf([evaluation]),
        };
      });
    },
  );
  app.get<{ Querystring: SubjectRecordQuery }>(
    '/v1/findings',
    { schema: { querystring: SubjectRecordQuerySchema } },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return read(request, 'evidence:read', (client, who) => listSubjectFindings(client, who, request.query));
    },
  );
  app.get<{ Params: { id: string } }>('/v1/receipts/:id', async (request) =>
    read(request, 'flight:read', async (client, who) => ({
      receipt: await getReceipt(client, request.params.id),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.get<{ Params: FlightRuleSelectionParams }>(
    '/v1/flights/:id/rule-selection',
    { schema: { params: FlightRuleSelectionParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => ({
        ...(await getFlightRuleSelection(client, who, request.params.id)),
        meta: await responseMeta(client, request.id, who, undefined, request.params.id),
      })),
  );
  app.get<{ Params: FlightRuleSelectionRecordParams }>(
    '/v1/flights/:id/rule-selections/:selectionId',
    { schema: { params: FlightRuleSelectionRecordParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => ({
        selection: await getFlightRuleSelectionRecord(client, who, request.params.id, request.params.selectionId),
      })),
  );
  app.get<{ Params: FlightMissionParams }>(
    '/v1/flights/:id/mission',
    { schema: { params: FlightMissionParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => {
        const shown = await getFlightMission(client, who, request.params.id);
        return { ...shown, meta: { ...shown.meta, requestId: request.id } };
      }),
  );
  app.get<{ Params: FlightMissionRevisionParams }>(
    '/v1/flights/:id/mission/revisions/:revision',
    { schema: { params: FlightMissionRevisionParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) =>
        getFlightMissionRevision(client, who, request.params.id, request.params.revision),
      ),
  );
  app.get<{ Params: FlightCommandLinkBaselineParams }>(
    '/v1/flights/:id/command-link-baselines/:baselineId',
    { schema: { params: FlightCommandLinkBaselineParamsSchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) =>
        getCommandLinkBaseline(client, who, request.params.id, request.params.baselineId),
      ),
  );
  app.get<{ Params: FlightMissionAvoidanceParams }>(
    '/v1/flights/:id/mission-avoidance',
    { schema: { params: FlightMissionAvoidanceParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => {
        const shown = await getMissionAvoidance(client, who, request.params.id);
        return { ...shown, meta: { ...shown.meta, requestId: request.id } };
      }),
  );
  app.post<{ Params: FlightMissionParams; Body: MissionRouteSuggestionRequest }>(
    '/v1/flights/:id/mission/route-suggestion',
    { schema: { params: FlightMissionParamsSchema, body: MissionRouteSuggestionRequestSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => {
        const shown = await getMissionRouteSuggestion(client, who, request.params.id, request.body);
        return { ...shown, meta: { ...shown.meta, requestId: request.id } };
      }),
  );
  app.get<{ Params: FlightMissionReleaseParams }>(
    '/v1/flights/:id/mission-releases/:releaseId',
    { schema: { params: FlightMissionReleaseParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) =>
        getMissionRelease(client, who, request.params.id, request.params.releaseId),
      ),
  );
  app.get<{ Params: FlightMissionReleaseFindingsParams }>(
    '/v1/flights/:id/mission-release-findings',
    { schema: { params: FlightMissionReleaseFindingsParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => getMissionReleaseFindings(client, who, request.params.id)),
  );
  app.get<{ Params: FlightControlsParams }>(
    '/v1/flights/:id/controls',
    { schema: { params: FlightControlsParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => getFlightControls(client, who, request.params.id, true)),
  );
  app.get<{ Params: FlightMissionReleaseParams }>(
    '/v1/flights/:id/mission-releases/:releaseId/validity',
    { schema: { params: FlightMissionReleaseParamsSchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) =>
        getMissionReleaseValidity(client, who, request.params.id, request.params.releaseId, true),
      ),
  );
  app.get<{ Params: FlightMissionBriefingParams }>(
    '/v1/flights/:id/briefings/:briefingId',
    { schema: { params: FlightMissionBriefingParamsSchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) =>
        getMissionBriefing(client, who, request.params.id, request.params.briefingId, true),
      ),
  );
  app.get<{ Params: FlightMissionBriefingParams }>(
    '/v1/flights/:id/briefings/:briefingId/acknowledgements',
    { schema: { params: FlightMissionBriefingParamsSchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) =>
        getMissionBriefingAcknowledgements(client, who, request.params.id, request.params.briefingId),
      ),
  );
  app.get<{ Params: AcceptedAreaControlParams }>(
    '/v1/area-controls/:hazardId/:controlId/versions/:version',
    { schema: { params: AcceptedAreaControlParamsSchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) =>
        getAcceptedAreaControl(client, who, request.params.hazardId, request.params.controlId, request.params.version),
      ),
  );
  app.get<{ Params: { id: string } }>('/v1/flights/:id/findings', async (request) =>
    read(request, 'flight:read', async (client, who) => {
      await requireRow(client, 'flight_views', request.params.id);
      const findings = await getFindings(client, request.params.id);
      return {
        findings,
        ...(await flightFindingReadContext(client, findings)),
        meta: await responseMeta(client, request.id, who, undefined, request.params.id),
      };
    }),
  );
  app.get<{ Querystring: ReceiptQuery }>(
    '/v1/receipts',
    { schema: { querystring: ReceiptQuerySchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => ({
        ...(await getReceipts(client, who, request.query)),
        meta: await responseMeta(client, request.id, who),
      })),
  );
  app.post<{ Body: FlightCreate }>('/v1/flights', { schema: { body: FlightCreateSchema } }, async (request, reply) => {
    const result = await withScope(
      pool,
      principal(request),
      async (client, who) => {
        const accepted = await idempotent(
          client,
          who,
          '/v1/flights',
          key(request),
          request.body,
          async () => {
            const flight = await createFlight(client, who, request.body);
            return { id: flight.id, value: flight };
          },
          (id) => getFlight(client, id),
        );
        return {
          flight: accepted.value,
          meta: await responseMeta(client, request.id, who, accepted.value.id, accepted.value.id),
        };
      },
      'flight:create',
    );
    return reply.code(201).send(result);
  });
  app.get<{ Querystring: FlightQuery }>(
    '/v1/flights',
    { schema: { querystring: FlightQuerySchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => ({
        ...(await getFlights(client, who, request.query)),
        meta: await responseMeta(client, request.id, who),
      })),
  );
  app.get<{ Params: { id: string } }>('/v1/flights/:id', async (request) =>
    read(request, 'flight:read', async (client, who) => ({
      flight: await getFlight(client, request.params.id),
      meta: await responseMeta(client, request.id, who, undefined, request.params.id),
    })),
  );
  app.get<{ Params: { id: string }; Querystring: TimelineQuery }>(
    '/v1/flights/:id/timeline',
    { schema: { querystring: TimelineQuerySchema } },
    async (request) =>
      read(request, 'flight:read', async (client, who) => ({
        flight: await getFlight(client, request.params.id),
        ...(await getTimeline(client, request.params.id, who, request.query)),
        availableCommands: who.capabilities,
        meta: await responseMeta(client, request.id, who, undefined, request.params.id),
      })),
  );
  app.get<{ Params: { id: string }; Querystring: TelemetryQuery }>(
    '/v1/flights/:id/telemetry',
    { schema: { querystring: TelemetryQuerySchema } },
    async (request) =>
      read(request, 'flight:read', (client, who) =>
        telemetrySnapshot(client, who, request.params.id, request.id, request.query),
      ),
  );
  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/v1/flights/:id/watch',
    async (request, reply) => {
      const who = principal(request),
        flightId = request.params.id,
        identity = (request as AuthRequest).ledgerIdentity;
      if (watches.size >= 16 || (principalWatches.get(who.id) ?? 0) >= 2)
        throw new DomainError(429, 'watch_busy', 'The bounded authenticated watch connection limit is reached');
      if (
        request.query.cursor !== undefined &&
        request.headers['last-event-id'] !== undefined &&
        request.query.cursor !== request.headers['last-event-id']
      )
        throw new DomainError(400, 'invalid_cursor', 'Query cursor and Last-Event-ID must agree');
      const supplied = request.query.cursor ?? request.headers['last-event-id'];
      if (supplied !== undefined && typeof supplied !== 'string')
        throw new DomainError(400, 'invalid_cursor', 'Watch cursor must be a single value');
      let cursor = await read(request, 'flight:read', async (client, current) => {
        await requireRow(client, 'flight_views', flightId);
        const position = Number(
          (await client.query('SELECT sequence FROM flight_live_heads WHERE flight_id=$1', [flightId])).rows[0]
            ?.sequence ?? 0,
        );
        return supplied ? parseLiveCursor(supplied) : parseLiveCursor(liveCursor(current, flightId, position));
      });
      if (watches.size >= 16 || (principalWatches.get(who.id) ?? 0) >= 2)
        throw new DomainError(429, 'watch_busy', 'The bounded authenticated watch connection limit is reached');
      const controller = new AbortController();
      let ended = false;
      const frame = (message: FlightWatchMessage): boolean => {
        if (ended || reply.raw.destroyed) return false;
        const id = 'cursor' in message ? `id: ${message.cursor}\n` : '';
        if (reply.raw.writableLength > 65536) {
          reply.raw.end(
            `event: resync_required\ndata: ${JSON.stringify({ type: 'resync_required', flightId, reason: 'slow_client' })}\n\n`,
          );
          ended = true;
          controller.abort();
          return false;
        }
        const ready = reply.raw.write(`${id}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
        if (!ready) {
          reply.raw.end(
            `event: resync_required\ndata: ${JSON.stringify({ type: 'resync_required', flightId, reason: 'slow_client' })}\n\n`,
          );
          ended = true;
          controller.abort();
          return false;
        }
        return true;
      };
      const close = () => {
        if (!ended) {
          frame({ type: 'stream.closed', flightId, reason: 'shutdown' });
          reply.raw.end();
        }
        ended = true;
        controller.abort();
      };
      watches.add(close);
      principalWatches.set(who.id, (principalWatches.get(who.id) ?? 0) + 1);
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) reply.raw.setHeader(name, value);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-store',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });
      reply.raw.write(': ready\n\n');
      reply.raw.once('close', () => {
        ended = true;
        controller.abort();
      });
      const started = Date.now();
      let heartbeat = started;
      const lifetime = setTimeout(
        () => {
          if (identity.expiresAt !== undefined && Date.now() >= identity.expiresAt)
            frame({ type: 'stream.closed', flightId, reason: 'authentication_expired' });
          ended = true;
          controller.abort();
          if (!reply.raw.destroyed) reply.raw.end();
        },
        Math.max(1, Math.min(60000, (identity.expiresAt ?? Infinity) - started)),
      );
      try {
        while (!ended && Date.now() - started < 60000) {
          if (
            identity.expiresAt !== undefined &&
            (!Number.isFinite(identity.expiresAt) || Date.now() >= identity.expiresAt)
          ) {
            frame({ type: 'stream.closed', flightId, reason: 'authentication_expired' });
            break;
          }
          try {
            const terminate = await withScope(
              pool,
              who,
              async (client, current) => {
                const membership = (
                  await client.query('SELECT * FROM ledger_authenticate($1,$2,$3)', [
                    identity.token ? sha256(identity.token) : null,
                    identity.issuer ?? null,
                    identity.subject ?? null,
                  ])
                ).rows[0];
                if (!membership?.active || membership.id !== who.id || membership.tenant_id !== who.tenantId) {
                  frame({ type: 'stream.closed', flightId, reason: 'access_revoked' });
                  return true;
                }
                const changes = await liveChanges(client, current, flightId, cursor);
                for (const message of changes) {
                  if (!frame(message)) return true;
                  if (message.type === 'resync_required') return true;
                  if ('cursor' in message) cursor = parseLiveCursor(message.cursor);
                }
                if (Date.now() - heartbeat >= 5000) {
                  if (!reply.raw.write(': heartbeat\n\n')) return true;
                  heartbeat = Date.now();
                }
                return false;
              },
              'flight:read',
              true,
              5000,
            );
            if (terminate) break;
          } catch (error) {
            if (error instanceof DomainError && [401, 403, 404].includes(error.status)) {
              frame({ type: 'stream.closed', flightId, reason: 'access_revoked' });
              break;
            }
            throw error;
          }
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) return resolve();
            const finish = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener('abort', finish);
                resolve();
              },
              timer = setTimeout(finish, 1000);
            controller.signal.addEventListener('abort', finish, { once: true });
          });
        }
      } catch {
        if (!ended) frame({ type: 'resync_required', flightId, reason: 'backlog' });
      } finally {
        clearTimeout(lifetime);
        ended = true;
        controller.abort();
        if (!reply.raw.destroyed) reply.raw.end();
        watches.delete(close);
        const count = (principalWatches.get(who.id) ?? 1) - 1;
        if (count) principalWatches.set(who.id, count);
        else principalWatches.delete(who.id);
      }
    },
  );
  app.get<{ Querystring: OrderQuery }>('/v1/orders', { schema: { querystring: OrderQuerySchema } }, async (request) =>
    read(request, 'order:read', async (client, who) => ({
      ...(await getOrders(client, who, request.query)),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.get('/v1/sources', async (request) =>
    read(request, 'flight:read', async (client, who) => ({
      capabilities: await readSourceCapabilities(client),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.post<{ Body: ExportCreate }>('/v1/exports', { schema: { body: ExportCreateSchema } }, async (request, reply) => {
    const accepted = await boundedExport(() =>
      withScope(
        pool,
        principal(request),
        async (client, who) => {
          const accepted = await idempotent(
            client,
            who,
            '/v1/exports',
            key(request),
            request.body,
            async () => {
              const record = await issueExport(client, who, request.body, store);
              return { id: record.id, value: record };
            },
            (id) => getExport(client, id),
          );
          return {
            response: {
              record: accepted.value,
              meta: await responseMeta(client, request.id, who, accepted.value.id, accepted.value.flightId),
            },
            trace: {
              event: 'export.created',
              requestId: request.id,
              tenantId: who.tenantId,
              principalId: who.id,
              exportId: accepted.value.id,
              replayed: accepted.replayed,
            },
          };
        },
        'evidence:read',
      ),
    );
    traceAccepted(request, accepted.trace);
    return reply.header('X-Evidence-Format', accepted.response.record.format).code(201).send(accepted.response);
  });
  app.get<{ Querystring: { decisionId?: string; flightId?: string } }>('/v1/exports', async (request) =>
    read(request, 'evidence:read', async (client, who) => {
      const rows = (
        await client.query<{ format: ExportRecord['format']; metadata: Omit<ExportRecord, 'format'> }>(
          "SELECT format,metadata FROM export_records WHERE format IN ('ledger.decision-evidence.1','ledger.flight-evidence.2') AND ($1::text IS NULL OR decision_id=$1) AND ($2::text IS NULL OR flight_id=$2) ORDER BY issued_at DESC,id DESC LIMIT 21",
          [request.query.decisionId ?? null, request.query.flightId ?? null],
        )
      ).rows;
      return {
        records: rows.slice(0, 20).map((row) => ({ ...row.metadata, format: row.format })),
        limit: 20,
        hasMore: rows.length > 20,
        meta: await responseMeta(client, request.id, who),
      };
    }),
  );
  app.get<{ Params: { id: string } }>('/v1/exports/:id', async (request) =>
    read(request, 'evidence:read', async (client, who) => ({
      record: await getExport(client, request.params.id),
      meta: await responseMeta(client, request.id, who),
    })),
  );
  app.get<{ Params: { id: string } }>('/v1/exports/:id/content', async (request, reply) =>
    boundedExport(async () => {
      const { record, bytes } = await withScope(
        pool,
        principal(request),
        async (client) => {
          const { record, key } = await getExportObject(client, request.params.id);
          let bytes: Uint8Array;
          try {
            bytes = await readBoundedObject(store, key, { maxBytes: record.byteLength, timeoutMs: 10000 });
          } catch {
            throw new DomainError(
              409,
              'export_bytes_unavailable',
              'Retained evidence bundle bytes are unavailable or exceeded their byte/time bounds',
            );
          }
          if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.bundleSha256)
            throw new DomainError(
              409,
              'export_integrity_failure',
              'Retained evidence bundle bytes do not match their immutable record',
            );
          return { record, bytes };
        },
        'evidence:read',
      );
      return reply
        .type('application/json')
        .header('X-Evidence-Format', record.format)
        .header('X-Content-SHA256', record.bundleSha256)
        .header('X-Manifest-SHA256', record.manifestDigest)
        .header('Cache-Control', 'private, no-store')
        .header('Content-Disposition', `attachment; filename="ledger-evidence-${record.id}.json"`)
        .send(Buffer.from(bytes));
    }),
  );
  app.post<{ Body: SubjectExportCreate }>(
    '/v1/subject-exports',
    { schema: { body: SubjectExportCreateSchema } },
    async (request, reply) => {
      const accepted = await boundedExport(() =>
        withScope(
          pool,
          principal(request),
          async (client, who) => {
            const accepted = await idempotent(
              client,
              who,
              '/v1/subject-exports',
              key(request),
              request.body,
              async () => {
                const record = await createSubjectExport(client, who, request.body, store);
                return { id: record.id, value: record };
              },
              (id) => getSubjectExport(client, id),
            );
            return {
              response: {
                record: accepted.value,
                meta: {
                  ...(await getOrganizationDecisions(client, who)).meta,
                  requestId: request.id,
                  effectId: accepted.value.id,
                },
              },
              trace: {
                event: 'subject_export.created',
                requestId: request.id,
                tenantId: who.tenantId,
                principalId: who.id,
                exportId: accepted.value.id,
                replayed: accepted.replayed,
              },
            };
          },
          'evidence:read',
        ),
      );
      traceAccepted(request, accepted.trace);
      return reply.code(201).send(accepted.response);
    },
  );
  app.get<{ Querystring: { decisionId?: string } }>('/v1/subject-exports', async (request) =>
    read(request, 'evidence:read', async (client, who) => ({
      ...(await listSubjectExports(client, who, request.query.decisionId)),
      meta: { ...(await getOrganizationDecisions(client, who, true)).meta, requestId: request.id },
    })),
  );
  app.get<{ Params: { id: string } }>('/v1/subject-exports/:id', async (request) =>
    read(request, 'evidence:read', async (client, who) => ({
      record: await getSubjectExport(client, request.params.id),
      meta: { ...(await getOrganizationDecisions(client, who, true)).meta, requestId: request.id },
    })),
  );
  app.get<{ Params: { id: string } }>('/v1/subject-exports/:id/content', async (request, reply) =>
    boundedExport(async () => {
      const { record, bytes } = await withScope(
        pool,
        principal(request),
        async (client) => {
          const { record, key } = await getSubjectExportObject(client, request.params.id);
          let bytes: Uint8Array;
          try {
            bytes = await readBoundedObject(store, key, { maxBytes: record.byteLength, timeoutMs: 10000 });
          } catch {
            throw new DomainError(
              409,
              'export_bytes_unavailable',
              'Retained subject evidence bytes are unavailable or exceeded their byte/time bounds',
            );
          }
          if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.bundleSha256)
            throw new DomainError(
              409,
              'export_integrity_failure',
              'Retained subject evidence bytes do not match their immutable record',
            );
          return { record, bytes };
        },
        'evidence:read',
      );
      return reply
        .type('application/json')
        .header('X-Evidence-Format', record.format)
        .header('X-Content-SHA256', record.bundleSha256)
        .header('X-Manifest-SHA256', record.manifestDigest)
        .header('Cache-Control', 'private, no-store')
        .header('Content-Disposition', `attachment; filename="ledger-subject-evidence-${record.id}.json"`)
        .send(Buffer.from(bytes));
    }),
  );
  app.post<{ Body: Command }>(
    '/v1/commands',
    {
      schema: { body: CommandSchema },
      preValidation: async (request) => {
        const kind = (request.body as { kind?: unknown } | null)?.kind;
        if (readsOnly(principal(request).capabilities) && !ACKNOWLEDGEMENT_COMMANDS.includes(String(kind)))
          throw readsOnlyRefusal();
        await refuseSingleControlBriefing(request);
      },
    },
    async (request, reply) => {
      rejectCredentials(request.body);
      refuseUnconfiguredIssuer(request.body, signIn);
      let issuedCredential: IssuedCredential | undefined;
      const accepted = await withScope(
        pool,
        principal(request),
        async (client, who) => {
          if (
            (request.body.kind === 'mission.release' ||
              request.body.kind === 'mission.departure-authorize' ||
              request.body.kind === 'mission.brief' ||
              request.body.kind === 'mission.briefing-acknowledge') &&
            !who.capabilities.includes('flight:read')
          )
            throw new DomainError(403, 'capability_required', 'Capability flight:read is required for this command');
          if (
            request.body.kind === 'mission.departure-authorize' ||
            request.body.kind === 'mission.brief' ||
            request.body.kind === 'mission.briefing-acknowledge'
          )
            await requireRow(client, 'flight_views', request.body.flightId);
          const accepted = await idempotent(
            client,
            who,
            '/v1/commands',
            key(request),
            request.body,
            async () => {
              const command = await acceptCommand(client, who, request.body, store, {
                simulationAvoidanceDemo,
                reauthenticate: reauthenticator(client, who, request, (request as AuthRequest).ledgerIdentity, env),
                issuedCredential: (credential) => (issuedCredential = credential),
              });
              return { id: command.id, value: command };
            },
            (id) => getCommand(client, id),
          );
          // The secret exists only in the first response; a retry cannot be shown it again.
          if (accepted.replayed && request.body.kind === 'credential.issue')
            throw new DomainError(
              409,
              'credential_secret_not_repeated',
              'This credential was already issued and its secret was returned once. Revoke it and issue another.',
              { credentialId: String(accepted.value.payload.credentialId) },
            );
          return {
            response: {
              command: accepted.value,
              meta:
                accepted.value.subject?.kind === 'sms'
                  ? await responseMeta(client, request.id, who, accepted.value.id)
                  : request.body.kind === 'decision.record' && 'subject' in request.body
                    ? {
                        ...(await getOrganizationDecisions(client, who)).meta,
                        requestId: request.id,
                        effectId: accepted.value.id,
                      }
                    : request.body.kind === 'rule-pack.adopt'
                      ? {
                          ...(await getOrganizationCoverage(client, who)).meta,
                          requestId: request.id,
                          effectId: accepted.value.id,
                        }
                      : await responseMeta(client, request.id, who, accepted.value.id, accepted.value.flightId),
              ...(request.body.kind === 'mission.departure-authorize'
                ? {
                    authorization: await getMissionDepartureAuthorization(
                      client,
                      who,
                      request.body.flightId,
                      accepted.value.id,
                      accepted.replayed ? 'replayed' : 'issued',
                    ),
                  }
                : {}),
            },
            trace: {
              event: 'command.accepted',
              requestId: request.id,
              tenantId: who.tenantId,
              principalId: who.id,
              commandId: accepted.value.id,
              ...(await taskTrace(client, accepted.value.id)),
              replayed: accepted.replayed,
            },
          };
        },
        request.body.kind === 'mission.release' ||
          request.body.kind === 'mission.departure-authorize' ||
          request.body.kind === 'mission.brief' ||
          request.body.kind === 'mission.briefing-acknowledge'
          ? 'flight:read'
          : commandCapability(request.body),
        false,
        undefined,
        request.body.kind === 'authority.update' && request.body.principalId === principal(request).id
          ? 'UPDATE'
          : 'SHARE',
      );
      const authorization = accepted.response.authorization;
      if (authorization) {
        const now = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
        if (now.getTime() >= Date.parse(authorization.permit.validUntil))
          throw new DomainError(
            409,
            'departure_permit_expired',
            'The original departure authorization expired; this flight remains held',
          );
        if (now.getTime() < Date.parse(authorization.permit.authorizedAt))
          throw new DomainError(409, 'departure_permit_not_current', 'The departure authorization is not current');
        authorization.evaluatedAt = now.toISOString();
      }
      traceAccepted(request, accepted.trace);
      if (issuedCredential)
        return reply
          .code(201)
          .header('Cache-Control', 'private, no-store')
          .send({ ...accepted.response, credential: issuedCredential });
      return reply.code(201).send(accepted.response);
    },
  );
  if (ownPool) app.addHook('onClose', async () => pool.end());
  return app;
}
