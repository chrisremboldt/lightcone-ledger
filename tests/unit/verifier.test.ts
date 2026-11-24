import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest, canonicalize, entryHash, sha256 } from '../../tools/verifier/integrity.mjs';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { interpretEvidenceCut } from '../../packages/evidence/src/evidence-cut.mjs';

const sections = [
  'streams',
  'entries',
  'receipts',
  'artifacts',
  'decision',
  'actor',
  'cuts',
  'snapshot',
  'interpreter',
  'interpretations',
];
const cuts = ['rendered', 'accepted', 'issuance'];
const time = '2026-10-01T17:00:00.000Z';
const tenant = 'tenant-alpha';
const encoding = 'ledger.v6.sha256.jcs.1';
type Fixture = any;

function seal(bundle: Fixture) {
  bundle.manifest.sectionDigests = Object.fromEntries(sections.map((name) => [name, canonicalDigest(bundle[name])]));
  bundle.manifest.interpretationDigests = Object.fromEntries(
    cuts.map((name) => [name, canonicalDigest(bundle.interpretations[name])]),
  );
  bundle.manifestDigest = canonicalDigest(bundle.manifest);
  return bundle;
}
function rechain(bundle: Fixture) {
  for (const stream of bundle.streams) {
    let previous = '';
    const rows = bundle.entries.filter((entry: any) => JSON.parse(entry.canonicalEnvelope).streamId === stream.id);
    rows.sort(
      (a: any, b: any) =>
        Number(JSON.parse(a.canonicalEnvelope).sequence) - Number(JSON.parse(b.canonicalEnvelope).sequence),
    );
    for (const entry of rows) {
      const envelope = JSON.parse(entry.canonicalEnvelope);
      entry.envelopeDigest = sha256(entry.canonicalEnvelope);
      entry.previousHash = previous;
      entry.entryHash = entryHash(tenant, stream.id, BigInt(envelope.sequence), previous, entry.envelopeDigest);
      previous = entry.entryHash;
    }
    stream.headHash = previous;
    stream.cutHeads = Object.fromEntries(
      cuts.map((name) => {
        const position = bundle.cuts[name].streams[stream.id] ?? 0;
        return [
          name,
          {
            sequence: String(position),
            hash: position === 0 ? '' : (rows[position - 1]?.entryHash ?? '00'.repeat(32)),
          },
        ];
      }),
    );
  }
  bundle.interpretations = Object.fromEntries(
    cuts.map((name) => [name, interpretEvidenceCut(bundle.entries, bundle.cuts[name], tenant)]),
  );
  return seal(bundle);
}
function fixture(): Fixture {
  const rendered = { streams: { 'a-command': 1 }, basisRevision: 1, principalRevision: 7 };
  const accepted = { streams: { 'a-command': 1, 'z-source': 1 }, basisRevision: 2, principalRevision: 7 };
  const sourcePayload = {
    sourceId: 'observer',
    kind: 'flight.observation',
    occurredAt: '2026-10-01T12:00:00-05:00',
    effectiveAt: '2026-10-01T17:00:00Z',
    sourceRevision: 1,
    subject: { flightId: 'flight-one' },
    artifactId: 'original-bytes',
    payload: { activity: 'landed', landingTime: time, title: 'Private evidence title' },
  };
  const receipt = {
    tenantId: tenant,
    id: 'receipt-one',
    eventId: 'observation',
    sourceId: 'observer',
    kind: 'flight.observation',
    occurredAt: time,
    receivedAt: time,
    sourceRevision: '1',
    artifactId: 'original-bytes',
    payload: sourcePayload.payload,
    inputSubject: sourcePayload.subject,
  };
  const envelope = (eventId: string, streamId: string, position: string, type: string, payload: any, extras = {}) => ({
    eventId,
    tenantId: tenant,
    streamId,
    sequence: position,
    type,
    schemaVersion: 1,
    principalId: 'actor-one',
    sourceId: null,
    sourceSessionId: null,
    occurredAt: null,
    effectiveAt: null,
    receivedAt: time,
    causationId: null,
    artifactId: null,
    payload,
    ...extras,
  });
  const envelopes = [
    envelope('created', 'a-command', '1', 'flight.created', { flightId: 'flight-one' }),
    envelope('decision-one', 'a-command', '2', 'decision.record', {
      flightId: 'flight-one',
      inputCut: rendered,
      acceptedInputCut: accepted,
      expectedBasisRevision: 2,
      decision: { kind: 'review', note: 'Private decision note' },
    }),
    envelope(
      'correction',
      'a-command',
      '3',
      'evidence.correct',
      { flightId: 'flight-one', correctionOf: 'observation', payload: { activity: 'active' } },
      { causationId: 'observation' },
    ),
    envelope('observation', 'z-source', '1', 'flight.observation', sourcePayload, {
      sourceId: 'observer',
      occurredAt: sourcePayload.occurredAt,
      effectiveAt: sourcePayload.effectiveAt,
      causationId: 'created',
      artifactId: 'original-bytes',
    }),
  ];
  const bytes = Buffer.from('Exact original source bytes\n');
  const source = readFileSync(new URL('../../packages/evidence/src/evidence-cut.mjs', import.meta.url), 'utf8');
  const runtimeContract = {
    name: 'node',
    major: 24,
    moduleFormat: 'esm',
    dependencies: [],
    network: 'none',
    interpretation: 'evidence-cut.1',
    canonicalization: encoding,
  };
  const decision = {
    id: 'decision-one',
    flightId: 'flight-one',
    actorId: 'actor-one',
    kind: 'review',
    note: 'Private decision note',
    recordedAt: time,
    renderedInputCut: rendered,
    acceptedInputCut: accepted,
    acceptedBasisRevision: 2,
  };
  const bundle: Fixture = {
    format: 'ledger.decision-evidence.1',
    manifestDigest: '',
    manifest: {
      format: 'ledger.decision-evidence.1',
      exportId: 'export-one',
      tenantId: tenant,
      scope: 'whole_tenant_prefixes',
      flightId: 'flight-one',
      decisionId: 'decision-one',
      issuedBy: 'actor-one',
      issuedAt: time,
      versions: { integrity: encoding, interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
      counts: { events: 4, streams: 3, receipts: 1, artifacts: 1, artifactBytes: bytes.length },
      limits: {
        maxEvents: 5000,
        maxStreams: 2000,
        maxArtifacts: 256,
        maxArtifactBytes: 16 * 1024 * 1024,
        maxBundleBytes: 32 * 1024 * 1024,
      },
      sectionDigests: {},
      interpretationDigests: {},
      limitations: [],
    },
    streams: [
      ['a-command', '3'],
      ['z-source', '1'],
      ['empty', '0'],
    ].map(([id, headSequence]) => ({ tenantId: tenant, id, name: id, headSequence, headHash: '', cutHeads: {} })),
    entries: envelopes.map((value) => ({
      canonicalEnvelope: canonicalize(value),
      envelopeDigest: '',
      previousHash: '',
      entryHash: '',
      encodingVersion: encoding,
    })),
    receipts: [receipt],
    artifacts: [
      {
        tenantId: tenant,
        id: 'original-bytes',
        sha256: sha256(bytes),
        byteLength: bytes.length,
        contentType: 'text/plain',
        bytesBase64: bytes.toString('base64'),
      },
    ],
    decision,
    actor: { id: 'actor-one', authorityRevision: 7, historicalProfile: 'not_retained' },
    cuts: { rendered, accepted, issuance: { streams: { 'a-command': 3, 'z-source': 1, empty: 0 } } },
    snapshot: {
      kind: 'export_time_sql_snapshot',
      capturedAt: time,
      projectorVersion: 'thread.1',
      projectionCut: { streams: { 'a-command': 3, 'z-source': 1 } },
      projectionRevision: 4,
      flight: { id: 'flight-one' },
      items: [{ id: 'observation', receiptId: 'receipt-one', artifactId: 'original-bytes' }, { id: 'correction' }],
      decisions: [decision],
      limitations: [],
    },
    interpreter: {
      name: 'evidence-cut.1',
      sourceEncoding: 'utf8',
      source,
      sourceSha256: sha256(source),
      runtimeContract,
      runtimeContractDigest: canonicalDigest(runtimeContract),
    },
    interpretations: {},
  };
  return rechain(bundle);
}
function verify(bundle: Fixture) {
  return verifyBundle(bundle, { expectedManifestDigest: bundle.manifestDigest });
}
function failureCode(bundle: Fixture) {
  try {
    verify(bundle);
    return 'unexpected-success';
  } catch (error: any) {
    return error.issues?.[0]?.code ?? error.message;
  }
}

describe('standalone independent verifier encoding boundary', () => {
  it('matches published SHA-256 and independently framed journal vectors', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(entryHash('tenant-alpha', 'stream-one', 1n, '', '00'.repeat(32))).toBe(
      '7e6bc2fca4f1e589bbc41bc13812d79e4c6c81d1b835a49c860e6a1a3a6161c3',
    );
    expect(entryHash('tenant-beta', 'stream-one', 1n, '', '00'.repeat(32))).not.toBe(
      entryHash('tenant-alpha', 'stream-one', 1n, '', '00'.repeat(32)),
    );
  });
});

describe('externally anchored complete-prefix verification and isolated reconstruction', () => {
  it('reconstructs all three inventories independently, preserving lexical source timestamps and the late correction', () => {
    const bundle = fixture();
    const result = verify(bundle);
    expect(result.status).toBe('verified');
    expect(result.counts).toEqual(bundle.manifest.counts);
    expect(result.replays.rendered.output.events.map((item: any) => item.eventId)).toEqual(['created']);
    expect(result.replays.accepted.output.events.map((item: any) => item.eventId)).toEqual(['created', 'observation']);
    expect(result.replays.issuance.output.events.map((item: any) => item.eventId)).toEqual([
      'created',
      'decision-one',
      'correction',
      'observation',
    ]);
    expect(result.replays.accepted.output.events[1].occurredAt).toBe('2026-10-01T12:00:00-05:00');
    expect(result.limitations.join(' ')).toContain('not a replayed historical browser display');
  });
  it('requires a separately retained anchor and rejects a modified bundle even with a newly self-consistent embedded digest', () => {
    const bundle = fixture();
    const originalAnchor = bundle.manifestDigest;
    expect(() => verifyBundle(bundle)).toThrow('independently retained');
    bundle.manifest.issuedBy = 'another-exporter';
    seal(bundle);
    expect(() => verifyBundle(bundle, { expectedManifestDigest: originalAnchor })).toThrow(
      'independently retained digest',
    );
  });
  it('checks raw artifact bytes rather than trusting the newly anchored digest declaration', () => {
    const bundle = fixture();
    bundle.artifacts[0].bytesBase64 = Buffer.from('different source bytes').toString('base64');
    seal(bundle);
    expect(failureCode(bundle)).toBe('artifact_bytes');
  });
  it('rebuilds three canonical files in an empty directory from a separate offline process with safe summary stdout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-verifier-unit-'));
    try {
      const bundle = fixture();
      const path = join(directory, 'bundle.json');
      writeFileSync(path, JSON.stringify(bundle));
      cpSync(new URL('../../tools/verifier/', import.meta.url), join(directory, 'verifier'), { recursive: true });
      const cli = join(directory, 'verifier', 'cli.mjs');
      const outputDirectory = join(directory, 'rebuilt');
      const args = [cli, path, '--expected-manifest-sha256', bundle.manifestDigest, '--rebuild-dir', outputDirectory];
      const isolatedOptions = { encoding: 'utf8' as const, cwd: directory, env: {} };
      const stdout = execFileSync(process.execPath, args, isolatedOptions);
      const result = JSON.parse(stdout);
      expect(result.status).toBe('verified');
      expect(stdout).not.toContain('Private decision note');
      expect(stdout).not.toContain('Private evidence title');
      expect(readdirSync(outputDirectory).sort()).toEqual(['accepted.json', 'issuance.json', 'rendered.json']);
      for (const name of cuts) {
        const content = readFileSync(join(outputDirectory, `${name}.json`), 'utf8');
        expect(JSON.parse(content)).toEqual(bundle.interpretations[name]);
        expect(sha256(content)).toBe(bundle.manifest.interpretationDigests[name]);
      }
      try {
        execFileSync(process.execPath, args, isolatedOptions);
        throw new Error('expected failure');
      } catch (error: any) {
        expect(error.status).toBe(1);
        expect(JSON.parse(error.stdout).issues[0].code).toBe('rebuild_directory');
      }
      bundle.interpreter.runtimeContract.major = 25;
      bundle.interpreter.runtimeContractDigest = canonicalDigest(bundle.interpreter.runtimeContract);
      seal(bundle);
      writeFileSync(path, JSON.stringify(bundle));
      try {
        execFileSync(
          process.execPath,
          [
            cli,
            path,
            '--expected-manifest-sha256',
            bundle.manifestDigest,
            '--rebuild-dir',
            join(directory, 'unavailable'),
          ],
          isolatedOptions,
        );
        throw new Error('expected unavailable');
      } catch (error: any) {
        expect(error.status).toBe(2);
        expect(JSON.parse(error.stdout).status).toBe('integrity_only');
      }
      expect(readdirSync(directory)).not.toContain('unavailable');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
