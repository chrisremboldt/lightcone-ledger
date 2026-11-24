import { describe, expect, it } from 'vitest';
import { canonicalize, canonicalDigest, entryHash, parseStrictJson, sha256 } from './src/index.js';
describe('independent integrity vectors', () => {
  it('keeps the default source bound while allowing an explicit strict envelope bound', () => {
    const value = { note: 'x'.repeat(70 * 1024) };
    const source = JSON.stringify(value);
    expect(() => parseStrictJson(source)).toThrow('64 KiB bound');
    expect(parseStrictJson(source, { maxBytes: 256 * 1024 })).toEqual(value);
    expect(() => parseStrictJson('{"id":1,"id":2}', { maxBytes: 256 * 1024 })).toThrow('duplicate key');
    expect(() => parseStrictJson('['.repeat(65) + '0' + ']'.repeat(65), { maxBytes: 256 * 1024 })).toThrow(
      'depth bound',
    );
    expect(() => parseStrictJson('{}', { maxBytes: Infinity })).toThrow('positive safe integer');
  });
  it('hashes exact bytes using the published SHA-256 abc vector', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('abc\n')).not.toBe(sha256('abc'));
  });
  it('canonicalizes recursively with stable Unicode key ordering and finite JSON numbers', () => {
    expect(canonicalize({ z: [true, null, { b: 2, a: 'decimal:1.000' }], a: -0 })).toBe(
      '{"a":0,"z":[true,null,{"a":"decimal:1.000","b":2}]}',
    );
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 }));
    expect(() => canonicalize({ x: undefined })).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize(9007199254740992)).toThrow();
  });
  it('matches a separately authored Python struct framing vector and binds tenant/sequence', () => {
    expect(entryHash('tenant-alpha', 'stream-one', 1, '', '00'.repeat(32))).toBe(
      '7e6bc2fca4f1e589bbc41bc13812d79e4c6c81d1b835a49c860e6a1a3a6161c3',
    );
    expect(entryHash('tenant-beta', 'stream-one', 1, '', '00'.repeat(32))).not.toBe(
      entryHash('tenant-alpha', 'stream-one', 1, '', '00'.repeat(32)),
    );
    expect(entryHash('a', 'bc', 1, '', 'x')).not.toBe(entryHash('ab', 'c', 1, '', 'x'));
  });
});
