import 'dotenv/config';
import { startTestIssuer } from './test-issuer.js';

// Local development only: an alternative to development tokens that runs the real OpenID Connect sign-in.
if (process.env.NODE_ENV === 'production') {
  console.error('The test issuer never runs with NODE_ENV=production.');
  process.exit(1);
}
const port = Number(process.env.TEST_ISSUER_PORT ?? 4010);
const clientId = process.env.LEDGER_OIDC_CLIENT_ID ?? 'ledger-local';
const webOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const issuer = await startTestIssuer({
  port,
  clients: [{ clientId, redirectUris: webOrigins.map((origin) => `${origin}/`) }],
});
console.log(`Test issuer for local development at ${issuer.url} (client ${clientId}). Not for any deployment.`);
console.log(`Set LEDGER_OIDC_ISSUER=${issuer.url} and LEDGER_OIDC_CLIENT_ID=${clientId} for the API and org:create.`);
const stop = () => void issuer.close().then(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
