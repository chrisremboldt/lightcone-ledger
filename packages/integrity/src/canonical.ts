export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('Unsafe JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      '{' +
      Object.keys(value as object)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalize((value as Record<string, unknown>)[key]))
        .join(',') +
      '}'
    );
  }
  throw new Error('Unsupported canonical JSON value');
}
