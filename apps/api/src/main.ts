import 'dotenv/config';
import { refuseOwnerConnection } from '@ledger/persistence';
import { createApp } from './index.js';
import { localInvestigationOptions } from './investigation-startup.js';
refuseOwnerConnection('API');
const app = await createApp({ logger: true, investigation: localInvestigationOptions() });
await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? '0.0.0.0' });
process.on('SIGTERM', async () => {
  await app.close();
});
process.on('SIGINT', async () => {
  await app.close();
});
