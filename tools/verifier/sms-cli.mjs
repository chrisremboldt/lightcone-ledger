#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { BundleVerificationError, parseStrictJson } from './integrity.mjs';
import { verifySmsExport } from './sms-export.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node tools/verifier/sms-cli.mjs EXPORT.json --expected-manifest-sha256 DIGEST');
  process.exit(0);
}
try {
  const flag = args.indexOf('--expected-manifest-sha256');
  const expectedManifestDigest = flag >= 0 ? args[flag + 1] : undefined;
  const file = args.find((arg, index) => !arg.startsWith('--') && index !== flag + 1);
  if (!file) throw new BundleVerificationError('cli_arguments', '$', 'An export file is required');
  if (flag >= 0 && (!expectedManifestDigest || expectedManifestDigest.startsWith('--')))
    throw new BundleVerificationError('cli_arguments', '$', 'The expected manifest digest needs a value');
  if ((await stat(file)).size > 64 * 1024 * 1024)
    throw new BundleVerificationError('file_bound', '$', 'Export file exceeds the 64 MiB verifier bound');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
  } catch {
    throw new BundleVerificationError('utf8_encoding', '$', 'Export is not valid UTF-8 JSON');
  }
  const result = verifySmsExport(parseStrictJson(source), { expectedManifestDigest });
  console.log(JSON.stringify(expectedManifestDigest ? result : { ...result, manifestAnchor: 'not_checked' }));
  process.exitCode = 0;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      issues:
        error instanceof BundleVerificationError
          ? error.issues
          : [{ code: 'file_operation', path: '$', message: 'The verifier could not read the export' }],
    }),
  );
  process.exitCode = 1;
}
