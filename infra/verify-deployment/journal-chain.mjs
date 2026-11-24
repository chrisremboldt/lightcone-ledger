#!/usr/bin/env node
// Checks every hash chain in a Ledger database's journal, offline, from what `psql` prints for the query below:
//
//   psql "$DATABASE_ADMIN_URL" -At -c "$(node infra/verify-deployment/journal-chain.mjs --query)" \
//     | node infra/verify-deployment/journal-chain.mjs
//
// For each stream it recomputes each event's envelope digest from its retained envelope, each entry hash from the
// previous one, and checks the stream's head against its last event. It prints one JSON line: the streams and events
// checked and a digest of every stream head, which is the same before a backup and after its restore; or the first
// problem found, with exit code 1. It imports nothing from Ledger but the offline verifier's own hashing.
import { createInterface } from 'node:readline';
import { canonicalize, entryHash, sha256 } from '../../tools/verifier/integrity.mjs';

const QUERY = `SELECT json_build_object('kind','event','tenant',tenant_id,'stream',stream_id,'sequence',stream_sequence::text,
'previous',previous_hash,'entry',entry_hash,'digest',envelope_digest,'encoding',encoding_version,'envelope',immutable_envelope)
FROM journal_events
UNION ALL
SELECT json_build_object('kind','head','tenant',tenant_id,'stream',id,'sequence',sequence::text,'entry',head_hash) FROM streams`;

if (process.argv.includes('--query')) {
  console.log(QUERY.replace(/\n/g, ' '));
  process.exit(0);
}

function fail(message, item) {
  console.log(JSON.stringify({ status: 'failed', message, tenant: item?.tenant, stream: item?.stream }));
  process.exit(1);
}

const events = new Map();
const heads = new Map();
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const item = JSON.parse(line);
  const key = `${item.tenant}\u0000${item.stream}`;
  if (item.kind === 'head') heads.set(key, item);
  else events.set(key, [...(events.get(key) ?? []), item]);
}
if (!heads.size) fail('No streams were read: is the query right, and is this the owner connection?');

let checked = 0;
for (const [key, head] of heads) {
  const stream = (events.get(key) ?? []).sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence)));
  let previous = '';
  for (const [index, event] of stream.entries()) {
    if (BigInt(event.sequence) !== BigInt(index + 1)) fail(`Event ${index + 1} of the stream is missing`, event);
    if (event.encoding !== 'ledger.v6.sha256.jcs.1') fail(`Unknown encoding ${event.encoding}`, event);
    if (canonicalize(JSON.parse(event.envelope)) !== event.envelope)
      fail('An envelope is not in canonical form', event);
    if (sha256(event.envelope) !== event.digest) fail(`The envelope of event ${event.sequence} has changed`, event);
    if (event.previous !== previous) fail(`Event ${event.sequence} does not follow the event before it`, event);
    const recomputed = entryHash(event.tenant, event.stream, BigInt(event.sequence), event.previous, event.digest);
    if (recomputed !== event.entry) fail(`The entry hash of event ${event.sequence} does not recompute`, event);
    previous = event.entry;
    checked += 1;
  }
  if (head.sequence !== String(stream.length) || head.entry !== previous)
    fail('The stream head does not match its last event', head);
  events.delete(key);
}
if (events.size) fail('Events belong to a stream that has no head', [...events.values()][0][0]);

const headsDigest = sha256(
  [...heads.values()]
    .map((head) => `${head.tenant} ${head.stream} ${head.sequence} ${head.entry}`)
    .sort()
    .join('\n'),
);
console.log(JSON.stringify({ status: 'verified', streams: heads.size, events: checked, headsDigest }));
