#!/usr/bin/env node
// Takes one backup of a Ledger deployment run from infra/compose.production.yaml, as docs/guides/deploy.md section 9
// describes, and checks it: Ledger's database, the identity provider's database, then the bucket, in that order, into
// a new folder of its own. Run it from the checkout's root, with the S3_ settings Ledger reads and the store's address
// on this host:
//
//   S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/backup.mjs
//
// Options: --folder <folder> (default backups), --compose <command> (default ./ledger-compose.sh, the guide's
// wrapper of docker compose with the deployment's env files and profiles), --without-keycloak (a deployment whose
// identity provider is not the keycloak profile). It prints one JSON line, also written as backup.json in the new
// folder, and exits 1 when anything failed or did not check out, leaving what it wrote for a person to look at.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: options } = parseArgs({
  options: {
    folder: { type: 'string', default: 'backups' },
    compose: { type: 'string', default: './ledger-compose.sh' },
    'without-keycloak': { type: 'boolean', default: false },
  },
});

/** Every table whose rows name an object in the bucket that Ledger keeps, by its key. */
const OBJECT_TABLES = [
  'artifacts',
  'restricted_artifacts',
  'record_productions',
  'export_records',
  'sms_exports',
  'finding_packet_records',
  'decision_packet_records',
];

function run(command, args, { input, output } = {}) {
  const file = output ? openSync(output, 'w') : undefined;
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', file ?? 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (file !== undefined) closeSync(file);
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${[command, ...args].join(' ')} exited ${result.status}: ${result.stderr.toString().trim()}`);
  return result.stdout?.toString() ?? '';
}

const compose = (args, more) => run(resolve(root, options.compose), args, more);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A database dumped by its owner inside its own container, in pg_dump's custom format. */
function dump(service, user, database, path) {
  compose(['exec', '-T', service, 'pg_dump', '-U', user, '--format=custom', database], { output: path });
  // pg_restore reads the whole table of contents back: a cut-off or damaged file fails here, not at a restore.
  const contents = compose(['exec', '-T', service, 'pg_restore', '--list'], { input: readFileSync(path) });
  const tables = contents.split('\n').filter((line) => / TABLE DATA /.test(line)).length;
  if (!tables) throw new Error(`${path} lists no table data`);
  return { file: path, bytes: statSync(path).size, sha256: sha256(path), tables };
}

/** The object keys the dumped database names, read from the dump itself. */
function keysNamedIn(path) {
  const data = compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--data-only',
      ...OBJECT_TABLES.flatMap((table) => ['-t', table]),
      '-f',
      '-',
    ],
    { input: readFileSync(path) },
  );
  const keys = new Set();
  let column = -1;
  for (const line of data.split('\n')) {
    const copy = /^COPY \S+ \((.+)\) FROM stdin;$/.exec(line);
    if (copy) {
      column = copy[1].split(', ').indexOf('object_key');
      continue;
    }
    if (line === '\\.') column = -1;
    else if (column >= 0 && line) keys.add(line.split('\t')[column]);
  }
  return keys;
}

const startedAt = new Date();
const folder = resolve(
  root,
  options.folder,
  startedAt
    .toISOString()
    .replace(/[:.]/g, '')
    .replace(/\d{3}Z$/, 'Z'),
);
const summary = { status: 'failed', folder, startedAt: startedAt.toISOString() };
try {
  if (existsSync(folder)) throw new Error(`${folder} exists already; nothing was written`);
  mkdirSync(folder, { recursive: true });
  // The databases first, then the bucket: Ledger stores an object before it commits the rows that name it and never
  // changes or deletes one, so a bucket copied after the dump holds every object the dump names.
  summary.ledger = dump('postgres', 'ledger_owner', 'ledger', join(folder, 'ledger.dump'));
  if (!options['without-keycloak'])
    summary.keycloak = dump('keycloak-db', 'keycloak', 'keycloak', join(folder, 'keycloak.dump'));
  summary.bucket = JSON.parse(
    run(process.execPath, [join(root, 'infra/verify-deployment/copy-bucket.mjs'), 'download', folder]),
  );
  const copied = new Set(
    JSON.parse(readFileSync(join(folder, 'objects.json'), 'utf8')).objects.map((object) => object.key),
  );
  const named = keysNamedIn(summary.ledger.file);
  const missing = [...named].filter((key) => !copied.has(key));
  summary.objectsNamedByDatabase = named.size;
  if (missing.length)
    throw new Error(`${missing.length} objects the database names are not in the bucket copy, such as ${missing[0]}`);
  summary.status = 'complete';
} catch (error) {
  summary.message = error.message;
  process.exitCode = 1;
}
summary.finishedAt = new Date().toISOString();
if (existsSync(folder)) writeFileSync(join(folder, 'backup.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
