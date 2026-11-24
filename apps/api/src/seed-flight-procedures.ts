import 'dotenv/config';
import { createApp } from './index.js';
import { adoptSeededRulePacks, SEEDED_PACK, SeedAdoptionConflict } from './seed-rule-packs.js';

if (process.env.LEDGER_ENV === 'staging' || process.env.NODE_ENV === 'production')
  throw new Error('The fictional procedure adoption seed is for isolated local and test databases only');

const app = await createApp({ env: 'local' });
try {
  await app.ready();
  const adopted = await adoptSeededRulePacks(app).catch((error: unknown) => {
    if (!(error instanceof SeedAdoptionConflict)) throw error;
    console.error(`Seed stopped: ${error.message}`);
    process.exitCode = 1;
    return null;
  });
  if (adopted)
    console.log(
      adopted.length
        ? `Adopted ${SEEDED_PACK.packId} version ${SEEDED_PACK.version} for ${adopted.join(', ')}`
        : `The seeded flight organizations already adopted ${SEEDED_PACK.packId} version ${SEEDED_PACK.version}`,
    );
} finally {
  await app.close();
}
