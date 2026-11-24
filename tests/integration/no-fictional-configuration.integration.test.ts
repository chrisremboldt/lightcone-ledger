import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { exampleVariables } from '../unit/environment-variables.js';

// A fresh .env from .env.example with its block for the seeded fictional organizations deleted: the API starts and
// answers, and nothing configures a fictional organization.
const marker = '# --- The seeded fictional organizations: only for pnpm db:seed (development tools) ---';
const example = readFileSync(join(import.meta.dirname, '..', '..', '.env.example'), 'utf8');
const [own, fictional] = example.split(marker) as [string, string];
const removed = [...exampleVariables(fictional).keys()];

describe('an API started without the fictional organizations’ configuration', () => {
  const pool = createPool();
  const saved = Object.fromEntries(removed.map((name) => [name, process.env[name]]));
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    for (const name of removed) delete process.env[name];
    app = await createApp({ pool, env: 'local', objectStore: new MemoryObjectStore() });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
  });

  it('is what the block alone configures', () => {
    expect(removed).toEqual(expect.arrayContaining(['LEDGER_FLIGHT_PREDEPARTURE', 'ALPHA_OPERATOR_TOKEN']));
    expect([...exampleVariables(own).keys()]).not.toContain('LEDGER_FLIGHT_PREDEPARTURE');
  });

  it('starts and answers its health, sign-in and published contract', async () => {
    for (const url of ['/healthz', '/readyz', '/v1/sign-in', '/openapi.json']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} ${response.body}`).toBe(200);
    }
  });
});
