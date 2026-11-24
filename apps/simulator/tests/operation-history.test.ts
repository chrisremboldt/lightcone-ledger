import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readOperationBatch,
  RETAINED_HISTORY_BATCHES,
  retireOperationBatches,
  writeOperationBatch,
} from '../src/operation-history.js';

describe('world history retention', () => {
  it('keeps only the newest batches, so a long run does not exhaust the volume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-history-'));
    try {
      const newest = RETAINED_HISTORY_BATCHES + 1;
      for (const index of [1, 2, newest]) await writeOperationBatch(directory, index, { index });
      await retireOperationBatches(directory, RETAINED_HISTORY_BATCHES);
      expect(await readdir(directory)).toHaveLength(3);
      await retireOperationBatches(directory, newest);
      await retireOperationBatches(directory, newest);
      expect(await readOperationBatch(directory, 1)).toBeUndefined();
      expect(await readOperationBatch(directory, 2)).toEqual({ index: 2 });
      expect(await readOperationBatch(directory, newest)).toEqual({ index: newest });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
