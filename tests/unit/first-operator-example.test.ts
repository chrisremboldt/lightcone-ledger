import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { usage } from '../../packages/cli/src/index.js';

const read = (path: string) => readFileSync(new URL(`../../examples/first-operator/${path}`, import.meta.url), 'utf8');

describe('The first operator example', () => {
  it('reads the open findings grouped by rule, then every finding, as the client prints them', () => {
    expect(usage).toContain('findings list [--pack <pack>] [--rule <rule>] [--all]');
    for (const [path, prefix] of [
      ['run.sh', '  ledger '],
      ['README.md', 'pnpm ledger '],
    ] as const) {
      const calls = read(path)
        .split('\n')
        .filter((line) => line.startsWith(`${prefix}findings list`));
      expect(
        calls.map((line) => line.slice(prefix.length).split('#')[0]!.trim()),
        path,
      ).toEqual(['findings list', 'findings list --all']);
    }
  });
});
