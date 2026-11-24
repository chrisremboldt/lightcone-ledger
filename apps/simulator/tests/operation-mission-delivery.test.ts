import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digest, type MissionAdapterResult, type PreparedMissionInput } from '@ledger/adapters';
import type { Artifact, Input, Upload, UploadCreate } from '@ledger/contracts';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import { advanceOperation, createOperation } from '../../../packages/simulation-models/src/operation.js';
import { OperationDelivery, prepareWorldFact, type PreparedWorldFact } from '../src/operation-delivery.js';
import { OperationTransport } from '../src/operation-transport.js';
import { readJournalEnvelope, writeJournalEnvelope } from '../src/private-journal.js';
import { scenarioConfig } from '../src/scenario.js';

const directories: string[] = [];
const transports: OperationTransport[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
interface SavedFact extends PreparedWorldFact {
  submission?: PreparedMissionInput;
  accepted?: MissionAdapterResult;
}
interface SavedJournal {
  version: 1;
  binding: string;
  principalId?: string;
  flightId?: string;
  facts: Record<string, SavedFact>;
}

function revisedMission(
  prepared: PreparedWorldFact,
  revision: number,
  sequence = prepared.fact.sequence + revision * 100,
) {
  const fact = structuredClone(prepared.fact);
  if (fact.kind !== 'mission') throw new Error('Expected mission');
  const shift = (revision - fact.source.sourceRevision) * 60_000;
  const later = (value: string) => new Date(Date.parse(value) + shift).toISOString();
  fact.sequence = sequence;
  fact.at = later(fact.at);
  fact.source.sourceRevision = revision;
  fact.source.occurredAt = later(fact.source.occurredAt);
  fact.source.operatingInterval = {
    start: later(fact.source.operatingInterval.start),
    end: later(fact.source.operatingInterval.end),
  };
  return prepareWorldFact(fact);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-mission-delivery-'));
  directories.push(directory);
  const world = createOperation({
    runId: 'mission-adapter',
    start: '2026-10-15T14:00:00.000Z',
    fleet: { alpha: 1, beta: 1 },
    missionPlan: 'dispatch-plan.1',
  });
  advanceOperation(world, world.now);
  const fact = world.facts.find((entry) => entry.kind === 'mission' && entry.tenant === 'alpha')!;
  if (fact.kind !== 'mission') throw new Error('Expected dispatched mission');
  const prepared = prepareWorldFact(fact);
  const order = world.facts.find((entry) => entry.kind === 'order' && entry.attemptId === fact.attemptId)!;
  if (order.kind !== 'order') throw new Error('Expected originating order');
  const departure = world.facts.find((entry) => entry.kind === 'departure' && entry.attemptId === fact.attemptId)!;
  if (departure.kind !== 'departure') throw new Error('Expected departure');
  const config = { ...scenarioConfig({}), apiUrl: 'http://fake-ledger.invalid', stateDirectory: directory };
  const primaryPath = join(directory, 'delivery', `${digest(fact.attemptId)}.json`);
  const journalPath = join(directory, 'mission', `${digest(fact.attemptId)}.json`);
  const primary = {
    version: 2,
    binding: digest(JSON.stringify({ apiUrl: config.apiUrl, tenant: fact.tenant, attemptId: fact.attemptId })),
    principals: { source: 'world-mission-source' },
    aircraftId: fact.aircraftId,
    primarySessionId: departure.sourceSessionId,
    facts: { [order.sequence]: prepareWorldFact(order) },
    commitments: [],
  };
  await mkdir(join(directory, 'delivery'));
  await writeFile(primaryPath, JSON.stringify(primary));
  const readJournal = async () => (await readJournalEnvelope(journalPath, 2 * 1024 * 1024)) as SavedJournal;
  const state = {
    support: true,
    missionCapability: true,
    grant: true,
    principalId: 'world-mission-source',
    flightVisible: true,
    loseFinalize: false,
    loseInput: false,
    receipt: 'valid' as 'valid' | 'missing' | 'wrong-flight',
    opaqueCallbackAck: false,
    callbacks: 0,
  };
  const calls: string[] = [];
  const uploads = new Map<
    string,
    { id: string; request: UploadCreate; bytes?: Buffer; artifact?: Artifact; finalizeKey?: string }
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
  const missionRequests: { key: string; body: string }[] = [];
  const callbackFacts: PreparedWorldFact[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const request = new URL(String(url));
    const path = request.pathname;
    calls.push(path);
    const key = new Headers(init?.headers).get('idempotency-key') ?? '';
    if (path === '/openapi.json') return Response.json(state.support ? openApiDocument : {});
    if (path === '/v1/me')
      return Response.json({
        principal: {
          id: state.principalId,
          tenantId: 'tenant-alpha',
          revision: 1,
          name: 'Fictional mission source',
          capabilities: ['input:write', 'flight:read', ...(state.missionCapability ? ['mission:write'] : [])],
          commandLinkSources: [],
          missionSources: state.grant ? ['mission-planner'] : [],
        },
      });
    if (path === '/v1/flights') {
      expect(request.searchParams.get('search')).toBe(order.order.order_id);
      expect(request.searchParams.get('limit')).toBe('200');
      return Response.json({
        flights: [
          { id: 'wrong-origin', originationKey: 'another-attempt', aircraft: fact.aircraftId },
          ...(state.flightVisible
            ? [{ id: 'flight-pinned', originationKey: fact.attemptId, aircraft: fact.aircraftId }]
            : []),
        ],
        nextCursor: null,
        meta: { outstandingWork: 0 },
      });
    }
    if (path === '/v1/uploads') {
      const requestBody = JSON.parse(init!.body as string) as UploadCreate;
      let id = uploadKeys.get(key);
      if (!id) {
        id = `upload-${uploads.size}`;
        uploadKeys.set(key, id);
        uploads.set(id, { id, request: requestBody });
      }
      expect(uploads.get(id)!.request).toEqual(requestBody);
      if (String(requestBody.filename).startsWith('mission-')) {
        const retained = await readJournal();
        expect(retained.flightId).toBe('flight-pinned');
        const entry = Object.values(retained.facts).find(
          (entry) =>
            requestBody.filename === `mission-${digest(Buffer.from(entry.bytesBase64, 'base64')).slice(0, 12)}.json`,
        );
        expect(entry).toBeDefined();
        expect(entry!.bytesBase64).toBe(prepareWorldFact(entry!.fact).bytesBase64);
        if (entry!.fact.sequence === fact.sequence) expect(entry!.bytesBase64).toBe(prepared.bytesBase64);
      }
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
        throw new Error('Lost finalized mission upload response');
      }
      return Response.json({ artifact: upload.artifact, meta: {} });
    }
    if (path === '/v1/inputs') {
      const body = init!.body as string;
      const input = JSON.parse(body) as Input;
      if (inputs.has(key)) expect(inputs.get(key)).toEqual(input);
      inputs.set(key, input);
      if (input.kind === 'mission.revision') {
        missionRequests.push({ key, body });
        const entry = Object.values((await readJournal()).facts).find(
          (entry) => entry.fact.kind === 'mission' && entry.fact.source.sourceRevision === input.sourceRevision,
        )!;
        const retained = entry.submission!;
        expect(retained).toMatchObject({
          key,
          principalId: 'world-mission-source',
          bytesBase64: prepareWorldFact(entry.fact).bytesBase64,
        });
        if (entry.fact.sequence === fact.sequence) expect(retained.bytesBase64).toBe(prepared.bytesBase64);
        expect(retained.input).toEqual(input);
        if (state.loseInput) {
          state.loseInput = false;
          throw new Error('Lost accepted mission input response');
        }
        if (state.receipt === 'missing') return Response.json({ meta: {} });
      }
      const suffix = input.kind === 'mission.revision' && input.sourceRevision > 1 ? `-${input.sourceRevision}` : '';
      return Response.json({
        receipt: {
          id: input.kind === 'mission.revision' ? `canonical-mission-receipt${suffix}` : 'ordinary-receipt',
          eventId: input.kind === 'mission.revision' ? `canonical-mission-event${suffix}` : 'ordinary-event',
          status: 'accepted',
          kind: input.kind,
          sourceId: input.sourceId,
          occurredAt: input.occurredAt,
          receivedAt: '2026-10-15T14:00:05.000Z',
          flightId:
            input.kind === 'mission.revision' && state.receipt === 'wrong-flight' ? 'another-flight' : 'flight-pinned',
          artifactId: input.kind === 'mission.revision' ? `canonical-earlier-artifact${suffix}` : input.artifactId,
          linkStatus: 'linked',
          processing: { status: 'pending', attempts: 0 },
          payload: input.payload,
        },
        meta: {},
      });
    }
    throw new Error(`Unexpected mission public request ${path}`);
  };
  let beforeCallback: () => Promise<void> = async () => {};
  const transport: Pick<OperationTransport, 'mission' | 'commandLink' | 'partnerOrder' | 'position'> = {
    async mission<T>(value: PreparedWorldFact, ingest: (raw: Uint8Array) => Promise<T>): Promise<T> {
      state.callbacks++;
      callbackFacts.push(structuredClone(value));
      expect((await readJournal()).facts[value.fact.sequence]).toMatchObject(value);
      await beforeCallback();
      if (state.opaqueCallbackAck) return { receiptId: 'fake-emulator-ack' } as unknown as T;
      return ingest(Buffer.from(value.bytesBase64, 'base64'));
    },
    async commandLink() {
      throw new Error('Unexpected command-link transport');
    },
    async partnerOrder() {
      throw new Error('Unexpected order transport');
    },
    async position() {
      throw new Error('Unexpected MQTT transport');
    },
  };
  return {
    state,
    calls,
    uploads,
    inputs,
    missionRequests,
    callbackFacts,
    prepared,
    departure,
    primary,
    primaryPath,
    journalPath,
    readJournal,
    directory,
    delivery: (apiUrl = config.apiUrl, selectedTransport = transport) =>
      new OperationDelivery({ ...config, apiUrl, transport: selectedTransport }, fetcher),
    blockCallback: (block: () => Promise<void>) => {
      beforeCallback = block;
    },
  };
}

describe('world mission adapter delivery', () => {
  it('persists raw and prepared bytes before writes and recovers the original request after ambiguous upload and intake responses', async () => {
    const f = await fixture();
    const primary = await readFile(f.primaryPath, 'utf8');
    f.state.loseFinalize = true;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('Lost finalized mission upload response');
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]).toMatchObject(f.prepared);
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.submission).toBeUndefined();
    f.state.loseInput = true;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('Lost accepted mission input response');
    const submission = structuredClone((await f.readJournal()).facts[f.prepared.fact.sequence]!.submission!);
    expect(f.uploads.size).toBe(1);
    expect(f.missionRequests).toHaveLength(1);
    f.state.support = false;
    f.state.grant = false;
    f.state.missionCapability = false;
    f.state.flightVisible = false;
    const before = f.calls.length;
    const callbacks = f.state.callbacks;
    expect(await f.delivery().deliver(JSON.parse(JSON.stringify(f.prepared)))).toEqual({
      receiptId: 'canonical-mission-receipt',
    });
    expect(f.calls.slice(before)).toEqual(['/v1/me', '/v1/inputs']);
    expect(f.state.callbacks).toBe(callbacks + 1);
    expect(f.missionRequests[1]).toEqual(f.missionRequests[0]);
    const accepted = (await f.readJournal()).facts[f.prepared.fact.sequence]!;
    expect(accepted.submission).toEqual(submission);
    expect(accepted.accepted).toMatchObject({
      submittedUploadArtifactId: submission.input.artifactId,
      sha256: digest(Buffer.from(f.prepared.bytesBase64, 'base64')),
      receipt: {
        receipt: {
          id: 'canonical-mission-receipt',
          eventId: 'canonical-mission-event',
          artifactId: 'canonical-earlier-artifact',
        },
      },
    });
    expect(accepted.accepted!.receipt.receipt.artifactId).not.toBe(submission.input.artifactId);
    const after = f.calls.length;
    expect(await f.delivery().deliver(f.prepared)).toEqual({ receiptId: 'canonical-mission-receipt' });
    expect(f.calls).toHaveLength(after);
    expect(f.state.callbacks).toBe(callbacks + 1);
    expect(f.uploads.size).toBe(1);
    expect(await readFile(f.primaryPath, 'utf8')).toBe(primary);
    const tampered = await f.readJournal();
    tampered.facts[f.prepared.fact.sequence]!.accepted!.receipt.receipt.flightId = 'another-flight';
    await writeJournalEnvelope(f.journalPath, tampered, 2 * 1024 * 1024);
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow();
    expect(f.calls).toHaveLength(after);
    expect(f.state.callbacks).toBe(callbacks + 1);
  });

  it('recovers an ambiguous older revision before fresh preparation and preserves both immutable submissions', async () => {
    const f = await fixture();
    const second = revisedMission(f.prepared, 2);
    f.state.loseInput = true;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('Lost accepted mission input response');
    const first = structuredClone((await f.readJournal()).facts[f.prepared.fact.sequence]!);
    const firstRequest = structuredClone(f.missionRequests[0]!);
    const uploaded = [...f.uploads.values()][0]!;
    const firstUpload = { ...uploaded, bytes: Buffer.from(uploaded.bytes!) };
    f.state.support = false;
    f.state.grant = false;
    f.state.missionCapability = false;
    f.state.flightVisible = false;
    const before = f.calls.length;
    await expect(f.delivery().deliver(second)).rejects.toMatchObject({ code: 'unsupported_contract' });
    expect(f.missionRequests).toEqual([firstRequest, firstRequest]);
    expect(f.calls.slice(before).filter((path) => path.startsWith('/v1/uploads'))).toEqual([]);
    expect(f.calls.slice(before).indexOf('/v1/inputs')).toBeLessThan(f.calls.slice(before).indexOf('/openapi.json'));
    expect(f.callbackFacts.slice(0, 2)).toEqual([f.prepared, f.prepared]);
    expect(f.uploads.size).toBe(1);
    let journal = await f.readJournal();
    expect(journal.facts[f.prepared.fact.sequence]!.submission).toEqual(first.submission);
    expect(journal.facts[f.prepared.fact.sequence]!.accepted!.submittedUploadArtifactId).toBe(
      first.submission!.input.artifactId,
    );
    expect(journal.facts[second.fact.sequence]!.submission).toBeUndefined();

    f.state.support = true;
    f.state.missionCapability = true;
    await expect(f.delivery().deliver(second)).rejects.toMatchObject({ code: 'source_grant_required' });
    expect(f.missionRequests).toEqual([firstRequest, firstRequest]);
    expect(f.uploads.size).toBe(1);
    f.state.grant = true;
    expect(await f.delivery().deliver(JSON.parse(JSON.stringify(second)))).toEqual({
      receiptId: 'canonical-mission-receipt-2',
    });
    journal = await f.readJournal();
    const acceptedFirst = journal.facts[f.prepared.fact.sequence]!;
    const acceptedSecond = journal.facts[second.fact.sequence]!;
    expect(acceptedFirst.submission).toEqual(first.submission);
    expect([...f.uploads.values()][0]).toEqual(firstUpload);
    expect(acceptedFirst.bytesBase64).toBe(f.prepared.bytesBase64);
    expect(acceptedSecond.bytesBase64).toBe(second.bytesBase64);
    expect(acceptedSecond.submission!.input.sourceRevision).toBe(2);
    expect(acceptedSecond.submission!.input.subject).toEqual(first.submission!.input.subject);
    expect(acceptedSecond.submission!.principalId).toBe(first.submission!.principalId);
    expect(acceptedSecond.submission!.key).not.toBe(first.submission!.key);
    expect(acceptedSecond.submission!.input.artifactId).not.toBe(first.submission!.input.artifactId);
    expect(acceptedSecond.accepted).toMatchObject({
      submittedUploadArtifactId: acceptedSecond.submission!.input.artifactId,
      sha256: digest(Buffer.from(second.bytesBase64, 'base64')),
      receipt: { receipt: { id: 'canonical-mission-receipt-2', artifactId: 'canonical-earlier-artifact-2' } },
    });
    expect(f.uploads.size).toBe(2);
    expect(f.missionRequests.slice(0, 2)).toEqual([firstRequest, firstRequest]);
    expect(f.missionRequests).toHaveLength(3);
    const after = f.calls.length;
    const callbacks = f.state.callbacks;
    expect(await f.delivery().deliver(f.prepared)).toEqual({ receiptId: 'canonical-mission-receipt' });
    expect(await f.delivery().deliver(second)).toEqual({ receiptId: 'canonical-mission-receipt-2' });
    expect(f.calls).toHaveLength(after);
    expect(f.state.callbacks).toBe(callbacks);
  });

  it('rejects reordered or conflicting revisions and serializes newer versions without overwriting a pending checkpoint', async () => {
    const f = await fixture();
    await f.delivery().deliver(f.prepared);
    const original = structuredClone((await f.readJournal()).facts[f.prepared.fact.sequence]!);
    const before = f.calls.length;
    const duplicateRevision = revisedMission(f.prepared, 1);
    await expect(f.delivery().deliver(duplicateRevision)).rejects.toThrow();
    const changedRevision = structuredClone(duplicateRevision.fact);
    if (changedRevision.kind !== 'mission') throw new Error('Expected mission');
    changedRevision.source.route.geometry.coordinates[1]![0] += 0.0001;
    await expect(f.delivery().deliver(prepareWorldFact(changedRevision))).rejects.toThrow();
    expect(f.calls).toHaveLength(before);
    expect((await f.readJournal()).facts).toEqual({ [f.prepared.fact.sequence]: original });

    const third = revisedMission(f.prepared, 3);
    const fourth = revisedMission(f.prepared, 4);
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
    f.state.loseInput = true;
    const thirdRejected = expect(delivery.deliver(third)).rejects.toThrow('Lost accepted mission input response');
    await callbackEntered;
    const fourthPending = delivery.deliver(fourth);
    try {
      const blocked = await f.readJournal();
      expect(blocked.facts[third.fact.sequence]).toMatchObject(third);
      expect(blocked.facts[fourth.fact.sequence]).toBeUndefined();
      expect(f.uploads.size).toBe(1);
    } finally {
      release();
    }
    await thirdRejected;
    expect(await fourthPending).toEqual({ receiptId: 'canonical-mission-receipt-4' });
    const journal = await f.readJournal();
    const thirdSaved = journal.facts[third.fact.sequence]!;
    const fourthSaved = journal.facts[fourth.fact.sequence]!;
    expect(journal.facts[f.prepared.fact.sequence]).toEqual(original);
    expect(thirdSaved).toMatchObject(third);
    expect(fourthSaved).toMatchObject(fourth);
    expect(thirdSaved.submission!.input.sourceRevision).toBe(3);
    expect(fourthSaved.submission!.input.sourceRevision).toBe(4);
    expect(thirdSaved.submission!.key).not.toBe(fourthSaved.submission!.key);
    expect(thirdSaved.submission!.input.artifactId).not.toBe(fourthSaved.submission!.input.artifactId);
    expect(thirdSaved.accepted!.submittedUploadArtifactId).toBe(thirdSaved.submission!.input.artifactId);
    expect(fourthSaved.accepted!.submittedUploadArtifactId).toBe(fourthSaved.submission!.input.artifactId);
    expect(f.missionRequests.map((request) => JSON.parse(request.body).sourceRevision)).toEqual([1, 3, 3, 4]);
    expect(f.missionRequests[2]).toEqual(f.missionRequests[1]);
    expect(f.callbackFacts).toEqual([f.prepared, third, third, fourth]);
    expect(f.uploads.size).toBe(3);

    const after = f.calls.length;
    await expect(f.delivery().deliver(revisedMission(f.prepared, 2))).rejects.toThrow();
    await expect(f.delivery().deliver(revisedMission(f.prepared, 4))).resolves.toEqual({
      receiptId: 'canonical-mission-receipt-4',
    });
    expect(f.calls).toHaveLength(after);
    expect((await f.readJournal()).facts).toEqual(journal.facts);
  });

  it('retains unsupported or ungranted plans and lets same-attempt ordinary evidence pass a blocked mission callback', async () => {
    const f = await fixture();
    f.state.support = false;
    await expect(f.delivery().deliver(f.prepared)).rejects.toMatchObject({ code: 'unsupported_contract' });
    expect(f.uploads.size).toBe(0);
    f.state.support = true;
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
    const pending = expect(delivery.deliver(f.prepared)).rejects.toMatchObject({ code: 'source_grant_required' });
    await callbackEntered;
    try {
      await delivery.deliver(prepareWorldFact(f.departure));
    } finally {
      release();
    }
    await pending;
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.submission).toBeUndefined();
    expect(f.missionRequests).toEqual([]);
    f.blockCallback(async () => {});
    f.state.grant = true;
    expect(await f.delivery().deliver(f.prepared)).toEqual({ receiptId: 'canonical-mission-receipt' });
    expect(f.inputs.size).toBe(2);
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.bytesBase64).toBe(f.prepared.bytesBase64);
  });

  it('pins the exact originating flight and refuses changed source bindings, retained geometry, principal or prepared flight', async () => {
    const f = await fixture();
    f.state.flightVisible = false;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('pending its originated flight');
    expect(f.uploads.size).toBe(0);
    await writeFile(f.primaryPath, JSON.stringify({ ...f.primary, aircraftId: 'another-aircraft' }));
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('retained originating flight binding');
    expect(f.uploads.size).toBe(0);
    await writeFile(f.primaryPath, JSON.stringify(f.primary));
    f.state.flightVisible = true;
    f.state.loseInput = true;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('Lost accepted mission input response');
    const saved = await f.readJournal();
    expect(saved.flightId).toBe('flight-pinned');
    const before = f.calls.length;
    await expect(f.delivery('http://another-ledger.invalid').deliver(f.prepared)).rejects.toThrow(
      'retained source binding',
    );
    const changed = structuredClone(f.prepared.fact);
    if (changed.kind !== 'mission') throw new Error('Expected mission');
    changed.source.route.geometry.coordinates[1]![0] += 0.0001;
    await expect(f.delivery().deliver(prepareWorldFact(changed))).rejects.toThrow('cannot change on retry');
    const retargeted = structuredClone(f.prepared.fact);
    if (retargeted.kind !== 'mission') throw new Error('Expected mission');
    retargeted.source.sourceMissionId += ':different';
    await expect(f.delivery().deliver(prepareWorldFact(retargeted))).rejects.toThrow('retained source binding');
    expect(f.calls).toHaveLength(before);
    await writeJournalEnvelope(f.journalPath, { ...saved, flightId: 'another-flight' }, 2 * 1024 * 1024);
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('pinned source, revision or flight');
    await writeJournalEnvelope(f.journalPath, saved, 2 * 1024 * 1024);
    f.state.principalId = 'replacement-source';
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('retained principal or tenant');
    expect(f.missionRequests).toHaveLength(1);
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.accepted).toBeUndefined();
  });

  it('does not acknowledge an emulator-only response or a missing or mismatched canonical receipt', async () => {
    const f = await fixture();
    f.state.opaqueCallbackAck = true;
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('has not confirmed canonical acceptance');
    expect(f.uploads.size).toBe(0);
    expect(f.missionRequests).toEqual([]);
    f.state.opaqueCallbackAck = false;
    f.state.receipt = 'missing';
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('receipt does not match');
    const retained = structuredClone((await f.readJournal()).facts[f.prepared.fact.sequence]!.submission!);
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.accepted).toBeUndefined();
    f.state.receipt = 'wrong-flight';
    await expect(f.delivery().deliver(f.prepared)).rejects.toThrow('receipt does not match');
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.accepted).toBeUndefined();
    expect((await f.readJournal()).facts[f.prepared.fact.sequence]!.submission).toEqual(retained);
    f.state.receipt = 'valid';
    expect(await f.delivery().deliver(f.prepared)).toEqual({ receiptId: 'canonical-mission-receipt' });
    expect(f.uploads.size).toBe(1);
    expect(
      f.missionRequests.every(
        (request) => request.key === retained.key && request.body === JSON.stringify(retained.input),
      ),
    ).toBe(true);
  });

  it('joins the real localhost transport callback to the adapter and retains the canonical public receipt', async () => {
    const f = await fixture();
    const observed: Buffer[] = [];
    const errors: unknown[] = [];
    const emulator = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/_simulation/mission/deliver');
        expect(request.headers['x-emulator-admin']).toBe('mission-join-admin');
        expect(request.headers['x-simulator-lease']).toBe('mission-join-lease');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          callbackUrl: string;
          bytesBase64: string;
        };
        expect(envelope.bytesBase64).toBe(f.prepared.bytesBase64);
        const bytes = Buffer.from(envelope.bytesBase64, 'base64');
        observed.push(bytes);
        expect((await f.readJournal()).facts[f.prepared.fact.sequence]).toMatchObject(f.prepared);
        const callback = await fetch(envelope.callbackUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-partner-key': 'mission-join-partner' },
          body: new Uint8Array(bytes),
        });
        expect(callback.status).toBe(200);
        await callback.arrayBuffer();
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":200}');
      } catch (error) {
        errors.push(error);
        response.writeHead(500, { 'content-type': 'application/json' }).end('{"status":500}');
      }
    });
    servers.push(emulator);
    await new Promise<void>((resolve) => emulator.listen(0, '127.0.0.1', resolve));
    const transport = new OperationTransport({
      emulatorUrl: `http://127.0.0.1:${(emulator.address() as { port: number }).port}`,
      adminKey: 'mission-join-admin',
      partnerKey: 'mission-join-partner',
      callbackHost: '127.0.0.1',
      callbackPort: 0,
      mqttUrl: 'mqtt://unused.invalid',
      bindings: {},
      stateDirectory: join(f.directory, 'transport'),
      controlHeaders: () => ({ 'x-simulator-lease': 'mission-join-lease' }),
    });
    transports.push(transport);
    await transport.start();
    expect(await f.delivery(undefined, transport).deliver(f.prepared)).toEqual({
      receiptId: 'canonical-mission-receipt',
    });
    expect(observed).toEqual([Buffer.from(f.prepared.bytesBase64, 'base64')]);
    expect(errors).toEqual([]);
    const retained = (await f.readJournal()).facts[f.prepared.fact.sequence]!;
    expect(retained.submission!.input.subject).toEqual({ flightId: 'flight-pinned' });
    expect(retained.accepted!.submittedUploadArtifactId).toBe(retained.submission!.input.artifactId);
    expect(retained.accepted!.receipt.receipt.artifactId).toBe('canonical-earlier-artifact');
    expect(f.missionRequests).toHaveLength(1);
  });
});
