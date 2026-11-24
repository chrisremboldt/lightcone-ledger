import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface TrickleCheckpoint {
  next: number;
  boundedRun?: { firstSequence: number; flightLimit: number };
  pending?: { tenant: 'alpha' | 'beta'; id: string; start: string; end: string; order: Record<string, unknown> };
}
export function bindBoundedRun(checkpoint: TrickleCheckpoint, flightLimit: number): number {
  if (!Number.isSafeInteger(flightLimit) || flightLimit < 1 || flightLimit > 10)
    throw new Error('Bounded trickle flight limit is invalid');
  if (checkpoint.boundedRun && checkpoint.boundedRun.flightLimit !== flightLimit)
    throw new Error('Bounded trickle checkpoint belongs to a different requested flight limit');
  checkpoint.boundedRun ??= { firstSequence: checkpoint.next, flightLimit };
  if (!Number.isSafeInteger(checkpoint.boundedRun.firstSequence + flightLimit))
    throw new Error('Bounded trickle sequence is outside its integer bound');
  return checkpoint.boundedRun.firstSequence;
}
export async function loadCheckpoint(path: string, recover: () => Promise<number>): Promise<TrickleCheckpoint> {
  let bytes: string;
  try {
    bytes = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { next: await recover() };
    throw new Error(`Trickle checkpoint cannot be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  let value: TrickleCheckpoint;
  try {
    value = JSON.parse(bytes) as TrickleCheckpoint;
  } catch {
    throw new Error('Trickle checkpoint is invalid JSON; refusing to reset its sequence');
  }
  const pending = value?.pending;
  if (
    !value ||
    !Number.isSafeInteger(value.next) ||
    value.next < 0 ||
    (pending &&
      (!['alpha', 'beta'].includes(pending.tenant) ||
        pending.id !== `trickle-${pending.tenant}-${value.next}` ||
        !Number.isFinite(Date.parse(pending.start)) ||
        !Number.isFinite(Date.parse(pending.end)) ||
        !pending.order ||
        typeof pending.order !== 'object' ||
        Array.isArray(pending.order)))
  )
    throw new Error('Trickle checkpoint shape is invalid; refusing to reset its sequence');
  if (
    value.boundedRun &&
    (!Number.isSafeInteger(value.boundedRun.firstSequence) ||
      value.boundedRun.firstSequence < 0 ||
      value.boundedRun.firstSequence > value.next ||
      !Number.isSafeInteger(value.boundedRun.flightLimit) ||
      value.boundedRun.flightLimit < 1 ||
      value.boundedRun.flightLimit > 10)
  )
    throw new Error('Bounded trickle checkpoint shape is invalid');
  return value;
}
export async function saveCheckpoint(path: string, checkpoint: TrickleCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(checkpoint) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
