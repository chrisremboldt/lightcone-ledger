// Downloads the Airspace Link OpenAPI schemas that the emulator validates against.
// They are not redistributed in this repository; each one is checked against its pinned schema digest.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const directory = new URL('../vendor/airspace-link/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8'));

function schemaDigest(yaml) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value)
      .filter((key) => !key.startsWith('x-'))
      .sort();
    return Object.fromEntries(keys.map((key) => [key, normalize(value[key])]));
  };
  return createHash('sha256')
    .update(JSON.stringify(normalize(parse(yaml))))
    .digest('hex');
}

function extractYaml(page, url) {
  const match = page.match(/```yaml\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`No OpenAPI block in ${url}`);
  return `${match[1]}\n`;
}

const changed = [];
let downloaded = 0;
for (const source of provenance.sources.filter((entry) => entry.schemaSha256)) {
  const target = new URL(source.file, directory);
  if (existsSync(target) && schemaDigest(readFileSync(target, 'utf8')) === source.schemaSha256) continue;
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${source.url} returned ${response.status}`);
  const yaml = extractYaml(await response.text(), source.url);
  if (schemaDigest(yaml) !== source.schemaSha256) {
    changed.push(source.url);
    continue;
  }
  writeFileSync(target, yaml);
  downloaded += 1;
}
if (changed.length) {
  console.error(`Airspace Link changed these schemas since they were pinned:\n${changed.join('\n')}`);
  console.error('Review the change, then update schemaSha256 in apps/emulators/vendor/airspace-link/provenance.json.');
  process.exit(1);
}
console.log(`Airspace Link schemas ready in ${fileURLToPath(directory)} (${downloaded} downloaded)`);
