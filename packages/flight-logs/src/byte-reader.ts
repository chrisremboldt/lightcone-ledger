/**
 * Reads a log as a stream of chunks, holding only the bytes of the message being read. A reader asks for the next
 * few bytes, looks at them, and takes them; the file is never held whole.
 */
export class ByteReader {
  private readonly chunks: AsyncIterator<Uint8Array>;
  private buffer = new Uint8Array(0);
  private start = 0;
  private ended = false;
  /** The file offset of the first byte not yet taken. */
  offset = 0;

  constructor(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    this.chunks =
      Symbol.asyncIterator in source
        ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : toAsync((source as Iterable<Uint8Array>)[Symbol.iterator]());
  }

  private get held(): number {
    return this.buffer.byteLength - this.start;
  }

  /** True when the next `count` bytes are in hand; false when the file ends first. */
  async has(count: number): Promise<boolean> {
    while (this.held < count && !this.ended) {
      const next = await this.chunks.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const kept = this.buffer.subarray(this.start);
      const joined = new Uint8Array(kept.byteLength + next.value.byteLength);
      joined.set(kept, 0);
      joined.set(next.value, kept.byteLength);
      this.buffer = joined;
      this.start = 0;
    }
    return this.held >= count;
  }

  /** The next `count` bytes without taking them. Call `has` first. */
  peek(count: number): Uint8Array {
    return this.buffer.subarray(this.start, this.start + count);
  }

  /** Takes the next `count` bytes. Call `has` first. */
  take(count: number): Uint8Array {
    const bytes = this.peek(count);
    this.start += count;
    this.offset += count;
    return bytes;
  }

  /** Takes up to `count` bytes, as many as the file still holds; returns how many were taken. */
  async skip(count: number): Promise<number> {
    let left = count;
    while (left > 0) {
      if (!(await this.has(1))) break;
      const step = Math.min(left, this.held);
      this.take(step);
      left -= step;
    }
    return count - left;
  }

  /** True when every byte of the file has been taken. */
  async atEnd(): Promise<boolean> {
    return !(await this.has(1));
  }
}

async function* toAsync(iterator: Iterator<Uint8Array>): AsyncGenerator<Uint8Array> {
  for (let next = iterator.next(); !next.done; next = iterator.next()) yield next.value;
}

/** The whole file in one piece, for a format that cannot be read as a stream; undefined once it is larger than `maxBytes`. */
export async function wholeFile(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.byteLength;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A little-endian view over a message's bytes. */
export function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Text up to the first NUL, as a log writes a fixed-length string. */
export function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder('utf-8').decode(end === -1 ? bytes : bytes.subarray(0, end));
}
