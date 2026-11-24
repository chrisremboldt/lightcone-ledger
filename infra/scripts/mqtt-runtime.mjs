import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, lstat, chmod, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(new URL('../../packages/adapters/package.json', import.meta.url));
export const { connect } = require('mqtt');
export function brokerCommand() {
  const architecture = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!architecture) throw new Error('Unsupported broker architecture');
  return {
    file: `/opt/mosquitto/lib/ld-musl-${architecture}.so.1`,
    args: ['--library-path', '/opt/mosquitto/lib:/opt/mosquitto/usr/lib', '/opt/mosquitto/usr/sbin/mosquitto'],
  };
}
export function mqttBindings(env) {
  const users = [],
    passwords = [];
  const bindings = ['ALPHA', 'BETA'].flatMap((tenant) =>
    ['DEVICE', 'ADAPTER'].map((role) => {
      const username = env[`DJI_${tenant}_${role}_USERNAME`],
        password = env[`DJI_${tenant}_${role}_PASSWORD`];
      if (
        typeof username !== 'string' ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(username) ||
        /^ledger-(?:local|dev)-/.test(username) ||
        typeof password !== 'string' ||
        !/^[A-Za-z0-9_-]{24,200}$/.test(password) ||
        /^ledger-(?:local|dev)-/.test(password)
      )
        throw new Error('Explicit bounded hosted MQTT credentials are required');
      users.push(username);
      passwords.push(password);
      return { tenant, role, username, password, topic: `thing/product/DJI-${tenant}-01/osd` };
    }),
  );
  if (new Set(users).size !== 4 || new Set(passwords).size !== 4)
    throw new Error('Hosted MQTT credentials must separate all four bindings');
  return bindings;
}
export async function prepareBroker(env = process.env) {
  if (
    env.LEDGER_ENV !== 'staging' ||
    env.LEDGER_SIMULATION_TARGET !== 'isolated' ||
    env.FLY_APP_NAME !== 'ledger-staging'
  )
    throw new Error('Hosted MQTT is restricted to the isolated staging app');
  const bindings = mqttBindings(env),
    directory = '/app/.local/runtime/mqtt';
  // Validate every fixed ancestor: recursive mkdir could otherwise follow a symlink.
  for (const path of ['/app', '/app/.local', '/app/.local/runtime', directory]) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe MQTT runtime directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(path, { mode: 0o700 });
    }
    if (path !== '/app') await chmod(path, 0o700);
  }
  const files = {
    passwords: bindings
      .map((binding) => {
        // This is Mosquitto2.0.22's native $7$ PBKDF2-SHA512 encoding: no plaintext file or secret argv.
        const salt = randomBytes(12),
          hash = pbkdf2Sync(binding.password, salt, 101, 64, 'sha512');
        return `${binding.username}:$7$101$${salt.toString('base64')}$${hash.toString('base64')}\n`;
      })
      .join(''),
    acl: bindings
      .map(
        (binding) =>
          `user ${binding.username}\ntopic ${binding.role === 'DEVICE' ? 'write' : 'read'} ${binding.topic}\n`,
      )
      .join(''),
    config: `listener 1883 127.0.0.1\nallow_anonymous false\npassword_file ${directory}/passwords\nacl_file ${directory}/acl\npersistence true\npersistence_location /data/ledger/mqtt/\nautosave_interval 1\nmax_packet_size 40000\nmessage_size_limit 32768\nmax_inflight_messages 20\nmax_queued_messages 200\nmax_queued_bytes 8388608\nmax_connections 16\nmemory_limit 67108864\nconnection_messages false\nlog_dest none\n`,
  };
  for (const [name, value] of Object.entries(files)) {
    if (Buffer.byteLength(value) > 8192) throw new Error('MQTT runtime configuration exceeds its bound');
    const destination = resolve(directory, name),
      temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  }
  return { ...brokerCommand(), args: [...brokerCommand().args, '-c', `${directory}/config`], bindings };
}
export async function probeBroker(binding, timeoutMs = 1000, { url = 'mqtt://127.0.0.1:1883', signal } = {}) {
  signal?.throwIfAborted();
  const client = connect(url, {
    protocolVersion: 5,
    username: binding.username,
    password: binding.password,
    clientId: `ledger-readiness-${randomUUID()}`,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: timeoutMs,
  });
  client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(failed, timeoutMs);
      function cleanup() {
        clearTimeout(timer);
        client.off('connect', ready);
        client.off('error', failed);
        signal?.removeEventListener('abort', failed);
      }
      function ready() {
        cleanup();
        resolve();
      }
      function failed() {
        cleanup();
        reject(new Error('MQTT readiness unavailable'));
      }
      client.once('connect', ready);
      client.once('error', failed);
      signal?.addEventListener('abort', failed, { once: true });
      if (signal?.aborted) failed();
    });
  } finally {
    await client.endAsync(true).catch(() => {});
  }
}
export async function waitForBroker(binding, options = {}) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      await probeBroker(binding, Math.min(1000, deadline - Date.now()), options);
      return;
    } catch {
      options.signal?.throwIfAborted();
      await delay(100, undefined, { signal: options.signal });
    }
  }
  throw new Error('MQTT broker did not become authenticated-ready');
}
