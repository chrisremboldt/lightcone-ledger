import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { places, yards } from '../../packages/simulation-models/src/places.js';
import { operators } from '../../apps/web/src/demo/fictional-organizations.js';

const source = fileURLToPath(new URL('../../apps/web/src/', import.meta.url));

/** The fictional world the seeds and the simulator create: organizations, people, aircraft and places. */
const fictionalNames = [
  ...operators.map((operator) => operator.name),
  'Synthetic Operations',
  ...['Dana Ortiz', 'Sam Rivera', 'Lee Park', 'Jordan Hale', 'Avery Chen', 'Morgan Ellis', 'Jordan Reyes'],
  ...['DJI-ALPHA-01', 'DJI-BETA-01', 'tenant-alpha', 'tenant-beta', 'tenant-utility'],
  ...Object.values(yards).map((yard) => yard.name),
  ...Object.keys(places),
];

// The demonstration's own world keeps its names: the autopilot scenes, the development-only walkthrough, and the
// fictional organizations and people the local sign-in screen offers (demo/), which the sign-in screen reads only behind
// the development and demonstration build switch.
const excluded = [/^autopilot\//, /^walkthrough\//, /^demo\//, /\.test\.tsx?$/];

function productionSources(): string[] {
  return readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:tsx?|css|html)$/.test(entry.name))
    .map((entry) => relative(source, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .filter((path) => !excluded.some((pattern) => pattern.test(path)));
}

describe('the production web app', () => {
  it('names no seeded fictional organization, person, aircraft or place', () => {
    const files = productionSources();
    expect(files).toContain('PeopleArea.tsx');
    const found = files.flatMap((path) => {
      const text = readFileSync(join(source, path), 'utf8');
      return fictionalNames
        .filter((name) => new RegExp(`(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text))
        .map((name) => `${path}: ${name}`);
    });
    expect(found).toEqual([]);
  });
});
