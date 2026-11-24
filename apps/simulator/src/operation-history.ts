import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface BatchEnvelope {
  version: 1;
  index: number;
  body: string;
  sha256: string;
}
const digest = (body: string) => createHash('sha256').update(body).digest('hex');

function batchPath(directory: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('World history batch index must be positive');
  return join(directory, `${index}.json`);
}

async function readEnvelope(directory: string, index: number): Promise<BatchEnvelope | undefined> {
  let encoded: string;
  try {
    encoded = await readFile(batchPath(directory, index), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const envelope = JSON.parse(encoded) as BatchEnvelope;
  if (
    envelope.version !== 1 ||
    envelope.index !== index ||
    typeof envelope.body !== 'string' ||
    digest(envelope.body) !== envelope.sha256
  )
    throw new Error(`World history batch ${index} commitment is invalid`);
  return envelope;
}

export async function readOperationBatch<T>(directory: string, index: number): Promise<T | undefined> {
  const envelope = await readEnvelope(directory, index);
  return envelope ? (JSON.parse(envelope.body) as T) : undefined;
}

/** Recovery reads only the newest batch; older batches are deleted so a long run stays within the volume's inodes. */
export const RETAINED_HISTORY_BATCHES = 1000;

export async function retireOperationBatches(directory: string, newest: number): Promise<void> {
  const index = newest - RETAINED_HISTORY_BATCHES;
  if (index < 1) return;
  await unlink(batchPath(directory, index)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function writeOperationBatch<T>(directory: string, index: number, value: T): Promise<void> {
  const path = batchPath(directory, index);
  const body = JSON.stringify(value);
  if (body === undefined) throw new Error('World history batch must contain a JSON value');
  const envelope: BatchEnvelope = { version: 1, index, body, sha256: digest(body) };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(envelope) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const retained = await readEnvelope(directory, index);
      if (!retained || retained.body !== body)
        throw new Error(`World history batch ${index} already contains different content`);
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export async function* readOperationHistory<T>(
  directory: string,
  throughIndex?: number,
): AsyncGenerator<{ index: number; value: T }> {
  if (throughIndex !== undefined && (!Number.isSafeInteger(throughIndex) || throughIndex < 0))
    throw new Error('World history boundary must be a nonnegative batch index');
  for (let index = 1; throughIndex === undefined || index <= throughIndex; index++) {
    const value = await readOperationBatch<T>(directory, index);
    if (value === undefined) {
      if (throughIndex !== undefined) throw new Error(`World history batch ${index} is missing`);
      return;
    }
    yield { index, value };
  }
}
