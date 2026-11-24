import type { Stats } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureHostedSmsPhase, ensureHostedSmsRoot } from '../src/hosted-sms-paths.js';
import { retainSmsPreparation } from '../src/sms-rehearsal-files.js';
import { prepareSmsIncident } from '../src/sms-rehearsal-plan.js';
import { configV3, incidentPreparedAt, incidentStart } from './sms-rehearsal-fixtures.js';

const mocks = vi.hoisted(() => ({ lstat: vi.fn(), mkdir: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  lstat: mocks.lstat,
  mkdir: mocks.mkdir,
}));

const root = configV3().directory;
const regular = (mode = 0o700, symlink = false) =>
  ({ mode, isDirectory: () => !symlink, isSymbolicLink: () => symlink }) as Stats;
const absent = () => Object.assign(new Error('Missing directory'), { code: 'ENOENT' });
afterEach(() => {
  mocks.lstat.mockReset();
  mocks.mkdir.mockReset();
});

describe('hosted SMS preparation ancestors', () => {
  it('refuses missing, linked or public persistent ancestors before any retention mkdir', async () => {
    const mkdir = mocks.mkdir.mockRejectedValue(new Error('No directory writes allowed'));
    const lstat = mocks.lstat;
    const preparation = prepareSmsIncident(configV3(), incidentStart, incidentPreparedAt);
    for (const invalid of [
      { path: '/data', metadata: regular(0o755, true) },
      { path: '/data/ledger', metadata: regular(0o755) },
      { path: '/data/ledger/world', metadata: regular(0o700, true) },
      { path: '/data/ledger/world', metadata: undefined },
    ]) {
      lstat.mockImplementation(async (path) => {
        if (path === invalid.path) {
          if (!invalid.metadata) throw absent();
          return invalid.metadata;
        }
        return regular(path === '/data' ? 0o755 : 0o700);
      });
      await expect(retainSmsPreparation(preparation)).rejects.toThrow(/ancestors/i);
    }
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('creates only each named component after its validated parent and refuses a substituted phase', async () => {
    const existing = new Set(['/data', '/data/ledger', '/data/ledger/world']);
    const steps: string[] = [];
    mocks.lstat.mockImplementation(async (path) => {
      if (typeof path !== 'string' || !existing.has(path)) throw absent();
      steps.push(`checked:${path}`);
      return regular(path === '/data' ? 0o755 : 0o700);
    });
    const mkdir = mocks.mkdir.mockImplementation(async (path, options) => {
      expect(options).toEqual({ mode: 0o700 });
      expect(typeof path).toBe('string');
      existing.add(String(path));
      steps.push(`created:${path}`);
      return undefined;
    });
    expect(await ensureHostedSmsRoot(root)).toBe(false);
    expect(mkdir).not.toHaveBeenCalled();
    await ensureHostedSmsPhase(`${root}/incident`);
    expect(mkdir.mock.calls.map(([path]) => path)).toEqual(['/data/ledger/world/sms', root, `${root}/incident`]);
    for (const path of ['/data/ledger/world/sms', root, `${root}/incident`]) {
      const parent = path.slice(0, path.lastIndexOf('/'));
      expect(steps.indexOf(`checked:${parent}`)).toBeLessThan(steps.indexOf(`created:${path}`));
    }
    const before = mkdir.mock.calls.length;
    await expect(ensureHostedSmsPhase(`${root}/other`)).rejects.toThrow(/phase directory/i);
    expect(mkdir).toHaveBeenCalledTimes(before);
  });
});
