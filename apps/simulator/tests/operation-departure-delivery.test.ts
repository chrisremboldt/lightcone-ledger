import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Input, TelemetrySegment, Upload, UploadCreate } from '@ledger/contracts';
import { digest } from '@ledger/adapters';
import { canonicalDigest } from '@ledger/integrity';
import { missionDeparturePermit } from '../../../packages/contracts/fixtures/demo/v1/mission-release.js';
import {
  advanceOperation,
  allocateOperationDeparture,
  consumeOperationDeparture,
  createOperation,
  operationCapacityPreset,
  operationReservationFit,
  reviseOperationReservation,
} from '../../../packages/simulation-models/src/operation.js';
import { OperationDelivery, prepareWorldFact } from '../src/operation-delivery.js';
import { departureDeliveryChannel, ordinaryDeliveryPending } from '../src/operation-delivery-policy.js';
import { initialOperationCheckpoint, OperationStore, readOperationCheckpoint } from '../src/operation-state.js';
import { scenarioConfig } from '../src/scenario.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const iso = (at: number) => new Date(at).toISOString();

function departedWorld() {
  const world = createOperation({
    ...operationCapacityPreset('illustrative-25.1'),
    runId: 'departure-delivery',
    start: '2026-10-15T14:00:00.000Z',
    fleet: { alpha: 1, beta: 1 },
    predeparture: { version: 'reserve-await-release.1', tenant: 'alpha' },
    incident: 'landing-disagreement',
    sampleIntervalMs: 30_000,
  });
  advanceOperation(world, world.now + 60_000);
  const held = world.reservations![0]!;
  reviseOperationReservation(world, held.id, {
    sourceRevision: 2,
    route: structuredClone(held.plan.route),
    operatingInterval: { start: iso(world.now), end: held.order.schedule.end },
  });
  const allocation = allocateOperationDeparture(world, {
    id: 'exclusive-departure-pad',
    reservationId: held.id,
    flightId: 'exact-released-flight',
    departureAttemptId: 'explicit-departure-attempt',
    mission: {
      missionId: 'released-mission',
      sourceRevision: held.plan.sourceRevision,
      eventId: 'released-mission-revision',
      contentDigest: 'a'.repeat(64),
      recordDigest: 'b'.repeat(64),
    },
    release: { id: 'exact-release', digest: 'c'.repeat(64) },
    durationMs: 90_000,
  });
  const request = {
    kind: 'mission.departure-authorize' as const,
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    departureAttemptId: allocation.departureAttemptId,
    allocation: { id: allocation.id, digest: canonicalDigest(allocation) },
    expectedPrincipalRevision: 3,
  };
  const permit = {
    ...structuredClone(missionDeparturePermit),
    flightId: allocation.flightId,
    aircraftId: allocation.aircraftId,
    release: allocation.release,
    mission: allocation.mission,
    departureAttemptId: allocation.departureAttemptId,
    allocation: request.allocation,
    authorizedAt: iso(world.now),
    validUntil: iso(world.now + 30_000),
    actor: {
      ...structuredClone(missionDeparturePermit.actor),
      scope: { kind: 'flight' as const, id: allocation.flightId },
    },
  };
  const fit = operationReservationFit(world, held.id, { marginMs: 10_000 });
  if (fit.status !== 'fits') throw new Error(fit.reason);
  const permitDigest = canonicalDigest(permit);
  const departure = consumeOperationDeparture(world, {
    allocation,
    caller: {
      apiUrl: 'http://ledger.example',
      tenantId: 'tenant-alpha',
      principalId: permit.actor.id,
      planDigest: 'd'.repeat(64),
      requestKey: 'original-departure-key',
      payloadSha256: 'e'.repeat(64),
    },
    request,
    requestBytes: JSON.stringify(request),
    permit,
    permitDigest,
    fit: {
      version: 'mission.departure-fit.1',
      permit: { id: permit.id, digest: permitDigest },
      mission: allocation.mission,
      aircraftId: allocation.aircraftId,
      evaluatedAt: iso(world.now),
      remainingDurationMs: fit.nominalDurationMs!,
      holdAllowanceMs: fit.holdAllowanceMs!,
      marginMs: 10_000,
      requiredCompletionAt: fit.requiredCompletionAt!,
    },
  });
  const attempt = world.attempts.find((entry) => entry.id === departure.attemptId)!;
  advanceOperation(world, Date.parse(attempt.landing) + 90_000);
  const prepared = world.facts
    .filter((fact) => fact.attemptId === departure.attemptId && ordinaryDeliveryPending(fact))
    .map(prepareWorldFact);
  const orders = prepared.filter((entry) => entry.fact.kind === 'order');
  const observations = prepared.filter((entry) => entry.fact.kind !== 'order');
  world.facts = [];
  return { world, departure, orders, observations };
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ledger-departure-delivery-'));
  directories.push(path);
  return path;
}

describe('committed departure evidence delivery', () => {
  it('orders each retained channel independently across restart while preserving legacy head rules', async () => {
    const path = join(await directory(), 'world.json');
    const f = departedWorld();
    const state = initialOperationCheckpoint(f.world, { mode: 'live', wallAt: f.world.now, paused: false });
    state.pending[f.departure.attemptId] = [...f.orders, ...f.observations];
    let store = new OperationStore(path, state);
    const native = f.observations.filter((entry) => departureDeliveryChannel(f.world, entry.fact) === 'native');
    const telemetry = f.observations.filter((entry) => entry.fact.kind === 'position');
    expect(native.map((entry) => entry.fact.kind)).toEqual(['departure', 'landing', 'landing-report']);
    expect(telemetry.length).toBeGreaterThan(1);
    expect(store.pendingHeads()).toEqual([f.orders[0], native[0], telemetry[0]]);
    expect(store.deliveryKey(native[0]!)).not.toBe(store.deliveryKey(telemetry[0]!));
    await expect(store.accept(native[1]!, 'overtaking-landing')).rejects.toThrow('pending delivery head');
    await expect(store.accept(telemetry[1]!, 'overtaking-position')).rejects.toThrow('pending delivery head');
    await store.accept(telemetry[0]!, 'first-position');
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    expect(store.pendingHeads()).toEqual([f.orders[0], native[0], telemetry[1]]);
    for (const entry of telemetry.slice(1)) await store.accept(entry, `position-${entry.fact.sequence}`);
    for (const entry of native) await store.accept(entry, `native-${entry.fact.sequence}`);
    expect(store.state.pending[f.departure.attemptId]).toEqual(f.orders);
    for (const entry of f.orders) await store.accept(entry, `order-${entry.fact.sequence}`);
    expect(store.state.pending).toEqual({});

    const legacy = structuredClone(state);
    delete legacy.world.departures;
    legacy.pending = { [f.departure.attemptId]: f.observations };
    const old = new OperationStore(join(await directory(), 'old.json'), legacy);
    expect(old.pendingHeads()).toEqual([native[0]]);
    expect(old.deliveryKey(native[0]!)).toBe(f.departure.attemptId);
    expect(old.deliveryKey(telemetry[0]!)).toBe(f.departure.attemptId);
    await expect(old.accept(telemetry[0]!, 'legacy-overtake')).rejects.toThrow('pending delivery head');
  });

  it('delivers exact ordered telemetry despite a native failure using the committed public flight without lookup', async () => {
    const root = await directory();
    const f = departedWorld();
    const state = initialOperationCheckpoint(f.world, { mode: 'live', wallAt: f.world.now, paused: false });
    state.pending[f.departure.attemptId] = f.observations;
    const store = new OperationStore(join(root, 'world.json'), state);
    const uploads = new Map<string, Uint8Array>();
    const uploadIds = new Map<string, string>();
    const uploadRecords = new Map<string, Upload>();
    const inputs = new Map<string, { body: Input; receiptId: string }>();
    const nativeRequests: Array<{ body: Input; key: string }> = [];
    let nativeUnavailable = true;
    const config = {
      ...scenarioConfig({}),
      stateDirectory: root,
      departureBinding: () => ({
        flightId: f.departure.flightId,
        tenantId: f.departure.caller.tenantId,
        aircraftId: f.departure.aircraftId,
        sourceSessionId: f.departure.sourceSessionId,
      }),
    };
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      const principal = headers.get('authorization')!.replace('Bearer ', '');
      const key = headers.get('idempotency-key') ?? '';
      if (path === '/v1/me') return Response.json({ principal: { id: principal, tenantId: 'tenant-alpha' } });
      if (path === '/v1/uploads') {
        const identity = `${principal}:${key}`;
        const body = JSON.parse(init!.body as string) as UploadCreate;
        if (!uploadIds.has(identity)) {
          const id = `artifact-${uploadIds.size}`;
          uploadIds.set(identity, id);
          uploadRecords.set(id, { id, status: 'pending', contentType: body.contentType, byteLength: body.byteLength });
        }
        const upload = uploadRecords.get(uploadIds.get(identity)!)!;
        expect(upload).toMatchObject({ contentType: body.contentType, byteLength: body.byteLength });
        return Response.json({ upload });
      }
      const content = path.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (content) {
        const bytes = Uint8Array.from(init!.body as Uint8Array);
        if (uploads.has(content[1]!)) expect(bytes).toEqual(uploads.get(content[1]!));
        uploads.set(content[1]!, bytes);
        const upload = uploadRecords.get(content[1]!)!;
        expect(bytes.byteLength).toBe(upload.byteLength);
        upload.status = 'stored';
        upload.sha256 = digest(bytes);
        return Response.json({ upload });
      }
      const finalize = path.match(/^\/v1\/uploads\/([^/]+)\/finalize$/);
      if (finalize) {
        const upload = uploadRecords.get(finalize[1]!)!;
        upload.status = 'finalized';
        upload.artifactId = upload.id;
        return Response.json({
          artifact: {
            id: upload.artifactId,
            uploadId: upload.id,
            sha256: upload.sha256,
            byteLength: upload.byteLength,
            contentType: upload.contentType,
            key: `${upload.id}/content`,
          },
        });
      }
      if (path === '/v1/inputs') {
        const body = JSON.parse(init!.body as string) as Input;
        expect(body.subject).toEqual({ flightId: f.departure.flightId });
        if (body.kind === 'flight.observation') {
          nativeRequests.push({ body, key });
          if (nativeUnavailable) throw new Error('Injected native outage');
        }
        const identity = `${principal}:${key}`;
        const previous = inputs.get(identity);
        if (previous) expect(body).toEqual(previous.body);
        const accepted = previous ?? { body, receiptId: `receipt-${inputs.size}` };
        inputs.set(identity, accepted);
        return Response.json({ receipt: { id: accepted.receiptId, processing: { status: 'pending' } } });
      }
      throw new Error(`Unexpected public request ${path}`);
    };
    let delivery = new OperationDelivery(config, fetcher);
    const native = f.observations.find((entry) => entry.fact.kind === 'departure')!;
    const positions = f.observations.filter((entry) => entry.fact.kind === 'position').slice(0, 2);
    const originalBytes = positions.map((entry) => entry.bytesBase64);
    await expect(delivery.deliver(native)).rejects.toThrow('native outage');
    for (const prepared of positions) {
      const result = await delivery.deliver(prepared);
      await store.accept(prepared, result.receiptId);
    }
    expect(store.pendingHeads()[0]).toEqual(native);
    const segments = [...inputs.values()]
      .filter((entry) => entry.body.kind === 'telemetry.segment')
      .map(
        (entry) => JSON.parse(Buffer.from(uploads.get(entry.body.artifactId!)!).toString('utf8')) as TelemetrySegment,
      );
    expect(segments.flatMap((segment) => segment.samples.map((sample) => sample.sequence))).toEqual([1, 2]);
    expect(segments.flatMap((segment) => segment.samples.map((sample) => sample.original.bytesBase64))).toEqual(
      originalBytes,
    );
    expect(segments.every((segment) => segment.sourceSessionId === f.departure.sourceSessionId)).toBe(true);
    delivery = new OperationDelivery(config, fetcher);
    nativeUnavailable = false;
    const accepted = await delivery.deliver(native);
    await store.accept(native, accepted.receiptId);
    expect(nativeRequests[1]).toEqual(nativeRequests[0]);
    const original = uploads.get(nativeRequests[0]!.body.artifactId!)!;
    expect(Buffer.from(original).toString('base64')).toBe(native.bytesBase64);
    expect(nativeRequests[0]!.body.payload).toEqual(JSON.parse(Buffer.from(original).toString('utf8')));
    const journalPath = join(root, 'delivery', `${digest(f.departure.attemptId)}.json`);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    expect(journal.flightId).toBe(f.departure.flightId);
    journal.flightId = 'another-flight';
    await writeFile(journalPath, JSON.stringify(journal));
    await expect(new OperationDelivery(config, fetcher).deliver(native)).rejects.toThrow('retained exact flight');
    await expect(
      new OperationDelivery(
        { ...config, departureBinding: () => ({ ...config.departureBinding(), tenantId: 'tenant-beta' }) },
        fetcher,
      ).deliver(positions[0]!),
    ).rejects.toThrow('retained source binding');
  });
});
