import { describe, expect, it } from 'vitest';
import { getRulePackVersion, getRuleSource } from '../../domain/src/rule-pack-registry.js';
import { registerStandardPacks, standardRulePacks } from '../src/index.js';

describe('standard rule packs', () => {
  it('registers every shipped pack and source once, and tolerates repeated startup calls', async () => {
    registerStandardPacks();
    registerStandardPacks();
    for (const registration of standardRulePacks()) {
      for (const version of registration.versions)
        expect(getRulePackVersion(registration.packId, version.version)).toEqual(version);
      for (const source of registration.sources ?? [])
        expect((await getRuleSource(source.sourceId))!.bytes.equals(source.bytes)).toBe(true);
    }
    expect(standardRulePacks().map(({ packId }) => packId)).toEqual([
      'ledger.demo-procedures',
      'ledger.part108-nprm',
      'ledger.example-operations',
      'ledger.part107',
      'ledger.example-waiver',
      'ledger.example-bvlos-waiver',
      'ledger.example-airspace',
      'ledger.example-crew',
      'ledger.example-weather',
    ]);
  });
});
