import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = (): never => {
  throw new Error('Private journal commitment is invalid');
};

export async function readPrivateText(
  path: string,
  maxBytes: number,
  options: { preserveBom?: boolean } = {},
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return invalid();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) return invalid();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: options.preserveBom ?? false }).decode(
      Buffer.concat(chunks, total),
    );
  } finally {
    await file.close();
  }
}

export async function readJournalEnvelope(
  path: string,
  maxBytes: number,
  options: { preserveBom?: boolean } = {},
): Promise<unknown | undefined> {
  let encoded: string;
  try {
    encoded = await readPrivateText(path, maxBytes, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const envelope = JSON.parse(encoded) as { version?: unknown; body?: unknown; sha256?: unknown };
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      Array.isArray(envelope) ||
      Object.keys(envelope).some((key) => !['version', 'body', 'sha256'].includes(key)) ||
      envelope.version !== 1 ||
      typeof envelope.body !== 'string' ||
      envelope.sha256 !== hash(envelope.body)
    )
      return invalid();
    return JSON.parse(envelope.body) as unknown;
  } catch {
    return invalid();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writePrivateBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function writeJournalEnvelope(path: string, value: unknown, maxBytes: number): Promise<void> {
  const body = JSON.stringify(value);
  const encoded = JSON.stringify({ version: 1, body, sha256: hash(body) }) + '\n';
  if (Buffer.byteLength(encoded) > maxBytes) return invalid();
  await writePrivateBytes(path, Buffer.from(encoded));
}

export async function lockPrivateJournal(path: string, label: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const identity = JSON.stringify({ pid: process.pid, id: randomUUID() });
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readPrivateText(lockPath, 4096)) as { pid?: unknown; id?: unknown };
    if (
      !previous ||
      typeof previous !== 'object' ||
      Array.isArray(previous) ||
      !Number.isSafeInteger(previous.pid) ||
      Number(previous.pid) < 1 ||
      typeof previous.id !== 'string' ||
      !previous.id ||
      previous.id.length > 200
    )
      throw new Error(`${label} action lock is invalid`);
    try {
      process.kill(Number(previous.pid), 0);
    } catch (processError) {
      if ((processError as NodeJS.ErrnoException).code === 'ESRCH')
        throw new Error(`${label} actor exited; remove only its abandoned lock ${lockPath} before resuming`);
      throw processError;
    }
    throw new Error(`This ${label.toLowerCase()} journal already has a running actor`);
  }
  try {
    await file.writeFile(identity);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(path);
  return async () => {
    if ((await readPrivateText(lockPath, 4096)) === identity) {
      await unlink(lockPath);
      await syncDirectory(path);
    }
  };
}
