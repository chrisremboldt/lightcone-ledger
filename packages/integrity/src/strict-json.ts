const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;

export function parseStrictJson(source: string, options: { maxBytes?: number } = {}): unknown {
  const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error('JSON byte bound must be a positive safe integer');
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > maxBytes)
    throw new Error(`JSON text exceeds the ${maxBytes === MAX_JSON_BYTES ? '64 KiB' : `${maxBytes} byte`} bound`);
  let position = 0;
  const invalid = (): never => {
    throw new Error('Invalid or ambiguous JSON text');
  };
  const whitespace = () => {
    while (position < source.length && /[\t\n\r ]/.test(source[position])) position++;
  };
  const string = (): string => {
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '"') {
        try {
          return JSON.parse(source.slice(start, position)) as string;
        } catch {
          invalid();
        }
      }
      if (character === '\\') position++;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error('JSON nesting exceeds the depth bound');
    whitespace();
    if (source[position] === '"') {
      string();
      return;
    }
    if (source[position] === '{') {
      position++;
      whitespace();
      const keys = new Set<string>();
      if (source[position] === '}') {
        position++;
        return;
      }
      while (true) {
        if (source[position] !== '"') invalid();
        const key = string();
        if (keys.has(key)) throw new Error('JSON object contains a duplicate key');
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
    position += token!.length;
  };
  value(0);
  whitespace();
  if (position !== source.length) invalid();
  return JSON.parse(source) as unknown;
}
