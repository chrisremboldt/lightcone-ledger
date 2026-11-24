import { crc32, inflateRawSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { parseStrictJson, sha256 } from './integrity.mjs';

/**
 * Verifies a produced file of records (`ledger.record-production.1`, a .zip) with Node alone. It imports no Ledger
 * package and runs nothing from the file. See docs/design/record-productions.md.
 */

export const RECORD_PRODUCTION_FORMAT = 'ledger.record-production.1';
const MAX_ENTRIES = 70000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const NOT_CHECKED = [
  'That the records are complete: the file holds what the selection found when it was produced, and nothing shows that the organization recorded everything it should have.',
  'That the journal positions are those of the organization’s journal: they are stated, and checking them needs the journal itself.',
  'That a record’s values are true, or that any requirement is met: these are the records as the organization kept them.',
  'The content of original files beyond their length and SHA-256.',
];

class Issues {
  list = [];
  add(code, path, message) {
    this.list.push({ code, path, message });
  }
  check(condition, code, path, message) {
    if (!condition) this.add(code, path, message);
    return Boolean(condition);
  }
}

/** Reads every entry of a .zip: stored or deflated, no encryption, no ZIP64, names that stay inside the archive. */
export function readZip(bytes, issues) {
  const buffer = Buffer.from(bytes);
  let end = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 22 - 65535); index--)
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  if (!issues.check(end >= 0, 'zip_structure', '$', 'The file is not a .zip: no end of central directory found'))
    return new Map();
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  let offset = buffer.readUInt32LE(end + 16);
  if (
    !issues.check(
      count <= MAX_ENTRIES && offset + directorySize <= end,
      'zip_structure',
      '$',
      'The central directory lies outside the file',
    )
  )
    return new Map();
  const entries = new Map();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (
      !issues.check(
        buffer.readUInt32LE(offset) === 0x02014b50,
        'zip_structure',
        `$.entries[${index}]`,
        'A central directory entry is malformed',
      )
    )
      return entries;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    let name;
    try {
      name = utf8.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      issues.add('zip_name', `$.entries[${index}]`, 'An entry name is not UTF-8');
      return entries;
    }
    offset += 46 + nameLength + extraLength + commentLength;
    const path = `$.entries[${JSON.stringify(name)}]`;
    if (
      !issues.check(
        name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !name.endsWith('/'),
        'zip_name',
        path,
        'An entry name leaves the archive or names a folder',
      ) ||
      !issues.check(!entries.has(name), 'zip_name', path, 'An entry name appears twice') ||
      !issues.check((flags & 1) === 0, 'zip_entry', path, 'An entry is encrypted') ||
      !issues.check(
        method === 0 || method === 8,
        'zip_entry',
        path,
        'An entry uses a compression method other than stored or deflate',
      )
    )
      continue;
    total += size;
    if (!issues.check(total <= MAX_TOTAL_BYTES, 'file_bound', '$', 'The entries exceed the 256 MiB verifier bound'))
      return entries;
    if (
      !issues.check(buffer.readUInt32LE(localOffset) === 0x04034b50, 'zip_structure', path, 'A local header is missing')
    )
      continue;
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let content;
    try {
      content = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: size + 1 });
    } catch {
      issues.add('zip_entry', path, 'An entry cannot be decompressed');
      continue;
    }
    if (
      issues.check(
        content.length === size,
        'zip_entry',
        path,
        'An entry’s length differs from the length it declares',
      ) &&
      issues.check(crc32(content) === checksum, 'zip_entry', path, 'An entry’s CRC-32 differs from its content')
    )
      entries.set(name, content);
  }
  return entries;
}

/** RFC 4180 rows of a CSV text. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell === '') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, closed: !quoted };
}

function checkIndex(content, issues) {
  const path = '$.files["index.html"]';
  let text;
  try {
    text = utf8.decode(content);
  } catch {
    issues.add('index_page', path, 'index.html is not UTF-8');
    return;
  }
  issues.check(!/<script\b/i.test(text), 'index_page', path, 'index.html holds a script');
  issues.check(
    !/\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(text) &&
      !/url\s*\(|@import/i.test(text),
    'index_page',
    path,
    'index.html loads a resource from outside the file',
  );
}

function checkRecords(manifest, files, entries, issues) {
  let records = 0;
  let replaced = 0;
  const originalDigests = new Set((manifest.originals ?? []).map((original) => original.sha256));
  for (const file of files.filter((item) => item.role === 'records')) {
    const path = `$.files[${JSON.stringify(file.path)}]`;
    const content = entries.get(file.path);
    if (!content) continue;
    let text;
    try {
      text = utf8.decode(content);
    } catch {
      issues.add('records_csv', path, 'A records file is not UTF-8');
      continue;
    }
    const { rows, closed } = csvRows(text);
    if (!issues.check(closed && rows.length >= 1, 'records_csv', path, 'A records file is not a CSV with a header row'))
      continue;
    const [header, ...data] = rows;
    const column = (name) => header.indexOf(name);
    if (
      !issues.check(
        ['recordId', 'recordedAt', 'recordedBy', 'replacedBy', 'originalSha256'].every((name) => column(name) >= 0),
        'records_csv',
        path,
        'A records file lacks the columns a produced file adds',
      )
    )
      continue;
    issues.check(
      data.length === file.rows,
      'records_csv',
      path,
      `The file has ${data.length} rows, not the ${file.rows} the manifest states`,
    );
    data.forEach((row, index) => {
      issues.check(
        row.length === header.length,
        'records_csv',
        `${path}.rows[${index + 1}]`,
        'A row has a different number of values than the header',
      );
      issues.check(
        originalDigests.has(row[column('originalSha256')]),
        'records_original',
        `${path}.rows[${index + 1}]`,
        'A row names an original file the manifest does not list',
      );
      if (row[column('replacedBy')]) replaced++;
    });
    records += data.length;
  }
  return { records, replaced };
}

/** Verifies the bytes of a produced file. With expectedManifestDigest, also that it is the file that was produced. */
export function verifyRecordProduction(bytes, options = {}) {
  const issues = new Issues();
  const entries = readZip(bytes, issues);
  const manifestBytes = entries.get('manifest.json');
  if (!manifestBytes) {
    if (!issues.list.length) issues.add('manifest', '$', 'The file holds no manifest.json');
    return { status: 'failed', issues: issues.list };
  }
  let manifest;
  try {
    manifest = parseStrictJson(utf8.decode(manifestBytes));
  } catch {
    issues.add('manifest', '$.manifest', 'manifest.json is not strict UTF-8 JSON');
    return { status: 'failed', issues: issues.list };
  }
  const manifestSha256 = sha256(manifestBytes);
  issues.check(
    manifest.format === RECORD_PRODUCTION_FORMAT,
    'manifest',
    '$.manifest.format',
    `The format is not ${RECORD_PRODUCTION_FORMAT}`,
  );
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  issues.check(files.length > 0, 'manifest', '$.manifest.files', 'The manifest lists no files');
  const listed = new Set();
  for (const file of files) {
    const path = `$.files[${JSON.stringify(file.path)}]`;
    if (!issues.check(!listed.has(file.path), 'manifest', path, 'A file is listed twice')) continue;
    listed.add(file.path);
    const content = entries.get(file.path);
    if (!issues.check(content, 'file_missing', path, 'A listed file is not in the .zip')) continue;
    issues.check(
      content.length === file.byteLength && sha256(content) === file.sha256,
      'file_digest',
      path,
      'A file’s length or SHA-256 differs from the manifest',
    );
  }
  for (const name of entries.keys())
    if (name !== 'manifest.json')
      issues.check(
        listed.has(name),
        'file_unlisted',
        `$.files[${JSON.stringify(name)}]`,
        'The .zip holds a file the manifest does not list',
      );
  const index = files.find((file) => file.role === 'index');
  if (
    issues.check(index?.path === 'index.html', 'index_page', '$.manifest.files', 'The manifest lists no index.html') &&
    entries.get('index.html')
  )
    checkIndex(entries.get('index.html'), issues);
  const counted = checkRecords(manifest, files, entries, issues);
  const counts = manifest.counts ?? {};
  const recordFiles = files.filter((file) => file.role === 'records');
  issues.check(
    counts.records === counted.records,
    'counts',
    '$.manifest.counts.records',
    'The record count differs from the rows of the records files',
  );
  issues.check(
    counts.recordTypes === recordFiles.length,
    'counts',
    '$.manifest.counts.recordTypes',
    'The record type count differs from the records files',
  );
  issues.check(
    counts.replaced === counted.replaced,
    'counts',
    '$.manifest.counts.replaced',
    'The replaced count differs from the rows that name a replacement',
  );
  const originals = Array.isArray(manifest.originals) ? manifest.originals : [];
  const included = originals.filter((original) => original.path);
  issues.check(
    counts.originals === originals.length,
    'counts',
    '$.manifest.counts.originals',
    'The original count differs from the originals listed',
  );
  issues.check(
    counts.originalsIncluded === included.length,
    'counts',
    '$.manifest.counts.originalsIncluded',
    'The included original count differs from the originals listed',
  );
  issues.check(
    manifest.selection?.includeOriginals === true || included.length === 0,
    'originals',
    '$.manifest.originals',
    'Originals are included although they were not asked for',
  );
  for (const original of included) {
    const file = files.find((item) => item.path === original.path);
    issues.check(
      file?.role === 'original' && file.sha256 === original.sha256 && file.byteLength === original.byteLength,
      'originals',
      `$.manifest.originals[${JSON.stringify(original.artifactId)}]`,
      'An included original differs from the digest the manifest lists for it',
    );
  }
  issues.check(
    files.filter((file) => file.role === 'original').length === included.length,
    'originals',
    '$.manifest.files',
    'The .zip holds original files the originals list does not name',
  );
  if (options.expectedManifestDigest !== undefined)
    issues.check(
      options.expectedManifestDigest === manifestSha256,
      'manifest_anchor',
      '$.manifest',
      'manifest.json differs from the digest kept apart from the file',
    );
  if (issues.list.length) return { status: 'failed', manifestSha256, issues: issues.list };
  return {
    status: options.expectedManifestDigest === undefined ? 'internally_consistent' : 'verified',
    format: manifest.format,
    productionId: manifest.productionId,
    organization: manifest.organization,
    producedBy: manifest.producedBy,
    producedAt: manifest.producedAt,
    reason: manifest.reason,
    requestedBy: manifest.requestedBy,
    selection: manifest.selection,
    manifestSha256,
    counts,
    files: files.length,
    originals: { listed: originals.length, included: included.length },
    ...(options.expectedManifestDigest === undefined
      ? {
          manifestAnchor:
            'not_checked: only the file’s own consistency was checked, not that it is the file that was produced. Pass the manifest digest kept apart from it.',
        }
      : {}),
    notChecked: NOT_CHECKED,
  };
}
