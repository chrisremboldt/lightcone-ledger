import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  type Finding,
  forbiddenLiterals,
  lastExemptMigration,
  scan,
  scannedFiles,
  scanSource,
} from './generalisation-guard-scan.js';

// Each entry is either a whole file that is specific to one problem type (with a reason), or one exact
// matched text in one file. Every entry names the issue that removes it.
type AllowListEntry =
  { file: string; wholeFile: true; issue: number; reason: string } | { file: string; match: string; issue: number };

const allowList: AllowListEntry[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'generalisation-guard-allow-list.json'), 'utf8'),
).entries;

function covers(entry: AllowListEntry, finding: Finding): boolean {
  return entry.file === finding.file && ('wholeFile' in entry || entry.match === finding.match);
}

function describeEntry(entry: AllowListEntry): string {
  return 'wholeFile' in entry ? `${entry.file} (whole file, #${entry.issue})` : `${entry.file}: ${entry.match}`;
}

describe('core code names no specific rule, report type or vendor', () => {
  const forbidden = forbiddenLiterals();
  const findings = scan(scannedFiles(), forbidden);

  test('every allow-list entry names a file, what it allows and the issue that removes it', () => {
    const keys = new Set<string>();
    for (const entry of allowList) {
      expect(typeof entry.file, JSON.stringify(entry)).toBe('string');
      expect(Number.isInteger(entry.issue) && entry.issue > 3, JSON.stringify(entry)).toBe(true);
      if ('wholeFile' in entry) expect(entry.wholeFile === true && entry.reason.length > 0).toBe(true);
      else expect(typeof entry.match === 'string' && entry.match.length > 0, JSON.stringify(entry)).toBe(true);
      const key = 'wholeFile' in entry ? entry.file : `${entry.file}\0${entry.match}`;
      expect(keys.has(key), `duplicate entry ${describeEntry(entry)}`).toBe(false);
      keys.add(key);
    }
  });

  test('every violation is on the allow-list', () => {
    const unlisted = findings
      .filter((finding) => !allowList.some((entry) => covers(entry, finding)))
      .map((finding) => `${finding.file}:${finding.line} ${finding.rule} ${finding.match}`);
    expect(
      unlisted,
      'Core code names a specific rule, input kind, problem type or vendor. Move it behind an extension point.',
    ).toEqual([]);
  });

  test('every allow-list entry still matches a violation, so the list shrinks as issues land', () => {
    const wholeFiles = new Set(allowList.filter((entry) => 'wholeFile' in entry).map((entry) => entry.file));
    const stale = allowList.filter((entry) => !findings.some((finding) => covers(entry, finding))).map(describeEntry);
    const redundant = allowList
      .filter((entry) => !('wholeFile' in entry) && wholeFiles.has(entry.file))
      .map(describeEntry);
    expect([...stale, ...redundant], 'Remove these allow-list entries').toEqual([]);
  });

  test('rule ids and problem-specific input kinds are read from the source', () => {
    expect(forbidden.ruleIds.size).toBeGreaterThan(0);
    expect(forbidden.inputKinds.size).toBeGreaterThan(0);
  });

  test('applied migrations are exempt by number and later ones are scanned', () => {
    const migrations = scannedFiles().filter((path) => path.endsWith('.sql'));
    for (const path of migrations)
      expect(Number(/\/(\d+)_/.exec(path)?.[1]), path).toBeGreaterThan(lastExemptMigration);
  });

  test('the scan reports each forbidden form and leaves generic code alone', () => {
    const [ruleId] = forbidden.ruleIds;
    const [inputKind] = forbidden.inputKinds;
    const rules = (path: string, text: string) => scanSource(path, text, forbidden).map((finding) => finding.rule);
    expect(rules('core.ts', `import { leaf } from './rules/some-pack-v1.js';`)).toEqual(['rule-module-import']);
    expect(rules('core.ts', `const id = '${ruleId}';`)).toContain('rule-id');
    expect(rules('core.ts', `if (input.kind === '${inputKind}') accept();`)).toContain('input-kind');
    expect(rules('core.ts', `const template = 'ledger.demo.example-control';`)).toEqual(['demo-content-id']);
    expect(rules('core.ts', `function acceptLostLinkReport() {}`)).toEqual(['problem-identifier']);
    expect(rules('core.ts', `query('SELECT id FROM c2_reports');`)).toEqual(['problem-literal']);
    expect(rules('core.ts', `throw new Error('Unsupported DJI payload');`)).toEqual(['vendor']);
    expect(rules('core.ts', `const vendor = 'skydio';`)).toEqual(['vendor']);
    expect(rules('0099_example.sql', `CREATE TABLE airspace_link_grants (id text);`)).toEqual(['vendor']);
    expect(
      rules(
        'core.ts',
        `import { jwtVerify } from 'jose';
         import { evaluate } from './rules/index.js';
         export function landedAt(observation: { landingTime: string }) { return observation.landingTime; }`,
      ),
    ).toEqual([]);
  });
});
