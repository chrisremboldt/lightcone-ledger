import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '@ledger/adapters';
import type { Artifact, Input, Upload, UploadCreate } from '@ledger/contracts';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import {
  advanceOperation,
  createOperation,
  operationCapacityPreset,
} from '../../../packages/simulation-models/src/operation.js';
import { OperationDelivery, prepareWorldFact, type PreparedWorldFact } from '../src/operation-delivery.js';
import type { OperationTransport } from '../src/operation-transport.js';
import { readJournalEnvelope } from '../src/private-journal.js';
import { scenarioConfig } from '../src/scenario.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
interface SavedFact extends PreparedWorldFact {
  accepted?: { receiptId: string; artifactId: string };
}
interface SavedJournal {
  principalId: string;
  flightId: string;
  facts: Record<string, SavedFact>;
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-command-link-journal-'));
  directories.push(directory);
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId: 'wire-journal',
    start: '2026-10-15T14:00:00.000Z',
    commandLinkEpisode: 'canal-market-relay.1',
  });
  advanceOperation(world, world.now + 121_000);
  const fact = world.facts.find((entry) => entry.kind === 'command-link' && entry.tenant === 'alpha')!;
  const reports = world.facts
    .filter((entry) => entry.kind === 'command-link' && entry.attemptId === fact.attemptId)
    .map(prepareWorldFact);
  const order = world.facts.find((entry) => entry.kind === 'order' && entry.attemptId === fact.attemptId)!;
  const departure = world.facts.find((entry) => entry.kind === 'departure' && entry.attemptId === fact.attemptId)!;
  const config = { ...scenarioConfig({}), apiUrl: 'http://fake-ledger.invalid', stateDirectory: directory };
  const primaryPath = join(directory, 'delivery', `${digest(fact.attemptId)}.json`);
  const journalPath = join(directory, 'command-link', `${digest(fact.attemptId)}.json`);
  await mkdir(join(directory, 'delivery'));
  await writeFile(
    primaryPath,
    JSON.stringify({
      version: 2,
      binding: digest(JSON.stringify({ apiUrl: config.apiUrl, tenant: fact.tenant, attemptId: fact.attemptId })),
      principals: { source: 'world-source' },
      aircraftId: fact.aircraftId,
      primarySessionId: departure.sourceSessionId,
      flightId: 'flight-pinned',
      facts: { [order.sequence]: prepareWorldFact(order) },
      commitments: [],
    }),
  );
  const state = { grant: true, loseFinalize: false, loseInput: false, principalId: 'world-source' };
  const calls: string[] = [];
  const uploads = new Map<
    string,
    { id: string; bytes?: Buffer; request: UploadCreate; artifact?: Artifact; finalizeKey?: string }
  >();
  const uploadKeys = new Map<string, string>();
  const uploadResponse = (id: string) => {
    const retained = uploads.get(id)!;
    const upload: Upload = {
      id,
      status: retained.artifact ? 'finalized' : retained.bytes ? 'stored' : 'pending',
      byteLength: retained.bytes?.length ?? retained.request.byteLength,
      contentType: retained.request.contentType,
      ...(retained.bytes ? { sha256: digest(retained.bytes) } : {}),
      ...(retained.artifact ? { artifactId: retained.artifact.id } : {}),
    };
    return Response.json({ upload, meta: {} });
  };
  const inputs = new Map<string, Input>();
  const readJournal = async () => (await readJournalEnvelope(journalPath, 2 * 1024 * 1024)) as SavedJournal;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    const key = new Headers(init?.headers).get('idempotency-key') ?? '';
    if (path === '/openapi.json') return Response.json(openApiDocument);
    if (path === '/v1/me')
      return Response.json({
        principal: { id: state.principalId, tenantId: 'tenant-alpha', capabilities: ['input:write', 'flight:read'] },
      });
    if (path === '/v1/uploads') {
      const request = JSON.parse(init!.body as string) as UploadCreate;
      let id = uploadKeys.get(key);
      if (!id) {
        id = `upload-${uploads.size}`;
        uploadKeys.set(key, id);
        uploads.set(id, { id, request });
      }
      expect(uploads.get(id)!.request).toEqual(request);
      return uploadResponse(id);
    }
    const uploadMatch = path.match(/^\/v1\/uploads\/([^/]+)\/(content|finalize)$/);
    if (uploadMatch) {
      const upload = uploads.get(uploadMatch[1]!)!;
      if (uploadMatch[2] === 'content') {
        const bytes = Buffer.from(init!.body as Uint8Array);
        if (upload.bytes) expect(bytes).toEqual(upload.bytes);
        expect(bytes.length).toBe(upload.request.byteLength);
        upload.bytes = bytes;
        return uploadResponse(upload.id);
      }
      if (upload.finalizeKey) expect(key).toBe(upload.finalizeKey);
      upload.finalizeKey = key;
      expect(upload.bytes).toBeDefined();
      upload.artifact ??= {
        id: `artifact-${upload.id}`,
        uploadId: upload.id,
        sha256: digest(upload.bytes!),
        byteLength: upload.bytes!.length,
        contentType: upload.request.contentType,
        key: `uploads/${upload.id}`,
      };
      if (state.loseFinalize) {
        state.loseFinalize = false;
        throw new Error('Lost finalized upload response');
      }
      return Response.json({ artifact: upload.artifact, meta: {} });
    }
    if (path === '/v1/inputs') {
      const input = JSON.parse(init!.body as string) as Input;
      if (input.kind === 'observation' && !state.grant)
        return Response.json(
          { error: { code: 'observation_grant_required', message: 'No grant for this source and type' } },
          { status: 403 },
        );
      if (inputs.has(key)) expect(inputs.get(key)).toEqual(input);
      inputs.set(key, input);
      if (state.loseInput && input.kind === 'observation') {
        state.loseInput = false;
        throw new Error('Lost accepted input response');
      }
      return Response.json({
        receipt: {
          id: `receipt-${key}`,
          eventId: `canonical-event-${key}`,
          kind: input.kind,
          sourceId: input.sourceId,
          flightId: 'flight-pinned',
          linkStatus: 'linked',
          artifactId:
            input.kind === 'observation'
              ? (input.payload as { originalArtifactId: string }).originalArtifactId
              : input.artifactId,
          occurredAt: input.occurredAt,
          payload: input.payload,
        },
        meta: {},
      });
    }
    throw new Error(`Unexpected fake public request ${path}`);
  };
  let beforeCallback: () => Promise<void> = async () => {};
  const transport: Pick<OperationTransport, 'commandLink' | 'partnerOrder' | 'position'> = {
    async commandLink<T>(prepared: PreparedWorldFact, ingest: (raw: Uint8Array) => Promise<T>): Promise<T> {
      await beforeCallback();
      return ingest(Buffer.from(prepared.bytesBase64, 'base64'));
    },
    async partnerOrder() {
      throw new Error('Unexpected order transport');
    },
    async position() {
      throw new Error('Unexpected position transport');
    },
  };
  const delivery = () => new OperationDelivery({ ...config, transport }, fetcher);
  return {
    state,
    calls,
    uploads,
    inputs,
    reports,
    departure,
    primaryPath,
    journalPath,
    readJournal,
    delivery,
    blockCallback: (block: () => Promise<void>) => {
      beforeCallback = block;
    },
  };
}

describe('durable world command-link submission', () => {
  it('retries a lost upload or receipt with identical bytes and keys, and keeps the confirmed receipt', async () => {
    const f = await fixture();
    const primary = await readFile(f.primaryPath, 'utf8');
    f.state.loseFinalize = true;
    await expect(f.delivery().deliver(f.reports[0]!)).rejects.toThrow('Lost finalized upload response');
    const raw = (await f.readJournal()).facts[f.reports[0]!.fact.sequence]!;
    expect(raw.bytesBase64).toBe(f.reports[0]!.bytesBase64);
    expect(raw.accepted).toBeUndefined();
    expect(f.inputs.size).toBe(0);
    f.state.loseInput = true;
    await expect(f.delivery().deliver(f.reports[0]!)).rejects.toThrow('Lost accepted input response');
    expect(f.uploads.size).toBe(1);
    expect(f.inputs.size).toBe(1);
    const result = await f.delivery().deliver(JSON.parse(JSON.stringify(f.reports[0]!)));
    // The replay reused the upload and the observation key: Ledger saw one of each.
    expect(f.uploads.size).toBe(1);
    expect(f.inputs.size).toBe(1);
    const [key, input] = [...f.inputs.entries()][0]!;
    expect(input).toMatchObject({ kind: 'observation', sourceId: f.reports[0]!.fact.sourceId });
    expect((input.payload as { type: string; subject: unknown }).type).toBe('link.status');
    expect((input.payload as { subject: unknown }).subject).toEqual({
      kind: 'flight',
      id: 'flight-pinned',
      scope: 'ledger',
    });
    const accepted = (await f.readJournal()).facts[f.reports[0]!.fact.sequence]!;
    expect(accepted.accepted).toEqual({ receiptId: `receipt-${key}`, artifactId: 'artifact-upload-0' });
    expect(result).toEqual({ receiptId: `receipt-${key}` });
    const after = f.calls.length;
    expect(await f.delivery().deliver(f.reports[0]!)).toEqual(result);
    expect(f.calls.length).toBe(after);
    expect(await readFile(f.primaryPath, 'utf8')).toBe(primary);
  });

  it('leaves a refused report retained, allows ordinary delivery and later drains the original reports', async () => {
    const f = await fixture();
    f.state.grant = false;
    let entered!: () => void;
    let release!: () => void;
    const callbackEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const callbackRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.blockCallback(async () => {
      entered();
      await callbackRelease;
    });
    const delivery = f.delivery();
    const pending = expect(delivery.deliver(f.reports[0]!)).rejects.toMatchObject({
      code: 'observation_grant_required',
    });
    await callbackEntered;
    await delivery.deliver(prepareWorldFact(f.departure));
    release();
    await pending;
    expect(f.inputs.size).toBe(1);
    expect((await f.readJournal()).facts[f.reports[0]!.fact.sequence]!.accepted).toBeUndefined();
    f.blockCallback(async () => {});
    f.state.grant = true;
    for (const report of f.reports) await f.delivery().deliver(report);
    expect(Object.values((await f.readJournal()).facts).every((entry) => entry.accepted)).toBe(true);
    expect(f.inputs.size).toBe(3);
    const primary = JSON.parse(await readFile(f.primaryPath, 'utf8'));
    expect(primary.primarySessionId).toBe(f.departure.sourceSessionId);
    expect(primary.primarySessionId).not.toBe(f.reports[0]!.fact.sourceSessionId);
    f.state.principalId = 'replacement-source';
    const changed = structuredClone(f.reports[1]!);
    changed.fact.sequence += 1;
    await expect(f.delivery().deliver(changed)).rejects.toThrow('changed its retained source identity');
  });

  it('refuses a journal kept by the retired command-link intake', async () => {
    const f = await fixture();
    await mkdir(join(f.journalPath, '..'), { recursive: true });
    const body = JSON.stringify({ version: 1, binding: 'retired', facts: {} });
    await writeFile(f.journalPath, JSON.stringify({ version: 1, body, sha256: digest(body) }));
    await expect(f.delivery().deliver(f.reports[0]!)).rejects.toThrow('retired command-link intake');
  });
});
