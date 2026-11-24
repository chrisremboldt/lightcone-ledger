#!/usr/bin/env node
import { open } from 'node:fs/promises';
import {
  BundleVerificationError,
  FINDING_PACKET_LIMITS,
  parseStrictJson,
  verifyFindingPacket,
} from './finding-packet.mjs';

const usage = 'Usage: node tools/verifier/finding-packet-cli.mjs PACKET.json [--expected-manifest-sha256 DIGEST]';

function parseArguments(args) {
  let file;
  let expectedManifestDigest;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--expected-manifest-sha256' && expectedManifestDigest === undefined && args[index + 1])
      expectedManifestDigest = args[++index];
    else if (!file && !args[index].startsWith('--')) file = args[index];
    else throw new BundleVerificationError('cli_arguments', '$', usage);
  }
  if (!file) throw new BundleVerificationError('cli_arguments', '$', usage);
  if (expectedManifestDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedManifestDigest))
    throw new BundleVerificationError(
      'cli_arguments',
      '$',
      'The expected manifest digest must be 64 lowercase hexadecimal characters',
    );
  return { file, expectedManifestDigest };
}

async function readBounded(file) {
  const handle = await open(file, 'r');
  try {
    if (!(await handle.stat()).isFile())
      throw new BundleVerificationError('packet_file', '$', 'The packet must be a regular file');
    const buffer = Buffer.alloc(FINDING_PACKET_LIMITS.maxPacketBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > FINDING_PACKET_LIMITS.maxPacketBytes)
      throw new BundleVerificationError('packet_bound', '$', 'The packet file exceeds its byte bound');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
try {
  const { file, expectedManifestDigest } = parseArguments(args);
  const bytes = await readBounded(file);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BundleVerificationError('utf8_encoding', '$', 'The packet is not valid UTF-8 JSON');
  }
  const result = verifyFindingPacket(parseStrictJson(source), { expectedManifestDigest });
  console.log(JSON.stringify(result));
  // Exit 2: consistent, but without the separately kept digest the packet's authenticity was not checked.
  if (result.status !== 'verified') process.exitCode = 2;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      issues:
        error instanceof BundleVerificationError
          ? error.issues
          : [{ code: 'packet_operation', path: '$', message: 'The verifier could not read or check the packet' }],
    }),
  );
  process.exitCode = 1;
}
