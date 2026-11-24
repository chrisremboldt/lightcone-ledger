import 'dotenv/config';
import { createPool } from '@ledger/persistence';
import {
  credentialReport,
  credentialSetupUsage,
  parseCredentialSetup,
  setUpCredential,
  type CredentialSetupOptions,
} from './credential-setup.js';

if (process.argv.slice(2).some((argument) => argument === '--help' || argument === '-h')) {
  console.log(credentialSetupUsage);
  process.exit(0);
}
let options: CredentialSetupOptions;
try {
  options = parseCredentialSetup(process.argv.slice(2));
} catch (error) {
  console.error(`${error instanceof Error ? error.message : String(error)}\n\n${credentialSetupUsage}`);
  process.exit(2);
}
// The owner connection, as pnpm org:create uses: on a fresh deployment no one may yet act through the API.
const pool = createPool(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL);
try {
  console.log(credentialReport(await setUpCredential(pool, options)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
