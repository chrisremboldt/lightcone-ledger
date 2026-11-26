#!/usr/bin/env node
// Takes one backup of a Ledger deployment run from infra/compose.production.yaml or infra/compose.lite.yaml, as
// docs/guides/deploy.md section 9 describes, and checks it: Ledger's database, the identity provider's database, then
// the original files, in that order, into a new folder of its own. Run it from the checkout's root. With the files in
// a bucket, give it the S3_ settings Ledger reads and the store's address on this host:
//
//   S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/backup.mjs
//
// With the files on disk (Ledger Lite), name their folder inside the ledger service instead:
//
//   node infra/backup.mjs --files /data/ledger/files --without-keycloak --compose ./ledger-lite-compose.sh
//
// Options: --folder <folder> (default backups), --compose <command> (default ./ledger-compose.sh, the guide's
// wrapper of docker compose with the deployment's env files and profiles), --without-keycloak (a deployment whose
// identity provider is not the keycloak profile), --files <folder> (the disk store's folder in the ledger service).
// It prints one JSON line, also written as backup.json in the new folder, and exits 1 when anything failed or did not
// check out, leaving what it wrote for a person to look at.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values: options } = parseArgs({
  options: {
    folder: { type: 'string', default: 'backups' },
    compose: { type: 'string', default: './ledger-compose.sh' },
    'without-keycloak': { type: 'boolean', default: false },
    files: { type: 'string' },
  },
});

/** Every table whose rows name an object Ledger keeps: the column with its key and the one with its SHA-256. */
const OBJECT_TABLES = {
  artifacts: ['object_key', 'sha256'],
  restricted_artifacts: ['object_key', 'sha256'],
  record_productions: ['archive_object_key', 'archive_sha256'],
  export_records: ['object_key', 'bundle_sha256'],
  sms_exports: ['object_key', 'bundle_sha256'],
  finding_packet_records: ['packet_object_key', 'packet_sha256'],
  decision_packet_records: ['object_key', 'packet_sha256'],
};

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

/** The objects the dumped database names, each key with the SHA-256 it holds for it, read from the dump itself. */
function objectsNamedIn(path) {
  const data = compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--data-only',
      ...Object.keys(OBJECT_TABLES).flatMap((table) => ['-t', table]),
      '-f',
      '-',
    ],
    { input: readFileSync(path) },
  );
  const named = new Map();
  let columns;
  for (const line of data.split('\n')) {
    const copy = /^COPY (?:\S+\.)?(\S+) \((.+)\) FROM stdin;$/.exec(line);
    if (copy) {
      const names = copy[2].split(', ');
      columns = OBJECT_TABLES[copy[1]]?.map((name) => names.indexOf(name));
      continue;
    }
    if (line === '\\.') columns = undefined;
    else if (columns && line) {
      const values = line.split('\t');
      named.set(values[columns[0]], values[columns[1]]);
    }
  }
  return named;
}

/** Copies the disk store's folder out of the ledger service into objects/, and lists each file as objects.json does. */
function copyFiles(folder) {
  const archive = join(folder, 'files.tar');
  compose(['exec', '-T', 'ledger', 'tar', '-C', options.files, '-cf', '-', '.'], { output: archive });
  const objects = join(folder, 'objects');
  mkdirSync(objects);
  run('tar', ['-xf', archive, '-C', objects]);
  rmSync(archive);
  const listed = readdirSync(objects, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { key: relative(objects, path).split(sep).join('/'), sha256: sha256(path), length: statSync(path).size };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  writeFileSync(
    join(folder, 'objects.json'),
    `${JSON.stringify({ folder: options.files, objects: listed }, null, 2)}\n`,
  );
  return {
    direction: 'download',
    objects: listed.length,
    bytes: listed.reduce((total, item) => total + item.length, 0),
  };
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
  // The databases first, then the files: Ledger stores an object before it commits the rows that name it and never
  // changes or deletes one, so files copied after the dump hold every object the dump names.
  summary.ledger = dump('postgres', 'ledger_owner', 'ledger', join(folder, 'ledger.dump'));
  if (!options['without-keycloak'])
    summary.keycloak = dump('keycloak-db', 'keycloak', 'keycloak', join(folder, 'keycloak.dump'));
  if (options.files) summary.files = copyFiles(folder);
  else
    summary.bucket = JSON.parse(
      run(process.execPath, [join(root, 'infra/verify-deployment/copy-bucket.mjs'), 'download', folder]),
    );
  const copied = new Map(
    JSON.parse(readFileSync(join(folder, 'objects.json'), 'utf8')).objects.map((object) => [object.key, object.sha256]),
  );
  const named = objectsNamedIn(summary.ledger.file);
  const missing = [...named.keys()].filter((key) => !copied.has(key));
  const changed = [...named].filter(([key, digest]) => copied.has(key) && copied.get(key) !== digest);
  summary.objectsNamedByDatabase = named.size;
  if (missing.length)
    throw new Error(`${missing.length} objects the database names are not in the copy, such as ${missing[0]}`);
  if (changed.length)
    throw new Error(
      `${changed.length} objects in the copy do not have the SHA-256 the database holds, such as ${changed[0][0]}`,
    );
  summary.status = 'complete';
} catch (error) {
  summary.message = error.message;
  process.exitCode = 1;
}
summary.finishedAt = new Date().toISOString();
if (existsSync(folder)) writeFileSync(join(folder, 'backup.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
