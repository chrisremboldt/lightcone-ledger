import 'dotenv/config';
import { createPool } from '@ledger/persistence';
import {
  organizationSetupUsage,
  parseOrganizationSetup,
  setUpOrganization,
  setupEnvironment,
  setupReport,
  type OrganizationSetupOptions,
} from './organization-setup.js';
import { signInSettings } from './openid-connect.js';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log(organizationSetupUsage);
  process.exit(0);
}
let options: OrganizationSetupOptions;
try {
  options = parseOrganizationSetup(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${organizationSetupUsage}`);
  process.exit(2);
}
// The owner connection, as migrations use: the organization's first person cannot yet act through the API.
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  const environment = setupEnvironment();
  const accepted = signInSettings(environment).issuers.map((setting) => setting.issuer);
  const result = await setUpOrganization(pool, options, environment, accepted);
  console.log(setupReport(options, result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
