import { resolve } from 'node:path';
import { canonicalize } from '@ledger/integrity';
import {
  OPERATION_MONITORING_JOURNAL_LIMITS,
  retainOperationMonitoringSource,
  type OperationMonitoringSourceJournal,
  type PreparedOperationMonitoringSource,
} from './operation-monitoring-source.js';
import { assertSeparateOperationPaths } from './operation-paths.js';
import { lockPrivateJournal, readJournalEnvelope, writeJournalEnvelope } from './private-journal.js';

// The envelope JSON-escapes the already bounded journal body.
const maxEnvelopeBytes = 2 * OPERATION_MONITORING_JOURNAL_LIMITS.maxBytes + 1024;

function invalid(): never {
  throw new Error('Monitoring journal commitment is invalid; refusing to replace retained originals');
}

function restoreJournal(value: unknown): OperationMonitoringSourceJournal {
  try {
    const journal = value as OperationMonitoringSourceJournal;
    if (
      !journal ||
      !Array.isArray(journal.originals) ||
      !journal.originals.length ||
      journal.originals.length > OPERATION_MONITORING_JOURNAL_LIMITS.maxRevisions ||
      Buffer.byteLength(JSON.stringify(journal)) > OPERATION_MONITORING_JOURNAL_LIMITS.maxBytes
    )
      return invalid();
    let restored: OperationMonitoringSourceJournal | undefined;
    for (const retained of journal.originals) {
      const { c2OriginalDigests, ...original } = retained;
      const c2Originals = c2OriginalDigests.map((digest) => journal.c2Originals[digest]!);
      restored = retainOperationMonitoringSource(restored, { ...original, c2Originals });
    }
    if (!restored || canonicalize(restored) !== canonicalize(journal)) return invalid();
    return restored;
  } catch {
    return invalid();
  }
}

async function readJournal(path: string): Promise<OperationMonitoringSourceJournal | undefined> {
  const value = await readJournalEnvelope(path, maxEnvelopeBytes);
  return value === undefined ? undefined : restoreJournal(value);
}

export async function readOperationMonitoringJournal(
  path: string,
  worldPath: string,
): Promise<OperationMonitoringSourceJournal | undefined> {
  const journalPath = resolve(path);
  await assertSeparateOperationPaths([journalPath, `${journalPath}.lock`], worldPath);
  return readJournal(journalPath);
}

export async function persistOperationMonitoringSource(
  path: string,
  worldPath: string,
  prepared: PreparedOperationMonitoringSource,
): Promise<OperationMonitoringSourceJournal> {
  const original = structuredClone(prepared);
  const journalPath = resolve(path);
  await assertSeparateOperationPaths([journalPath, `${journalPath}.lock`], worldPath);
  const unlock = await lockPrivateJournal(journalPath, 'Operation monitoring');
  try {
    const previous = await readJournal(journalPath);
    const journal = retainOperationMonitoringSource(previous, original);
    if (!previous || canonicalize(previous) !== canonicalize(journal))
      await writeJournalEnvelope(journalPath, journal, maxEnvelopeBytes);
    return journal;
  } finally {
    await unlock();
  }
}
