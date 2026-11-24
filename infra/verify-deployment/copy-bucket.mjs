#!/usr/bin/env node
// Copies Ledger's bucket to a folder, or a folder back into an empty bucket, with the settings Ledger itself reads:
//
//   node --env-file=ledger.env infra/verify-deployment/copy-bucket.mjs download ./ledger-objects-2026-11-23
//   node --env-file=ledger.env infra/verify-deployment/copy-bucket.mjs upload ./ledger-objects-2026-11-23
//
// A download checks each object against the SHA-256 Ledger stored with it and writes objects.json beside the files.
// An upload writes each object only if it is absent (If-None-Match: *), with its content type and digest, so it never
// replaces stored bytes; it answers 412 for one that is there and compares the two. Run it from a checkout after
// pnpm install, where S3_ENDPOINT reaches the store from this computer.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(new URL('../../packages/persistence/package.json', import.meta.url));
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const [direction, folder] = process.argv.slice(2);
if (!['download', 'upload'].includes(direction) || !folder) {
  console.error('Usage: copy-bucket.mjs download|upload <folder>, with the S3_ settings in the environment');
  process.exit(2);
}
const bucket = process.env.S3_BUCKET;
if (!bucket || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  console.error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required, as for Ledger itself');
  process.exit(2);
}
const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'auto',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  forcePathStyle: true,
});
const root = resolve(folder);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pathOf = (key) => {
  const path = resolve(root, 'objects', key);
  if (!path.startsWith(join(root, 'objects') + '/'))
    throw new Error(`Refusing an object key outside the folder: ${key}`);
  return path;
};

async function download() {
  const listed = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    listed.push(...(page.Contents ?? []).map((item) => item.Key));
    token = page.NextContinuationToken;
  } while (token);
  const objects = [];
  for (const key of listed.sort()) {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = Buffer.from(await result.Body.transformToByteArray());
    const digest = sha256(bytes);
    const stored = result.Metadata?.sha256;
    if (stored && stored !== digest) throw new Error(`${key} does not match the SHA-256 stored with it`);
    await mkdir(dirname(pathOf(key)), { recursive: true });
    await writeFile(pathOf(key), bytes);
    objects.push({ key, sha256: digest, length: bytes.length, contentType: result.ContentType ?? null });
  }
  await writeFile(join(root, 'objects.json'), `${JSON.stringify({ bucket, objects }, null, 2)}\n`);
  return { direction, objects: objects.length, bytes: objects.reduce((total, item) => total + item.length, 0) };
}

async function upload() {
  const { objects } = JSON.parse(await readFile(join(root, 'objects.json'), 'utf8'));
  let written = 0;
  let present = 0;
  for (const item of objects) {
    const bytes = await readFile(pathOf(item.key));
    if (sha256(bytes) !== item.sha256) throw new Error(`${item.key} in the folder has changed since it was copied`);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: item.key,
          Body: bytes,
          ContentType: item.contentType ?? undefined,
          IfNoneMatch: '*',
          Metadata: { sha256: item.sha256 },
        }),
      );
      written += 1;
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 412) throw error;
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: item.key }));
      if (sha256(Buffer.from(await result.Body.transformToByteArray())) !== item.sha256)
        throw new Error(`${item.key} is in the bucket with other bytes; it was left as it is`);
      present += 1;
    }
  }
  return { direction, objects: objects.length, written, alreadyPresent: present };
}

console.log(JSON.stringify(direction === 'download' ? await download() : await upload()));
