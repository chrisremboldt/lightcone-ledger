export function investigationCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new TypeError('The collected context contains an unsupported number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(investigationCanonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('The collected context contains unsupported JSON.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${investigationCanonicalJson(record[key])}`)
    .join(',')}}`;
}

export async function investigationBytesDigest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function investigationDigest(value: unknown): Promise<string> {
  return investigationBytesDigest(new TextEncoder().encode(investigationCanonicalJson(value)));
}
