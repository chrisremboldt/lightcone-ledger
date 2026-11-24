#!/usr/bin/env node
// Runs a deployment of Ledger end to end on this computer, from infra/compose.production.yaml, and checks that its
// backup restores. See README.md beside this file for what it starts, what it checks and how to remove it.
//
//   node infra/verify-deployment/verify.mjs all [--project ledger-verify] [--image ledger-verify:local]
//   node infra/verify-deployment/verify.mjs start|populate|backup|restore|remove
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addPerson, openBrowser, signIn, signOut, signSafetyPolicy } from './browser.mjs';
import { organization, people, storage, urls } from './settings.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const kit = join(root, 'infra/verify-deployment');
const work = join(root, '.local/verify-deployment');
const certificates = join(work, 'certs');
const backups = join(work, 'backups');
// The organization's own pack folder, mounted where infra/compose.production.yaml mounts the checkout's packs/.
const packFolder = join(work, 'packs');
const waiver = {
  folder: join(root, 'examples/first-operator/waiver'),
  packId: 'example-ridge.waiver-107w-ex-2026-00417',
};
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { project: { type: 'string', default: 'ledger-verify' }, image: { type: 'string', default: '' } },
});
const image = options.image || `${options.project}:local`;
const profiles = ['database', 'storage', 'proxy', 'keycloak'];

function log(step, detail = {}) {
  console.log(JSON.stringify({ step, ...detail }));
}

function run(command, args, { input, output, quiet = false, allowFailure = false, env } = {}) {
  const file = output ? openSync(output, 'w') : undefined;
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: [input === undefined ? 'ignore' : 'pipe', file ?? 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (file !== undefined) closeSync(file);
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  if (result.status !== 0 && !allowFailure) {
    console.error(stdout, stderr);
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  if (!quiet && stderr.trim() && result.status !== 0) console.error(stderr.trim());
  return { status: result.status, stdout, stderr };
}

function composeArguments() {
  const imageFile = join(work, 'compose.image.yaml');
  writeFileSync(
    imageFile,
    `services:\n  ledger:\n    image: ${image}\n  setup:\n    image: ${image}\n  adapter:\n    image: ${image}\n`,
  );
  return [
    'compose',
    '-p',
    options.project,
    '--env-file',
    join(kit, 'verify.env'),
    '--env-file',
    join(kit, 'verify-owner.env'),
    '-f',
    join(root, 'infra/compose.production.yaml'),
    '-f',
    join(kit, 'compose.yaml'),
    '-f',
    imageFile,
    ...profiles.flatMap((profile) => ['--profile', profile]),
  ];
}

function compose(args, more = {}) {
  return run('docker', [...composeArguments(), ...args], more);
}

/** The deployment's docker compose as one command, as the guide's ledger-compose.sh is, for infra/backup.mjs. */
function composeScript() {
  const path = join(work, 'ledger-compose.sh');
  const quoted = composeArguments().map((argument) => `'${argument.replaceAll("'", "'\\''")}'`);
  writeFileSync(path, `#!/bin/sh\nexec docker ${quoted.join(' ')} "$@"\n`, { mode: 0o755 });
  return path;
}

/** The organization's own pack, built into the pack folder as pnpm pack:build does, before Ledger starts. */
function placePackFile() {
  rmSync(packFolder, { recursive: true, force: true });
  mkdirSync(packFolder, { recursive: true });
  run(process.execPath, [
    ...['--import', 'tsx', 'packages/standard-packs/src/pack-cli.ts', 'build', waiver.folder],
    ...['--out', packFolder],
  ]);
  log('pack_file_placed', { folder: packFolder, packId: waiver.packId });
}

/** A command of the image, as the guide runs migrations and the setup commands: the setup service, which alone is given the owner's connection. */
function fromImage(script, args = []) {
  return compose(['run', '--rm', '--no-deps', 'setup', script, ...args]);
}

function psql(service, user, database, sql) {
  return compose(['exec', '-T', service, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-At', '-c', sql])
    .stdout;
}

function openssl(args) {
  run('openssl', args, { quiet: true });
}

/** A local certificate authority and one server certificate for the three names, made once. */
function makeCertificates() {
  if (existsSync(join(certificates, 'server.spki'))) return;
  mkdirSync(certificates, { recursive: true });
  const at = (name) => join(certificates, name);
  openssl(
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', at('authority-key.pem')]
      .concat(['-out', at('authority.pem'), '-subj', '/CN=Ledger verification local authority'])
      .concat(['-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']),
  );
  openssl(
    ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('server-key.pem'), '-out', at('server.csr')].concat([
      '-subj',
      '/CN=ledger.localhost',
    ]),
  );
  writeFileSync(
    at('server.ext'),
    'subjectAltName=DNS:ledger.localhost,DNS:ledger-api.localhost,DNS:id.localhost\nextendedKeyUsage=serverAuth\n',
  );
  openssl(
    ['x509', '-req', '-in', at('server.csr'), '-CA', at('authority.pem'), '-CAkey', at('authority-key.pem')].concat([
      '-CAcreateserial',
      '-days',
      '30',
      '-out',
      at('server.pem'),
      '-extfile',
      at('server.ext'),
    ]),
  );
  const publicKey = run('openssl', ['x509', '-in', at('server.pem'), '-pubkey', '-noout']).stdout;
  const der = spawnSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: publicKey }).stdout;
  const digest = spawnSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).stdout;
  writeFileSync(at('server.spki'), digest.toString('base64'));
  // The proxy reads the key as its own user; these files are throwaway fixtures for this computer.
  run('chmod', ['644', at('server-key.pem')]);
}

/** A GET over TLS that trusts the local authority only. */
function get(url, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const call = request(url, { ca: readFileSync(join(certificates, 'authority.pem')), headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

/** The command-line client, as a person signed in at Keycloak, with the ID token the web app received. */
function ledger(token, args) {
  return run(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
    env: { LEDGER_API_URL: urls.api, LEDGER_TOKEN: token, NODE_EXTRA_CA_CERTS: join(certificates, 'authority.pem') },
  }).stdout;
}

const hostStorage = {
  S3_ENDPOINT: urls.objects,
  S3_BUCKET: storage.bucket,
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: storage.accessKeyId,
  S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
};

function createBucket() {
  compose(['exec', '-T', 'objects', 'sh', '-c', `echo "s3.bucket.create -name ${storage.bucket}" | weed shell`]);
}

function checkObjectStore() {
  const result = run(process.execPath, [join(kit, 'check-object-store.mjs')], { env: hostStorage });
  log('object_store_checked', JSON.parse(result.stdout));
}

async function waitFor(what, test, seconds = 180) {
  for (let waited = 0; waited < seconds; waited += 2) {
    if (await test().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Gave up waiting for ${what}`);
}

async function startLedger() {
  compose(['up', '-d', '--wait', 'ledger']);
  const ready = await get(`${urls.api}/readyz`);
  const signInSettings = JSON.parse((await get(`${urls.api}/v1/sign-in`)).body);
  const issuer = signInSettings.issuers[0];
  if (!issuer?.authorizationEndpoint) throw new Error('The API could not read the identity provider’s discovery');
  log('ledger_ready', {
    readyz: JSON.parse(ready.body),
    deployment: signInSettings.deploymentName,
    issuer: issuer.issuer,
  });
  const preflight = await new Promise((resolve, reject) => {
    const call = request(
      `${urls.api}/v1/me`,
      {
        method: 'OPTIONS',
        ca: readFileSync(join(certificates, 'authority.pem')),
        headers: { origin: urls.web.replace(/\/$/, ''), 'access-control-request-method': 'GET' },
      },
      (response) => resolve(response.headers['access-control-allow-origin'] ?? null),
    );
    call.on('error', reject);
    call.end();
  });
  log('cors_checked', { origin: urls.web.replace(/\/$/, ''), allowedOrigin: preflight });
}

async function start() {
  makeCertificates();
  if (run('docker', ['image', 'inspect', image], { allowFailure: true, quiet: true }).status !== 0) {
    log('building_image', { image });
    run('docker', ['build', '-f', 'infra/Dockerfile', '-t', image, '.']);
  }
  compose(['up', '-d', '--wait', 'postgres', 'objects', 'keycloak', 'proxy']);
  createBucket();
  checkObjectStore();
  log('migrated', { output: fromImage('packages/persistence/dist/migrate.js').stdout.trim() });
  const created = fromImage('apps/api/dist/create-organization.js', [
    ...['--name', organization.name, '--time-zone', 'America/Denver', '--admin', people.administrator.name],
    ...['--sign-in-issuer', urls.issuer, '--sign-in-subject', people.administrator.subject],
  ]);
  log('organization_created', { output: created.stdout.trim().split('\n')[0] });
  placePackFile();
  await startLedger();
}

async function settled() {
  await waitFor('the workers to finish', async () => {
    const pending = psql(
      'postgres',
      'ledger_owner',
      'ledger',
      "SELECT count(*) FROM work_items WHERE state<>'completed'",
    );
    return pending.trim() === '0';
  });
}

/** What a person reads back: the records, the coverage and the people, without the moment each was read. */
function readBack(token) {
  const strip = (value) =>
    JSON.parse(JSON.stringify(value), (key, item) =>
      /^(?:asOf|generatedAt|readAt|now)$/.test(key) ? undefined : item,
    );
  const records = Object.fromEntries(
    ['aircraft.identity', 'person.certificate', 'flight.record', 'operation.role-assignment'].map((type) => [
      type,
      JSON.parse(ledger(token, ['records', 'list', type, '--json'])),
    ]),
  );
  return strip({
    records,
    coverage: JSON.parse(ledger(token, ['coverage', '--json'])),
    people: JSON.parse(ledger(token, ['people', 'list', '--json'])),
  });
}

function journalChain() {
  const query = run(process.execPath, [join(kit, 'journal-chain.mjs'), '--query']).stdout.trim();
  const rows = psql('postgres', 'ledger_owner', 'ledger', query);
  const result = JSON.parse(run(process.execPath, [join(kit, 'journal-chain.mjs')], { input: rows }).stdout);
  if (result.status !== 'verified') throw new Error(`The journal's chain did not verify: ${result.message}`);
  return result;
}

async function populate() {
  const { browser, context } = await openBrowser(certificates);
  try {
    const { page, token } = await signIn(context, people.administrator);
    log('signed_in', { person: people.administrator.name, through: urls.issuer });
    // The pack file in the mounted folder is offered for adoption as the organization's own, and its adoption prints.
    const offered = JSON.parse(ledger(token, ['packs', 'list', '--json'])).packs.find(
      (pack) => pack.packId === waiver.packId,
    );
    if (offered?.origin.kind !== 'organization_file')
      throw new Error(`The pack file in the mounted folder is not offered: ${JSON.stringify(offered ?? null)}`);
    const printed = ledger(token, ['packs', 'adopt', waiver.packId, '--mode', 'active']);
    if (!printed.startsWith(`Pack: `) || !printed.includes('Not sent.'))
      throw new Error(`The adoption of ${waiver.packId} did not print: ${printed}`);
    log('own_pack_offered', { packId: waiver.packId, origin: offered.origin, printed: printed.split('\n')[0] });
    for (const type of ['aircraft.identity', 'person.certificate', 'flight.record', 'operation.role-assignment'])
      log('imported', {
        type,
        output: ledger(token, ['records', 'import', type, join(kit, 'records', `${type}.csv`)]).split('\n')[1],
      });
    const adoption = ledger(token, [
      ...['packs', 'adopt', 'ledger.part107', '--mode', 'active', '--from', '2026-10-01', '--until', '2027-10-01'],
      ...['--set-all', 'timeZone=America/Denver', '--reason', 'Adopted for the deployment verification.'],
    ]);
    log('adopted', { output: adoption.trim().split('\n').at(-1) });
    await addPerson(page, people.pilot);
    log('person_added', { person: people.pilot.name, subject: people.pilot.subject });
    const identity = await signSafetyPolicy(page, people.administrator, people.pilot);
    log('policy_signed', { reauthentication: identity });
    if (identity.method !== 'openid_connect' || !identity.authenticatedAt)
      throw new Error('The signature does not record a fresh sign-in at the identity provider');
    await signOut(page);
    const pilot = await signIn(context, people.pilot);
    log('signed_in', { person: people.pilot.name, through: urls.issuer });
    await signOut(pilot.page);
  } finally {
    await browser.close();
  }
  await settled();
}

async function snapshot(name) {
  const { browser, context } = await openBrowser(certificates);
  try {
    const { page, token } = await signIn(context, people.administrator);
    const read = readBack(token);
    await signOut(page);
    const chain = journalChain();
    writeFileSync(join(work, `${name}.json`), `${JSON.stringify({ read, chain }, null, 2)}\n`);
    return { read, chain, token };
  } finally {
    await browser.close();
  }
}

/** The folder the latest backup was written to. */
const latestBackup = join(work, 'latest-backup.txt');

async function backup() {
  await snapshot('before-backup');
  rmSync(backups, { recursive: true, force: true });
  // The guide's backup script, as the nightly schedule runs it: both databases, then the bucket, checked.
  const taken = JSON.parse(
    run(process.execPath, [join(root, 'infra/backup.mjs'), '--folder', backups, '--compose', composeScript()], {
      env: hostStorage,
    }).stdout,
  );
  if (taken.status !== 'complete') throw new Error(`The backup did not complete: ${taken.message}`);
  writeFileSync(latestBackup, taken.folder);
  log('backed_up', taken);
}

function restoreDatabase(service, user, database, dump) {
  // Into an empty database: the image creates PostGIS and its schemas in the one it starts with, as the dump does.
  for (const sql of [`DROP DATABASE ${database}`, `CREATE DATABASE ${database}`]) psql(service, user, 'postgres', sql);
  compose(['exec', '-T', service, 'pg_restore', '-U', user, '-d', database, '--exit-on-error'], {
    input: readFileSync(dump),
  });
}

async function restore() {
  const before = JSON.parse(readFileSync(join(work, 'before-backup.json'), 'utf8'));
  const backupDir = readFileSync(latestBackup, 'utf8').trim();
  // Empty containers: every container and volume of the deployment is removed first.
  compose(['down', '--volumes']);
  compose(['up', '-d', '--wait', 'postgres', 'keycloak-db', 'objects']);
  const env = Object.fromEntries(
    readFileSync(join(kit, 'verify.env'), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const quoted = (value) => `'${value.replaceAll("'", "''")}'`;
  psql(
    'postgres',
    'ledger_owner',
    'ledger',
    `CREATE ROLE ledger_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD ${quoted(env.DATABASE_APP_PASSWORD)};
     CREATE ROLE ledger_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD ${quoted(env.DATABASE_WORKER_PASSWORD)};
     GRANT ledger_app TO ledger_worker;`,
  );
  restoreDatabase('postgres', 'ledger_owner', 'ledger', join(backupDir, 'ledger.dump'));
  restoreDatabase('keycloak-db', 'keycloak', 'keycloak', join(backupDir, 'keycloak.dump'));
  createBucket();
  const copied = run(process.execPath, [join(kit, 'copy-bucket.mjs'), 'upload', backupDir], { env: hostStorage });
  log('restored', { bucket: JSON.parse(copied.stdout) });
  log('migrated', { output: fromImage('packages/persistence/dist/migrate.js').stdout.trim() });
  compose(['up', '-d', '--wait', 'keycloak', 'proxy']);
  await startLedger();
  await settled();

  const after = await snapshot('after-restore');
  const same = JSON.stringify(after.read) === JSON.stringify(before.read);
  log('records_read_the_same', { same });
  if (!same)
    throw new Error(
      'The records read differently after the restore: compare before-backup.json and after-restore.json',
    );
  if (after.chain.headsDigest !== before.chain.headsDigest) throw new Error('The journal’s stream heads changed');
  log('journal_chain_verified', after.chain);
  checkObjectStore();

  const { browser, context } = await openBrowser(certificates);
  try {
    const pilot = await signIn(context, people.pilot);
    log('signed_in', { person: people.pilot.name, after: 'restore' });
    await signOut(pilot.page);
    const { page, token } = await signIn(context, people.administrator);
    log('signed_in', { person: people.administrator.name, after: 'restore' });
    const zip = join(work, 'records-after-restore.zip');
    const produced = ledger(token, [
      ...['records', 'produce', '--reason', 'Restore drill', '--requested-by', 'Deployment verification'],
      ...['--out', zip, '--originals'],
    ]);
    const digest = /Manifest SHA-256: ([0-9a-f]{64})/.exec(produced)?.[1];
    const verified = run(process.execPath, [
      join(root, 'tools/verifier/record-production-cli.mjs'),
      zip,
      '--expected-manifest-sha256',
      digest,
    ]);
    log('record_production_verified', { result: JSON.parse(verified.stdout).status });
    // New work after the restore: an import the workers must evaluate, which needs every grant the roles had.
    const file = join(kit, 'records', 'after-restore', 'flight.record.csv');
    log('imported', {
      type: 'flight.record',
      output: ledger(token, ['records', 'import', 'flight.record', file]).split('\n')[1],
    });
    await signOut(page);
  } finally {
    await browser.close();
  }
  await settled();
  log('workers_evaluated_new_work', { pending: 0 });
}

function remove() {
  compose(['down', '--volumes', '--remove-orphans']);
  log('removed', { project: options.project, kept: [work, image] });
}

const steps = { start, populate, backup, restore, remove };
const step = positionals[0];
try {
  if (step === 'all') for (const name of ['start', 'populate', 'backup', 'restore']) await steps[name]();
  else if (steps[step]) await steps[step]();
  else {
    console.error('Usage: verify.mjs all|start|populate|backup|restore|remove [--project <name>] [--image <name>]');
    process.exitCode = 2;
  }
  if (steps[step] || step === 'all') log('done', { step });
} catch (error) {
  log('failed', { during: step, message: error.message });
  process.exitCode = 1;
}
