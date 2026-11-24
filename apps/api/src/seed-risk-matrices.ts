import 'dotenv/config';
import { createApp } from './index.js';
import { adoptSeededRiskMatrices } from './seed-risk-matrix.js';

if (process.env.LEDGER_ENV === 'staging' || process.env.NODE_ENV === 'production')
  throw new Error('The fictional risk-matrix seed is for isolated local and test databases only');

const app = await createApp({ env: 'local' });
try {
  await app.ready();
  const adopted = await adoptSeededRiskMatrices(app);
  console.log(
    adopted.length
      ? `Adopted the example 5×5 risk matrix for ${adopted.join(', ')}`
      : 'The seeded flight organizations already have an adopted risk matrix',
  );
} finally {
  await app.close();
}
