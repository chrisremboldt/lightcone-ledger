import { crc32, deflateRawSync } from 'node:zlib';

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
