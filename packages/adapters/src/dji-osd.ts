import type { TelemetrySample } from '@ledger/contracts';

export const DJI_DOCUMENTATION_DIGEST = '8676893f5f5043987fd049d767f5e44808081d0ae60383059c239b69c8e384ce';
export const DJI_MESSAGE_MAX_BYTES = 32768;
export const DJI_LIMITATIONS = [
  'Synthetic selected-scalar OSD decoder grounded in pinned official Markdown; no complete vendor JSON Schema or real-device validation.',
  'Adapter capture positions are not a DJI upstream sequence; missing positions do not establish upstream packet loss.',
  'Source timestamp is a device claim in Unix milliseconds; receipt time and known-at-cut membership remain separate.',
  'M3D height is Earth ellipsoid height. horizontal_speed m/s uses the explicit M30 unit table; WGS84 is the selected integration contract pending validation.',
  'Encrypted flight-record files, state/events/media, and outbound flight controls are outside this OSD path.',
];

/** Reject ambiguous JSON before normalization, including duplicate escaped keys. */
function strictJson(source: string): unknown {
  let position = 0;
  const invalid = (): never => {
    throw new Error('Invalid or ambiguous DJI JSON');
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
    if (depth > 50) throw new Error('DJI JSON nesting exceeds the decoder bound');
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
        if (keys.has(key)) throw new Error('Duplicate DJI JSON key');
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
function operational(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(authorization|cookie|setcookie|password|clientsecret|accesstoken|refreshtoken|apikey|secretaccesskey|secretcode|privatekey)$/.test(
        key.replace(/[_-]/g, '').toLowerCase(),
      )
    )
      throw new Error('Credential-bearing DJI OSD is outside this evidence path');
    operational(item);
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
function bounded(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`Invalid DJI ${field}`);
  return value;
}

export function decodeDjiOsd(
  topic: string,
  raw: Uint8Array,
  binding: { deviceId: string; gatewayId: string },
  sequence: number,
): TelemetrySample {
  if (topic !== `thing/product/${binding.deviceId}/osd`)
    throw new Error('DJI topic does not match configured device binding');
  if (raw.byteLength === 0 || raw.byteLength > DJI_MESSAGE_MAX_BYTES)
    throw new Error('DJI payload exceeds the selected decoder byte bound');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid adapter capture sequence');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new Error('DJI payload is not valid UTF-8');
  }
  const body = strictJson(source);
  operational(body);
  if (
    !record(body) ||
    !record(body.data) ||
    body.gateway !== binding.gatewayId ||
    typeof body.tid !== 'string' ||
    !body.tid ||
    body.tid.length > 200 ||
    typeof body.bid !== 'string' ||
    !body.bid ||
    body.bid.length > 200
  )
    throw new Error('DJI OSD envelope or gateway binding is invalid');
  if (
    !Number.isSafeInteger(body.timestamp) ||
    Number(body.timestamp) < 0 ||
    !Number.isFinite(new Date(Number(body.timestamp)).getTime())
  )
    throw new Error('DJI timestamp must be Unix milliseconds');
  const data = body.data;
  const altitudeMeters = data.height === undefined ? null : bounded(data.height, -10000, 100000, 'height');
  return {
    sequence,
    occurredAt: new Date(Number(body.timestamp)).toISOString(),
    latitude: bounded(data.latitude, -90, 90, 'latitude'),
    longitude: bounded(data.longitude, -180, 180, 'longitude'),
    altitudeMeters,
    altitudeReference: altitudeMeters === null ? 'unknown' : 'ellipsoid',
    ...(data.horizontal_speed !== undefined
      ? { speedMetersPerSecond: bounded(data.horizontal_speed, 0, 500, 'horizontal_speed') }
      : {}),
    original: { topic, bytesBase64: Buffer.from(raw).toString('base64') },
  };
}
