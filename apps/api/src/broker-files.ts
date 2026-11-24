import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Pool } from '@ledger/persistence';

/** Where the broker reads the files, as the compose files mount them. */
export const BROKER_FILES_PATH = '/mosquitto/config/accounts';
const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/;

export interface BrokerFilesOptions {
  out: string;
  /** Each organization given a listener, with its port. Empty: the only organization, on 1883. */
  listeners: Map<string, number>;
  brokerPath: string;
  /** Local and test only: each source's password is its account name followed by -password. */
  developmentPasswords: boolean;
}

export const brokerFilesUsage = `Usage: pnpm broker:files --out <folder> [--listen <organization id>=<port>]... [--broker-path <path>]

  --out           The folder to write mosquitto.conf and each organization's password and access files into. A
                  password already in it is kept; a source new since the last run is given one, printed once.
  --listen        An organization and the port its sources connect to. Repeat it for each organization. Without it,
                  the deployment's only organization listens on 1883.
  --broker-path   Where the broker sees the folder. Default: ${BROKER_FILES_PATH}.
  --development-passwords
                  Local and test databases only: each source's password is its account name followed by
                  -password, so the development tools know it.

Each active source of an organization gets one account, named by its id, on its organization's listener only. A
listener puts its organization's id in front of every topic, so a source publishes and subscribes to its own
organization's topics and never sees another's. Run it again after a source is added, deactivated or reactivated,
then restart the broker.`;

export function parseBrokerFiles(argv: string[]): BrokerFilesOptions {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    options: {
      out: { type: 'string' },
      listen: { type: 'string', multiple: true },
      'broker-path': { type: 'string' },
      'development-passwords': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.out?.trim()) throw new Error('--out is required');
  const listeners = new Map<string, number>();
  for (const value of values.listen ?? []) {
    const match = /^([A-Za-z0-9._-]{1,128})=(\d{1,5})$/.exec(value);
    const port = Number(match?.[2]);
    if (!match || port < 1 || port > 65535)
      throw new Error('--listen is <organization id>=<port>, for example tenant-x=1883');
    if (listeners.has(match[1]!) || [...listeners.values()].includes(port))
      throw new Error('Each organization and each port is given once');
    listeners.set(match[1]!, port);
  }
  const brokerPath = values['broker-path']?.trim() || BROKER_FILES_PATH;
  if (!/^\/[A-Za-z0-9._/-]*$/.test(brokerPath)) throw new Error('--broker-path is an absolute path');
  return {
    out: resolve(values.out.trim()),
    listeners,
    brokerPath: brokerPath.replace(/\/+$/, ''),
    developmentPasswords: values['development-passwords'] === true,
  };
}

export interface BrokerOrganization {
  id: string;
  name: string;
  port: number;
  /** The ids of its active sources. */
  sources: string[];
  /** Each source's name, for the person running the command. */
  sourceNames?: Record<string, string>;
}

/** Mosquitto's own PBKDF2-SHA512 password encoding, as its password tool writes it. */
export function brokerPasswordHash(password: string, salt = randomBytes(12)): string {
  return `$7$101$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 101, 64, 'sha512').toString('base64')}`;
}

export const developmentBrokerPassword = (account: string) => `${account}-password`;

/** The organizations with a listener, and the sources each one has on record. */
export async function brokerOrganizations(
  pool: Pool,
  listeners: Map<string, number>,
): Promise<{
  organizations: BrokerOrganization[];
  unheard: string[];
  skipped: string[];
}> {
  const rows = (
    await pool.query<{ tenant_id: string; name: string; principal_id: string | null; principal_name: string | null }>(
      `SELECT t.id AS tenant_id,t.name,p.id AS principal_id,p.name AS principal_name FROM tenants t
       LEFT JOIN principals p ON p.tenant_id=t.id AND p.kind='source' AND p.active
       ORDER BY t.id COLLATE "C",p.id COLLATE "C"`,
    )
  ).rows;
  const tenants = new Map<string, { name: string; sources: string[]; names: Record<string, string> }>();
  for (const row of rows) {
    const tenant = tenants.get(row.tenant_id) ?? { name: row.name, sources: [], names: {} };
    if (row.principal_id) {
      tenant.sources.push(row.principal_id);
      tenant.names[row.principal_id] = row.principal_name ?? row.principal_id;
    }
    tenants.set(row.tenant_id, tenant);
  }
  const chosen = new Map(listeners);
  if (!chosen.size) {
    if (tenants.size !== 1)
      throw new Error(
        `This database has ${tenants.size} organizations. Name each one that uses the broker with --listen <organization id>=<port>: ${[...tenants.keys()].join(', ')}`,
      );
    chosen.set([...tenants.keys()][0]!, 1883);
  }
  const organizations: BrokerOrganization[] = [];
  const skipped: string[] = [];
  for (const [id, port] of chosen) {
    const tenant = tenants.get(id);
    if (!tenant) throw new Error(`There is no organization ${id}`);
    if (!SAFE_NAME.test(id)) throw new Error(`The organization id ${id} cannot name a broker listener`);
    const sources = tenant.sources.filter((source) => SAFE_NAME.test(source));
    skipped.push(...tenant.sources.filter((source) => !SAFE_NAME.test(source)));
    organizations.push({
      id,
      name: tenant.name,
      port,
      sources,
      sourceNames: Object.fromEntries(sources.map((source) => [source, tenant.names[source]!])),
    });
  }
  return { organizations, unheard: [...tenants.keys()].filter((id) => !chosen.has(id)), skipped };
}

/** The account lines of every password file already in the folder, by account. */
export async function existingPasswords(out: string): Promise<Map<string, string>> {
  const accounts = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return accounts;
    throw error;
  }
  for (const name of names.filter((value) => value.startsWith('passwords-')))
    for (const line of (await readFile(join(out, name), 'utf8')).split('\n')) {
      const split = line.indexOf(':');
      if (split > 0 && line.slice(split + 1).startsWith('$7$'))
        accounts.set(line.slice(0, split), line.slice(split + 1));
    }
  return accounts;
}

export interface BrokerFiles {
  files: Record<string, string>;
  /** Passwords made in this run, each shown once. */
  issued: { organization: string; account: string; password: string }[];
}

export function brokerFiles(
  organizations: BrokerOrganization[],
  options: { brokerPath: string; developmentPasswords: boolean; existing: Map<string, string> },
  newPassword = () => randomBytes(32).toString('base64url'),
): BrokerFiles {
  const issued: BrokerFiles['issued'] = [];
  const files: Record<string, string> = {};
  const listeners: string[] = [];
  for (const organization of organizations) {
    const passwords = organization.sources.map((account) => {
      if (options.developmentPasswords) return `${account}:${brokerPasswordHash(developmentBrokerPassword(account))}`;
      const kept = options.existing.get(account);
      if (kept) return `${account}:${kept}`;
      const password = newPassword();
      issued.push({ organization: organization.id, account, password });
      return `${account}:${brokerPasswordHash(password)}`;
    });
    files[`passwords-${organization.id}`] = passwords.map((line) => `${line}\n`).join('');
    files[`acl-${organization.id}`] = [
      `# ${organization.id}: its active sources, each under its own account. The listener's mount point keeps them`,
      "# inside the organization's own topics.",
      ...organization.sources.flatMap((account) => [`user ${account}`, 'topic readwrite #']),
      '',
    ].join('\n');
    listeners.push(
      `# ${organization.id}: ${organization.sources.length} source${organization.sources.length === 1 ? '' : 's'}`,
      `listener ${organization.port} 0.0.0.0`,
      `mount_point ${organization.id}/`,
      'allow_anonymous false',
      `password_file ${options.brokerPath}/passwords-${organization.id}`,
      `acl_file ${options.brokerPath}/acl-${organization.id}`,
      '',
    );
  }
  files['mosquitto.conf'] = [
    '# Written by pnpm broker:files from the sources on record. Run it again rather than editing this file.',
    'per_listener_settings true',
    'persistence true',
    'persistence_location /mosquitto/data/',
    'autosave_interval 60',
    'max_packet_size 40000',
    'max_inflight_messages 20',
    'max_queued_messages 200',
    'max_queued_bytes 8388608',
    'log_type error',
    'log_type warning',
    'log_type notice',
    'log_dest stdout',
    '',
    ...listeners,
  ].join('\n');
  return { files, issued };
}

/** Writes each file whole, then removes the files of organizations no longer given a listener. */
export async function writeBrokerFiles(out: string, files: Record<string, string>, developmentPasswords: boolean) {
  // Development fixtures are readable by the broker container's own user; a deployment's are not world-readable.
  const fileMode = developmentPasswords ? 0o644 : 0o600;
  await mkdir(out, { recursive: true, mode: developmentPasswords ? 0o755 : 0o700 });
  for (const [name, text] of Object.entries(files)) {
    const destination = join(out, name);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { flag: 'wx', mode: fileMode });
    await chmod(temporary, fileMode);
    await rename(temporary, destination);
  }
  for (const name of await readdir(out))
    if (/^(?:passwords|acl)-/.test(name) && !(name in files)) await rm(join(out, name));
}

export function brokerReport(
  options: BrokerFilesOptions,
  organizations: BrokerOrganization[],
  result: BrokerFiles,
  notes: { unheard: string[]; skipped: string[] },
): string {
  const lines = [`Wrote the broker files to ${options.out}:`];
  for (const organization of organizations) {
    const count = organization.sources.length;
    lines.push(
      `  ${organization.name} (${organization.id}): port ${organization.port}, ${count} source account${count === 1 ? '' : 's'}`,
    );
    for (const source of organization.sources)
      lines.push(`    ${source}: ${organization.sourceNames?.[source] ?? source}`);
  }
  if (notes.unheard.length) lines.push(`No listener, so no broker access: ${notes.unheard.join(', ')}.`);
  if (notes.skipped.length) lines.push(`Sources whose ids cannot name a broker account: ${notes.skipped.join(', ')}.`);
  if (options.developmentPasswords) lines.push('Each account password is the account name followed by -password.');
  if (result.issued.length) {
    lines.push('', 'New broker passwords, shown only now. Give each to its source:');
    for (const item of result.issued) lines.push(`  ${item.organization} ${item.account} ${item.password}`);
  }
  lines.push('', 'Restart the broker to load them.');
  return lines.join('\n');
}
