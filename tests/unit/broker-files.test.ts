import { pbkdf2Sync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROKER_FILES_PATH,
  brokerFiles,
  existingPasswords,
  parseBrokerFiles,
  writeBrokerFiles,
  type BrokerOrganization,
} from '../../apps/api/src/broker-files.js';

const organizations: BrokerOrganization[] = [
  { id: 'tenant-first', name: 'Fictional First', port: 1883, sources: ['source-a', 'source-b'] },
  { id: 'tenant-second', name: 'Fictional Second', port: 1884, sources: [] },
];

/** Checks a password against a Mosquitto $7$ line the way the broker does. */
function matches(line: string, password: string) {
  const [, , iterations, salt, hash] = line.split('$');
  return (
    pbkdf2Sync(password, Buffer.from(salt!, 'base64'), Number(iterations), 64, 'sha512').toString('base64') === hash
  );
}

describe('broker files from the sources on record', () => {
  it('gives each organization its own listener, mount point, accounts and access rules', () => {
    let count = 0;
    const { files, issued } = brokerFiles(
      organizations,
      { brokerPath: BROKER_FILES_PATH, developmentPasswords: false, existing: new Map() },
      () => `password-${++count}`,
    );
    expect(Object.keys(files).sort()).toEqual([
      'acl-tenant-first',
      'acl-tenant-second',
      'mosquitto.conf',
      'passwords-tenant-first',
      'passwords-tenant-second',
    ]);
    const config = files['mosquitto.conf']!;
    expect(config).toContain('per_listener_settings true');
    expect(config).toContain(
      [
        'listener 1883 0.0.0.0',
        'mount_point tenant-first/',
        'allow_anonymous false',
        `password_file ${BROKER_FILES_PATH}/passwords-tenant-first`,
        `acl_file ${BROKER_FILES_PATH}/acl-tenant-first`,
      ].join('\n'),
    );
    expect(config).toContain('listener 1884 0.0.0.0\nmount_point tenant-second/');
    expect(config).not.toMatch(/allow_anonymous true/);
    expect(files['acl-tenant-first']).toContain('user source-a\ntopic readwrite #\nuser source-b\ntopic readwrite #\n');
    expect(files['passwords-tenant-second']).toBe('');
    expect(issued).toEqual([
      { organization: 'tenant-first', account: 'source-a', password: 'password-1' },
      { organization: 'tenant-first', account: 'source-b', password: 'password-2' },
    ]);
    const lines = files['passwords-tenant-first']!.trim().split('\n');
    expect(lines.map((line) => line.split(':')[0])).toEqual(['source-a', 'source-b']);
    expect(matches(lines[0]!.slice('source-a:'.length), 'password-1')).toBe(true);
    expect(files['passwords-tenant-first']).not.toContain('password-1');
  });

  it('keeps a password already issued, drops a source no longer on record, and gives fixtures in development', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ledger-broker-'));
    try {
      const first = brokerFiles(organizations, {
        brokerPath: BROKER_FILES_PATH,
        developmentPasswords: false,
        existing: new Map(),
      });
      await writeBrokerFiles(out, first.files, false);
      expect((await stat(join(out, 'passwords-tenant-first'))).mode & 0o777).toBe(0o600);
      const existing = await existingPasswords(out);
      expect([...existing.keys()]).toEqual(['source-a', 'source-b']);

      const second = brokerFiles([{ ...organizations[0]!, sources: ['source-a'] }], {
        brokerPath: BROKER_FILES_PATH,
        developmentPasswords: false,
        existing,
      });
      expect(second.issued).toEqual([]);
      await writeBrokerFiles(out, second.files, false);
      expect((await readFile(join(out, 'passwords-tenant-first'), 'utf8')).trim()).toBe(
        `source-a:${existing.get('source-a')}`,
      );
      expect((await readdir(out)).sort()).toEqual(['acl-tenant-first', 'mosquitto.conf', 'passwords-tenant-first']);

      const development = brokerFiles([organizations[0]!], {
        brokerPath: BROKER_FILES_PATH,
        developmentPasswords: true,
        existing,
      });
      expect(development.issued).toEqual([]);
      const line = development.files['passwords-tenant-first']!.split('\n')[1]!;
      expect(matches(line.slice('source-b:'.length), 'source-b-password')).toBe(true);
      await writeFile(join(out, 'passwords-stale'), 'stale:$7$x');
      await writeBrokerFiles(out, development.files, true);
      expect((await stat(join(out, 'mosquitto.conf'))).mode & 0o777).toBe(0o644);
      expect(await readdir(out)).not.toContain('passwords-stale');
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('reads its options', () => {
    const options = parseBrokerFiles([
      '--out',
      'broker',
      '--listen',
      'tenant-first=1883',
      '--listen',
      'tenant-second=1884',
    ]);
    expect([...options.listeners]).toEqual([
      ['tenant-first', 1883],
      ['tenant-second', 1884],
    ]);
    expect(options.brokerPath).toBe(BROKER_FILES_PATH);
    expect(() => parseBrokerFiles(['--out', 'x', '--listen', 'tenant-first=1883', '--listen', 'other=1883'])).toThrow(
      'Each organization and each port is given once',
    );
    expect(() => parseBrokerFiles(['--out', 'x', '--listen', 'tenant first=1883'])).toThrow('--listen is');
    expect(() => parseBrokerFiles([])).toThrow('--out is required');
  });

  it('commits no broker configuration that names an organization', async () => {
    const committed = await readdir(new URL('../../infra/mqtt/', import.meta.url));
    // The accounts folder holds only what the command writes, and git ignores it.
    expect(committed.sort()).toEqual(['README.md', 'accounts']);
    const ignored = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
    expect(ignored).toContain('infra/mqtt/accounts/*\n!infra/mqtt/accounts/.gitkeep');
  });
});
