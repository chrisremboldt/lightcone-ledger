import 'dotenv/config';
import { assertObjectStoreReady, refuseOwnerConnection } from '@ledger/persistence';
import { createApp } from './index.js';
import { developmentSignInNotice } from './openid-connect.js';
import { setupEnvironment } from './organization-setup.js';
refuseOwnerConnection('API');
await assertObjectStoreReady();
const app = await createApp({ logger: true });
const notice = developmentSignInNotice(setupEnvironment());
if (notice) app.log.warn(notice);
await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' });
process.on('SIGTERM', async () => {
  await app.close();
});
process.on('SIGINT', async () => {
  await app.close();
});
