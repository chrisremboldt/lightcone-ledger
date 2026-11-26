import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, link, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { sha256 } from '@ledger/integrity';

export interface ObjectReadOptions {
  maxBytes: number;
  timeoutMs?: number;
}
export interface ObjectWriteOptions {
  timeoutMs?: number;
}
export interface ObjectStore {
  putIfAbsent(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options?: ObjectWriteOptions,
  ): Promise<{ version?: string }>;
  get(key: string, options?: ObjectReadOptions): Promise<Uint8Array>;
}
const DEFAULT_READ_BYTES = 32 * 1024 * 1024;
function readLimits(options?: ObjectReadOptions): { maxBytes: number; timeoutMs: number } {
  const maxBytes = options?.maxBytes ?? DEFAULT_READ_BYTES,
    timeoutMs = options?.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid object read bounds');
  return { maxBytes, timeoutMs };
}
async function deadline<T>(timeoutMs: number, operation: (controller: AbortController) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Object operation deadline exceeded');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller), expired]);
  } finally {
    clearTimeout(timer!);
  }
}
async function collectBounded(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw new Error('Object exceeds retained byte bound');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}
export async function readBoundedObject(
  store: ObjectStore,
  key: string,
  options: ObjectReadOptions,
): Promise<Uint8Array> {
  const { maxBytes, timeoutMs } = readLimits(options);
  return deadline(timeoutMs, async () => {
    const bytes = await store.get(key, { maxBytes, timeoutMs });
    if (bytes.byteLength > maxBytes) throw new Error('Object exceeds retained byte bound');
    return bytes;
  });
}
export async function writeBoundedObject(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  timeoutMs: number,
): Promise<{ version?: string }> {
  return deadline(timeoutMs, () => store.putIfAbsent(key, bytes, contentType, { timeoutMs }));
}
function assertSame(existing: Uint8Array, bytes: Uint8Array): void {
  if (existing.byteLength !== bytes.byteLength || sha256(existing) !== sha256(bytes))
    throw new Error('Immutable object already exists with different content');
}
export class DiskObjectStore implements ObjectStore {
  constructor(private root = resolve(process.env.OBJECT_STORAGE_DIR ?? '.ledger-objects')) {}
  private path(key: string): string {
    if (!/^[a-zA-Z0-9/_-]+$/.test(key)) throw new Error('Invalid object key');
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep)) throw new Error('Object outside storage root');
    return path;
  }
  async putIfAbsent(key: string, bytes: Uint8Array, _contentType: string): Promise<{ version?: string }> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = path + '.' + randomUUID();
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      assertSame(await this.get(key), bytes);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { version: sha256(bytes) };
  }
  async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array> {
    const { maxBytes, timeoutMs } = readLimits(options);
    return deadline(timeoutMs, async (controller) => {
      const handle = await open(this.path(key), 'r');
      let body: ReturnType<typeof handle.createReadStream> | undefined;
      try {
        if ((await handle.stat()).size > maxBytes) throw new Error('Object exceeds retained byte bound');
        body = handle.createReadStream({ autoClose: false, signal: controller.signal });
        return await collectBounded(body, maxBytes);
      } finally {
        body?.destroy();
        await handle.close();
      }
    });
  }
}
export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, Uint8Array>();
  async putIfAbsent(key: string, bytes: Uint8Array, _contentType: string): Promise<{ version?: string }> {
    const prior = this.objects.get(key);
    if (prior) assertSame(prior, bytes);
    else this.objects.set(key, bytes.slice());
    return { version: sha256(bytes) };
  }
  async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array> {
    const { maxBytes } = readLimits(options);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('Object missing');
    if (bytes.byteLength > maxBytes) throw new Error('Object exceeds retained byte bound');
    return bytes.slice();
  }
}
export class S3ObjectStore implements ObjectStore {
  private client: S3Client;
  constructor(
    private bucket: string,
    options: { endpoint?: string; region?: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? 'auto',
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
    });
  }
  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    options?: ObjectWriteOptions,
  ): Promise<{ version?: string }> {
    return deadline(options?.timeoutMs ?? 60000, async (controller) => {
      try {
        const result = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            IfNoneMatch: '*',
            Metadata: { sha256: sha256(bytes) },
          }),
          { abortSignal: controller.signal },
        );
        return { version: result.VersionId ?? result.ETag };
      } catch (error: any) {
        if (error.$metadata?.httpStatusCode !== 412 && error.name !== 'PreconditionFailed') throw error;
        assertSame(
          await this.get(key, { maxBytes: bytes.byteLength, timeoutMs: Math.min(options?.timeoutMs ?? 10000, 10000) }),
          bytes,
        );
        return { version: sha256(bytes) };
      }
    });
  }
  async get(key: string, options?: ObjectReadOptions): Promise<Uint8Array> {
    const { maxBytes, timeoutMs } = readLimits(options);
    return deadline(timeoutMs, async (controller) => {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: controller.signal,
      });
      if (!result.Body) throw new Error('Object missing');
      const body = result.Body as any;
      const stop = () => {
        if (typeof body.destroy === 'function') body.destroy(controller.signal.reason);
        else if (typeof body.cancel === 'function') void body.cancel().catch(() => {});
      };
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        if (controller.signal.aborted) {
          stop();
          throw new Error('Object operation deadline exceeded');
        }
        if (result.ContentLength !== undefined && result.ContentLength > maxBytes)
          throw new Error('Object exceeds retained byte bound');
        return await collectBounded(body, maxBytes);
      } finally {
        controller.signal.removeEventListener('abort', stop);
        if (typeof body.destroy === 'function') body.destroy();
        else if (typeof body.cancel === 'function') void body.cancel().catch(() => {});
      }
    });
  }
}
/**
 * Where this process keeps original bytes. OBJECT_STORE (or its older name OBJECT_STORAGE_BACKEND) names s3 or disk.
 * Unset, a deployment (LEDGER_ENV=staging) uses S3 and local development a folder. A deployment never falls back to a
 * folder it was not given: disk is a deployment's choice only when named, with the folder in OBJECT_STORAGE_DIR as an
 * absolute path, so original bytes never land unnoticed in a container's own short-lived files.
 */
export function objectStoreSetting(env: NodeJS.ProcessEnv = process.env): {
  kind: 's3' | 'disk';
  directory?: string;
  named: boolean;
} {
  const value = env.OBJECT_STORE || env.OBJECT_STORAGE_BACKEND;
  if (value && value !== 's3' && value !== 'disk') throw new Error('OBJECT_STORE must be s3 or disk');
  const kind = (value as 's3' | 'disk' | undefined) ?? (env.LEDGER_ENV === 'staging' ? 's3' : 'disk');
  if (kind === 's3') return { kind, named: Boolean(value) };
  const directory = env.OBJECT_STORAGE_DIR?.trim();
  if (value === 'disk' && !directory)
    throw new Error('OBJECT_STORE=disk needs OBJECT_STORAGE_DIR, the folder to keep files in');
  if (value === 'disk' && !isAbsolute(directory!)) throw new Error('OBJECT_STORAGE_DIR must be an absolute path');
  return { kind, directory: resolve(directory || '.ledger-objects'), named: Boolean(value) };
}

/**
 * Refuses a start whose named folder for files is missing, not a folder, or not writable by this process. Ledger does
 * not create it: a folder that is not there usually means a volume or disk that was not mounted.
 */
export async function assertObjectStoreReady(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const setting = objectStoreSetting(env);
  if (setting.kind !== 'disk' || !setting.named) return;
  const directory = setting.directory!;
  const found = await stat(directory).catch(() => undefined);
  if (!found) throw new Error(`The folder for files, ${directory} (OBJECT_STORAGE_DIR), does not exist`);
  if (!found.isDirectory()) throw new Error(`OBJECT_STORAGE_DIR names ${directory}, which is not a folder`);
  try {
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`The folder for files, ${directory} (OBJECT_STORAGE_DIR), is not writable by this process`);
  }
}

export function createObjectStore(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  const setting = objectStoreSetting(env);
  if (setting.kind === 's3') {
    const { S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
    if (!S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY)
      throw new Error('Immutable object storage credentials are required');
    return new S3ObjectStore(S3_BUCKET, {
      endpoint: S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
    });
  }
  return new DiskObjectStore(setting.directory);
}
