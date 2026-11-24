import { createHash } from 'node:crypto';

export class BundleVerificationError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'BundleVerificationError';
    this.issues = [{ code, path, message }];
  }
}
export function requireValue(condition, code, path, message) {
  if (!condition) throw new BundleVerificationError(code, path, message);
}
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalize(value, depth = 0) {
  requireValue(depth <= 200, 'json_depth', '$', 'JSON nesting exceeds the verifier bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireValue(
      Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
      'json_number',
      '$',
      'Canonical JSON contains an unsupported number',
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalize(item, depth + 1)).join(',') + ']';
  requireValue(
    value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'json_value',
    '$',
    'Canonical JSON contains an unsupported value',
  );
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalize(value[key], depth + 1))
      .join(',') +
    '}'
  );
}
export function canonicalDigest(value) {
  return sha256(canonicalize(value));
}

/** Detect duplicate keys before native parsing; escaped spellings cannot alias a key. */
export function parseStrictJson(source, path = '$') {
  requireValue(typeof source === 'string', 'json_type', path, 'Expected JSON text');
  let position = 0;
  const invalid = () => {
    throw new BundleVerificationError('json_syntax', path, 'Invalid or ambiguous JSON text');
  };
  const whitespace = () => {
    while (/[\t\n\r ]/.test(source[position] ?? '') && position < source.length) position++;
  };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, position));
        } catch {
          invalid();
        }
      }
      if (character === '\\') position++;
    }
    invalid();
  };
  const value = (depth) => {
    requireValue(depth <= 200, 'json_depth', path, 'JSON nesting exceeds the verifier bound');
    whitespace();
    if (source[position] === '"') {
      string();
      return;
    }
    if (source[position] === '{') {
      position++;
      whitespace();
      const keys = new Set();
      if (source[position] === '}') {
        position++;
        return;
      }
      while (true) {
        if (source[position] !== '"') invalid();
        const key = string();
        requireValue(!keys.has(key), 'json_duplicate_key', path, 'JSON object contains a duplicate key');
        keys.add(key);
        whitespace();
        if (source[position++] !== ':') invalid();
        value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === '}') return;
        if (separator !== ',') invalid();
        whitespace();
      }
    }
    if (source[position] === '[') {
      position++;
      whitespace();
      if (source[position] === ']') {
        position++;
        return;
      }
      while (true) {
        value(depth + 1);
        whitespace();
        const separator = source[position++];
        if (separator === ']') return;
        if (separator !== ',') invalid();
      }
    }
    const token = source.slice(position).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) invalid();
    position += token.length;
  };
  value(0);
  whitespace();
  if (position !== source.length) invalid();
  try {
    return JSON.parse(source);
  } catch {
    invalid();
  }
}

export function decodeBase64(value, path) {
  requireValue(
    typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    'base64_encoding',
    path,
    'Bytes must use canonical base64 encoding',
  );
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.toString('base64') === value, 'base64_encoding', path, 'Bytes must use canonical base64 encoding');
  return bytes;
}
export function sequence(value, path, allowZero = false) {
  requireValue(
    typeof value === 'string' && /^(?:0|[1-9]\d{0,19})$/.test(value),
    'sequence_encoding',
    path,
    'Sequence must be a canonical decimal string',
  );
  const number = BigInt(value);
  requireValue(
    number <= 18_446_744_073_709_551_615n && (allowZero || number > 0n),
    'sequence_range',
    path,
    'Sequence is outside the declared unsigned 64-bit range',
  );
  return number;
}
function frame(value) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
export function entryHash(tenantId, streamId, position, previousHash, envelopeDigest) {
  const encodedPosition = Buffer.alloc(8);
  encodedPosition.writeBigUInt64BE(BigInt(position));
  return sha256(
    Buffer.concat([
      frame('ledger.v6.entry.1'),
      frame(tenantId),
      frame(streamId),
      encodedPosition,
      frame(previousHash),
      frame(envelopeDigest),
    ]),
  );
}
