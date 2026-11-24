import 'dotenv/config';
import { backfillObservationReferencesPage } from '@ledger/domain';
import { createPool } from '@ledger/persistence';

// Indexes the reference fields of observations accepted before migration 0063 (observation_references). Safe to run
// again: rows already indexed are kept. Interrupted, it resumes from the start, or from the id it last printed when
// passed as `--after <id>`. Each page commits on its own, so no run holds a long transaction.
const afterFlag = process.argv.indexOf('--after');
let after: string | null = afterFlag >= 0 ? (process.argv[afterFlag + 1] ?? null) : '';
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
let scanned = 0;
let indexed = 0;
try {
  while (after !== null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const page = await backfillObservationReferencesPage(client, { after });
      await client.query('COMMIT');
      scanned += page.scanned;
      indexed += page.indexed;
      after = page.after;
      if (after) console.log(`Indexed through observation ${after}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(`Observation references backfilled: ${scanned} observations read, ${indexed} references added`);
} finally {
  await pool.end();
}
