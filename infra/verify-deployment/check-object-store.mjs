#!/usr/bin/env node
// Checks that an S3-compatible store keeps what Ledger writes once, with the settings Ledger itself reads:
//
//   node --env-file=ledger.env infra/verify-deployment/check-object-store.mjs
//
// It writes one small object under ledger-store-check/ through Ledger's own object store code, writes the same key
// again with the same bytes (a retried upload) and with other bytes, and reads it back. A store that honours
// conditional writes (If-None-Match: *) keeps the first bytes and refuses the other ones. One that ignores them
// replaces the bytes: Ledger must not be run on it. The check object stays in the bucket; it is a few bytes.
// Run it from a checkout after pnpm build, where S3_ENDPOINT reaches the store from this computer.
import { randomUUID } from 'node:crypto';
import { S3ObjectStore } from '../../packages/persistence/dist/objects.js';

const bucket = process.env.S3_BUCKET;
if (!bucket || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
  console.error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required, as for Ledger itself');
  process.exit(2);
}
const store = new S3ObjectStore(bucket, {
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
});
const key = `ledger-store-check/${randomUUID()}`;
const first = Buffer.from(`written first ${key}`);
const other = Buffer.from(`written second ${key}`);

await store.putIfAbsent(key, first, 'text/plain');
await store.putIfAbsent(key, first, 'text/plain');
let otherRefused = false;
try {
  await store.putIfAbsent(key, other, 'text/plain');
} catch (error) {
  otherRefused = /already exists with different content/.test(error.message);
  if (!otherRefused) throw error;
}
const kept = Buffer.from(await store.get(key)).equals(first);
const result = {
  status: kept && otherRefused ? 'keeps_first_bytes' : 'replaces_stored_bytes',
  key,
  retrySameBytes: 'accepted',
  otherBytes: otherRefused ? 'refused' : 'accepted',
  storedBytes: kept ? 'first' : 'replaced',
};
console.log(JSON.stringify(result));
if (result.status !== 'keeps_first_bytes') {
  console.error('This store ignores conditional writes: a retried upload can replace stored bytes. Do not use it.');
  process.exit(1);
}
