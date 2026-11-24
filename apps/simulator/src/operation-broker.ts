import { createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { OperationWorld } from '@ledger/simulation-models/operation';

interface MqttCredential {
  username: string;
  password: string;
}
export type OperationMqttBindings = Record<string, { device: MqttCredential; adapter: MqttCredential }>;
const configurationFiles = ['passwords', 'acl', 'mosquitto.conf'] as const;
interface LegacyBrokerBundle {
  version: 1;
  runId: string;
  port: number;
  binding: string;
  mqttBindings: OperationMqttBindings;
  files: Record<(typeof configurationFiles)[number], string>;
}
interface HostedBrokerBundle extends Omit<LegacyBrokerBundle, 'version'> {
  version: 2;
  profile: 'hosted.2';
  dataDirectory: string;
}
type BrokerBundle = LegacyBrokerBundle | HostedBrokerBundle;
export interface HostedOperationBrokerOptions {
  profile: 'hosted.2';
}
export interface HostedOperationBrokerLoadOptions extends HostedOperationBrokerOptions {
  port: number;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => {
  throw new Error(`World broker: ${message}`);
};
function binding(world: OperationWorld, port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('port must be between 1 and 65535');
  if (
    !world.aircraft.length ||
    world.aircraft.length > 50 ||
    new Set(world.aircraft.map((aircraft) => aircraft.id)).size !== world.aircraft.length ||
    world.aircraft.some((aircraft) => !/^[A-Za-z0-9_-]{1,200}$/.test(aircraft.id))
  )
    fail('requires a finite fleet with distinct MQTT-safe device identities');
  return digest(
    JSON.stringify({
      version: 1,
      config: world.config,
      aircraft: world.aircraft.map(({ id, tenant }) => ({ id, tenant })),
      port,
    }),
  );
}
function hostedProfile(options: HostedOperationBrokerOptions | undefined): boolean {
  if (options !== undefined && options.profile !== 'hosted.2') fail('broker profile is unsupported');
  return options !== undefined;
}
function hostedDataDirectory(directory: string): string {
  if (/[\s\\'"#\u0000-\u001f\u007f-\u009f]/u.test(directory))
    fail('hosted paths must not contain whitespace, controls or configuration delimiters');
  return join(directory, 'data');
}
function hostedBinding(world: OperationWorld, directory: string, port: number): string {
  binding(world, port);
  return digest(
    JSON.stringify({
      version: 2,
      profile: 'hosted.2',
      config: world.config,
      aircraft: world.aircraft.map(({ id, tenant }) => ({ id, tenant })),
      port,
      directory,
      dataDirectory: hostedDataDirectory(directory),
    }),
  );
}
async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    fail('configuration directory must be private and cannot be a symlink');
}
async function privateFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 1024 * 1024)
    fail('configuration files must be private regular files within their byte bound');
  return readFile(path, 'utf8');
}
function acl(bindings: OperationMqttBindings): string {
  return Object.entries(bindings)
    .flatMap(([deviceId, credentials]) => [
      `user ${credentials.device.username}\ntopic write thing/product/${deviceId}/osd\n`,
      `user ${credentials.adapter.username}\ntopic read thing/product/${deviceId}/osd\n`,
    ])
    .join('');
}
function configuration(fleetSize: number): string {
  return [
    'user root',
    'listener 1883 0.0.0.0',
    'allow_anonymous false',
    'password_file /mosquitto/config/operation/passwords',
    'acl_file /mosquitto/config/operation/acl',
    'persistence true',
    'persistence_location /mosquitto/data/',
    'autosave_interval 1',
    'max_packet_size 40000',
    'message_size_limit 32768',
    'max_inflight_messages 20',
    'max_queued_messages 200',
    'max_queued_bytes 8388608',
    `max_connections ${Math.max(16, fleetSize * 2 + 4)}`,
    'memory_limit 67108864',
    'connection_messages false',
    'log_dest stdout',
    '',
  ].join('\n');
}
function hostedConfiguration(fleetSize: number, directory: string, port: number): string {
  return [
    `listener ${port} 127.0.0.1`,
    'allow_anonymous false',
    `password_file ${join(directory, 'passwords')}`,
    `acl_file ${join(directory, 'acl')}`,
    'persistence true',
    `persistence_location ${hostedDataDirectory(directory)}/`,
    'autosave_interval 1',
    'max_packet_size 40000',
    'message_size_limit 32768',
    'max_inflight_messages 20',
    'max_queued_messages 200',
    'max_queued_bytes 8388608',
    `max_connections ${Math.max(16, fleetSize * 2 + 4)}`,
    'memory_limit 67108864',
    'connection_messages false',
    'log_dest stdout',
    '',
  ].join('\n');
}
async function readBundle(
  path: string,
  world: OperationWorld,
  options?: HostedOperationBrokerLoadOptions,
): Promise<BrokerBundle> {
  const hosted = hostedProfile(options);
  await privateDirectory(dirname(path));
  const { sha256, ...bundle } = JSON.parse(await privateFile(path)) as BrokerBundle & { sha256: string };
  if (bundle.version === 2 && !hosted) fail('hosted broker requires the explicit hosted.2 profile');
  if (hosted && bundle.version !== 2) fail('hosted.2 requires a retained version 2 broker');
  if (
    (hosted
      ? bundle.version !== 2 || bundle.profile !== 'hosted.2' || bundle.port !== options!.port
      : bundle.version !== 1) ||
    bundle.runId !== world.config.runId ||
    bundle.binding !== (hosted ? hostedBinding(world, dirname(path), options!.port) : binding(world, bundle.port)) ||
    digest(JSON.stringify(bundle)) !== sha256
  )
    fail('retained configuration does not match this world or its commitment');
  if (bundle.version === 2) {
    if (bundle.dataDirectory !== hostedDataDirectory(dirname(path))) fail('retained broker data path changed');
    await privateDirectory(bundle.dataDirectory);
  }
  const deviceIds = world.aircraft.map((aircraft) => aircraft.id);
  if (
    !bundle.mqttBindings ||
    Object.keys(bundle.mqttBindings).length !== deviceIds.length ||
    deviceIds.some((id) => !Object.hasOwn(bundle.mqttBindings, id))
  )
    fail('retained credentials do not match the aircraft identities');
  const usernames = new Set<string>();
  const passwords = new Set<string>();
  for (const credentials of Object.values(bundle.mqttBindings))
    for (const role of ['device', 'adapter'] as const) {
      const credential = credentials?.[role];
      if (
        !credential ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(credential.username) ||
        !/^[A-Za-z0-9_-]{32,200}$/.test(credential.password) ||
        usernames.has(credential.username) ||
        passwords.has(credential.password)
      )
        fail('retained credentials must separate every device and adapter');
      usernames.add(credential.username);
      passwords.add(credential.password);
    }
  const files = {} as Record<(typeof configurationFiles)[number], string>;
  for (const name of configurationFiles) {
    files[name] = await privateFile(join(dirname(path), name));
    if (!bundle.files || digest(files[name]) !== bundle.files[name]) fail(`retained ${name} commitment changed`);
  }
  const expectedConfiguration = hosted
    ? hostedConfiguration(deviceIds.length, dirname(path), options!.port)
    : configuration(deviceIds.length);
  if (files.acl !== acl(bundle.mqttBindings) || files['mosquitto.conf'] !== expectedConfiguration)
    fail('retained broker policy does not match the exact aircraft bindings');
  return bundle;
}

export async function loadOperationBindings(
  path: string,
  world: OperationWorld,
  options?: HostedOperationBrokerLoadOptions,
): Promise<OperationMqttBindings> {
  return (await readBundle(resolve(path), world, options)).mqttBindings;
}

export async function prepareOperationBroker(
  world: OperationWorld,
  directory: string,
  port: number,
  options?: HostedOperationBrokerOptions,
): Promise<{ bindings: OperationMqttBindings; bindingsPath: string; configPath: string; dataDirectory?: string }> {
  const destination = resolve(directory);
  const hosted = hostedProfile(options);
  const dataDirectory = hosted ? hostedDataDirectory(destination) : undefined;
  const loadOptions = hosted ? { profile: 'hosted.2' as const, port } : undefined;
  const bindingsPath = join(destination, 'bindings.json');
  const configPath = join(destination, 'mosquitto.conf');
  const expectedBinding = hosted ? hostedBinding(world, destination, port) : binding(world, port);
  let exists = false;
  try {
    await privateDirectory(destination);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (exists && (await readdir(destination)).length) {
    const retained = await readBundle(bindingsPath, world, loadOptions);
    if (retained.binding !== expectedBinding) fail('retained broker belongs to a different port or configuration');
    return { bindings: retained.mqttBindings, bindingsPath, configPath, ...(hosted ? { dataDirectory } : {}) };
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    if (hosted) await mkdir(join(temporary, 'data'), { mode: 0o700 });
    const bindings: OperationMqttBindings = {};
    for (const aircraft of world.aircraft) {
      const prefix = `operation-${digest(`${world.config.runId}:${aircraft.id}`).slice(0, 24)}`;
      bindings[aircraft.id] = {
        device: { username: `${prefix}-device`, password: randomBytes(24).toString('base64url') },
        adapter: { username: `${prefix}-adapter`, password: randomBytes(24).toString('base64url') },
      };
    }
    const files = {
      passwords: Object.values(bindings)
        .flatMap((credentials) => [credentials.device, credentials.adapter])
        .map((credential) => {
          const salt = randomBytes(12);
          const hash = pbkdf2Sync(credential.password, salt, 101, 64, 'sha512');
          return `${credential.username}:$7$101$${salt.toString('base64')}$${hash.toString('base64')}\n`;
        })
        .join(''),
      acl: acl(bindings),
      'mosquitto.conf': hosted
        ? hostedConfiguration(world.aircraft.length, destination, port)
        : configuration(world.aircraft.length),
    };
    const bundle: BrokerBundle = hosted
      ? {
          version: 2,
          profile: 'hosted.2',
          runId: world.config.runId,
          port,
          dataDirectory: dataDirectory!,
          binding: expectedBinding,
          mqttBindings: bindings,
          files: Object.fromEntries(
            configurationFiles.map((name) => [name, digest(files[name])]),
          ) as BrokerBundle['files'],
        }
      : {
          version: 1,
          runId: world.config.runId,
          port,
          binding: expectedBinding,
          mqttBindings: bindings,
          files: Object.fromEntries(
            configurationFiles.map((name) => [name, digest(files[name])]),
          ) as BrokerBundle['files'],
        };
    const encoded = JSON.stringify({ ...bundle, sha256: digest(JSON.stringify(bundle)) }) + '\n';
    for (const [name, value] of Object.entries({ ...files, 'bindings.json': encoded })) {
      const file = await open(join(temporary, name), 'wx', 0o600);
      try {
        await file.writeFile(value);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const prepared = await open(temporary, 'r');
    try {
      await prepared.sync();
    } finally {
      await prepared.close();
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    const parent = await open(dirname(destination), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const retained = await readBundle(bindingsPath, world, loadOptions);
    if (retained.binding !== expectedBinding) fail('retained broker belongs to a different port or configuration');
    return { bindings: retained.mqttBindings, bindingsPath, configPath, ...(hosted ? { dataDirectory } : {}) };
  } finally {
    await Promise.all(
      [...configurationFiles, 'bindings.json'].map((name) =>
        unlink(join(temporary, name)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }),
      ),
    );
    if (hosted)
      await rmdir(join(temporary, 'data')).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    await rmdir(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
