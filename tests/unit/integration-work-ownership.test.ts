import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

// Integration files that need not settle their own worker work, each with the reason. Keep this list short.
const EXCEPTIONS = new Map<string, string>([
  [
    'tests/integration/no-fictional-configuration.integration.test.ts',
    'Starts the API and reads public routes; it creates no organization and queues no work.',
  ],
  [
    'tests/integration/one-process.integration.test.ts',
    'Starts the one process and reads /readyz; it creates no organization and queues no work, and every earlier file settled its own.',
  ],
]);

function integrationFiles(): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => !/(^|\/)(node_modules|dist|\.git)\//.test(path))
    .filter((path) => path.endsWith('.integration.test.ts') || /^tests\/integration\/.*\.test\.ts$/.test(path))
    .map((path) => relative(root, join(root, path)))
    .sort();
}

describe('Integration files and the shared work queue', () => {
  it('finds the integration files', () => {
    expect(integrationFiles().length).toBeGreaterThan(40);
  });

  // A file that leaves work pending breaks whichever later file's workers find it, so each settles its own.
  it('has every integration file settle its own tenants with the shared helper', () => {
    const unsettled = integrationFiles().filter(
      (path) =>
        !EXCEPTIONS.has(path) &&
        !/import \{[^}]*\bsettleOwnedWork\b[^}]*\} from '[./]*(tests\/integration\/)?worker-queue\.js'/.test(
          readFileSync(join(root, path), 'utf8'),
        ),
    );
    expect(unsettled, 'import settleOwnedWork from tests/integration/worker-queue.ts and call it in afterAll').toEqual(
      [],
    );
  });

  it('lists only exceptions that still exist', () => {
    const files = new Set(integrationFiles());
    expect([...EXCEPTIONS.keys()].filter((path) => !files.has(path))).toEqual([]);
  });
});
