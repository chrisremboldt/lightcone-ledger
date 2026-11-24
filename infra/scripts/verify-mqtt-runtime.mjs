import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';
import { prepareBroker, waitForBroker, connect, brokerCommand } from './mqtt-runtime.mjs';

let check = 'fixture',
  broker;
const clients = [];
const completed = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Qualification timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function client(binding, extra = {}) {
  const connection = connect('mqtt://127.0.0.1:1883', {
    protocolVersion: 5,
    username: binding?.username,
    password: binding?.password,
    clientId: `qualification-${randomUUID()}`,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 1500,
    ...extra,
  });
  connection.on('error', () => {});
  clients.push(connection);
  await bounded(
    new Promise((resolve, reject) => {
      connection.once('connect', resolve);
      connection.once('error', reject);
    }),
    2000,
  );
  return connection;
}
async function rejected(binding) {
  let connected = false;
  try {
    const connection = await client(binding);
    connected = connection.connected;
  } catch {}
  assert.equal(connected, false);
}
async function close(connection) {
  await bounded(connection.endAsync(true), 2000);
}
function receive(connection, topic, payload) {
  return bounded(
    new Promise((resolve) => {
      const listener = (actual, value) => {
        if (actual === topic && value.toString() === payload) {
          connection.off('message', listener);
          resolve();
        }
      };
      connection.on('message', listener);
    }),
  );
}
async function subscribe(connection, topic) {
  // A broker may accept a subscription while filtering messages by read ACL.
  try {
    await bounded(connection.subscribeAsync(topic, { qos: 1 }));
  } catch {}
}
async function publish(connection, topic, payload) {
  await bounded(connection.publishAsync(topic, payload, { qos: 1 }));
}
async function forbiddenRead(connection, publisher, topic) {
  const marker = `forbidden-read-${randomUUID()}`;
  let seen = false;
  const listener = (actual, value) => {
    if (actual === topic && value.toString() === marker) seen = true;
  };
  connection.on('message', listener);
  await subscribe(connection, topic);
  await publish(publisher, topic, marker);
  await delay(200);
  connection.off('message', listener);
  assert.equal(seen, false);
}
async function forbiddenWrite(connection, reader, topic) {
  const marker = `forbidden-write-${randomUUID()}`;
  let seen = false;
  const listener = (actual, value) => {
    if (actual === topic && value.toString() === marker) seen = true;
  };
  reader.on('message', listener);
  try {
    await publish(connection, topic, marker);
  } catch {}
  await delay(200);
  reader.off('message', listener);
  assert.equal(seen, false);
}
async function stopBroker() {
  if (!broker || broker.exitCode !== null || broker.signalCode !== null) return;
  const ended = new Promise((resolve) => broker.once('exit', resolve));
  broker.kill('SIGTERM');
  await bounded(ended, 3000);
}
function launch(config) {
  broker = spawn(config.file, config.args, { stdio: 'ignore' });
  broker.on('error', () => {});
}
try {
  assert.equal(process.env.MQTT_VERIFY_FIXTURE, '1');
  const env = { ...process.env };
  for (const tenant of ['ALPHA', 'BETA'])
    for (const role of ['DEVICE', 'ADAPTER']) {
      env[`DJI_${tenant}_${role}_USERNAME`] =
        `qualification-${tenant.toLowerCase()}-${role.toLowerCase()}-${randomBytes(8).toString('hex')}`;
      env[`DJI_${tenant}_${role}_PASSWORD`] = randomBytes(32).toString('base64url');
    }
  const config = await prepareBroker(env),
    [alphaDevice, alphaAdapter, betaDevice, betaAdapter] = config.bindings;
  check = 'nonroot-and-version';
  assert.equal(process.getuid(), 1000);
  assert.equal(process.getgid(), 1000);
  const command = brokerCommand(),
    version = spawnSync(command.file, [...command.args, '-h'], { encoding: 'utf8', timeout: 2000 });
  assert.match(version.stdout, /mosquitto version 2\.0\.22/);
  completed.push(check);
  check = 'private-config-without-plaintext-passwords';
  const passwords = await readFile('/app/.local/runtime/mqtt/passwords', 'utf8');
  for (const binding of config.bindings) assert.equal(passwords.includes(binding.password), false);
  for (const path of [
    '/app/.local/runtime/mqtt/config',
    '/app/.local/runtime/mqtt/passwords',
    '/app/.local/runtime/mqtt/acl',
  ])
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const path of [
    '/data/ledger',
    '/data/ledger/mqtt',
    '/data/ledger/dji-checkpoints',
    '/data/ledger/dji-reports',
  ]) {
    const value = await stat(path);
    assert.equal(value.uid, 1000);
    assert.equal(value.mode & 0o777, 0o700);
  }
  completed.push(check);
  launch(config);
  await waitForBroker(alphaDevice);
  check = 'anonymous-and-wrong-password-rejected';
  await rejected(undefined);
  await rejected({ ...alphaDevice, password: randomBytes(32).toString('base64url') });
  completed.push(check);
  for (const connection of clients) if (connection.connected) await close(connection);
  check = 'exact-topic-delivery-both-tenants';
  const ad = await client(alphaDevice),
    aa = await client(alphaAdapter),
    bd = await client(betaDevice),
    ba = await client(betaAdapter);
  await subscribe(aa, alphaAdapter.topic);
  await subscribe(ba, betaAdapter.topic);
  for (const [device, adapter, binding] of [
    [ad, aa, alphaDevice],
    [bd, ba, betaDevice],
  ]) {
    const marker = `delivery-${randomUUID()}`,
      received = receive(adapter, binding.topic, marker);
    await publish(device, binding.topic, marker);
    await received;
  }
  completed.push(check);
  check = 'tenant-and-direction-isolation';
  await forbiddenRead(aa, bd, betaDevice.topic);
  await forbiddenRead(ba, ad, alphaDevice.topic);
  await forbiddenRead(ad, ad, alphaDevice.topic);
  await forbiddenWrite(ad, ba, betaDevice.topic);
  await forbiddenWrite(aa, aa, alphaDevice.topic);
  await subscribe(aa, 'thing/product/#');
  await forbiddenRead(aa, bd, betaDevice.topic);
  completed.push(check);
  check = 'loopback-only-listener';
  const address = Object.values(networkInterfaces())
    .flat()
    .find((value) => value?.family === 'IPv4' && !value.internal)?.address;
  assert.ok(address);
  const exposed = await bounded(
    new Promise((resolve) => {
      const socket = createConnection({ host: address, port: 1883 });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    }),
    1000,
  );
  assert.equal(exposed, false);
  completed.push(check);
  for (const connection of clients) if (connection.connected) await close(connection);
  check = 'persistent-offline-queue-after-restart';
  const clientId = `persistent-${randomUUID()}`,
    persistent = await client(alphaAdapter, { clientId, clean: false, properties: { sessionExpiryInterval: 60 } });
  await bounded(persistent.subscribeAsync(alphaAdapter.topic, { qos: 1 }));
  await bounded(persistent.endAsync(false));
  const writer = await client(alphaDevice),
    marker = `recovery-${randomUUID()}`;
  await publish(writer, alphaDevice.topic, marker);
  await close(writer);
  await stopBroker();
  assert.ok((await stat('/data/ledger/mqtt/mosquitto.db')).size > 0);
  launch(config);
  await waitForBroker(alphaDevice);
  // Install the message listener before CONNECT can restore a queued delivery.
  const restored = connect('mqtt://127.0.0.1:1883', {
    protocolVersion: 5,
    username: alphaAdapter.username,
    password: alphaAdapter.password,
    clientId,
    clean: false,
    reconnectPeriod: 0,
    connectTimeout: 1500,
    properties: { sessionExpiryInterval: 60 },
  });
  restored.on('error', () => {});
  clients.push(restored);
  await receive(restored, alphaAdapter.topic, marker);
  await close(restored);
  completed.push(check);
  check = 'graceful-shutdown';
  await stopBroker();
  completed.push(check);
  check = 'supervisor-peer-failure-shutdown';
  const childEnv = { ...env };
  delete childEnv.DATABASE_URL;
  delete childEnv.WORKER_DATABASE_URL;
  childEnv.SIMULATOR_AUTORUN = '0';
  const supervisor = spawn(process.execPath, ['infra/scripts/supervise.mjs'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let ready = false;
  supervisor.stdout.on('data', (bytes) => {
    if (bytes.toString().includes('"event":"mqtt_ready"')) ready = true;
  });
  const exited = await bounded(new Promise((resolve) => supervisor.once('exit', (code) => resolve(code))), 8000).catch(
    (error) => {
      supervisor.kill('SIGKILL');
      throw error;
    },
  );
  assert.equal(ready, true);
  assert.notEqual(exited, 0);
  let alive = true;
  try {
    const connection = await client(alphaDevice);
    alive = connection.connected;
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
  completed.push(check);
  console.log(JSON.stringify({ status: 'passed', brokerVersion: '2.0.22', uid: 1000, checks: completed }));
} catch {
  console.error(JSON.stringify({ status: 'failed', check }));
  process.exitCode = 1;
} finally {
  for (const connection of clients) await connection.endAsync(true).catch(() => {});
  try {
    await stopBroker();
  } catch {
    broker?.kill('SIGKILL');
  }
}
