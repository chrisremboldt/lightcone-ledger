import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { endpointSchemas, missingAirspaceSchemas, validatePayload } from './schema.js';
import { answerMetarRequest, recordedMetarReports } from './metar.js';
import { answerTafRequest, recordedTafForecasts } from './taf.js';
import { answerTfrRequest } from './tfr.js';
import {
  answerSkydioRequest,
  readSkydioEmulatedFlights,
  skydioEmulatorState,
  type SkydioEmulatorState,
} from './skydio.js';
import { handleNoticeRequest, NoticeInbox } from './notices.js';
import {
  djiFaultScripts,
  planScriptedFlight,
  runScriptedFlight,
  type DjiFaultScript,
  type DjiFlightPublisher,
  type ScriptedFlight,
} from './dji-fault-script.js';

type Json = Record<string, unknown>;
export interface EmulatorConfig {
  host: string;
  port: number;
  adminKey: string;
  partnerKey: string;
  machineClientId: string;
  machineClientSecret: string;
  apiKey: string;
  userClientId: string;
  userRedirectUris: string[];
  callbackSecret: string;
  callbackOrigins: string[];
  /**
   * The API token the flight service stand-in accepts, as the whole Authorization header. Unset, as on a host that
   * is not a local development host and names none, the stand-in is off.
   */
  flightServiceToken?: string;
}
const local = (host: string): boolean => ['127.0.0.1', 'localhost', '::1'].includes(host);
export function emulatorConfig(env: NodeJS.ProcessEnv = process.env): EmulatorConfig {
  const host = env.EMULATOR_HOST ?? '127.0.0.1';
  const defaults = local(host) && (env.LEDGER_ENV ?? 'local') === 'local' && env.NODE_ENV !== 'production';
  const secret = (name: string, fallback: string): string => {
    if (env[name]) return env[name]!;
    if (!defaults) throw new Error(`${name} must be configured for a non-loopback emulator host`);
    return fallback;
  };
  return {
    host,
    port: Number(env.EMULATOR_PORT ?? 4002),
    adminKey: secret('EMULATOR_ADMIN_KEY', 'ledger-local-emulator-admin'),
    partnerKey: secret('PARTNER_API_KEY', 'ledger-local-partner'),
    machineClientId: secret('AIRSPACE_CLIENT_ID', 'ledger-local-airhub'),
    machineClientSecret: secret('AIRSPACE_CLIENT_SECRET', 'ledger-local-airhub-secret'),
    apiKey: secret('AIRSPACE_API_KEY', 'ledger-local-airhub-api'),
    userClientId: secret('AIRSPACE_USER_CLIENT_ID', 'ledger-local-user'),
    userRedirectUris: (env.AIRSPACE_REDIRECT_URIS ?? 'http://127.0.0.1:4002/oauth/callback').split(','),
    callbackSecret: secret('AIRSPACE_CALLBACK_SECRET', 'ledger-local-airhub-callback'),
    callbackOrigins: (
      env.EMULATOR_CALLBACK_ORIGINS ?? 'http://127.0.0.1:4000,http://localhost:4000,http://127.0.0.1:4003'
    ).split(','),
    flightServiceToken: env.SKYDIO_API_TOKEN || (defaults ? 'ledger-local-skydio-token' : undefined),
  };
}

interface Grant {
  mode: 'machine' | 'user';
  scopes: Set<string>;
  expires: number;
}
interface CodeGrant {
  challenge: string;
  redirectUri: string;
  clientId: string;
  scopes: string[];
  expires: number;
}
export interface EmulatorState {
  orders: Json[];
  operations: Map<string, Json>;
  laanc: Map<string, Json>;
  grants: Map<string, Grant>;
  codes: Map<string, CodeGrant>;
  callbackAttempts: Array<{ authorizationId: string; status: string; code: number; deliveredAt: string }>;
  sourceClock?: string;
  /** Published weather reports, each the exact text of one report object; the recorded ones until replaced. */
  metarReports: string[];
  /** Published weather forecasts, each the exact text of one forecast object; the recorded ones until replaced. */
  tafForecasts: string[];
  /** The flight service stand-in: invented flights placed around the time the emulators started, until replaced. */
  skydio: SkydioEmulatorState;
  /** What the notice stand-ins received: email over SMTP and webhook calls. */
  notices: NoticeInbox;
}
const statuses = new Set([
  'STATUS_UNSPECIFIED',
  'STATUS_APPROVED',
  'STATUS_RESCINDED',
  'STATUS_RESCIND_ACK',
  'STATUS_AUTOCANCEL',
  'STATUS_DENIED',
  'STATUS_CLOSED',
  'STATUS_CANCELED',
  'STATUS_INVALID_CANCEL',
  'STATUS_INVALID',
  'STATUS_EXPIRED',
  'STATUS_RECEIVED',
]);
const scopes = [
  'operation:read',
  'operation:create',
  'operation:update',
  'operation:delete',
  'laanc:read',
  'laanc:create',
  'laanc:update',
  'laanc:delete',
  'briefing:area:read',
  'briefing:location:read',
];

class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}
async function readBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 2 * 1024 * 1024) throw new HttpError(413, 'Emulator request exceeds the configured bound');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function tokenFor(kind: string, input: string): string {
  return `${kind}.${createHash('sha256').update(input).digest('base64url')}`;
}

export interface EmulatorOptions {
  /** Where scripted flights publish their telemetry messages. Without it the scripted-flight controls refuse to start. */
  djiFlights?: DjiFlightPublisher;
  /** Shared with the SMTP stand-in, so the page of notices shows the email it received. */
  notices?: NoticeInbox;
}

export function createEmulator(
  config = emulatorConfig(),
  options: EmulatorOptions = {},
): { server: Server; state: EmulatorState } {
  const state: EmulatorState = {
    orders: [],
    operations: new Map(),
    laanc: new Map(),
    grants: new Map(),
    codes: new Map(),
    callbackAttempts: [],
    metarReports: recordedMetarReports(),
    tafForecasts: recordedTafForecasts(),
    skydio: skydioEmulatorState(new Date().toISOString()),
    notices: options.notices ?? new NoticeInbox(),
  };
  let controlLease: { id: string; owner: 'scenario' | 'trickle'; expires: number } | undefined;
  let scriptedFlight: ScriptedFlight | undefined;
  const startScriptedFlight = (body: { script?: unknown; start?: unknown; speed?: unknown }) => {
    if (!options.djiFlights) throw new HttpError(503, 'No telemetry publisher is configured for scripted flights');
    if (scriptedFlight?.progress().status === 'running')
      throw new HttpError(409, 'A scripted flight is already running; stop it before starting another');
    const script =
      typeof body.script === 'string'
        ? Object.hasOwn(djiFaultScripts, body.script)
          ? djiFaultScripts[body.script]!
          : undefined
        : (body.script as DjiFaultScript | undefined);
    if (!script || typeof script !== 'object') throw new HttpError(400, 'Unknown fault script');
    if (body.start !== undefined && (typeof body.start !== 'string' || !Number.isFinite(Date.parse(body.start))))
      throw new HttpError(400, 'start must be a timestamp');
    const speed = body.speed ?? 1;
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.1 || speed > 1000)
      throw new HttpError(400, 'speed must be a number from 0.1 to 1000');
    let plan;
    try {
      plan = planScriptedFlight(script, {
        start: (body.start as string | undefined) ?? sourceTime(),
        deviceId: options.djiFlights.deviceId,
        gatewayId: options.djiFlights.gatewayId,
        runId: randomUUID(),
      });
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    scriptedFlight = runScriptedFlight(plan, options.djiFlights, { speed });
    return scriptedFlight.progress();
  };
  const activeLease = () => (controlLease && controlLease.expires > Date.now() ? controlLease : undefined);
  const sourceTime = () => state.sourceClock ?? new Date().toISOString();
  const rateWindows = new Map<string, { start: number; requests: number }>();
  const send = (response: ServerResponse, status: number, body: unknown, contentType = 'application/json') => {
    response.writeHead(status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-ledger-simulation': 'fictional-vendor-emulator',
    });
    response.end(contentType === 'application/json' ? JSON.stringify(body) : String(body));
  };
  const allowCallback = (callback: unknown): void => {
    if (callback === undefined || callback === '') return;
    if (typeof callback !== 'string') throw new HttpError(400, 'callbackUrl must be a URL');
    const url = new URL(callback);
    if (url.username || url.password || !config.callbackOrigins.includes(url.origin))
      throw new HttpError(400, 'Callback origin is outside the emulator allowlist');
  };
  const requireGrant = (request: IncomingMessage, scope: string, userOnly = false): Grant => {
    const raw = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const grant = state.grants.get(raw);
    if (!grant || grant.expires < Date.now()) throw new HttpError(401, 'Token missing or expired');
    if (grant.mode === 'machine' && request.headers['x-api-key'] !== config.apiKey)
      throw new HttpError(403, 'API key required');
    if (!grant.scopes.has(scope) || (userOnly && grant.mode !== 'user'))
      throw new HttpError(403, 'Insufficient capability');
    const current = rateWindows.get(raw);
    const window = current && Date.now() - current.start < 1000 ? current : { start: Date.now(), requests: 0 };
    window.requests += 1;
    rateWindows.set(raw, window);
    if (window.requests > 200) throw new HttpError(429, 'Synthetic per-token rate limit');
    return grant;
  };
  const checked = (request: IncomingMessage, response: ServerResponse, path: string, body: unknown): void => {
    const result = validatePayload(request.method ?? 'GET', path, body, 'response');
    if (!result.valid)
      throw new HttpError(500, `Emulator response failed pinned schema: ${JSON.stringify(result.errors)}`);
    send(response, 200, body);
  };
  const publish = async (operationId: string, authorization: Json): Promise<void> => {
    const parent = state.operations.get(operationId);
    if (!parent?.callbackUrl) return;
    const callback = {
      authId: authorization.id,
      authStatus: authorization.status,
      authStatusDate: authorization.lastUpdatedAt,
      startTime: authorization.startTime,
      duration: (Date.parse(String(authorization.endTime)) - Date.parse(String(authorization.startTime))) / 60_000,
      altitude: authorization.altitude,
      atc: authorization.airTrafficControl,
    };
    const bytes = JSON.stringify(callback);
    try {
      const delivered = await fetch(String(parent.callbackUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-simulation-signature': createHmac('sha256', config.callbackSecret).update(bytes).digest('hex'),
        },
        body: bytes,
        signal: AbortSignal.timeout(5000),
      });
      state.callbackAttempts.push({
        authorizationId: String(authorization.id),
        status: String(authorization.status),
        code: delivered.status,
        deliveredAt: new Date().toISOString(),
      });
    } catch {
      state.callbackAttempts.push({
        authorizationId: String(authorization.id),
        status: String(authorization.status),
        code: 0,
        deliveredAt: new Date().toISOString(),
      });
    }
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    try {
      if (await handleNoticeRequest(state.notices, request, response, url, () => readBytes(request))) return;
      if (path === '/healthz')
        return send(response, 200, {
          status: 'ok',
          simulation: true,
          schemas: missingAirspaceSchemas().length ? 0 : endpointSchemas().length,
          fidelity: 'documented_schema_conformant',
          synthetic: ['provider-auth', 'callback-delivery', 'rate-limit', 'failure-timing'],
        });
      if (path.startsWith('/_simulation/')) {
        if (request.headers['x-emulator-admin'] !== config.adminKey)
          throw new HttpError(403, 'Simulator capability required');
        if (path === '/_simulation/control-lease') {
          const lease = activeLease();
          if (request.method === 'GET')
            return send(
              response,
              200,
              lease
                ? { held: true, owner: lease.owner, expiresAt: new Date(lease.expires).toISOString() }
                : { held: false },
            );
          if (request.method === 'POST') {
            const body = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { owner?: string };
            if (body.owner !== 'scenario' && body.owner !== 'trickle')
              throw new HttpError(400, 'Unknown simulator control owner');
            if (lease)
              throw new HttpError(
                409,
                `Emulator controls are held by ${lease.owner}; stop it before running another generator`,
              );
            controlLease = { id: randomUUID(), owner: body.owner, expires: Date.now() + 60_000 };
            return send(response, 200, {
              leaseId: controlLease.id,
              expiresAt: new Date(controlLease.expires).toISOString(),
            });
          }
          if (!lease || request.headers['x-simulator-lease'] !== lease.id)
            throw new HttpError(409, 'Simulator control lease expired or belongs to another generator');
          if (request.method === 'PUT') {
            lease.expires = Date.now() + 60_000;
            return send(response, 200, { expiresAt: new Date(lease.expires).toISOString() });
          }
          if (request.method === 'DELETE') {
            controlLease = undefined;
            return send(response, 200, { released: true });
          }
          throw new HttpError(405, 'Unsupported simulator lease method');
        }
        if (request.method !== 'GET') {
          const lease = activeLease();
          const supplied = request.headers['x-simulator-lease'];
          if ((lease && supplied !== lease.id) || (supplied && supplied !== lease?.id))
            throw new HttpError(409, 'Simulator controls require their current exclusive lease');
        }
        if (path === '/_simulation/reset' && request.method === 'POST') {
          state.orders = [];
          state.operations.clear();
          state.laanc.clear();
          state.grants.clear();
          state.codes.clear();
          state.callbackAttempts = [];
          state.sourceClock = undefined;
          state.metarReports = recordedMetarReports();
          state.tafForecasts = recordedTafForecasts();
          state.skydio = skydioEmulatorState(new Date().toISOString());
          scriptedFlight?.stop();
          scriptedFlight = undefined;
          return send(response, 200, { reset: true });
        }
        if (path === '/_simulation/clock' && request.method === 'POST') {
          const body = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { now?: string };
          if (!body.now || !Number.isFinite(Date.parse(body.now)))
            throw new HttpError(400, 'Expected source clock timestamp');
          state.sourceClock = new Date(body.now).toISOString();
          return send(response, 200, { sourceTime: state.sourceClock, ledgerClockChanged: false });
        }
        if (path === '/_simulation/metar/reports' && request.method === 'PUT') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { reports?: unknown };
          const reports = value.reports;
          if (
            !Array.isArray(reports) ||
            reports.length > 5000 ||
            reports.some(
              (report) =>
                !report ||
                typeof report !== 'object' ||
                typeof (report as Json).icaoId !== 'string' ||
                typeof (report as Json).rawOb !== 'string' ||
                !Number.isSafeInteger((report as Json).obsTime),
            )
          )
            throw new HttpError(400, 'Expected reports: report objects with icaoId, rawOb and obsTime');
          state.metarReports = reports.map((report) => JSON.stringify(report));
          return send(response, 200, { reports: state.metarReports.length });
        }
        if (path === '/_simulation/skydio/flights' && request.method === 'PUT') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { flights?: unknown };
          try {
            state.skydio.flights = readSkydioEmulatedFlights(value.flights);
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          return send(response, 200, { flights: state.skydio.flights.length });
        }
        if (path === '/_simulation/skydio/rate-limit' && request.method === 'POST') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as {
            requests?: unknown;
            retryAfterSeconds?: unknown;
          };
          const whole = (given: unknown, most: number) =>
            Number.isSafeInteger(given) && Number(given) >= 0 && Number(given) <= most;
          if (!whole(value.requests, 1000) || !whole(value.retryAfterSeconds ?? 2, 3600))
            throw new HttpError(400, 'Expected requests (0 to 1000) and retryAfterSeconds (0 to 3600)');
          state.skydio.rateLimited = value.requests as number;
          state.skydio.retryAfterSeconds = (value.retryAfterSeconds as number | undefined) ?? 2;
          return send(response, 200, { ...value, retryAfterSeconds: state.skydio.retryAfterSeconds });
        }
        if (path === '/_simulation/taf/forecasts' && request.method === 'PUT') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { forecasts?: unknown };
          const forecasts = value.forecasts;
          if (
            !Array.isArray(forecasts) ||
            forecasts.length > 5000 ||
            forecasts.some(
              (forecast) =>
                !forecast ||
                typeof forecast !== 'object' ||
                typeof (forecast as Json).icaoId !== 'string' ||
                typeof (forecast as Json).rawTAF !== 'string' ||
                !Number.isFinite(Date.parse(String((forecast as Json).issueTime))),
            )
          )
            throw new HttpError(400, 'Expected forecasts: forecast objects with icaoId, rawTAF and issueTime');
          state.tafForecasts = forecasts.map((forecast) => JSON.stringify(forecast));
          return send(response, 200, { forecasts: state.tafForecasts.length });
        }
        if (path === '/_simulation/partner/orders' && request.method === 'PUT') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as { orders?: Json[] };
          if (!Array.isArray(value.orders) || value.orders.length > 1000)
            throw new HttpError(400, 'Expected bounded orders array');
          state.orders = value.orders;
          return send(response, 200, { count: state.orders.length });
        }
        if (path === '/_simulation/partner/deliver' && request.method === 'POST') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as {
            callbackUrl: string;
            order: Json;
          };
          allowCallback(value.callbackUrl);
          const result = await fetch(value.callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partner-key': config.partnerKey },
            body: JSON.stringify(value.order),
            signal: AbortSignal.timeout(5000),
          });
          return send(response, 200, { status: result.status });
        }
        if (path === '/_simulation/command-link/deliver' && request.method === 'POST') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as {
            callbackUrl?: unknown;
            bytesBase64?: unknown;
          };
          if (!value || typeof value.callbackUrl !== 'string' || !value.callbackUrl)
            throw new HttpError(400, 'Command-link delivery requires a callback URL');
          let callback: URL;
          try {
            callback = new URL(value.callbackUrl);
          } catch {
            throw new HttpError(400, 'Command-link callback must be a URL');
          }
          if (!['http:', 'https:'].includes(callback.protocol))
            throw new HttpError(400, 'Command-link callback must use HTTP or HTTPS');
          allowCallback(value.callbackUrl);
          const maxBytes = 64 * 1024;
          if (typeof value.bytesBase64 !== 'string' || !value.bytesBase64)
            throw new HttpError(400, 'Command-link delivery requires canonical base64 source bytes');
          if (value.bytesBase64.length > 4 * Math.ceil(maxBytes / 3))
            throw new HttpError(413, 'Command-link source exceeds 64 KiB');
          const bytes = Buffer.from(value.bytesBase64, 'base64');
          if (bytes.byteLength > maxBytes) throw new HttpError(413, 'Command-link source exceeds 64 KiB');
          if (!bytes.byteLength || bytes.toString('base64') !== value.bytesBase64)
            throw new HttpError(400, 'Command-link delivery requires canonical base64 source bytes');
          const result = await fetch(callback, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partner-key': config.partnerKey },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          await result.body?.cancel();
          return send(response, 200, { status: result.status });
        }
        if (path === '/_simulation/mission/deliver' && request.method === 'POST') {
          const value = JSON.parse(Buffer.from(await readBytes(request)).toString()) as {
            callbackUrl?: unknown;
            bytesBase64?: unknown;
          };
          if (!value || typeof value.callbackUrl !== 'string' || !value.callbackUrl)
            throw new HttpError(400, 'Mission delivery requires a callback URL');
          let callback: URL;
          try {
            callback = new URL(value.callbackUrl);
          } catch {
            throw new HttpError(400, 'Mission callback must be a URL');
          }
          if (!['http:', 'https:'].includes(callback.protocol))
            throw new HttpError(400, 'Mission callback must use HTTP or HTTPS');
          allowCallback(value.callbackUrl);
          const maxBytes = 64 * 1024;
          if (typeof value.bytesBase64 !== 'string' || !value.bytesBase64)
            throw new HttpError(400, 'Mission delivery requires canonical base64 source bytes');
          if (value.bytesBase64.length > 4 * Math.ceil(maxBytes / 3))
            throw new HttpError(413, 'Mission source exceeds 64 KiB');
          const bytes = Buffer.from(value.bytesBase64, 'base64');
          if (bytes.byteLength > maxBytes) throw new HttpError(413, 'Mission source exceeds 64 KiB');
          if (!bytes.byteLength || bytes.toString('base64') !== value.bytesBase64)
            throw new HttpError(400, 'Mission delivery requires canonical base64 source bytes');
          const result = await fetch(callback, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-partner-key': config.partnerKey },
            body: new Uint8Array(bytes),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          await result.body?.cancel();
          return send(response, 200, { status: result.status });
        }
        const match = path.match(/^\/_simulation\/airspace\/operations\/([^/]+)\/authorizations\/([^/]+)\/status$/);
        if (match && request.method === 'POST') {
          const body = JSON.parse(Buffer.from(await readBytes(request)).toString()) as Json;
          if (!statuses.has(String(body.status))) throw new HttpError(400, 'Unknown vendor status');
          const operation = state.laanc.get(match[1]!);
          const authorization = (operation?.authorizations as Json[] | undefined)?.find((row) => row.id === match[2]);
          if (!authorization) throw new HttpError(404, 'Authorization not found');
          authorization.status = body.status;
          authorization.lastUpdatedAt = body.occurredAt ?? sourceTime();
          if (body.denialReason) authorization.denialReason = body.denialReason;
          await publish(match[1]!, authorization);
          return send(response, 200, { authorization });
        }
        if (path === '/_simulation/dji/scripts' && request.method === 'GET')
          return send(response, 200, {
            scripts: Object.values(djiFaultScripts).map(({ name, description, durationSeconds, periodSeconds }) => ({
              name,
              description,
              durationSeconds,
              periodSeconds,
            })),
          });
        if (path === '/_simulation/dji/flights' && request.method === 'POST') {
          const body = JSON.parse(Buffer.from(await readBytes(request)).toString()) as Json;
          return send(response, 202, { flight: startScriptedFlight(body ?? {}) });
        }
        if (path === '/_simulation/dji/flights/current') {
          if (!scriptedFlight) throw new HttpError(404, 'No scripted flight has started');
          if (request.method === 'GET') return send(response, 200, { flight: scriptedFlight.progress() });
          if (request.method === 'DELETE') {
            scriptedFlight.stop();
            return send(response, 200, { flight: scriptedFlight.progress() });
          }
        }
        if (path === '/_simulation/callback-attempts' && request.method === 'GET')
          return send(response, 200, { attempts: state.callbackAttempts });
        throw new HttpError(404, 'Unknown simulator control');
      }
      if (path === '/oauth/authorize' && request.method === 'GET') {
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        const requested = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
        if (
          clientId !== config.userClientId ||
          !config.userRedirectUris.includes(redirectUri) ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
          requested.some((scope) => !scopes.includes(scope))
        )
          throw new HttpError(400, 'Invalid emulated PKCE request');
        const code = tokenFor('code', `${clientId}:${redirectUri}:${challenge}:${url.searchParams.get('state')}`);
        state.codes.set(code, { clientId, redirectUri, challenge, scopes: requested, expires: Date.now() + 60_000 });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: redirect.toString(), 'cache-control': 'no-store' });
        return response.end();
      }
      if (path === '/oauth/token' && request.method === 'POST') {
        const form = new URLSearchParams(Buffer.from(await readBytes(request)).toString());
        const code = form.get('code') ?? '';
        const grant = state.codes.get(code);
        if (
          !grant ||
          grant.expires < Date.now() ||
          form.get('grant_type') !== 'authorization_code' ||
          form.get('client_id') !== grant.clientId ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          throw new HttpError(400, 'Invalid emulated PKCE exchange');
        state.codes.delete(code);
        const token = tokenFor('user', code);
        state.grants.set(token, { mode: 'user', scopes: new Set(grant.scopes), expires: Date.now() + 3600_000 });
        return send(response, 200, {
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: grant.scopes.join(' '),
        });
      }
      if (path === '/v1/oauth/token' && request.method === 'POST') {
        const form = new URLSearchParams(Buffer.from(await readBytes(request)).toString());
        const requested = (form.get('scope') ?? '').split(' ').filter(Boolean);
        if (
          request.headers['x-api-key'] !== config.apiKey ||
          form.get('client_id') !== config.machineClientId ||
          form.get('client_secret') !== config.machineClientSecret ||
          form.get('grant_type') !== 'client_credentials' ||
          requested.some((scope) => !scopes.includes(scope))
        )
          return send(response, 400, { message: 'Invalid machine credentials or scopes', statusCode: 400 });
        const token = tokenFor('machine', `${config.machineClientId}:${requested.join(' ')}`);
        const expires = Date.now() + 3600_000;
        state.grants.set(token, { mode: 'machine', scopes: new Set(requested), expires });
        return checked(request, response, path, {
          data: { accessToken: token, expires: new Date(expires).toISOString() },
          message: 'success',
          statusCode: 200,
        });
      }
      const flightService =
        config.flightServiceToken === undefined
          ? undefined
          : answerSkydioRequest(
              state.skydio,
              config.flightServiceToken,
              {
                method: request.method ?? 'GET',
                path,
                query: url.searchParams,
                authorization: request.headers.authorization,
              },
              sourceTime(),
            );
      if (flightService) {
        response.writeHead(flightService.status, {
          ...flightService.headers,
          'cache-control': 'no-store',
          'x-ledger-simulation': 'invented-flight-service',
        });
        return response.end(flightService.body);
      }
      const restriction = request.method === 'GET' ? answerTfrRequest(path) : undefined;
      if (restriction) {
        response.writeHead(restriction.status, {
          ...(restriction.contentType ? { 'content-type': restriction.contentType } : {}),
          'cache-control': 'no-store',
          'x-ledger-simulation': 'recorded-flight-restrictions',
        });
        return response.end(restriction.body);
      }
      if (path === '/api/data/taf' && request.method === 'GET') {
        const answer = answerTafRequest(state.tafForecasts, url.searchParams, sourceTime());
        response.writeHead(answer.status, {
          ...(answer.status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }),
          'cache-control': 'no-store',
          'x-ledger-simulation': 'recorded-weather-forecasts',
        });
        return response.end(answer.body);
      }
      if (path === '/api/data/metar' && request.method === 'GET') {
        const answer = answerMetarRequest(state.metarReports, url.searchParams, sourceTime());
        response.writeHead(answer.status, {
          ...(answer.status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }),
          'cache-control': 'no-store',
          'x-ledger-simulation': 'recorded-weather-reports',
        });
        return response.end(answer.body);
      }
      if (path.startsWith('/partner/')) {
        if (request.headers['x-partner-key'] !== config.partnerKey)
          throw new HttpError(403, 'Partner credential required');
        if (path === '/partner/orders' && request.method === 'GET')
          return send(response, 200, { orders: state.orders });
        if (path === '/partner/orders.csv' && request.method === 'GET')
          return send(
            response,
            200,
            'order_id,version,state\n' +
              state.orders
                .map((order) =>
                  [order.order_id, order.version, order.state]
                    .map((value) => `"${String(value).replaceAll('"', '""')}"`)
                    .join(','),
                )
                .join('\n') +
              '\n',
            'text/csv',
          );
        const id = path.match(/^\/partner\/orders\/([^/]+)$/)?.[1];
        if (id && request.method === 'GET') {
          const order = state.orders
            .filter((row) => row.order_id === decodeURIComponent(id))
            .sort((a, b) => Number(b.version) - Number(a.version))[0];
          if (!order) throw new HttpError(404, 'Order not found');
          return send(response, 200, { order });
        }
        throw new HttpError(404, 'Unknown partner endpoint');
      }
      if (missingAirspaceSchemas().length)
        throw new HttpError(
          503,
          'The Airspace Link emulator has not downloaded its schemas: run pnpm vendor:airspace, then restart the emulators',
        );
      const endpoint = endpointSchemas().find(
        (entry) =>
          entry.method === request.method && new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path),
      );
      if (!endpoint) throw new HttpError(404, 'Unsupported public vendor surface');
      const userOnly = path.includes('/laanc');
      const suffix =
        request.method === 'GET'
          ? 'read'
          : request.method === 'DELETE'
            ? 'delete'
            : request.method === 'POST'
              ? 'create'
              : 'update';
      const scope = path.startsWith('/v2/briefing')
        ? `briefing:${path.endsWith('/area') ? 'area' : 'location'}:read`
        : `${userOnly ? 'laanc' : 'operation'}:${suffix}`;
      requireGrant(request, scope, userOnly);
      const bytes = await readBytes(request);
      const body = bytes.length ? (JSON.parse(Buffer.from(bytes).toString()) as Json) : {};
      if (endpoint.request) {
        const validation = validatePayload(request.method!, path, body, 'request');
        if (!validation.valid)
          throw new HttpError(400, `Request fails published schema: ${JSON.stringify(validation.errors)}`);
      }
      if (path === '/v1/operations' && request.method === 'GET') {
        let operations = [...state.operations.values()];
        if (url.searchParams.has('id'))
          operations = operations.filter((row) => url.searchParams.getAll('id').includes(String(row.id)));
        if (url.searchParams.has('dateRangeStart'))
          operations = operations.filter(
            (row) => Date.parse(String(row.endTime)) >= Date.parse(url.searchParams.get('dateRangeStart')!),
          );
        if (url.searchParams.has('dateRangeEnd'))
          operations = operations.filter(
            (row) => Date.parse(String(row.startTime)) <= Date.parse(url.searchParams.get('dateRangeEnd')!),
          );
        return checked(request, response, path, { operations });
      }
      if (path === '/v1/operations' && request.method === 'POST') {
        allowCallback(body.callbackUrl);
        const id = randomUUID();
        const at = sourceTime();
        state.operations.set(id, {
          ...body,
          id,
          createdBy: body.pilotId,
          createdDate: at,
          lastEditedBy: body.pilotId,
          lastEditedDate: at,
          authorizationProviders: ['APPROVAL_PROVIDER_LAANC'],
        });
        return checked(request, response, path, { id });
      }
      const operationId = path.match(/^\/v1\/operations\/([^/]+)/)?.[1];
      const parent = operationId ? state.operations.get(operationId) : undefined;
      if (path.startsWith('/v1/operations/') && !parent) throw new HttpError(404, 'Operation not found');
      if (operationId && path === `/v1/operations/${operationId}`) {
        if (request.method === 'GET') return checked(request, response, path, { operation: parent });
        if (request.method === 'DELETE') {
          state.operations.delete(operationId);
          state.laanc.delete(operationId);
          return checked(request, response, path, {});
        }
        allowCallback(body.callbackUrl);
        state.operations.set(operationId, { ...parent, ...body, lastEditedDate: sourceTime() });
        return checked(request, response, path, {});
      }
      if (operationId && path === `/v1/operations/${operationId}/laanc`) {
        if (request.method === 'POST') {
          const candidate = {
            hashCode: createHash('sha256').update(operationId).digest('hex').slice(0, 32),
            submissionType: 'SUBMISSION_TYPE_AUTO_AUTHORIZATION',
            startTime: parent!.startTime,
            endTime: parent!.endTime,
            geom: parent!.boundary,
            altitude: parent!.maxAltitude,
            airTrafficControl: 'SIM',
          };
          const operation = { ...body, candidates: [candidate], notices: [], authorizations: [] };
          state.laanc.set(operationId, operation);
          return checked(request, response, path, { operation });
        }
        const operation = state.laanc.get(operationId);
        if (!operation) throw new HttpError(404, 'LAANC operation not found');
        if (request.method === 'GET') return checked(request, response, path, { operation });
        if (request.method === 'DELETE') {
          state.laanc.delete(operationId);
          return checked(request, response, path, {});
        }
        state.laanc.set(operationId, { ...operation, ...body });
        return checked(request, response, path, {});
      }
      const authMatch = path.match(/^\/v1\/operations\/([^/]+)\/laanc\/authorizations\/([^/]+)(?:\/(\w+))?$/);
      if (authMatch) {
        const operation = state.laanc.get(authMatch[1]!);
        if (!operation) throw new HttpError(404, 'LAANC operation not found');
        const authorizations = operation.authorizations as Json[];
        if (request.method === 'POST') {
          const candidate = (operation.candidates as Json[]).find((row) => row.hashCode === authMatch[2]);
          if (!candidate) throw new HttpError(404, 'Candidate not found');
          const at = sourceTime();
          const authorization = {
            ...candidate,
            id: `SIM${createHash('sha256').update(`${operationId}:${authMatch[2]}`).digest('hex').slice(0, 9).toUpperCase()}`,
            status: 'STATUS_APPROVED',
            createdAt: at,
            lastUpdatedAt: at,
            createdBy: parent!.pilotId,
            editedBy: parent!.pilotId,
            justification: body.justification ?? '',
            airspaceClassCodes: ['CLASS_D'],
            facilityMaps: [],
          };
          authorizations.push(authorization);
          await publish(operationId!, authorization);
          return checked(request, response, path, { authorization });
        }
        const authorization = authorizations.find((row) => row.id === authMatch[2]);
        if (!authorization) throw new HttpError(404, 'Authorization not found');
        if (request.method === 'GET') return checked(request, response, path, { authorization });
        const actions: Record<string, string> = {
          cancel: 'STATUS_CANCELED',
          cancelinvalid: 'STATUS_INVALID_CANCEL',
          close: 'STATUS_CLOSED',
          rescindack: 'STATUS_RESCIND_ACK',
        };
        authorization.status = actions[authMatch[3]!]!;
        authorization.lastUpdatedAt = sourceTime();
        await publish(operationId!, authorization);
        return checked(request, response, path, {});
      }
      if (path.startsWith('/v2/briefing/b4ufly/')) {
        // Empty notices are a synthetic dataset; the public schema controls their representation.
        const schema = endpoint.response;
        const value = {
          status: 'NOTICE_STATUS_UNSPECIFIED',
          authorizationType: 'AUTHORIZATION_TYPE_UNSPECIFIED',
          notices: [],
        };
        if (schema && !schema(value))
          throw new HttpError(501, 'Briefing dataset is not implemented; no geographic coverage is claimed');
        return checked(request, response, path, value);
      }
      throw new HttpError(501, 'Published surface not implemented by this milestone');
    } catch (error) {
      const code = error instanceof HttpError ? error.code : 400;
      if (code === 429) response.setHeader('retry-after', '1');
      send(response, code, error instanceof Error ? error.message : 'Request failed');
    }
  });
  return { server, state };
}
