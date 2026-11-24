import { beforeEach, describe, expect, it, vi } from 'vitest';

const { factory, runner } = vi.hoisted(() => {
  const runner = vi.fn(async () => {
    throw new Error('Startup tests must never run inference');
  });
  return { runner, factory: vi.fn(() => runner) };
});

vi.mock('../../packages/investigator/dist/index.js', () => ({ createLocalInvestigationRunner: factory }));

import { localInvestigationOptions } from '../../apps/api/src/investigation-startup.js';

describe('local investigation startup', () => {
  beforeEach(() => {
    factory.mockClear();
    runner.mockClear();
  });

  it('requires explicit opt-in and constructs the runner without accepting extra host settings', () => {
    for (const flag of [undefined, '', '0']) {
      expect(
        localInvestigationOptions({
          ...(flag === undefined ? {} : { LEDGER_INVESTIGATOR_ENABLED: flag }),
          LEDGER_INVESTIGATOR_API_ORIGIN: 'not-an-origin',
        }),
      ).toBeUndefined();
    }
    expect(factory).not.toHaveBeenCalled();
    const env = new Proxy<NodeJS.ProcessEnv>(
      {
        LEDGER_INVESTIGATOR_ENABLED: '1',
        LEDGER_INVESTIGATOR_API_ORIGIN: 'http://ledger.test',
        LEDGER_INVESTIGATOR_MODEL: 'untrusted-model',
        LEDGER_INVESTIGATOR_PROVIDER: 'untrusted-provider',
        LEDGER_INVESTIGATOR_EXECUTABLE: '/untrusted/executable',
      },
      {
        get(target, property) {
          expect(['LEDGER_INVESTIGATOR_ENABLED', 'LEDGER_INVESTIGATOR_API_ORIGIN']).toContain(property);
          return Reflect.get(target, property);
        },
      },
    );
    expect(localInvestigationOptions(env)).toEqual({ apiOrigin: 'http://ledger.test', runner });
    expect(factory).toHaveBeenCalledExactlyOnceWith();
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses unknown enable flags and missing or non-origin API addresses before constructing a runner', () => {
    expect(() => localInvestigationOptions({ LEDGER_INVESTIGATOR_ENABLED: 'true' })).toThrow();
    for (const origin of [
      undefined,
      '',
      'file:///tmp/ledger',
      'http://human@ledger.test',
      'http://ledger.test/path',
      'http://ledger.test?token=untrusted',
      'http://ledger.test#fragment',
    ])
      expect(() =>
        localInvestigationOptions({
          LEDGER_INVESTIGATOR_ENABLED: '1',
          ...(origin === undefined ? {} : { LEDGER_INVESTIGATOR_API_ORIGIN: origin }),
        }),
      ).toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
});
