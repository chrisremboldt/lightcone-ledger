import 'dotenv/config';
import { createPool } from '@ledger/persistence';
import {
  brokerFiles,
  brokerFilesUsage,
  brokerOrganizations,
  brokerReport,
  existingPasswords,
  parseBrokerFiles,
  writeBrokerFiles,
  type BrokerFilesOptions,
} from './broker-files.js';
import { setupEnvironment } from './organization-setup.js';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log(brokerFilesUsage);
  process.exit(0);
}
let options: BrokerFilesOptions;
try {
  options = parseBrokerFiles(process.argv.slice(2));
  if (options.developmentPasswords && setupEnvironment() === 'staging')
    throw new Error('--development-passwords is for local and test databases only');
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${brokerFilesUsage}`);
  process.exit(2);
}
// The owner connection, as pnpm org:create uses: the broker serves every organization of the deployment.
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  const { organizations, unheard, skipped } = await brokerOrganizations(pool, options.listeners);
  const result = brokerFiles(organizations, { ...options, existing: await existingPasswords(options.out) });
  await writeBrokerFiles(options.out, result.files, options.developmentPasswords);
  console.log(brokerReport(options, organizations, result, { unheard, skipped }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
