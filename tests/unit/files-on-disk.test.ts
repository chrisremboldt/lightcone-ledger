import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diskStoreNamed, FILES_DIRECTORY, refusedInOneProcess } from '../../infra/scripts/runtime-config.mjs';
import {
  assertObjectStoreReady,
  createObjectStore,
  DiskObjectStore,
  objectStoreSetting,
  S3ObjectStore,
} from '../../packages/persistence/src/index.js';

let folder: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'ledger-files-'));
});
afterAll(async () => {
  await chmod(folder, 0o700).catch(() => undefined);
  await rm(folder, { recursive: true, force: true });
});

const s3 = { S3_BUCKET: 'ledger', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' };

describe('Where a deployment keeps original files', () => {
  it('uses S3 unless the deployment names the disk store', () => {
    expect(objectStoreSetting({ LEDGER_ENV: 'staging' })).toEqual({ kind: 's3', named: false });
    expect(createObjectStore({ LEDGER_ENV: 'staging', ...s3 })).toBeInstanceOf(S3ObjectStore);
    expect(() => createObjectStore({ LEDGER_ENV: 'staging' })).toThrow('Immutable object storage credentials');
    // A folder it was not given is never a deployment's fallback.
    expect(objectStoreSetting({ LEDGER_ENV: 'staging', OBJECT_STORAGE_DIR: folder }).kind).toBe('s3');
  });

  it('keeps files in the folder a deployment names, given as an absolute path', () => {
    const env = { LEDGER_ENV: 'staging', OBJECT_STORE: 'disk', OBJECT_STORAGE_DIR: folder };
    expect(objectStoreSetting(env)).toEqual({ kind: 'disk', directory: folder, named: true });
    expect(createObjectStore(env)).toBeInstanceOf(DiskObjectStore);
    expect(() => objectStoreSetting({ LEDGER_ENV: 'staging', OBJECT_STORE: 'disk' })).toThrow(
      'OBJECT_STORE=disk needs OBJECT_STORAGE_DIR',
    );
    expect(() => objectStoreSetting({ OBJECT_STORE: 'disk', OBJECT_STORAGE_DIR: 'files' })).toThrow(
      'OBJECT_STORAGE_DIR must be an absolute path',
    );
    expect(() => objectStoreSetting({ OBJECT_STORE: 'folder' })).toThrow('OBJECT_STORE must be s3 or disk');
  });

  it('refuses to start with a named folder that is missing, not a folder, or not writable', async () => {
    const env = (directory: string) => ({ OBJECT_STORE: 'disk', OBJECT_STORAGE_DIR: directory });
    await expect(assertObjectStoreReady(env(folder))).resolves.toBeUndefined();
    await expect(assertObjectStoreReady(env(join(folder, 'missing')))).rejects.toThrow('does not exist');
    const file = join(folder, 'a-file');
    await writeFile(file, 'x');
    await expect(assertObjectStoreReady(env(file))).rejects.toThrow('is not a folder');
    if (process.getuid?.() !== 0) {
      const locked = join(folder, 'locked');
      await mkdir(locked, { mode: 0o500 });
      await expect(assertObjectStoreReady(env(locked))).rejects.toThrow('is not writable');
    }
    // Local development keeps its own default folder, made as files arrive.
    await expect(assertObjectStoreReady({})).resolves.toBeUndefined();
  });

  it('never replaces stored bytes, and a file changed on disk is refused rather than taken', async () => {
    const store = new DiskObjectStore(folder);
    const bytes = new TextEncoder().encode('original bytes');
    await store.putIfAbsent('tenant/upload/one', bytes, 'text/plain');
    await store.putIfAbsent('tenant/upload/one', bytes, 'text/plain');
    await expect(
      store.putIfAbsent('tenant/upload/one', new TextEncoder().encode('other'), 'text/plain'),
    ).rejects.toThrow('Immutable object already exists with different content');
    expect(await readFile(join(folder, 'tenant/upload/one'), 'utf8')).toBe('original bytes');
    await writeFile(join(folder, 'tenant/upload/one'), 'changed on disk');
    await expect(store.putIfAbsent('tenant/upload/one', bytes, 'text/plain')).rejects.toThrow(
      'Immutable object already exists with different content',
    );
  });
});

describe('The image with files on disk', () => {
  it('keeps them only on the volume at /data', () => {
    expect(diskStoreNamed({ OBJECT_STORE: 'disk', OBJECT_STORAGE_DIR: FILES_DIRECTORY })).toBe(true);
    expect(() => diskStoreNamed({ OBJECT_STORE: 'disk', OBJECT_STORAGE_DIR: '/app/files' })).toThrow(
      'on a volume mounted at /data',
    );
    expect(diskStoreNamed({ OBJECT_STORE: 's3' })).toBe(false);
    expect(diskStoreNamed({})).toBe(false);
  });

  it('runs the API and the workers in one process, and refuses what would need another', () => {
    expect(refusedInOneProcess({ LEDGER_ENV: 'staging' })).toEqual([]);
    expect(refusedInOneProcess({ LEDGER_ADAPTER: 'dji-cloud-api-osd-position' })).toEqual(['adapter']);
    expect(refusedInOneProcess({ LEDGER_EMULATORS: '1' })).toEqual(['emulators']);
  });
});
