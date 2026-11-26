import { createHash, randomBytes } from 'node:crypto';
import type { Fidelity, FlightCreate, FlightInput, ReceiptResponse } from '@ledger/contracts';
import { LedgerClient } from '@ledger/contracts/client';

export { LedgerClient };
export {
  MonitoringWindowAdapter,
  MonitoringWindowPendingError,
  type MonitoringWindowAdapterConfig,
  type MonitoringWindowAdapterResult,
  type PreparedMonitoringWindowInput,
} from './monitoring-window.js';
export { MissionAdapter, MissionPendingError } from './mission.js';
export type { MissionAdapterConfig, MissionAdapterResult, PreparedMissionInput } from './mission-types.js';
export {
  commandLinkStatusAdapter,
  commandLinkStatusDescriptor,
  translateCommandLinkStatus,
  type CommandLinkStatusBinding,
} from './command-link-status.js';
export {
  DjiMqttAdapter,
  describeTelemetry,
  decodeDjiOsd,
  DJI_DOCUMENTATION_DIGEST,
  DJI_LIMITATIONS,
  type DjiAdapterConfig,
} from './dji.js';
export * from './adapter-contract.js';
export * from './conformance.js';
export {
  HttpObservationSink,
  ObservationSinkRefusal,
  type HttpObservationSinkConfig,
} from './http-observation-sink.js';
export * from './source-loop.js';
export * from './source-transports.js';
export {
  djiOsdPositionAdapter,
  djiOsdPositionDescriptor,
  translateDjiOsdPosition,
  type DjiOsdBinding,
} from './dji-osd-position.js';
export {
  airspaceAuthorizationAdapter,
  airspaceAuthorizationDescriptor,
  translateAirspaceAuthorization,
  type AirspaceAuthorizationBinding,
} from './airspace-authorization.js';
export { crewRosterDutyAdapter, crewRosterDutyDescriptor, translateCrewRosterDuty } from './crew-roster-duty.js';
export {
  djiOsdBatteryAdapter,
  djiOsdBatteryDescriptor,
  translateDjiOsdBattery,
  DJI_BATTERY_DOCUMENTATION,
} from './dji-osd-battery.js';
export {
  djiDockModels,
  djiDockWindAdapter,
  djiDockWindDescriptor,
  translateDjiDockWind,
  type DjiDockBinding,
  type DjiDockModel,
} from './dji-dock-wind.js';
export {
  MetarRefusal,
  metarTime,
  parseMetarStations,
  publishedMetarAdapter,
  publishedMetarDescriptor,
  readDirectionRange,
  readMetar,
  readVisibilityGroups,
  readWindGroup,
  translatePublishedMetar,
  type GroupReading,
  type MetarBinding,
  type MetarReading,
  type MetarStationSite,
} from './published-metar.js';
export {
  type TafReading,
  publishedTafAdapter,
  publishedTafDescriptor,
  readTaf,
  tafDayHour,
  translatePublishedTaf,
} from './published-taf.js';
export {
  type RestrictionBinding,
  type RestrictionRegion,
  boundaryTouchesCircle,
  parseRestrictionRegions,
  publishedTfrAdapter,
  publishedTfrDescriptor,
  restrictionListItems,
  translatePublishedTfr,
} from './published-tfr.js';
export { type XmlElement, XmlRefusal, readXmlElements } from './xml-elements.js';
export const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const boundedKey = (value: string): string => (value.length > 150 ? `adapter:${digest(value)}` : value);

export interface AdapterConfig {
  sourceId: string;
  sourceSessionId?: string;
  ledger: LedgerClient;
  fidelity?: Fidelity;
}
export interface AdapterResult {
  receipt: ReceiptResponse;
  artifactId: string;
  sha256: string;
}

const secretKeys =
  /^(authorization|cookie|set-cookie|client_secret|clientsecret|access_token|accesstoken|refresh_token|refreshtoken|x-api-key|api_key|apikey|password)$/i;
function isLaancAuthorization(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).status === 'string' &&
    String((value as Record<string, unknown>).status).startsWith('STATUS_') &&
    Object.hasOwn(value, 'submissionType') &&
    Object.hasOwn(value, 'geom'),
  );
}
export function assertOperationalBody(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKeys.test(key) && !(key === 'authorization' && isLaancAuthorization(child)))
      throw new Error(`Credential field is not operational evidence: ${key}`);
    assertOperationalBody(child);
  }
}

export async function retainInput(
  config: AdapterConfig,
  raw: Uint8Array,
  contentType: string,
  input: Omit<FlightInput, 'artifactId' | 'sourceId' | 'sourceSessionId'>,
  key: string,
): Promise<AdapterResult> {
  assertOperationalBody(input.payload);
  if (contentType.includes('json')) assertOperationalBody(JSON.parse(new TextDecoder().decode(raw)));
  const sha256 = digest(raw);
  const { artifact } = await config.ledger.upload(
    raw,
    contentType,
    boundedKey(`${config.sourceId}:bytes:${sha256}`),
    `${config.sourceId.slice(0, 150)}-${sha256.slice(0, 12)}.json`,
  );
  const receipt = await config.ledger.input(
    { ...input, sourceId: config.sourceId, sourceSessionId: config.sourceSessionId, artifactId: artifact.id },
    boundedKey(key),
  );
  return { receipt, artifactId: artifact.id, sha256 };
}

export interface OrderMapping {
  id: string;
  revision: string;
  status: string;
  occurredAt: string;
  label: string;
  start: string;
  end: string;
  fulfillments: string;
  cancellation?: string;
  fulfillment: { intentId: string; attempt: string; orderIds: string; aircraft: string };
  statusValues: Record<string, 'accepted' | 'cancelled'>;
}

export const defaultOrderMapping: OrderMapping = {
  id: 'order_id',
  revision: 'version',
  status: 'state',
  occurredAt: 'updated_at',
  label: 'requested_work.name',
  start: 'schedule.start',
  end: 'schedule.end',
  fulfillments: 'flights',
  cancellation: 'cancellation',
  fulfillment: { intentId: 'flight_intent_id', attempt: 'attempt', orderIds: 'order_refs', aircraft: 'aircraft_id' },
  statusValues: { accepted: 'accepted', cancelled: 'cancelled' },
};

function field(value: unknown, path: string): unknown {
  if (!path || path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
    throw new Error('Invalid declarative mapping path');
  return path
    .split('.')
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object' && Object.hasOwn(current, part)
          ? (current as Record<string, unknown>)[part]
          : undefined,
      value,
    );
}
const textField = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value) throw new Error(`Missing string field ${name}`);
  return value;
};
const numberField = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Missing nonnegative integer field ${name}`);
  return value as number;
};
const timestamp = (value: unknown, name: string): string => {
  const text = textField(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`Invalid timestamp ${name}`);
  return text;
};

function orderCancellation(value: unknown, occurredAt: string, status: 'accepted' | 'cancelled') {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || status !== 'cancelled')
    throw new Error('Cancellation needs a cancelled order and a dispatcher disposition');
  const cancellation = value as Record<string, unknown>;
  const dispatcher = cancellation.dispatcher as Record<string, unknown> | undefined;
  if (
    cancellation.reason !== 'requested_window_unreachable' ||
    !dispatcher ||
    typeof dispatcher !== 'object' ||
    Array.isArray(dispatcher) ||
    Object.keys(cancellation).some((key) => !['reason', 'note', 'decidedAt', 'dispatcher'].includes(key)) ||
    Object.keys(dispatcher).some((key) => !['id', 'name'].includes(key))
  )
    throw new Error('Cancellation disposition has unsupported fields');
  const note = textField(cancellation.note, 'cancellation.note');
  const decidedAt = timestamp(cancellation.decidedAt, 'cancellation.decidedAt');
  const id = textField(dispatcher.id, 'cancellation.dispatcher.id');
  const name = textField(dispatcher.name, 'cancellation.dispatcher.name');
  if (note.length > 1000 || id.length > 200 || name.length > 200 || Date.parse(decidedAt) !== Date.parse(occurredAt))
    throw new Error('Cancellation disposition exceeds its limits or differs from the revision clock');
  return { reason: cancellation.reason, note, decidedAt, dispatcher: { id, name } };
}

export function mapPartnerOrder(raw: unknown, sourceId: string, mapping: OrderMapping = defaultOrderMapping) {
  assertOperationalBody(raw);
  const externalId = textField(field(raw, mapping.id), mapping.id);
  const revision = numberField(field(raw, mapping.revision), mapping.revision);
  const vendorStatus = textField(field(raw, mapping.status), mapping.status);
  const status = mapping.statusValues[vendorStatus];
  if (!status) throw new Error('Unmapped partner order status');
  const scheduledStart = timestamp(field(raw, mapping.start), mapping.start);
  const scheduledEnd = timestamp(field(raw, mapping.end), mapping.end);
  if (Date.parse(scheduledEnd) <= Date.parse(scheduledStart))
    throw new Error('Order window must have positive duration');
  const occurredAt = timestamp(field(raw, mapping.occurredAt), mapping.occurredAt);
  const cancellation = mapping.cancellation
    ? orderCancellation(field(raw, mapping.cancellation), occurredAt, status)
    : undefined;
  const label = textField(field(raw, mapping.label), mapping.label);
  const rows = field(raw, mapping.fulfillments);
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Order fulfillments must be a bounded array');
  const fulfillments: FlightCreate[] = rows.map((row, index) => {
    const id = textField(field(row, mapping.fulfillment.intentId), mapping.fulfillment.intentId);
    const attempt = numberField(field(row, mapping.fulfillment.attempt), mapping.fulfillment.attempt);
    const orderIds = field(row, mapping.fulfillment.orderIds);
    if (!Array.isArray(orderIds) || orderIds.some((value) => typeof value !== 'string' || !value))
      throw new Error('Fulfillment order references must be strings');
    return {
      originationKey: `${id}:attempt:${attempt}`,
      label: rows.length > 1 ? `${label} · ${index + 1} of ${rows.length}` : label,
      aircraft: textField(field(row, mapping.fulfillment.aircraft), mapping.fulfillment.aircraft),
      scheduledStart,
      scheduledEnd,
      orderRefs: orderIds.map((orderId) => ({ orderId, revision })),
      aliases: [{ sourceId, externalId: id }],
    };
  });
  return {
    externalId,
    revision,
    status,
    label,
    scheduledStart,
    scheduledEnd,
    fulfillments,
    occurredAt,
    ...(cancellation ? { cancellation } : {}),
  };
}

export class PartnerOrderAdapter {
  constructor(
    private config: AdapterConfig & { baseUrl: string; apiKey: string; mapping?: OrderMapping; fetcher?: typeof fetch },
  ) {}
  async ingest(raw: Uint8Array): Promise<AdapterResult> {
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    return this.ingestOrder(body, raw);
  }
  private async ingestOrder(body: unknown, raw: Uint8Array, delivery = 'webhook'): Promise<AdapterResult> {
    const { occurredAt, ...payload } = mapPartnerOrder(body, this.config.sourceId, this.config.mapping);
    return retainInput(
      this.config,
      raw,
      'application/json',
      {
        kind: 'order.revision',
        occurredAt,
        sourceRevision: payload.revision,
        subject: { orderId: payload.externalId },
        payload,
        fidelity: this.config.fidelity ?? 'synthetic_contract',
      },
      `order:${payload.externalId}:${payload.revision}:${delivery}`,
    );
  }
  async poll(): Promise<AdapterResult[]> {
    const response = await (this.config.fetcher ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}/partner/orders`, {
      headers: { 'x-partner-key': this.config.apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Partner feed returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const batch: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!batch || typeof batch !== 'object' || !Array.isArray((batch as { orders?: unknown }).orders))
      throw new Error('Partner response lacks orders');
    const results: AdapterResult[] = [];
    for (const order of (batch as { orders: unknown[] }).orders)
      results.push(await this.ingestOrder(order, bytes, `poll:${digest(bytes)}`));
    return results;
  }
}

export interface OAuthMachine {
  kind: 'machine';
  clientId: string;
  clientSecret: string;
  apiKey: string;
  scopes: string[];
}
export interface OAuthUser {
  kind: 'user';
  accessToken: string | (() => string | Promise<string>);
  apiKey?: string;
}
export type AirspaceCredential = OAuthMachine | OAuthUser;
export interface AirspaceConfig extends AdapterConfig {
  baseUrl: string;
  credential: AirspaceCredential;
  fetcher?: typeof fetch;
  schemaDigest?: string;
}

export class AirspaceLinkAdapter {
  private machineToken?: { value: string; expires: number };
  readonly retainedReceipts: AdapterResult[] = [];
  constructor(private config: AirspaceConfig) {}
  private declaredSchema() {
    return {
      ...(this.config.schemaDigest ? { schemaDigest: this.config.schemaDigest } : {}),
      limitations: [
        'Published wire schema declaration only; no sandbox or live validation. Authentication and transport schemas are incomplete.',
        ...(this.config.schemaDigest
          ? [
              'schemaDigest is SHA-256 of the pinned provenance manifest/bundle, rather than an individual endpoint schema.',
            ]
          : []),
      ],
    };
  }
  private async authHeaders(): Promise<Record<string, string>> {
    const credentials = this.config.credential;
    if (credentials.kind === 'user')
      return {
        authorization: `Bearer ${typeof credentials.accessToken === 'function' ? await credentials.accessToken() : credentials.accessToken}`,
        ...(credentials.apiKey ? { 'x-api-key': credentials.apiKey } : {}),
      };
    if (!this.machineToken || this.machineToken.expires <= Date.now() + 30_000) {
      const response = await (this.config.fetcher ?? fetch)(
        `${this.config.baseUrl.replace(/\/$/, '')}/v1/oauth/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-api-key': credentials.apiKey },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            scope: credentials.scopes.join(' '),
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error(`AirHub authentication returned ${response.status}`);
      const token = (await response.json()) as { data: { accessToken: string; expires: string } };
      if (!token.data?.accessToken || !Number.isFinite(Date.parse(token.data.expires)))
        throw new Error('Malformed AirHub token response');
      this.machineToken = { value: token.data.accessToken, expires: Date.parse(token.data.expires) };
    }
    return { authorization: `Bearer ${this.machineToken.value}`, 'x-api-key': credentials.apiKey };
  }
  async vendorRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    originationKey: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const supported =
      /^\/v1\/operations(?:\/[A-Za-z0-9_-]+(?:\/laanc(?:\/authorizations\/[A-Za-z0-9_-]+(?:\/(?:cancel|cancelinvalid|close|rescindack))?)?)?)?$/.test(
        path,
      ) || /^\/v2\/briefing\/b4ufly\/(area|location)$/.test(path);
    if (!supported) throw new Error('Unsupported AirHub adapter surface');
    if (body) assertOperationalBody(body);
    const attemptedAt = new Date().toISOString();
    if (body) {
      const requestBytes = new TextEncoder().encode(JSON.stringify(body));
      this.retainedReceipts.push(
        await retainInput(
          this.config,
          requestBytes,
          'application/json',
          {
            kind: 'source.observation',
            occurredAt: attemptedAt,
            subject: { originationKey },
            payload: {
              vendor: 'airspace-link',
              direction: 'outbound',
              method,
              path,
              request: body,
              ...this.declaredSchema(),
            },
            fidelity: this.config.fidelity ?? 'synthetic_contract',
          },
          `airhub:request:${method}:${path}:${digest(requestBytes)}:${attemptedAt}`,
        ),
      );
    }
    const headers = { ...(await this.authHeaders()), ...(body ? { 'content-type': 'application/json' } : {}) };
    const response = await (this.config.fetcher ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new Error(`AirHub operation returned ${response.status}`);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
    const observedAt = new Date().toISOString();
    const normalized =
      value && typeof value === 'object' && Object.hasOwn(value, 'authorization')
        ? { authorizationRecord: (value as Record<string, unknown>).authorization }
        : value;
    this.retainedReceipts.push(
      await retainInput(
        this.config,
        bytes,
        'application/json',
        {
          kind: 'source.observation',
          occurredAt: observedAt,
          subject: { originationKey },
          payload: {
            vendor: 'airspace-link',
            direction: 'inbound',
            method,
            path,
            response: normalized,
            ...this.declaredSchema(),
          },
          fidelity: this.config.fidelity ?? 'synthetic_contract',
        },
        `airhub:response:${method}:${path}:${digest(bytes)}:${observedAt}`,
      ),
    );
    return value;
  }
  async pollOperation(operationId: string, originationKey: string): Promise<AdapterResult[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(operationId)) throw new Error('Invalid AirHub operation identity');
    const path = `/v1/operations/${encodeURIComponent(operationId)}/laanc`;
    const response = await (this.config.fetcher ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: await this.authHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`AirHub LAANC returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      operation?: { authorizations?: Array<Record<string, unknown>> };
    };
    if (!parsed.operation || !Array.isArray(parsed.operation.authorizations))
      throw new Error('Malformed AirHub LAANC operation response');
    const results: AdapterResult[] = [];
    for (const authorization of parsed.operation.authorizations) {
      const occurredAt = timestamp(authorization.lastUpdatedAt, 'lastUpdatedAt');
      const id = textField(authorization.id, 'authorization.id');
      const status = textField(authorization.status, 'authorization.status');
      results.push(
        await retainInput(
          this.config,
          bytes,
          'application/json',
          {
            kind: 'airspace.status',
            occurredAt,
            subject: { originationKey },
            payload: {
              operationId,
              authorizationId: id,
              status,
              authorizationRecord: authorization,
              ...this.declaredSchema(),
            },
            fidelity: this.config.fidelity ?? 'synthetic_contract',
          },
          `airhub:authorization:${id}:${digest(JSON.stringify(authorization))}`,
        ),
      );
    }
    return results;
  }
  async receiveCallback(raw: Uint8Array, originationKey: string, verified: boolean): Promise<AdapterResult> {
    if (!verified) throw new Error('AirHub callback verifier rejected delivery');
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    const id = textField(body.authId, 'authId');
    const occurredAt = timestamp(body.authStatusDate, 'authStatusDate');
    return retainInput(
      this.config,
      raw,
      'application/json',
      {
        kind: 'airspace.status',
        occurredAt,
        subject: { originationKey },
        payload: {
          authorizationId: id,
          status: textField(body.authStatus, 'authStatus'),
          callback: body,
          limitations: ['Callback signing, retry and ordering are synthetic pending vendor validation.'],
        },
        fidelity: 'synthetic_contract',
      },
      `airhub:callback:${id}:${digest(raw)}`,
    );
  }
}

export class PkceClient {
  constructor(
    private config: {
      authorizationUrl: string;
      tokenUrl: string;
      clientId: string;
      redirectUri: string;
      scopes: string[];
      fetcher?: typeof fetch;
    },
  ) {}
  authorize(verifier = randomBytes(32).toString('base64url'), state = randomBytes(16).toString('hex')) {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('PKCE verifier must meet RFC 7636 bounds');
    const url = new URL(this.config.authorizationUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      state,
    }).toString();
    return { url: url.toString(), verifier, state };
  }
  async exchange(code: string, verifier: string): Promise<string> {
    const response = await (this.config.fetcher ?? fetch)(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        code,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`User OAuth exchange returned ${response.status}`);
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) throw new Error('Malformed user OAuth token');
    return body.access_token;
  }
}
