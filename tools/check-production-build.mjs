#!/usr/bin/env node
// Fails when the ordinary web build (apps/web/dist) contains any part of the simulated-person
// demo: its modules, its recordings, its scene titles or the fixture people's credentials.
// Run it after `pnpm build`; the demonstration build (dist-demo) is meant to contain them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const web = join(root, 'apps/web');
const autopilot = join(web, 'src/autopilot');
const dist = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(web, 'dist');

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Read from the source so a new scene is covered without editing this check. */
function sceneTitles() {
  const source = readFileSync(join(autopilot, 'scenes.ts'), 'utf8');
  const titles = [...source.matchAll(/^ {2}title: (['"`])(.+?)\1,$/gm)].map((match) => match[2]);
  const scenes = source.match(/: Scene = \{$/gm)?.length ?? 0;
  if (titles.length === 0 || titles.length !== scenes)
    throw new Error(`Read ${titles.length} titles for ${scenes} scenes in apps/web/src/autopilot/scenes.ts.`);
  return titles;
}

/** Bundlers name a lazily loaded chunk after its module, so these names mean demo code shipped. */
function demoModuleNames() {
  return filesUnder(autopilot).map((path) => basename(path, extname(path)));
}

function check() {
  if (!existsSync(join(dist, 'index.html'))) return [`No build at ${relative(root, dist)}. Run \`pnpm build\` first.`];

  const markers = ['ledger-dev-', 'Simulated person', 'recorded_demonstration', ...sceneTitles()];
  const chunkNames = new Set(demoModuleNames());
  const problems = [];
  for (const path of filesUnder(dist)) {
    const name = relative(dist, path);
    const chunk = basename(path).match(/^(.+?)-[\w-]{8}\.(?:js|mjs|css)$/);
    if (chunk && chunkNames.has(chunk[1])) problems.push(`${name}: chunk built from apps/web/src/autopilot`);
    const content = readFileSync(path);
    for (const marker of markers) if (content.includes(marker)) problems.push(`${name}: contains "${marker}"`);
  }
  return problems;
}

const problems = check();
if (problems.length > 0) {
  console.error(`The ordinary web build contains demo code (${relative(root, dist)}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Guard every reference to the demo inline with `import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === ' +
      "'demo'` so the bundler drops it (see apps/web/src/transport.ts).",
  );
  process.exit(1);
}
console.log(`No demo code in ${relative(root, dist)}.`);
