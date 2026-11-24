import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitoringReportSource } from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { monitoringRecord, monitoringSource } from '../../../packages/contracts/fixtures/demo/v1/monitoring-window.js';
import {
  persistOperationMonitoringSource,
  readOperationMonitoringJournal,
} from '../src/operation-monitoring-journal.js';
import type {
  OperationMonitoringC2Original,
  PreparedOperationMonitoringSource,
} from '../src/operation-monitoring-source.js';
import * as privateJournal from '../src/private-journal.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-monitoring-journal-'));
  directories.push(directory);
  const worldPath = join(directory, 'world.json');
  const path = join(directory, 'monitoring', 'source.json');
  await writeFile(worldPath, 'retained world checkpoint\n', { mode: 0o600 });
  return { directory, path, worldPath };
}

function bytesOriginal(bytes: Buffer) {
  return { bytesBase64: bytes.toString('base64'), sha256: sha256(bytes), byteLength: bytes.length };
}

/** The exact original of one command-link status report the monitoring window declares. */
function statusOriginal(sourceEventId: string, status: 'lost' | 'restored', occurredAt: string) {
  const flight = monitoringSource.flights[0]!;
  const source = {
    sourceSessionId: flight.c2SourceSessionId,
    occurredAt,
    sourceEventId,
    incidentId: 'fixture-baseline-incident',
    aircraftId: flight.aircraftId,
    status,
  };
  return {
    sourceId: flight.c2SourceId,
    sourceSessionId: source.sourceSessionId,
    sourceEventId,
    ...bytesOriginal(Buffer.from(JSON.stringify(source, null, 2) + '\n')),
  } satisfies OperationMonitoringC2Original;
}
const declaredC2Originals = [
  statusOriginal('baseline-loss', 'lost', '2026-10-15T14:13:00Z'),
  statusOriginal('baseline-restoration', 'restored', '2026-10-15T14:14:00Z'),
];

function prepared(
  revision = 1,
  change?: (source: MonitoringReportSource) => void,
  c2Originals: OperationMonitoringC2Original[] = declaredC2Originals,
): PreparedOperationMonitoringSource {
  const source: MonitoringReportSource = structuredClone(monitoringSource);
  source.sourceRevision = revision;
  change?.(source);
  const identity = {
    runId: 'monitoring-journal',
    tenantId: monitoringRecord.authority.tenantId,
    sourceId: monitoringRecord.sourceId,
    sourceSessionId: source.sourceSessionId,
    sourceWindowId: source.sourceWindowId,
    sourceRevision: revision,
    planDigest: canonicalDigest({ control: monitoringSource.control, window: monitoringSource.window }),
  };
  return {
    version: 'operation.monitoring-source.1',
    identity,
    key: `simulator:monitoring:${canonicalDigest(identity)}`,
    ...bytesOriginal(Buffer.from(JSON.stringify(source, null, 2) + '\n')),
    c2Originals: structuredClone(c2Originals),
  };
}

async function expectUnchanged(path: string, before: Buffer, action: Promise<unknown>) {
  await expect(action).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
}

describe('durable operation monitoring originals', () => {
  it('restarts with exact originals, deduplicates retries without rewriting, and holds a private lock through persistence', async () => {
    const { path, worldPath } = await fixture();
    expect(await readOperationMonitoringJournal(path, worldPath)).toBeUndefined();
    const first = prepared();
    const writeEnvelope = privateJournal.writeJournalEnvelope;
    let writing!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const writer = vi.spyOn(privateJournal, 'writeJournalEnvelope').mockImplementationOnce(async (...args) => {
      writing();
      await blocked;
      return writeEnvelope(...args);
    });
    const pending = persistOperationMonitoringSource(path, worldPath, first);
    await entered;
    try {
      expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
      await expect(persistOperationMonitoringSource(path, worldPath, first)).rejects.toThrow(/running actor/i);
    } finally {
      resume();
    }
    const initial = await pending;
    writer.mockRestore();
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readOperationMonitoringJournal(path, worldPath)).toEqual(initial);
    const sentinel = new Date('2020-01-01T00:00:00.000Z');
    await utimes(path, sentinel, sentinel);
    const retained = await readFile(path);
    const metadata = await stat(path, { bigint: true });
    expect(await persistOperationMonitoringSource(path, worldPath, structuredClone(first))).toEqual(initial);
    expect(await readFile(path)).toEqual(retained);
    const retried = await stat(path, { bigint: true });
    expect({ ino: retried.ino, mtimeNs: retried.mtimeNs }).toEqual({ ino: metadata.ino, mtimeNs: metadata.mtimeNs });

    const second = prepared(2);
    const journal = await persistOperationMonitoringSource(path, worldPath, second);
    expect(journal.originals).toHaveLength(2);
    expect(journal.originals.map((original) => original.bytesBase64)).toEqual([first.bytesBase64, second.bytesBase64]);
    expect(journal.originals[0]).toEqual(initial.originals[0]);
    expect(Object.values(journal.c2Originals)).toEqual(first.c2Originals);
    expect(await readOperationMonitoringJournal(path, worldPath)).toEqual(journal);
    expect(await readdir(dirname(path))).toEqual(['source.json']);
  });

  it('refuses corrupt commitments, changed context, replacement bytes and out-of-order revisions without overwriting', async () => {
    const { path, worldPath } = await fixture();
    const first = prepared();
    await persistOperationMonitoringSource(path, worldPath, first);
    const retained = await readFile(path);
    const changedContext = prepared(2, (source) => {
      source.control.controlVersion++;
    });
    await expectUnchanged(path, retained, persistOperationMonitoringSource(path, worldPath, changedContext));
    const changedCaller = prepared(2);
    changedCaller.identity.tenantId = 'another-tenant';
    changedCaller.key = `simulator:monitoring:${canonicalDigest(changedCaller.identity)}`;
    await expectUnchanged(path, retained, persistOperationMonitoringSource(path, worldPath, changedCaller));
    const replacement = prepared(1, (source) => {
      source.occurredAt = '2026-10-15T14:20:02Z';
    });
    await expectUnchanged(path, retained, persistOperationMonitoringSource(path, worldPath, replacement));
    await expectUnchanged(path, retained, persistOperationMonitoringSource(path, worldPath, prepared(3)));

    const envelope = JSON.parse(retained.toString('utf8')) as { body: string; sha256: string };
    envelope.sha256 = '0'.repeat(64);
    const corrupt = Buffer.from(JSON.stringify(envelope));
    await writeFile(path, corrupt);
    await expect(readOperationMonitoringJournal(path, worldPath)).rejects.toThrow(/commitment/i);
    await expectUnchanged(path, corrupt, persistOperationMonitoringSource(path, worldPath, first));
    await writeFile(path, retained);
    const body = JSON.parse(envelope.body) as { c2Originals: Record<string, { sha256: string }> };
    Object.values(body.c2Originals)[0]!.sha256 = '0'.repeat(64);
    await privateJournal.writeJournalEnvelope(path, body, 8 * 1024 * 1024 + 1024);
    const resealed = await readFile(path);
    await expect(readOperationMonitoringJournal(path, worldPath)).rejects.toThrow(/commitment/i);
    await expectUnchanged(path, resealed, persistOperationMonitoringSource(path, worldPath, first));
    expect(await readdir(dirname(path))).toEqual(['source.json']);
  });

  it('bounds retained revisions and total original bytes while leaving the last valid journal intact', async () => {
    const { directory, path, worldPath } = await fixture();
    for (let revision = 1; revision <= 16; revision++)
      await persistOperationMonitoringSource(path, worldPath, prepared(revision));
    const retained = await readFile(path);
    expect((await readOperationMonitoringJournal(path, worldPath))!.originals).toHaveLength(16);
    await expectUnchanged(path, retained, persistOperationMonitoringSource(path, worldPath, prepared(17)));

    const base = declaredC2Originals[0]!;
    const padded = Array.from({ length: 48 }, (_, index): OperationMonitoringC2Original => {
      const source = JSON.parse(Buffer.from(base.bytesBase64, 'base64').toString('utf8')) as {
        sourceEventId: string;
      };
      source.sourceEventId = `padded-${index}`;
      const json = JSON.stringify(source);
      const bytes = Buffer.from(json + ' '.repeat(64 * 1024 - Buffer.byteLength(json)));
      return {
        sourceId: base.sourceId,
        sourceSessionId: base.sourceSessionId,
        sourceEventId: source.sourceEventId,
        ...bytesOriginal(bytes),
      };
    });
    const oversized = prepared(
      1,
      (source) => {
        source.flights[0]!.declaredC2SourceEventIds = padded.map((original) => original.sourceEventId);
      },
      padded,
    );
    const oversizedPath = join(directory, 'bounded.json');
    await expect(persistOperationMonitoringSource(oversizedPath, worldPath, oversized)).rejects.toThrow(/byte bound/i);
    expect(await readOperationMonitoringJournal(oversizedPath, worldPath)).toBeUndefined();
    const { c2Originals, ...original } = oversized;
    const { sourceRevision: _revision, ...identity } = oversized.identity;
    const oversizedBody = {
      version: 'operation.monitoring-source-journal.1',
      identityDigest: canonicalDigest(identity),
      originals: [{ ...original, c2OriginalDigests: c2Originals.map(canonicalDigest) }],
      c2Originals: Object.fromEntries(c2Originals.map((entry) => [canonicalDigest(entry), entry])),
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedBody))).toBeGreaterThan(4 * 1024 * 1024);
    await privateJournal.writeJournalEnvelope(oversizedPath, oversizedBody, 8 * 1024 * 1024 + 1024);
    const oversizedFile = await readFile(oversizedPath);
    await expect(readOperationMonitoringJournal(oversizedPath, worldPath)).rejects.toThrow(/commitment/i);
    await expectUnchanged(
      oversizedPath,
      oversizedFile,
      persistOperationMonitoringSource(oversizedPath, worldPath, prepared()),
    );
    expect(await readFile(path)).toEqual(retained);
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['monitoring', 'world.json']));
    expect((await readdir(directory)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
    // Slow file work: generous so a busy machine does not fail it.
  }, 60_000);

  it('guards world transaction aliases, future paths beneath symlinked owned trees, and hardlinked world or lock files', async () => {
    const { directory, worldPath } = await fixture();
    const worldBytes = await readFile(worldPath);
    const first = prepared();
    const refused = async (path: string) => {
      await expect(readOperationMonitoringJournal(path, worldPath)).rejects.toThrow(/separate|alias|outside/i);
      await expect(persistOperationMonitoringSource(path, worldPath, first)).rejects.toThrow(/separate|alias|outside/i);
      expect(await readFile(worldPath)).toEqual(worldBytes);
    };
    for (const path of [worldPath, `${worldPath}.pending`, `${worldPath}.lock`]) await refused(path);
    for (const suffix of ['history', 'delivery', 'broker']) {
      const owned = join(directory, `retained-${suffix}`);
      await mkdir(owned);
      await symlink(owned, `${worldPath}.${suffix}`);
      const alias = join(directory, `alias-${suffix}`);
      await symlink(owned, alias);
      await refused(join(alias, 'future', 'monitoring.json'));
      expect(await readdir(owned)).toEqual([]);
    }
    const hardlink = join(directory, 'world-alias.json');
    await link(worldPath, hardlink);
    await refused(hardlink);
    const lockAlias = join(directory, 'safe.json');
    await link(worldPath, `${lockAlias}.lock`);
    await refused(lockAlias);
    expect(await readFile(`${lockAlias}.lock`)).toEqual(worldBytes);
    expect(await readFile(hardlink)).toEqual(worldBytes);
  });
});
