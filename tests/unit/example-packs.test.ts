import { describe, expect, it } from 'vitest';
import {
  examplePacksEnabled,
  isExamplePack,
  packOffered,
  standardRulePacks,
} from '../../packages/standard-packs/src/index.js';

describe('example packs', () => {
  it('counts every shipped pack as an example except the ones that quote a regulation', () => {
    const regulatory = standardRulePacks()
      .map((pack) => pack.packId)
      .filter((packId) => !isExamplePack(packId));
    expect(regulatory.sort()).toEqual(['ledger.part107', 'ledger.part108-nprm']);
  });

  it('offers them in local development and tests, and in a deployment only when asked', () => {
    expect(examplePacksEnabled({})).toBe(true);
    expect(examplePacksEnabled({ LEDGER_ENV: 'local' })).toBe(true);
    expect(examplePacksEnabled({ LEDGER_ENV: 'test' })).toBe(true);
    expect(examplePacksEnabled({ LEDGER_ENV: 'staging' })).toBe(false);
    expect(examplePacksEnabled({ LEDGER_ENV: 'staging', LEDGER_EXAMPLE_PACKS: '1' })).toBe(true);
    expect(examplePacksEnabled({ LEDGER_ENV: 'local', LEDGER_EXAMPLE_PACKS: '0' })).toBe(false);
    expect(() => examplePacksEnabled({ LEDGER_EXAMPLE_PACKS: 'yes' })).toThrow('LEDGER_EXAMPLE_PACKS must be 0 or 1');
  });

  it('offers the shipped examples to a seeded fictional organization, and to any other only when asked', () => {
    const fictional = { fictional: true };
    const own = { fictional: false };
    for (const packId of ['ledger.part107', 'ledger.part108-nprm', 'example-ridge.waiver-0042']) {
      expect(packOffered(packId, own, {}), packId).toBe(true);
      expect(packOffered(packId, fictional, {}), packId).toBe(true);
    }
    for (const packId of standardRulePacks()
      .map((pack) => pack.packId)
      .filter(isExamplePack)) {
      expect(packOffered(packId, fictional, {}), packId).toBe(true);
      expect(packOffered(packId, own, { LEDGER_ENV: 'local' }), packId).toBe(false);
      expect(packOffered(packId, own, { LEDGER_EXAMPLE_PACKS: '1' }), packId).toBe(true);
    }
  });

  it('never has a regulatory pack relieve or depend on an example pack', () => {
    for (const pack of standardRulePacks().filter(({ packId }) => !isExamplePack(packId)))
      for (const version of pack.versions)
        for (const leaf of version.leaves)
          for (const relief of ('relieves' in leaf && leaf.relieves) || [])
            expect(isExamplePack(relief.packId)).toBe(false);
  });
});
