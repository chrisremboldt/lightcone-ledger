import {
  TELEMETRY_DECODER,
  TELEMETRY_FORMAT,
  TELEMETRY_MAX_BYTES,
  TELEMETRY_MAX_SAMPLES,
  type TelemetrySegment,
  type TelemetrySegmentDescriptor,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  DomainError,
  readBoundedObject,
  type JournalEvent,
  type ObjectStore,
  type PoolClient,
} from '@ledger/persistence';

/** Reject ambiguous JSON before normalization, including duplicate escaped keys. */
function strictJson(source: string): unknown {
  let position = 0;
  const invalid = (): never => {
    throw new Error('Invalid or ambiguous telemetry JSON');
  };
  const space = () => {
    while (position < source.length && /[\t\r\n ]/.test(source[position]!)) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const value = source[position++];
      if (value === '"') {
        try {
          return JSON.parse(source.slice(start, position));
        } catch {
          return invalid();
        }
      }
      if (value === '\\') position++;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 50) throw new Error('telemetry JSON nesting exceeds the decoder bound');
    space();
    if (source[position] === '"') {
      string();
      return;
    }
    if (source[position] === '{') {
      position++;
      space();
      const keys = new Set<string>();
      if (source[position] === '}') {
        position++;
        return;
      }
      while (true) {
        if (source[position] !== '"') invalid();
        const key = string();
        if (keys.has(key)) throw new Error('Duplicate telemetry JSON key');
        keys.add(key);
        space();
        if (source[position++] !== ':') invalid();
        value(depth + 1);
        space();
        const separator = source[position++];
        if (separator === '}') return;
        if (separator !== ',') invalid();
        space();
      }
    }
    if (source[position] === '[') {
      position++;
      space();
      if (source[position] === ']') {
        position++;
        return;
      }
      while (true) {
        value(depth + 1);
        space();
        const separator = source[position++];
        if (separator === ']') return;
        if (separator !== ',') invalid();
      }
    }
    const token = source.slice(position).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) invalid();
    position += token!.length;
  };
  value(0);
  space();
  if (position !== source.length) invalid();
  try {
    return JSON.parse(source);
  } catch {
    return invalid();
  }
}

function invalid(): never {
  throw new DomainError(
    400,
    'invalid_telemetry_segment',
    'Retained telemetry bytes do not match the bounded descriptor and supported DJI normalization',
  );
}
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, any>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}
function time(value: unknown): value is string {
  return typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
function credentials(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) credentials(item);
    return;
  }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'authorization',
        'cookie',
        'password',
        'clientsecret',
        'accesstoken',
        'refreshtoken',
        'apikey',
        'secretaccesskey',
        'secretcode',
        'privatekey',
        'setcookie',
      ].includes(key.replaceAll('_', '').replaceAll('-', '').toLowerCase())
    )
      throw new DomainError(400, 'credential_payload', 'Original telemetry envelope contains a credential field');
    credentials(item);
  }
}
export function decodeTelemetry(
  bytes: Uint8Array,
  descriptor: TelemetrySegmentDescriptor,
  sourceId: string,
  sourceSessionId: string,
): TelemetrySegment {
  if (bytes.byteLength > TELEMETRY_MAX_BYTES) invalid();
  let value: unknown;
  try {
    value = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  if (!object(value)) invalid();
  keys(value, [
    'format',
    'sourceId',
    'sourceSessionId',
    'deviceId',
    'gatewayId',
    'decoderVersion',
    'fidelity',
    'coordinateReference',
    'sequenceBasis',
    'sessionStartSequence',
    'samples',
  ]);
  if (
    value.format !== TELEMETRY_FORMAT ||
    value.decoderVersion !== TELEMETRY_DECODER ||
    value.fidelity !== 'synthetic_contract' ||
    value.coordinateReference !== 'WGS84' ||
    value.sequenceBasis !== 'adapter_capture' ||
    !identity(value.deviceId) ||
    !identity(value.gatewayId) ||
    value.sourceId !== sourceId ||
    value.sourceSessionId !== sourceSessionId ||
    !Number.isSafeInteger(value.sessionStartSequence) ||
    value.sessionStartSequence < 0 ||
    !Array.isArray(value.samples) ||
    !value.samples.length ||
    value.samples.length > TELEMETRY_MAX_SAMPLES
  )
    invalid();
  for (const sample of value.samples) {
    if (!object(sample)) invalid();
    keys(sample, [
      'sequence',
      'occurredAt',
      'latitude',
      'longitude',
      'altitudeMeters',
      'altitudeReference',
      'speedMetersPerSecond',
      'original',
    ]);
    if (
      !Number.isSafeInteger(sample.sequence) ||
      sample.sequence < value.sessionStartSequence ||
      !time(sample.occurredAt) ||
      !finite(sample.latitude, -90, 90) ||
      !finite(sample.longitude, -180, 180) ||
      !(sample.altitudeMeters === null || finite(sample.altitudeMeters, -10000, 100000)) ||
      !['ellipsoid', 'relative', 'unknown'].includes(sample.altitudeReference) ||
      !(sample.speedMetersPerSecond === undefined || finite(sample.speedMetersPerSecond, 0, 500)) ||
      !object(sample.original)
    )
      invalid();
    keys(sample.original, ['topic', 'bytesBase64']);
    const base64 = sample.original.bytesBase64;
    if (
      sample.original.topic !== `thing/product/${value.deviceId}/osd` ||
      typeof base64 !== 'string' ||
      base64.length > 87384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    )
      invalid();
    const raw = Buffer.from(base64, 'base64');
    if (!raw.length || raw.length > 32768 || raw.toString('base64') !== base64) invalid();
    let original: unknown;
    try {
      original = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      invalid();
    }
    credentials(original);
    if (
      !object(original) ||
      !object(original.data) ||
      !identity(original.gateway) ||
      !identity(original.tid) ||
      !identity(original.bid) ||
      !Number.isSafeInteger(original.timestamp) ||
      original.timestamp < 0 ||
      !Number.isFinite(new Date(original.timestamp).getTime())
    )
      invalid();
    if (original.gateway !== value.gatewayId) invalid();
    if (
      sample.occurredAt !== new Date(original.timestamp).toISOString() ||
      sample.latitude !== original.data.latitude ||
      sample.longitude !== original.data.longitude
    )
      invalid();
    if (original.data.height === undefined) {
      if (sample.altitudeMeters !== null || sample.altitudeReference !== 'unknown') invalid();
    } else if (sample.altitudeMeters !== original.data.height || sample.altitudeReference !== 'ellipsoid') invalid();
    if (sample.speedMetersPerSecond !== original.data.horizontal_speed) invalid();
  }
  const sequences = value.samples.map((sample) => sample.sequence),
    times = value.samples.map((sample) => Date.parse(sample.occurredAt));
  if (
    descriptor.format !== value.format ||
    descriptor.deviceId !== value.deviceId ||
    descriptor.decoderVersion !== value.decoderVersion ||
    descriptor.sequenceBasis !== value.sequenceBasis ||
    descriptor.sessionStartSequence !== value.sessionStartSequence ||
    descriptor.sampleCount !== value.samples.length ||
    descriptor.firstSequence !== Math.min(...sequences) ||
    descriptor.lastSequence !== Math.max(...sequences) ||
    Date.parse(descriptor.firstOccurredAt) !== Math.min(...times) ||
    Date.parse(descriptor.lastOccurredAt) !== Math.max(...times)
  )
    invalid();
  if (descriptor.gatewayId !== value.gatewayId) invalid();
  return value as TelemetrySegment;
}
export async function projectTelemetry(client: PoolClient, event: JournalEvent, store: ObjectStore): Promise<void> {
  const segment = (await client.query('SELECT * FROM telemetry_segments WHERE event_id=$1', [event.id])).rows[0];
  if (!segment) invalid();
  const artifact = (await client.query('SELECT * FROM artifacts WHERE id=$1', [segment.artifact_id])).rows[0];
  if (!artifact || artifact.byte_length > TELEMETRY_MAX_BYTES) invalid();
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedObject(store, artifact.object_key, { maxBytes: artifact.byte_length, timeoutMs: 10000 });
  } catch {
    throw new DomainError(
      409,
      'telemetry_bytes_unavailable',
      'Retained telemetry segment bytes are unavailable or exceeded their bounds',
    );
  }
  if (bytes.byteLength !== artifact.byte_length || sha256(bytes) !== artifact.sha256)
    throw new DomainError(
      409,
      'telemetry_integrity_failure',
      'Retained telemetry bytes failed their artifact commitment',
    );
  const decoded = decodeTelemetry(bytes, segment.descriptor, segment.source_id, segment.source_session_id);
  const other = (
    await client.query(
      "SELECT 1 FROM telemetry_segments WHERE session_id=$1 AND (descriptor->>'sessionStartSequence')::bigint<>$2 LIMIT 1",
      [segment.session_id, decoded.sessionStartSequence],
    )
  ).rowCount;
  if (other)
    throw new DomainError(
      400,
      'telemetry_session_conflict',
      'Source session changed its declared capture sequence baseline',
    );
  for (const [offset, sample] of decoded.samples.entries()) {
    const originalHash = sha256(Buffer.from(sample.original.bytesBase64, 'base64'));
    const normalized = { ...sample, original: { topic: sample.original.topic } };
    const claimDigest = canonicalDigest({ ...normalized, originalSha256: originalHash });
    await client.query(
      'INSERT INTO telemetry_samples(id,tenant_id,segment_id,session_id,sample_offset,sequence,occurred_at,received_at,sample,original_topic,original_sha256,claim_digest,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING',
      [
        `${segment.id}:${offset}`,
        event.tenant_id,
        segment.id,
        segment.session_id,
        offset,
        sample.sequence,
        sample.occurredAt,
        event.received_at,
        normalized,
        sample.original.topic,
        originalHash,
        claimDigest,
        sample.latitude,
        sample.longitude,
      ],
    );
  }
}
