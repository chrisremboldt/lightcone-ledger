import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { MemoryObjectStore, type Pool } from '../../packages/persistence/src/index.js';

// Answers only the runtime role check the API makes when it becomes ready; nothing else may reach it.
const rolePool = {
  query: async () => ({ rows: [{ name: 'ledger_app', rolsuper: false, rolbypassrls: false, owns_tables: false }] }),
  end: async () => undefined,
} as unknown as Pool;

describe('API schema compilation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compiles every request and response schema without a validator warning', async () => {
    const consoleWarnings = [
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const logged: string[] = [];
    const app = await createApp({
      pool: rolePool,
      env: 'test',
      objectStore: new MemoryObjectStore(),
      logger: { level: 'warn', stream: { write: (line: string) => logged.push(line) } },
    });
    try {
      // Request validators and response serializers are compiled when the app becomes ready.
      await app.ready();
    } finally {
      await app.close();
    }
    for (const spy of consoleWarnings) expect(spy.mock.calls).toEqual([]);
    expect(logged).toEqual([]);
  });
});
