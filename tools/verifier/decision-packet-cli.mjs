#!/usr/bin/env node
import { open } from 'node:fs/promises';
import {
  BundleVerificationError,
  DECISION_PACKET_LIMITS,
  parseStrictJson,
  verifyDecisionPacket,
} from './decision-packet.mjs';
import { verifyDecisionPacketV2 } from './decision-packet-v2.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node tools/verifier/decision-packet-cli.mjs PACKET.json --expected-manifest-sha256 DIGEST');
  process.exit(0);
}
try {
  let file;
  let expectedManifestDigest;
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === '--expected-manifest-sha256' &&
      expectedManifestDigest === undefined &&
      args[index + 1] &&
      !args[index + 1].startsWith('--')
    )
      expectedManifestDigest = args[++index];
    else if (!file && !args[index].startsWith('--')) file = args[index];
    else throw new BundleVerificationError('cli_arguments', '$', 'Expected one packet file and one manifest digest');
  }
  if (!file || !/^[a-f0-9]{64}$/.test(expectedManifestDigest ?? ''))
    throw new BundleVerificationError(
      'cli_arguments',
      '$',
      'A packet file and independently retained manifest digest are required',
    );
  const handle = await open(file, 'r');
  let bytes;
  try {
    if (!(await handle.stat()).isFile())
      throw new BundleVerificationError('packet_file', '$', 'Packet must be a regular file');
    const buffer = Buffer.alloc(DECISION_PACKET_LIMITS.maxPacketBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > DECISION_PACKET_LIMITS.maxPacketBytes)
      throw new BundleVerificationError('packet_bound', '$', 'Packet exceeds its file byte bound');
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BundleVerificationError('utf8_encoding', '$', 'Packet is not valid UTF-8 JSON');
  }
  const packet = parseStrictJson(source);
  const verify =
    packet?.format === 'ledger.decision-packet.1'
      ? verifyDecisionPacket
      : packet?.format === 'ledger.decision-packet.2'
        ? verifyDecisionPacketV2
        : null;
  if (!verify) throw new BundleVerificationError('packet_format', '$.format', 'Unsupported selected packet format');
  console.log(JSON.stringify(verify(packet, { expectedManifestDigest })));
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      issues:
        error instanceof BundleVerificationError
          ? error.issues
          : [{ code: 'packet_operation', path: '$', message: 'The verifier could not read or validate the packet' }],
    }),
  );
  process.exitCode = 1;
}
