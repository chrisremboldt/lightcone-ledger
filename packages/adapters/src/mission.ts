import type { ValidateFunction } from 'ajv';
import {
  MISSION_SOURCE_MAX_BYTES,
  MissionInputSchema,
  MissionSourceSchema,
  missionRoutePlanningReasons,
  type MissionInput,
  type MissionSource,
  type Principal,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import type { MissionAdapterConfig, MissionAdapterResult, PreparedMissionInput } from './mission-types.js';
import { normalizeApiUrl, requireSourceContract, schemaValidator } from './source-contract.js';

type PendingCode = 'unsupported_contract' | 'capability_required' | 'source_grant_required';
export class MissionPendingError extends Error {
  constructor(
    public code: PendingCode,
    message: string,
  ) {
    super(message);
    this.name = 'MissionPendingError';
  }
}

const VERSION = 'ledger.mission-submission.1';
const SOURCE_BYTES_LIMIT = MISSION_SOURCE_MAX_BYTES;
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
const validateSource = ajv.compile<MissionSource>(MissionSourceSchema);
const validateInput = ajv.compile<MissionInput>(MissionInputSchema);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const filename = (value: string) => `mission-${value.slice(0, 12)}.json`;
const unsupported = (): never => {
  throw new MissionPendingError('unsupported_contract', 'Served Ledger contract does not support mission delivery');
};

function utcTime(value: string): number | undefined {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}

export class MissionAdapter {
  private readonly ledger: LedgerClient;
  private readonly binding: Omit<MissionAdapterConfig, 'ledger'> & { apiUrl: string };

  constructor(config: MissionAdapterConfig) {
    const { ledger, tenantId, sourceId, sourceMissionId, aircraftId, flightId } = config;
    if (![tenantId, sourceId, sourceMissionId, aircraftId, flightId].every(id))
      throw new Error('Mission adapter requires exact tenant, source, mission, aircraft and flight bindings');
    this.ledger = ledger;
    this.binding = {
      tenantId,
      sourceId,
      sourceMissionId,
      aircraftId,
      flightId,
      apiUrl: normalizeApiUrl(ledger.baseUrl, 'Mission adapter'),
    };
  }

  async prepare(raw: Uint8Array): Promise<PreparedMissionInput> {
    this.checkApiUrl();
    if (!(raw instanceof Uint8Array) || raw.byteLength > SOURCE_BYTES_LIMIT)
      throw new Error('Mission source exceeds its 64 KiB byte contract');
    const bytes = Buffer.from(raw);
    const source = this.source(bytes);
    const rawDigest = sha256(bytes);
    const candidate = this.input(source, 'pending-mission-artifact');
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
      throw new Error('Mission upload does not match the retained source bytes');
    const input = this.input(source, artifact.id);
    if (!served(input)) return unsupported();
    const prepared: Omit<PreparedMissionInput, 'submissionDigest'> = {
      version: VERSION,
      apiUrl: this.binding.apiUrl,
      tenantId: this.binding.tenantId,
      principalId: principal.id,
      key: this.key(source),
      input,
      bytesBase64: bytes.toString('base64'),
      sha256: rawDigest,
    };
    return { ...prepared, submissionDigest: canonicalDigest(prepared) };
  }

  async send(prepared: PreparedMissionInput): Promise<MissionAdapterResult> {
    const retained = this.retained(prepared);
    await this.servedSupport(retained.input, Buffer.from(retained.bytesBase64, 'base64').byteLength, retained.sha256);
    await this.currentPrincipal(true, retained.principalId);
    return this.deliver(retained);
  }

  async recover(prepared: PreparedMissionInput): Promise<MissionAdapterResult> {
    const retained = this.retained(prepared);
    await this.currentPrincipal(false, retained.principalId);
    return this.deliver(retained);
  }

  private checkApiUrl(): void {
    if (normalizeApiUrl(this.ledger.baseUrl, 'Mission adapter') !== this.binding.apiUrl)
      throw new Error('Mission client changed its retained API URL');
  }

  private source(bytes: Uint8Array): MissionSource {
    if (bytes.byteLength > SOURCE_BYTES_LIMIT) throw new Error('Mission source exceeds 64 KiB');
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    canonicalize(value);
    if (!validateSource(value)) throw new Error('Mission source does not match its public contract');
    const start = utcTime(value.operatingInterval.start);
    const end = utcTime(value.operatingInterval.end);
    if (
      utcTime(value.occurredAt) === undefined ||
      start === undefined ||
      end === undefined ||
      start >= end ||
      value.altitude.minimum > value.altitude.maximum
    )
      throw new Error('Mission source requires valid UTC times, a positive interval and an ordered altitude band');
    if (value.sourceMissionId !== this.binding.sourceMissionId || value.aircraftId !== this.binding.aircraftId)
      throw new Error('Mission source changed its pinned mission or aircraft');
    if (
      value.routePlanning &&
      missionRoutePlanningReasons(value.routePlanning, value.route.geometry.coordinates, value.operatingInterval).length
    )
      throw new Error('Mission planning context must retain its required locations and source interval bounds');
    return value;
  }

  private input(source: MissionSource, artifactId: string): MissionInput {
    const { sourceRevision, occurredAt, ...payload } = source;
    return {
      sourceId: this.binding.sourceId,
      kind: 'mission.revision',
      sourceRevision,
      occurredAt,
      subject: { flightId: this.binding.flightId },
      artifactId,
      fidelity: 'synthetic_contract',
      payload,
    };
  }

  private uploadKey(rawDigest: string): string {
    return `mission:bytes:${canonicalDigest({ sourceId: this.binding.sourceId, sha256: rawDigest })}`;
  }

  private key(source: Pick<MissionSource, 'sourceMissionId' | 'sourceRevision'>): string {
    return `mission:revision:${canonicalDigest({
      version: 'ledger.mission-delivery.1',
      tenantId: this.binding.tenantId,
      sourceId: this.binding.sourceId,
      sourceMissionId: source.sourceMissionId,
      sourceRevision: source.sourceRevision,
    })}`;
  }

  private retained(prepared: PreparedMissionInput): PreparedMissionInput {
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
      throw new Error('Retained mission submission changed its bounded identity or request');
    const bytes = Buffer.from(prepared.bytesBase64, 'base64');
    if (
      bytes.byteLength > SOURCE_BYTES_LIMIT ||
      bytes.toString('base64') !== prepared.bytesBase64 ||
      sha256(bytes) !== prepared.sha256
    )
      throw new Error('Retained mission source bytes changed');
    const source = this.source(bytes);
    if (
      canonicalize(prepared.input) !== canonicalize(this.input(source, prepared.input.artifactId)) ||
      prepared.key !== this.key(source)
    )
      throw new Error('Retained mission request changed its pinned source, revision or flight');
    const { submissionDigest, ...content } = prepared;
    if (canonicalDigest(content) !== submissionDigest)
      throw new Error('Retained mission submission changed its content commitment');
    return structuredClone(prepared);
  }

  private async servedSupport(input: MissionInput, byteLength: number, rawDigest: string): Promise<ValidateFunction> {
    try {
      return await requireSourceContract({
        ledger: this.ledger,
        input,
        inputSchema: MissionInputSchema,
        kind: 'mission.revision',
        key: this.key({ sourceMissionId: input.payload.sourceMissionId, sourceRevision: input.sourceRevision }),
        uploadKey: this.uploadKey(rawDigest),
        filename: filename(rawDigest),
        byteLength,
        unsupported,
      });
    } catch (error) {
      if (error instanceof MissionPendingError) throw error;
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
      throw new Error('Mission client changed its retained principal or tenant');
    const required = fresh ? ['input:write', 'mission:write'] : ['input:write'];
    if (
      !Array.isArray(principal.capabilities) ||
      required.some((capability) => !principal.capabilities.includes(capability as Principal['capabilities'][number]))
    )
      throw new MissionPendingError('capability_required', 'Mission delivery lacks its required write capabilities');
    if (
      fresh &&
      (!Array.isArray(principal.missionSources) ||
        principal.missionSources.length > 100 ||
        !principal.missionSources.every(id) ||
        new Set(principal.missionSources).size !== principal.missionSources.length ||
        !principal.missionSources.includes(this.binding.sourceId))
    )
      throw new MissionPendingError('source_grant_required', 'Mission source has not been explicitly granted');
    return principal;
  }

  private async deliver(prepared: PreparedMissionInput): Promise<MissionAdapterResult> {
    const receipt = await this.ledger.input(prepared.input, prepared.key);
    const accepted = receipt?.receipt;
    if (
      !accepted ||
      !id(accepted.id) ||
      !id(accepted.eventId) ||
      accepted.status !== 'accepted' ||
      accepted.kind !== 'mission.revision' ||
      accepted.sourceId !== prepared.input.sourceId ||
      accepted.flightId !== this.binding.flightId ||
      accepted.linkStatus !== 'linked' ||
      !id(accepted.artifactId) ||
      Date.parse(accepted.occurredAt) !== Date.parse(prepared.input.occurredAt) ||
      canonicalize(accepted.payload) !== canonicalize(prepared.input.payload)
    )
      throw new Error('Mission receipt does not match the submitted planned geometry');
    return { receipt, submittedUploadArtifactId: prepared.input.artifactId, sha256: prepared.sha256 };
  }
}
