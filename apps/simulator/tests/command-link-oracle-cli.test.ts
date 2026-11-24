import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAttemptOracle } from '../src/attempt-oracle-cli.js';

vi.mock('node:fs/promises', () => ({ open: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('explicit oracle journal selection', () => {
  it('reads only the selected journal and rejects unknown kinds before file or network access', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetcher = vi.fn(async () => {
      throw new Error('Malformed local journals must not trigger a public read');
    });
    vi.stubGlobal('fetch', fetcher);
    const close = vi.fn(async () => {});
    const openFile = vi.mocked(open);
    openFile.mockImplementation(async () => {
      let read = false;
      return {
        stat: async () => ({ size: 2, isFile: () => true }),
        read: async (buffer: Buffer) => {
          if (read) return { bytesRead: 0, buffer };
          read = true;
          buffer.write('{}');
          return { bytesRead: 2, buffer };
        },
        close,
      } as unknown as Awaited<ReturnType<typeof open>>;
    });
    const env = {
      SIMULATOR_WORLD_STATE: '/oracle-fixture/world.json',
      SIMULATOR_ORACLE_ATTEMPT: 'intent-cli-alpha-0:attempt:1',
      SIMULATOR_ORACLE_TENANT: 'alpha',
      LEDGER_API_URL: 'http://oracle.invalid',
      SIMULATOR_ORACLE_TOKEN: 'fixture-read-token',
    };
    const attemptHash = createHash('sha256').update(env.SIMULATOR_ORACLE_ATTEMPT).digest('hex');
    const commandLinkPath = `${env.SIMULATOR_WORLD_STATE}.delivery/command-link/${attemptHash}.json`;
    const landingPath = `${env.SIMULATOR_WORLD_STATE}.delivery/delivery/${attemptHash}.json`;
    const commandLink = await runAttemptOracle({ ...env, SIMULATOR_ORACLE_KIND: 'command-link' });
    expect(commandLink).toMatchObject({ status: 'unverifiable', kind: 'command-link' });
    expect(openFile.mock.calls.map(([path]) => path)).toEqual([commandLinkPath]);

    const defaultLanding = await runAttemptOracle(env);
    expect(defaultLanding).toMatchObject({
      status: 'unverifiable',
      attemptId: env.SIMULATOR_ORACLE_ATTEMPT,
      tenant: 'alpha',
      reportedLandings: [],
      usage: { requests: 0, bytes: 0 },
    });
    expect(Object.hasOwn(defaultLanding, 'kind')).toBe(false);
    const explicitLanding = await runAttemptOracle({ ...env, SIMULATOR_ORACLE_KIND: 'landing' });
    expect(explicitLanding).toEqual(defaultLanding);
    expect(Object.hasOwn(explicitLanding, 'kind')).toBe(false);
    expect(openFile.mock.calls.map(([path]) => path)).toEqual([commandLinkPath, landingPath, landingPath]);

    for (const kind of ['unknown', '']) {
      const rejected = await runAttemptOracle({ ...env, SIMULATOR_ORACLE_KIND: kind });
      expect(rejected).toMatchObject({ status: 'unverifiable', issues: [{ code: 'kind_invalid' }] });
    }
    expect(openFile).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
