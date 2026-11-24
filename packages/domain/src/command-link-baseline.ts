import {
  COMMAND_LINK_BASELINE_MAX_BYTES,
  COMMAND_LINK_BASELINE_MAX_READ_BYTES,
  type CommandLinkBaselineAuthority,
  type CommandLinkBaselineInput,
  type CommandLinkBaselineRecord,
  type CommandLinkBaselineRecordResponse,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize, parseStrictJson, sha256 } from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  type AuthContext,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';

interface ArtifactRow {
  object_key: string;
  byte_length: number;
  sha256: string;
  content_type: string;
}
interface BaselineMetadata {
  id: string;
  receipt_id: string;
  flight_id: string;
  aircraft_id: string;
  source_id: string;
  source_session_id: string;
  source_event_id: string;
  artifact_id: string;
  actor_id: string;
  occurred_at: Date;
  recorded_at: Date;
  record_digest: string;
  record_bytes: number;
  state: string | null;
}
interface ProjectionMetadata extends BaselineMetadata, ArtifactRow {
  content_digest: string;
  first_event_id: string;
  stream_name: string;
  receipt_event_id: string;
  receipt_kind: string;
  receipt_source_id: string;
  receipt_flight_id: string | null;
  receipt_artifact_id: string | null;
  receipt_link_status: string;
  receipt_occurred_at: Date;
  receipt_received_at: Date;
  receipt_payload: CommandLinkBaselineInput['payload'];
  receipt_subject: CommandLinkBaselineInput['subject'];
}
export interface VerifiedCommandLinkBaselineSource {
  sha256: string;
  byteLength: number;
  contentDigest: string;
}
// RETAINED: baselines are no longer accepted (the intake refuses them with 410). Baselines recorded earlier are still
// projected, read and verified here, against the authority they were accepted under.
const REQUIRED_CAPABILITIES = ['input:write', 'command-link:write'] as const;
const AUTHORITY_VERSION = 'ledger.command-link-baseline-authority.1';
const BASELINE_COLUMNS =
  'b.id,b.receipt_id,b.flight_id,b.aircraft_id,b.source_id,b.source_session_id,b.source_event_id,b.artifact_id,b.actor_id,b.occurred_at,b.recorded_at,b.record_digest';
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
function baselineResponse(
  record: CommandLinkBaselineRecord,
  digest: string,
  processing: CommandLinkBaselineRecordResponse['processing'],
): CommandLinkBaselineRecordResponse {
  const response = { baseline: record, digest, processing };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > COMMAND_LINK_BASELINE_MAX_READ_BYTES)
    throw new DomainError(409, 'command_link_baseline_record_too_large', 'Baseline response exceeds its read bound');
  return response;
}
function keys(value: unknown, required: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?Z$/.test(value))
    return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19);
}
function grants(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id) && new Set(value).size === value.length;
}
function normalizedInput(input: CommandLinkBaselineInput): void {
  if (
    !keys(input, [
      'sourceId',
      'sourceSessionId',
      'kind',
      'occurredAt',
      'subject',
      'artifactId',
      'fidelity',
      'payload',
    ]) ||
    input.kind !== 'command-link.baseline' ||
    input.fidelity !== 'synthetic_contract' ||
    !id(input.sourceId) ||
    !id(input.sourceSessionId) ||
    !id(input.artifactId) ||
    !utc(input.occurredAt) ||
    !keys(input.subject, ['flightId']) ||
    !id(input.subject.flightId) ||
    !keys(input.payload, ['version', 'sourceEventId', 'aircraftId', 'state']) ||
    input.payload.version !== 'command-link.baseline.1' ||
    !id(input.payload.sourceEventId) ||
    !id(input.payload.aircraftId) ||
    !['up', 'down', 'unknown'].includes(input.payload.state)
  )
    throw new DomainError(
      400,
      'command_link_baseline_source_invalid',
      'Baseline evidence must match its typed source contract',
    );
}
export function verifyCommandLinkBaselineInputSource(
  input: CommandLinkBaselineInput,
  bytes: Uint8Array,
): VerifiedCommandLinkBaselineSource {
  normalizedInput(input);
  if (bytes.byteLength > COMMAND_LINK_BASELINE_MAX_BYTES)
    throw new DomainError(
      413,
      'command_link_baseline_source_too_large',
      'Command-link baseline exceeds its 64 KiB source bound',
    );
  try {
    const source = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    const expected = {
      ...input.payload,
      sourceId: input.sourceId,
      sourceSessionId: input.sourceSessionId,
      flightId: input.subject.flightId,
      occurredAt: input.occurredAt,
    };
    if (canonicalize(source) !== canonicalize(expected)) throw new Error('Source mapping differs');
  } catch {
    throw new DomainError(
      400,
      'command_link_baseline_source_invalid',
      'Baseline input must reproduce its exact original UTF-8 JSON source',
    );
  }
  const original = {
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    bytesBase64: Buffer.from(bytes).toString('base64'),
  };
  return {
    sha256: original.sha256,
    byteLength: original.byteLength,
    contentDigest: canonicalDigest({
      version: 'ledger.command-link-baseline-content.1',
      sourceId: input.sourceId,
      sourceSessionId: input.sourceSessionId,
      flightId: input.subject.flightId,
      occurredAt: input.occurredAt,
      fidelity: input.fidelity,
      payload: input.payload,
      original,
    }),
  };
}
function acceptedAuthority(
  value: unknown,
  principalId: string,
  tenantId: string,
  sourceId: string,
): CommandLinkBaselineAuthority {
  if (
    !keys(value, [
      'version',
      'principalId',
      'tenantId',
      'principalRevision',
      'inputKind',
      'sourceId',
      'requiredCapabilities',
      'grantedSources',
    ]) ||
    value.version !== AUTHORITY_VERSION ||
    value.principalId !== principalId ||
    value.tenantId !== tenantId ||
    !id(value.principalId) ||
    !id(value.tenantId) ||
    !Number.isSafeInteger(value.principalRevision) ||
    Number(value.principalRevision) < 1 ||
    value.inputKind !== 'command-link.baseline' ||
    value.sourceId !== sourceId ||
    !id(sourceId) ||
    !Array.isArray(value.requiredCapabilities) ||
    canonicalDigest(value.requiredCapabilities) !== canonicalDigest(REQUIRED_CAPABILITIES) ||
    !grants(value.grantedSources) ||
    !value.grantedSources.includes(sourceId)
  )
    throw new DomainError(
      403,
      'command_link_baseline_authority_invalid',
      'Retained baseline authority does not match its immutable issuer and source',
    );
  return value as unknown as CommandLinkBaselineAuthority;
}
export function validateAcceptedCommandLinkBaselineAuthority(event: JournalEvent): CommandLinkBaselineAuthority {
  if (
    event.event_type !== 'command-link.baseline' ||
    !id(event.source_id) ||
    !id(event.source_session_id) ||
    ('effective_at' in event && event.effective_at !== null)
  )
    throw new DomainError(
      403,
      'command_link_baseline_authority_invalid',
      'Only baseline source evidence may use this authority',
    );
  return acceptedAuthority(event.payload.acceptedAuthority, event.principal_id, event.tenant_id, event.source_id);
}
async function originalBytes(artifact: ArtifactRow, objectStore?: ObjectStore): Promise<Uint8Array> {
  if (artifact.content_type !== 'application/json')
    throw new DomainError(400, 'command_link_baseline_source_invalid', 'Baseline original must be application/json');
  if (artifact.byte_length < 1 || artifact.byte_length > COMMAND_LINK_BASELINE_MAX_BYTES)
    throw new DomainError(
      413,
      'command_link_baseline_source_too_large',
      'Command-link baseline exceeds its 64 KiB source bound',
    );
  let bytes: Uint8Array;
  try {
    if (!objectStore) throw new Error('No object store supplied');
    bytes = await readBoundedObject(objectStore, artifact.object_key, {
      maxBytes: artifact.byte_length,
      timeoutMs: 10000,
    });
  } catch {
    throw new DomainError(409, 'artifact_unavailable', 'Original baseline source bytes are unavailable');
  }
  if (bytes.byteLength !== artifact.byte_length || sha256(bytes) !== artifact.sha256)
    throw new DomainError(
      409,
      'artifact_integrity_failure',
      'Original baseline bytes differ from their retained digest',
    );
  return bytes;
}
function verifyRecord(record: CommandLinkBaselineRecord, row: BaselineMetadata, tenantId: string): void {
  normalizedInput(record.input);
  acceptedAuthority(record.authority, row.actor_id, tenantId, row.source_id);
  if (
    !keys(record, ['eventId', 'receiptId', 'recordedAt', 'input', 'authority', 'original']) ||
    !keys(record.original, ['artifactId', 'sha256', 'byteLength']) ||
    record.eventId !== row.id ||
    record.receiptId !== row.receipt_id ||
    record.recordedAt !== row.recorded_at.toISOString() ||
    record.input.sourceId !== row.source_id ||
    record.input.sourceSessionId !== row.source_session_id ||
    record.input.payload.sourceEventId !== row.source_event_id ||
    record.input.payload.aircraftId !== row.aircraft_id ||
    record.input.subject.flightId !== row.flight_id ||
    record.input.artifactId !== row.artifact_id ||
    record.original.artifactId !== row.artifact_id ||
    Date.parse(record.input.occurredAt) !== row.occurred_at.getTime() ||
    row.occurred_at.getTime() > row.recorded_at.getTime() ||
    !/^[a-f0-9]{64}$/.test(record.original.sha256) ||
    !Number.isSafeInteger(record.original.byteLength) ||
    record.original.byteLength < 1 ||
    record.original.byteLength > COMMAND_LINK_BASELINE_MAX_BYTES ||
    canonicalDigest(record) !== row.record_digest
  )
    throw new DomainError(
      409,
      'command_link_baseline_commitment_mismatch',
      'Baseline record differs from its immutable acceptance',
    );
}
export async function getCommandLinkBaseline(
  client: PoolClient,
  principal: AuthContext,
  flightId: string,
  baselineId: string,
): Promise<CommandLinkBaselineRecordResponse> {
  if (
    !(await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2', [principal.tenantId, flightId]))
      .rowCount
  )
    throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const row = (
    await client.query<BaselineMetadata>(
      `SELECT ${BASELINE_COLUMNS},octet_length(b.record::text) AS record_bytes,w.state FROM command_link_baselines b
    LEFT JOIN work_items w ON w.tenant_id=b.tenant_id AND w.event_id=b.id WHERE b.tenant_id=$1 AND b.flight_id=$2 AND b.id=$3`,
      [principal.tenantId, flightId, baselineId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      404,
      'command_link_baseline_not_found',
      'The exact baseline was not found within this flight',
    );
  if (row.record_bytes > COMMAND_LINK_BASELINE_MAX_READ_BYTES)
    throw new DomainError(409, 'command_link_baseline_record_too_large', 'Baseline record exceeds its read bound');
  const record = (
    await client.query<{ record: CommandLinkBaselineRecord }>(
      'SELECT record FROM command_link_baselines WHERE tenant_id=$1 AND flight_id=$2 AND id=$3',
      [principal.tenantId, flightId, baselineId],
    )
  ).rows[0].record;
  verifyRecord(record, row, principal.tenantId);
  return baselineResponse(
    record,
    row.record_digest,
    row.state === 'completed'
      ? 'completed'
      : row.state === 'failed'
        ? 'failed'
        : row.state === 'leased'
          ? 'processing'
          : 'pending',
  );
}
export async function projectCommandLinkBaselineEvent(
  client: PoolClient,
  event: JournalEvent,
  objectStore?: ObjectStore,
): Promise<void> {
  const authority = validateAcceptedCommandLinkBaselineAuthority(event);
  const flightId = event.payload.flightId;
  if (
    !id(flightId) ||
    !(
      await client.query('SELECT id FROM flight_views WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        event.tenant_id,
        flightId,
      ])
    ).rowCount
  )
    throw new DomainError(404, 'flight_not_found', 'Flight was not found within your scope');
  const row = (
    await client.query<ProjectionMetadata>(
      `SELECT ${BASELINE_COLUMNS},octet_length(b.record::text) AS record_bytes,a.object_key,a.byte_length,a.sha256,a.content_type,
    c.content_digest,s.first_event_id,stream.name AS stream_name,r.event_id AS receipt_event_id,r.kind AS receipt_kind,r.source_id AS receipt_source_id,
    r.flight_id AS receipt_flight_id,r.artifact_id AS receipt_artifact_id,r.link_status AS receipt_link_status,r.occurred_at AS receipt_occurred_at,
    r.received_at AS receipt_received_at,r.payload AS receipt_payload,r.input_subject AS receipt_subject
    FROM command_link_baselines b JOIN artifacts a ON a.tenant_id=b.tenant_id AND a.id=b.artifact_id
    JOIN command_link_sessions s ON s.tenant_id=b.tenant_id AND s.source_id=b.source_id AND s.source_session_id=b.source_session_id AND s.flight_id=b.flight_id AND s.aircraft_id=b.aircraft_id
    JOIN command_link_source_events c ON c.tenant_id=b.tenant_id AND c.event_id=b.id AND c.receipt_id=b.receipt_id AND c.source_id=b.source_id AND c.source_session_id=b.source_session_id AND c.source_event_id=b.source_event_id AND c.flight_id=b.flight_id AND c.aircraft_id=b.aircraft_id
    JOIN receipts r ON r.tenant_id=b.tenant_id AND r.id=b.receipt_id JOIN streams stream ON stream.tenant_id=b.tenant_id AND stream.id=$3
    WHERE b.tenant_id=$1 AND b.id=$2 AND b.flight_id=$4 FOR SHARE OF r`,
      [event.tenant_id, event.id, event.stream_id, flightId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      409,
      'command_link_baseline_acceptance_missing',
      'The immutable baseline acceptance is unavailable',
    );
  if (row.record_bytes > COMMAND_LINK_BASELINE_MAX_READ_BYTES)
    throw new DomainError(409, 'command_link_baseline_record_too_large', 'Baseline record exceeds its retained bound');
  const record = (
    await client.query<{ record: CommandLinkBaselineRecord }>(
      'SELECT record FROM command_link_baselines WHERE tenant_id=$1 AND id=$2',
      [event.tenant_id, event.id],
    )
  ).rows[0].record;
  verifyRecord(record, row, event.tenant_id);
  if (
    row.first_event_id !== event.id ||
    row.stream_name !== `source:${event.principal_id}:${event.source_id}:${event.source_session_id}` ||
    event.received_at.getTime() !== row.recorded_at.getTime() ||
    event.occurred_at?.getTime() !== row.occurred_at.getTime() ||
    event.source_id !== row.source_id ||
    event.source_session_id !== row.source_session_id ||
    event.artifact_id !== row.artifact_id ||
    row.receipt_event_id !== event.id ||
    row.receipt_kind !== event.event_type ||
    row.receipt_source_id !== event.source_id ||
    row.receipt_flight_id !== flightId ||
    row.receipt_artifact_id !== event.artifact_id ||
    row.receipt_link_status !== 'linked' ||
    row.receipt_occurred_at.getTime() !== row.occurred_at.getTime() ||
    row.receipt_received_at.getTime() !== row.recorded_at.getTime() ||
    row.sha256 !== record.original.sha256 ||
    row.byte_length !== record.original.byteLength ||
    canonicalDigest(row.receipt_payload) !== canonicalDigest(record.input.payload) ||
    canonicalDigest(row.receipt_subject) !== canonicalDigest(record.input.subject) ||
    canonicalDigest(record.authority) !== canonicalDigest(authority) ||
    canonicalDigest(event.payload) !==
      canonicalDigest({ ...record.input, flightId, acceptedAuthority: record.authority })
  )
    throw new DomainError(
      409,
      'command_link_baseline_commitment_mismatch',
      'Baseline differs from its immutable journal and receipt',
    );
  const verified = verifyCommandLinkBaselineInputSource(record.input, await originalBytes(row, objectStore));
  if (verified.contentDigest !== row.content_digest)
    throw new DomainError(
      409,
      'command_link_baseline_commitment_mismatch',
      'Baseline source commitment differs from the retained event identity',
    );
}
