import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
export { canonicalize } from './canonical.js';
export { parseStrictJson } from './strict-json.js';

export const INTEGRITY_VERSION = 'ledger.v6.sha256.jcs.1';
export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalDigest(value: unknown): string {
  return sha256(canonicalize(value));
}
function frame(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
export function entryHash(
  tenantId: string,
  streamId: string,
  sequence: bigint | number,
  previousHash: string,
  envelopeDigest: string,
): string {
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(BigInt(sequence));
  return sha256(
    Buffer.concat([
      frame('ledger.v6.entry.1'),
      frame(tenantId),
      frame(streamId),
      seq,
      frame(previousHash),
      frame(envelopeDigest),
    ]),
  );
}
