import type { ValidateFunction } from 'ajv';
import {
  CONTROL_EFFECTIVENESS_LIMITS,
  MonitoringReportInputV2Schema,
  MonitoringReportSourceV2Schema,
  type MonitoringReportInputV2,
  type MonitoringReportSourceV2,
  type Principal,
  type ReceiptResponse,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import { normalizeApiUrl, requireSourceContract, schemaValidator } from './source-contract.js';

export interface MonitoringWindowAdapterConfig {
  ledger: LedgerClient;
  tenantId: string;
  sourceId: string;
  sourceSessionId: string;
  sourceWindowId: string;
}
export interface PreparedMonitoringWindowInput {
  version: 'ledger.monitoring-window-submission.2';
  apiUrl: string;
  tenantId: string;
  principalId: string;
  key: string;
  input: MonitoringReportInputV2;
  bytesBase64: string;
  sha256: string;
  submissionDigest: string;
}
export interface MonitoringWindowAdapterResult {
  receipt: ReceiptResponse;
  submittedUploadArtifactId: string;
  sha256: string;
}
type PendingCode = 'unsupported_contract' | 'capability_required' | 'source_grant_required';
export class MonitoringWindowPendingError extends Error {
  constructor(
    public code: PendingCode,
    message: string,
  ) {
    super(message);
    this.name = 'MonitoringWindowPendingError';
  }
}

const VERSION = 'ledger.monitoring-window-submission.2';
const SOURCE_BYTES_LIMIT = CONTROL_EFFECTIVENESS_LIMITS.maxMonitoringOriginalBytes;
const BASE64_LIMIT = 4 * Math.ceil(SOURCE_BYTES_LIMIT / 3);
const CHECKPOINT_KEYS = [
  'version',
  'apiUrl',
  'tenantId',
  'principalId',
  'key',
  'input',
  'bytesBase64',
  'sha256',
  'submissionDigest',
];
const ajv = schemaValidator();
const validateSource = ajv.compile<MonitoringReportSourceV2>(MonitoringReportSourceV2Schema);
const validateInput = ajv.compile<MonitoringReportInputV2>(MonitoringReportInputV2Schema);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const filename = (value: string) => `monitoring-window-${value.slice(0, 12)}.json`;
const unsupported = (): never => {
  throw new MonitoringWindowPendingError(
    'unsupported_contract',
    'Served Ledger contract does not support monitoring-window delivery',
  );
};

function utc(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new Error('Monitoring source requires valid UTC timestamps');
  return parsed;
}
function interval(value: { start: string; end: string }): number {
  const duration = utc(value.end) - utc(value.start);
  if (duration <= 0) throw new Error('Monitoring source intervals must have positive duration');
  return duration;
}

export class MonitoringWindowAdapter {
  private readonly ledger: LedgerClient;
  private readonly binding: Omit<MonitoringWindowAdapterConfig, 'ledger'> & { apiUrl: string };

  constructor(config: MonitoringWindowAdapterConfig) {
    const { ledger, tenantId, sourceId, sourceSessionId, sourceWindowId } = config;
    if (![tenantId, sourceId, sourceSessionId, sourceWindowId].every(id))
      throw new Error('Monitoring adapter requires exact tenant, source, session and window bindings');
    this.ledger = ledger;
    this.binding = {
      tenantId,
      sourceId,
      sourceSessionId,
      sourceWindowId,
      apiUrl: normalizeApiUrl(ledger.baseUrl, 'Monitoring adapter'),
    };
  }

  async prepare(raw: Uint8Array): Promise<PreparedMonitoringWindowInput> {
    this.checkApiUrl();
    if (!(raw instanceof Uint8Array) || raw.byteLength > SOURCE_BYTES_LIMIT)
      throw new Error('Monitoring source exceeds its 128 KiB byte contract');
    const bytes = Buffer.from(raw);
    const source = this.source(bytes);
    const rawDigest = sha256(bytes);
    const candidate = this.input(source, 'pending-monitoring-window-artifact');
    const served = await this.servedSupport(candidate, bytes.byteLength, rawDigest);
    const principal = await this.currentPrincipal(true);
    const { artifact } = await this.ledger.upload(
      bytes,
      'application/json',
      this.uploadKey(rawDigest),
      filename(rawDigest),
    );
    if (
      !artifact ||
      !id(artifact.id) ||
      artifact.sha256 !== rawDigest ||
      artifact.byteLength !== bytes.byteLength ||
      artifact.contentType !== 'application/json'
    )
      throw new Error('Monitoring upload does not match its retained source bytes');
    const input = this.input(source, artifact.id);
    if (!served(input)) return unsupported();
    const content: Omit<PreparedMonitoringWindowInput, 'submissionDigest'> = {
      version: VERSION,
      apiUrl: this.binding.apiUrl,
      tenantId: this.binding.tenantId,
      principalId: principal.id,
      key: this.key(source),
      input,
      bytesBase64: bytes.toString('base64'),
      sha256: rawDigest,
    };
    return { ...content, submissionDigest: canonicalDigest(content) };
  }

  async send(prepared: PreparedMonitoringWindowInput): Promise<MonitoringWindowAdapterResult> {
    const retained = this.retained(prepared);
    await this.servedSupport(retained.input, Buffer.from(retained.bytesBase64, 'base64').byteLength, retained.sha256);
    await this.currentPrincipal(true, retained.principalId);
    return this.deliver(retained);
  }

  async recover(prepared: PreparedMonitoringWindowInput): Promise<MonitoringWindowAdapterResult> {
    const retained = this.retained(prepared);
    await this.currentPrincipal(false, retained.principalId);
    return this.deliver(retained);
  }

  private checkApiUrl(): void {
    if (normalizeApiUrl(this.ledger.baseUrl, 'Monitoring adapter') !== this.binding.apiUrl)
      throw new Error('Monitoring client changed its retained API URL');
  }

  private source(bytes: Uint8Array): MonitoringReportSourceV2 {
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    canonicalize(value);
    if (!validateSource(value)) throw new Error('Monitoring source does not match its public V2 contract');
    if (value.sourceSessionId !== this.binding.sourceSessionId || value.sourceWindowId !== this.binding.sourceWindowId)
      throw new Error('Monitoring source changed its pinned session or window');
    if (interval(value.window) > CONTROL_EFFECTIVENESS_LIMITS.maxWindowMilliseconds)
      throw new Error('Monitoring window exceeds one hour');
    const occurredAt = utc(value.occurredAt);
    if (utc(value.completeThrough) > occurredAt)
      throw new Error('Monitoring completeness cannot follow its source occurrence');
    if (
      value.flights.reduce((count, flight) => count + flight.declaredC2SourceEventIds.length + 1, 0) >
      CONTROL_EFFECTIVENESS_LIMITS.maxC2Records
    )
      throw new Error('Monitoring source exceeds its combined 128-record C2 bound');
    const flights = new Set<string>();
    const sessions = new Set<string>();
    for (const flight of value.flights) {
      const session = canonicalize([flight.c2SourceId, flight.c2SourceSessionId]);
      if (flights.has(flight.flightId) || sessions.has(session))
        throw new Error('Monitoring source must select distinct flights and C2 sessions');
      flights.add(flight.flightId);
      sessions.add(session);
      for (const reported of [
        ...flight.observedIntervals,
        ...(flight.coverageIntervals ?? []),
        ...flight.gaps.map((gap) => gap.interval),
      ]) {
        interval(reported);
        if (utc(reported.end) > occurredAt)
          throw new Error('Reported monitoring intervals cannot follow their source occurrence');
      }
    }
    return value;
  }

  private input(source: MonitoringReportSourceV2, artifactId: string): MonitoringReportInputV2 {
    const { sourceSessionId, occurredAt, ...payload } = source;
    return {
      sourceId: this.binding.sourceId,
      sourceSessionId,
      kind: 'monitoring.window',
      occurredAt,
      artifactId,
      fidelity: 'synthetic_contract',
      payload,
    };
  }

  private uploadKey(rawDigest: string): string {
    return `monitoring-window:bytes:${canonicalDigest({ sourceId: this.binding.sourceId, sha256: rawDigest })}`;
  }

  private key(source: Pick<MonitoringReportSourceV2, 'sourceSessionId' | 'sourceWindowId' | 'sourceRevision'>): string {
    return `monitoring-window:revision:${canonicalDigest({
      version: 'ledger.monitoring-window-delivery.2',
      tenantId: this.binding.tenantId,
      sourceId: this.binding.sourceId,
      sourceSessionId: source.sourceSessionId,
      sourceWindowId: source.sourceWindowId,
      sourceRevision: source.sourceRevision,
    })}`;
  }

  private retained(prepared: PreparedMonitoringWindowInput): PreparedMonitoringWindowInput {
    this.checkApiUrl();
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      Object.getPrototypeOf(prepared) !== Object.prototype ||
      Object.keys(prepared).length !== CHECKPOINT_KEYS.length ||
      !CHECKPOINT_KEYS.every((key) => Object.hasOwn(prepared, key)) ||
      typeof prepared.bytesBase64 !== 'string' ||
      prepared.bytesBase64.length > BASE64_LIMIT ||
      prepared.version !== VERSION ||
      prepared.apiUrl !== this.binding.apiUrl ||
      prepared.tenantId !== this.binding.tenantId ||
      !id(prepared.principalId) ||
      !id(prepared.key) ||
      !digest(prepared.sha256) ||
      !digest(prepared.submissionDigest) ||
      !validateInput(prepared.input)
    )
      throw new Error('Retained monitoring submission changed its bounded identity or request');
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    if (
      bytes.byteLength > SOURCE_BYTES_LIMIT ||
      bytes.toString('base64') !== prepared.bytesBase64 ||
      sha256(bytes) !== prepared.sha256
    )
      throw new Error('Retained monitoring source bytes changed');
    const source = this.source(bytes);
    if (
      canonicalize(prepared.input) !== canonicalize(this.input(source, prepared.input.artifactId)) ||
      prepared.key !== this.key(source)
    )
      throw new Error('Retained monitoring request changed its pinned source window or revision');
    const { submissionDigest, ...content } = prepared;
    if (canonicalDigest(content) !== submissionDigest)
      throw new Error('Retained monitoring submission changed its content commitment');
    return structuredClone(prepared);
  }

  private async servedSupport(
    input: MonitoringReportInputV2,
    byteLength: number,
    rawDigest: string,
  ): Promise<ValidateFunction> {
    try {
      return await requireSourceContract({
        ledger: this.ledger,
        input,
        inputSchema: MonitoringReportInputV2Schema,
        kind: 'monitoring.window',
        key: this.key({ sourceSessionId: input.sourceSessionId, ...input.payload }),
        uploadKey: this.uploadKey(rawDigest),
        filename: filename(rawDigest),
        byteLength,
        unsupported,
      });
    } catch (error) {
      if (error instanceof MonitoringWindowPendingError) throw error;
      return unsupported();
    }
  }

  private async currentPrincipal(fresh: boolean, principalId?: string): Promise<Principal> {
    const { principal } = await this.ledger.request<{ principal: Principal }>('/v1/me');
    if (
      !principal ||
      !id(principal.id) ||
      principal.tenantId !== this.binding.tenantId ||
      (principalId && principal.id !== principalId)
    )
      throw new Error('Monitoring client changed its retained principal or tenant');
    const required = fresh ? ['input:write', 'monitoring:write'] : ['input:write'];
    if (
      !Array.isArray(principal.capabilities) ||
      required.some((capability) => !principal.capabilities.includes(capability as Principal['capabilities'][number]))
    )
      throw new MonitoringWindowPendingError(
        'capability_required',
        'Monitoring delivery lacks its required write capabilities',
      );
    if (
      fresh &&
      (!Array.isArray(principal.monitoringSources) ||
        principal.monitoringSources.length > 100 ||
        !principal.monitoringSources.every(id) ||
        new Set(principal.monitoringSources).size !== principal.monitoringSources.length ||
        !principal.monitoringSources.includes(this.binding.sourceId))
    )
      throw new MonitoringWindowPendingError(
        'source_grant_required',
        'Monitoring source has not been explicitly granted',
      );
    return principal;
  }

  private async deliver(prepared: PreparedMonitoringWindowInput): Promise<MonitoringWindowAdapterResult> {
    const receipt = await this.ledger.input(prepared.input, prepared.key);
    const accepted = receipt?.receipt;
    if (
      !accepted ||
      !id(accepted.id) ||
      !id(accepted.eventId) ||
      accepted.status !== 'accepted' ||
      accepted.kind !== 'monitoring.window' ||
      accepted.sourceId !== prepared.input.sourceId ||
      accepted.flightId !== undefined ||
      accepted.orderId !== undefined ||
      accepted.linkStatus !== 'linked' ||
      !id(accepted.artifactId) ||
      Date.parse(accepted.occurredAt) !== Date.parse(prepared.input.occurredAt) ||
      canonicalize(accepted.payload) !== canonicalize(prepared.input.payload)
    )
      throw new Error('Monitoring receipt does not match the submitted source window');
    return { receipt, submittedUploadArtifactId: prepared.input.artifactId, sha256: prepared.sha256 };
  }
}
