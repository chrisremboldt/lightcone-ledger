import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeFiles, exampleVariables, readsIn, root } from './environment-variables.js';

/** Set by the tools themselves (Vite, pnpm, a CI runner), never by a person running Ledger. */
const setByTools = new Set(['DEV', 'BASE_URL', 'INIT_CWD', 'CI']);

function reads() {
  const names = new Map<string, string>();
  const patterns: { pattern: RegExp; path: string }[] = [];
  for (const path of codeFiles()) {
    const found = readsIn(readFileSync(join(root, path), 'utf8'), path);
    for (const name of found.names) if (!names.has(name)) names.set(name, path);
    for (const pattern of found.patterns) patterns.push({ pattern, path });
  }
  return { names, patterns };
}

describe('.env.example', () => {
  const example = exampleVariables(readFileSync(join(root, '.env.example'), 'utf8'));
  const { names, patterns } = reads();

  it('finds what the code reads', () => {
    for (const name of ['DATABASE_URL', 'S3_BUCKET', 'LEDGER_WEB_DIR', 'LEDGER_EMULATORS', 'SIMULATOR_HAZARD_PLAN'])
      expect(names.has(name), name).toBe(true);
    expect(patterns.length).toBeGreaterThan(0);
  });

  it('lists every variable the code reads', () => {
    const missing = [...names]
      .filter(([name]) => !setByTools.has(name) && !example.has(name))
      .map(([name, path]) => `${name} (read in ${path})`);
    expect(missing).toEqual([]);
    const unmatched = patterns
      .filter(({ pattern }) => ![...example.keys()].some((name) => pattern.test(name)))
      .map(({ pattern, path }) => `${pattern} (read in ${path})`);
    expect(unmatched).toEqual([]);
  });

  it('lists only variables something reads', () => {
    const unread = [...example.keys()].filter(
      (name) => !names.has(name) && !patterns.some(({ pattern }) => pattern.test(name)),
    );
    expect(unread).toEqual([]);
  });

  it('says what each variable is for and whether production needs it', () => {
    const undescribed = [...example]
      .filter(([, comment]) => !/^# [^]*Production: (?:required|optional|not used|the image sets it)\b/.test(comment))
      .map(([name]) => name);
    expect(undescribed).toEqual([]);
  });

  it('keeps everything that names a seeded fictional organization in the one block a person can delete', () => {
    const text = readFileSync(join(root, '.env.example'), 'utf8');
    const marker = '# --- The seeded fictional organizations: only for pnpm db:seed (development tools) ---';
    expect(text.split(marker)).toHaveLength(2);
    const [own, fictional] = text.split(marker) as [string, string];
    expect(own.match(/\b(?:alpha|beta|utility)\b|tenant-|ledger-dev-/gi)).toBeNull();
    expect(fictional).toMatch(/tenant-alpha/);
    // The block is the end of the file, so deleting it leaves every other variable in place.
    expect([...exampleVariables(own).keys()].length).toBeGreaterThan(50);
  });
});
