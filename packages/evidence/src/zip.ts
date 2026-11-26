import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A plain .zip writer for produced files: deflate (or stored, when deflate does not help), UTF-8 names, no
 * extra fields, no encryption, no ZIP64. Every entry carries the same modification time, so the same entries and time
 * give the same bytes.
 */

export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const UTF8_NAMES = 0x0800;

function dosTime(at: Date): { time: number; date: number } {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export function writeZip(entries: readonly ZipEntry[], modifiedAt: string): Buffer {
  const { time, date } = dosTime(new Date(modifiedAt));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path) || !entry.path || entry.path.startsWith('/') || entry.path.split('/').includes('..'))
      throw new Error(`Invalid or repeated zip entry path ${entry.path}`);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const stored = deflated.byteLength >= entry.bytes.byteLength;
    const data = stored ? Buffer.from(entry.bytes) : deflated;
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(entry.bytes.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.byteLength, 20);
    central.writeUInt32LE(entry.bytes.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * Reads the entries of a .zip this writer made: stored or deflated, no ZIP64, no archive comment. Anything else is
 * refused rather than read in part.
 */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = zip.byteLength - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('Not a .zip this writer made');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('A .zip directory entry is malformed');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`The .zip entry ${name} is malformed`);
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : undefined;
    if (!content || content.byteLength !== size || crc32(content) !== zip.readUInt32LE(at + 16))
      throw new Error(`The .zip entry ${name} does not read back as written`);
    entries.set(name, content);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
