import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusedOwnerConnection, withoutOwnerConnection } from '../../infra/scripts/runtime-config.mjs';
import { superviseRuntime } from '../../infra/scripts/supervise.mjs';
import { refuseOwnerConnection } from '../../packages/persistence/src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');
const owner = 'postgresql://ledger_owner:secret@db.example.invalid:5432/ledger';

/** The lines of one top-level service of a Compose file, up to the next service. */
function service(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  expect(start, name).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z-]+:$|^[a-z]/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('the database owner connection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops the API and the workers outside local and test, naming what to remove', () => {
    for (const processName of ['API', 'workers'] as const) {
      expect(() => refuseOwnerConnection(processName, { LEDGER_ENV: 'staging', DATABASE_ADMIN_URL: owner })).toThrow(
        `The ${processName} will not start with the database owner's connection (DATABASE_ADMIN_URL)`,
      );
      expect(() =>
        refuseOwnerConnection(processName, { NODE_ENV: 'production', LEDGER_DATABASE_OWNER_PASSWORD: 'secret' }),
      ).toThrow('(LEDGER_DATABASE_OWNER_PASSWORD)');
      expect(() => refuseOwnerConnection(processName, { LEDGER_ENV: 'staging' })).not.toThrow();
      for (const LEDGER_ENV of ['local', 'test'])
        expect(() => refuseOwnerConnection(processName, { LEDGER_ENV, DATABASE_ADMIN_URL: owner })).not.toThrow();
    }
  });

  it('stops the image supervisor before it starts anything, and is never passed to what it starts', async () => {
    expect(refusedOwnerConnection({ LEDGER_ENV: 'staging', DATABASE_ADMIN_URL: owner })).toEqual([
      'DATABASE_ADMIN_URL',
    ]);
    expect(refusedOwnerConnection({ LEDGER_ENV: 'local', DATABASE_ADMIN_URL: owner })).toEqual([]);
    expect(
      withoutOwnerConnection({ DATABASE_URL: 'app', DATABASE_ADMIN_URL: owner, LEDGER_DATABASE_OWNER_PASSWORD: 'x' }),
    ).toEqual({ DATABASE_URL: 'app' });

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await superviseRuntime({ LEDGER_ENV: 'staging', NODE_ENV: 'production', DATABASE_ADMIN_URL: owner })).toBe(
      1,
    );
    const event = JSON.parse(String(logged.mock.calls[0]![0]));
    expect(event).toMatchObject({ event: 'owner_connection_refused', variables: ['DATABASE_ADMIN_URL'] });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it('is given by the production Compose file only to the setup service', () => {
    const compose = read('infra/compose.production.yaml');
    expect(service(compose, 'ledger')).toContain('env_file: ../ledger.env\n');
    expect(service(compose, 'setup')).toContain('env_file: [../ledger.env, ../ledger-owner.env]');
    expect(compose.split('ledger-owner.env]').length).toBe(2);
    for (const name of ['ledger', 'adapter']) expect(service(compose, name)).not.toContain('ledger-owner.env');
  });

  it('is kept by the verification kit in its own file, given only to the setup service', () => {
    expect(read('infra/verify-deployment/verify.env')).not.toMatch(/DATABASE_ADMIN_URL|OWNER_PASSWORD/);
    expect(read('infra/verify-deployment/verify-owner.env')).toMatch(/^DATABASE_ADMIN_URL=/m);
    const overlay = read('infra/verify-deployment/compose.yaml');
    expect(service(overlay, 'ledger')).not.toContain('verify-owner.env');
    expect(service(overlay, 'setup')).toContain('verify-owner.env');
  });
});
