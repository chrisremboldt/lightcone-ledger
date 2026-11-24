import 'dotenv/config';
import { createPool } from '@ledger/persistence';
import {
  developmentTokenReport,
  developmentTokenSetupUsage,
  parseDevelopmentTokenSetup,
  setUpDevelopmentToken,
  type DevelopmentTokenSetupOptions,
} from './development-token-setup.js';
import { setupEnvironment } from './organization-setup.js';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log(developmentTokenSetupUsage);
  process.exit(0);
}
let options: DevelopmentTokenSetupOptions;
try {
  options = parseDevelopmentTokenSetup(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${developmentTokenSetupUsage}`);
  process.exit(2);
}
// The owner connection, as pnpm org:create uses: the administrator whose token was lost cannot act through the API.
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  console.log(developmentTokenReport(await setUpDevelopmentToken(pool, options, setupEnvironment())));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
