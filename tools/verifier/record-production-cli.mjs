#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { BundleVerificationError } from './integrity.mjs';
import { verifyRecordProduction } from './record-production.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node tools/verifier/record-production-cli.mjs RECORDS.zip [--expected-manifest-sha256 DIGEST]');
  process.exit(0);
}
try {
  const flag = args.indexOf('--expected-manifest-sha256');
  const expectedManifestDigest = flag >= 0 ? args[flag + 1] : undefined;
  const file = args.find((arg, index) => !arg.startsWith('--') && (flag < 0 || index !== flag + 1));
  if (!file) throw new BundleVerificationError('cli_arguments', '$', 'A produced .zip file is required');
  if (flag >= 0 && (!expectedManifestDigest || expectedManifestDigest.startsWith('--')))
    throw new BundleVerificationError('cli_arguments', '$', 'The expected manifest digest needs a value');
  if ((await stat(file)).size > 256 * 1024 * 1024)
    throw new BundleVerificationError('file_bound', '$', 'The file exceeds the 256 MiB verifier bound');
  const result = verifyRecordProduction(await readFile(file), { expectedManifestDigest });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'verified' ? 0 : result.status === 'internally_consistent' ? 2 : 1;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      issues:
        error instanceof BundleVerificationError
          ? error.issues
          : [{ code: 'file_operation', path: '$', message: 'The verifier could not read the file' }],
    }),
  );
  process.exitCode = 1;
}
