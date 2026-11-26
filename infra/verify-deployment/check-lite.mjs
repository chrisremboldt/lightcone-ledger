#!/usr/bin/env node
// Brings Ledger Lite (infra/compose.lite.yaml) up on this computer with throwaway settings, checks that it answers
// /readyz as the application role, refuses a development token and keeps files on its volume, then takes it down with
// its volumes. Run it from the checkout's root; it builds the image from the checkout unless LEDGER_IMAGE names one:
//
//   node infra/verify-deployment/check-lite.mjs
//
// It uses the project name ledger-lite-check and port 18400 on 127.0.0.1, so it runs beside another stack, and writes
// its settings under .local/check-lite. Every password there is a public fixture. It prints one JSON line per step and
// exits 1 when a check did not hold.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const work = join(root, '.local/check-lite');
const port = 18400;
const base = `http://127.0.0.1:${port}`;

mkdirSync(work, { recursive: true });
writeFileSync(
  join(work, 'ledger.env'),
  [
    'DATABASE_URL=postgresql://ledger_app:check-app@postgres:5432/ledger',
    'WORKER_DATABASE_URL=postgresql://ledger_worker:check-worker@postgres:5432/ledger',
    'DATABASE_APP_PASSWORD=check-app',
    'DATABASE_WORKER_PASSWORD=check-worker',
    `CORS_ORIGINS=${base}`,
    // Never reached: the API fetches the issuer's discovery document only when someone signs in.
    'LEDGER_OIDC_ISSUER=https://id.example.org/realms/ledger',
    'LEDGER_OIDC_CLIENT_ID=ledger-web',
    '',
  ].join('\n'),
);
writeFileSync(
  join(work, 'ledger-owner.env'),
  'LEDGER_DATABASE_OWNER_PASSWORD=check-owner\nDATABASE_ADMIN_URL=postgresql://ledger_owner:check-owner@postgres:5432/ledger\n',
);
// The check's own env files and no pack folder, laid over the Lite file.
writeFileSync(
  join(work, 'compose.check.yaml'),
  [
    'services:',
    '  ledger:',
    `    env_file: !override ['${join(work, 'ledger.env')}']`,
    "    volumes: !override ['ledger-lite-files:/data']",
    '  setup:',
    `    env_file: !override ['${join(work, 'ledger.env')}', '${join(work, 'ledger-owner.env')}']`,
    '',
  ].join('\n'),
);
const compose = [
  'compose',
  '-p',
  'ledger-lite-check',
  '--env-file',
  join(work, 'ledger.env'),
  '--env-file',
  join(work, 'ledger-owner.env'),
  '-f',
  join(root, 'infra/compose.lite.yaml'),
  '-f',
  join(work, 'compose.check.yaml'),
];

function docker(args) {
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: root,
    env: {
      ...process.env,
      LEDGER_LITE_PORT: String(port),
      LEDGER_IMAGE: process.env.LEDGER_IMAGE || 'ledger-lite-check:local',
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

const log = (step, detail = {}) => console.log(JSON.stringify({ step, ...detail }));
let failed = false;
try {
  docker(['up', '-d', '--wait', ...(process.env.LEDGER_IMAGE ? [] : ['--build'])]);
  log('started');
  const ready = await fetch(`${base}/readyz`).then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }));
  if (ready.status !== 200 || ready.body.status !== 'ready' || ready.body.role !== 'ledger_app')
    throw new Error(`/readyz answered ${ready.status} ${JSON.stringify(ready.body)}`);
  log('ready', ready.body);
  const development = await fetch(`${base}/v1/me`, { headers: { authorization: 'Bearer ledger-dev-check' } });
  if (development.status !== 401) throw new Error(`A development token was answered ${development.status}`);
  log('development_token_refused');
  const processes = docker(['top', 'ledger']);
  if (!processes.includes('one-process') || /dist\/main\.js/.test(processes))
    throw new Error(`The ledger container runs more than the one process:\n${processes}`);
  const files = docker(['exec', '-T', 'ledger', 'sh', '-c', 'stat -c "%u %a" /data/ledger/files']).trim();
  if (files !== '1000 700') throw new Error(`The files folder is ${files}, not owned by 1000 with mode 700`);
  log('one_process_with_files_on_the_volume');
} catch (error) {
  failed = true;
  log('failed', { message: error.message });
} finally {
  try {
    docker(['down', '-v']);
    log('removed');
  } catch (error) {
    failed = true;
    log('remove_failed', { message: error.message });
  }
}
process.exitCode = failed ? 1 : 0;
