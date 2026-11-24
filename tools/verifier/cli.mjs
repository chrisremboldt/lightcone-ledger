#!/usr/bin/env node
import { readFile, stat, mkdir, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { verifyBundle, parseStrictJson, BundleVerificationError } from './index.mjs';
import { canonicalize, sha256 } from './integrity.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node tools/verifier/cli.mjs BUNDLE.json --expected-manifest-sha256 DIGEST [--rebuild-dir EMPTY_DIRECTORY]',
  );
  process.exit(0);
}
let file;
let expectedManifestDigest;
let rebuildDirectory;
try {
  const supplied = new Set();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--expected-manifest-sha256' || args[index] === '--rebuild-dir') {
      const flag = args[index];
      if (supplied.has(flag) || !args[index + 1] || args[index + 1].startsWith('--'))
        throw new BundleVerificationError(
          'cli_arguments',
          '$',
          'Verifier flags require one value and cannot be repeated',
        );
      supplied.add(flag);
      if (flag === '--expected-manifest-sha256') expectedManifestDigest = args[++index];
      else rebuildDirectory = args[++index];
    } else if (!file && !args[index].startsWith('--')) file = args[index];
    else throw new BundleVerificationError('cli_arguments', '$', 'Unknown or duplicate verifier argument');
  }
  if (!file) throw new BundleVerificationError('cli_arguments', '$', 'A bundle file is required');
  if ((await stat(file)).size > 256 * 1024 * 1024)
    throw new BundleVerificationError('file_bound', '$', 'Bundle file exceeds the 256 MiB verifier bound');
  const bytes = await readFile(file);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BundleVerificationError('utf8_encoding', '$', 'Bundle is not valid UTF-8 JSON');
  }
  const verified = verifyBundle(parseStrictJson(source), { expectedManifestDigest });
  const rebuiltFiles = [];
  if (rebuildDirectory && verified.status === 'verified') {
    await mkdir(rebuildDirectory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(rebuildDirectory)).isDirectory() ||
      (await lstat(rebuildDirectory)).isSymbolicLink() ||
      (await readdir(rebuildDirectory)).length !== 0
    )
      throw new BundleVerificationError(
        'rebuild_directory',
        '$',
        'Reconstruction requires an empty real directory; existing files are never overwritten',
      );
    for (const name of ['rendered', 'accepted', 'issuance']) {
      const content = canonicalize(verified.replays[name].output);
      await writeFile(join(rebuildDirectory, `${name}.json`), content, { flag: 'wx', mode: 0o600 });
      rebuiltFiles.push({ cut: name, file: `${name}.json`, sha256: sha256(content) });
    }
  }
  const replays = Object.fromEntries(
    Object.entries(verified.replays).map(([name, result]) => [
      name,
      result.status === 'verified'
        ? {
            status: result.status,
            digest: result.digest,
            eventCount: result.eventCount,
            missingCausationCount: result.missingCausationIds.length,
          }
        : { status: result.status, limitations: result.limitations },
    ]),
  );
  console.log(JSON.stringify({ ...verified, replays, ...(rebuiltFiles.length ? { rebuiltFiles } : {}) }));
  process.exitCode = verified.status === 'verified' ? 0 : 2;
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'failed',
      issues:
        error instanceof BundleVerificationError
          ? error.issues
          : [
              {
                code: 'file_operation',
                path: '$',
                message: 'The verifier could not read the bundle or write reconstruction files',
              },
            ],
    }),
  );
  process.exitCode = 1;
}
