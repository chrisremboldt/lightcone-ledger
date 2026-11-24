import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { isExamplePack, standardRulePacks } from '../../packages/standard-packs/src/index.js';

/** The README's sentence for one shipped pack's latest version. */
const sentence =
  /Its latest version, (\d+), has (\d+) rules? a check runs, (\d+) a person checks and (\d+) not supported yet\./;

function readmeLine(packId: string): string | undefined {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  return readme.split('\n').find((line) => line.startsWith(`- \`${packId}\``));
}

describe('README shipped packs', () => {
  it('states, for each shipped pack’s latest version, how many rules a check runs, a person checks and are not supported yet', () => {
    const actual: Record<string, number[]> = {};
    const stated: Record<string, number[] | undefined> = {};
    for (const registration of standardRulePacks()) {
      const latest = Math.max(...registration.versions.map(({ version }) => version));
      const pack = getRulePackVersion(registration.packId, latest)!;
      const count = (coverage: string) => pack.leaves.filter((leaf) => leaf.coverage === coverage).length;
      actual[registration.packId] = [latest, count('automated'), count('manual'), count('unsupported')];
      expect(count('automated') + count('manual') + count('unsupported'), registration.packId).toBe(pack.leaves.length);
      const line = readmeLine(registration.packId);
      stated[registration.packId] = line === undefined ? undefined : sentence.exec(line)?.slice(1).map(Number);
    }
    // Each entry is [latest version, a check runs, a person checks, not supported yet].
    expect(stated).toEqual(actual);
  });

  it('marks each invented example pack, and says where the examples are offered', () => {
    for (const { packId } of standardRulePacks())
      expect(readmeLine(packId)?.startsWith(`- \`${packId}\` (*example*; `), packId).toBe(isExamplePack(packId));
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('only when the API and the workers run with `LEDGER_EXAMPLE_PACKS=1`');
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    expect(example).toContain('not to an organization made with pnpm org:create');
  });
});
