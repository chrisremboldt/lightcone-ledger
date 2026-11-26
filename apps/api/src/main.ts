import 'dotenv/config';
import { startMetrics } from '@ledger/metrics';
import { assertObjectStoreReady, refuseOwnerConnection } from '@ledger/persistence';
import { createApp } from './index.js';
import { developmentSignInNotice } from './openid-connect.js';
import { setupEnvironment } from './organization-setup.js';
refuseOwnerConnection('API');
await assertObjectStoreReady();
const port = Number(process.env.PORT ?? 4000);
const metrics = await startMetrics(process.env, { servicePort: port });
const app = await createApp({ logger: true, metrics: metrics?.registry });
if (metrics) app.addHook('onClose', () => metrics.server.close());
const notice = developmentSignInNotice(setupEnvironment());
if (notice) app.log.warn(notice);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
process.on('SIGTERM', async () => {
  await app.close();
});
process.on('SIGINT', async () => {
  await app.close();
});
