import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Input, Upload, UploadCreate } from '@ledger/contracts';
import { InputSchema } from '@ledger/contracts';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  advanceOperation,
  createOperation,
  holdAircraft,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { OperationDelivery, prepareWorldFact } from '../src/operation-delivery.js';
import { initialOperationCheckpoint, OperationStore, readOperationCheckpoint } from '../src/operation-state.js';
import { scenarioConfig } from '../src/scenario.js';

it('retries a dispatcher cancellation with its original actor, observation and receipt after delivery restart', async () => {
  const fact: WorldFact = {
    kind: 'cancellation',
    sequence: 3,
    tenant: 'alpha',
    at: '2026-10-17T14:02:00.001Z',
    attemptId: 'held-alpha:attempt:1',
    sourceSessionId: 'held-alpha-capture-1',
    aircraftId: 'held-alpha-aircraft',
    personId: 'held-alpha-dispatcher',
    personName: 'Alpha dispatch',
    reason: 'requested_window_unreachable',
    note: 'Medical delivery cancelled before departure because its requested window is no longer reachable.',
  };
  const prepared = prepareWorldFact(fact);
  expect(JSON.parse(Buffer.from(prepared.bytesBase64, 'base64').toString('utf8'))).toEqual({
    activity: 'cancelled',
    title: 'Flight cancelled before departure',
    aircraft: fact.aircraftId,
    personId: fact.personId,
    personName: fact.personName,
    personRole: 'dispatcher',
    reason: fact.reason,
    note: fact.note,
  });
  expect(prepared.fact).toEqual(fact);
  expect(prepareWorldFact(JSON.parse(JSON.stringify(fact)))).toEqual(prepared);
  const directory = await mkdtemp(join(tmpdir(), 'ledger-native-cancellation-'));
  try {
    const config = { ...scenarioConfig({}), stateDirectory: directory };
    const order: WorldFact = {
      sequence: 0,
      kind: 'order',
      tenant: fact.tenant,
      at: '2026-10-17T14:00:00.000Z',
      attemptId: fact.attemptId,
      sourceSessionId: fact.sourceSessionId,
      aircraftId: fact.aircraftId,
      order: {
        order_id: 'held-alpha-order',
        version: 2,
        updated_at: '2026-10-17T14:00:00.000Z',
        state: 'accepted',
        schedule: { start: '2026-10-17T14:00:00.000Z', end: '2026-10-17T14:06:00.000Z' },
        requested_work: { name: 'Medical delivery' },
        flights: [
          {
            flight_intent_id: 'held-alpha',
            attempt: 1,
            order_refs: ['held-alpha-order'],
            aircraft_id: fact.aircraftId,
          },
        ],
      },
    };
    const uploads = new Map<string, Uint8Array>();
    const uploadIds = new Map<string, string>();
    const uploadRecords = new Map<string, Upload>();
    const receipts = new Map<string, { id: string; body: Input }>();
    const attempts: Array<{ key: string; body: Input; receiptId: string }> = [];
    let expectedToken = config.tokens.alpha.source;
    let loseResponse = true;
    const fetcher: typeof fetch = async (url, init) => {
      const request = new URL(String(url));
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${expectedToken}`);
      const key = headers.get('idempotency-key') ?? '';
      if (request.pathname === '/v1/me')
        return Response.json({
          principal: {
            id: expectedToken === config.tokens.alpha.actor ? 'alpha-actor' : 'alpha-source',
            tenantId: 'tenant-alpha',
          },
        });
      if (request.pathname === '/v1/flights') {
        expect(request.searchParams.get('search')).toBe(order.order.order_id);
        return Response.json({ flights: [{ id: 'held-alpha-flight', originationKey: fact.attemptId }] });
      }
      if (request.pathname === '/v1/uploads') {
        const body = JSON.parse(init!.body as string) as UploadCreate;
        if (!uploadIds.has(key)) {
          const id = `upload-${uploadIds.size}`;
          uploadIds.set(key, id);
          uploadRecords.set(id, { id, status: 'pending', contentType: body.contentType, byteLength: body.byteLength });
        }
        const upload = uploadRecords.get(uploadIds.get(key)!)!;
        expect(upload).toMatchObject({ contentType: body.contentType, byteLength: body.byteLength });
        return Response.json({ upload });
      }
      const content = request.pathname.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (content) {
        const bytes = Uint8Array.from(init!.body as Uint8Array);
        if (uploads.has(content[1]!)) expect(bytes).toEqual(uploads.get(content[1]!));
        uploads.set(content[1]!, bytes);
        const upload = uploadRecords.get(content[1]!)!;
        expect(bytes.byteLength).toBe(upload.byteLength);
        upload.status = 'stored';
        upload.sha256 = createHash('sha256').update(bytes).digest('hex');
        return Response.json({ upload });
      }
      const finalized = request.pathname.match(/^\/v1\/uploads\/([^/]+)\/finalize$/);
      if (finalized) {
        const upload = uploadRecords.get(finalized[1]!)!;
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
      if (request.pathname !== '/v1/inputs') throw new Error(`Unexpected public request ${request.pathname}`);
      const body = JSON.parse(init!.body as string) as Input;
      const previous = receipts.get(key);
      if (previous) expect(body).toEqual(previous.body);
      const receipt = previous ?? { id: `receipt-${receipts.size}`, body };
      receipts.set(key, receipt);
      if (body.kind === 'flight.observation') {
        attempts.push({ key, body, receiptId: receipt.id });
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Lost native cancellation response after acceptance');
        }
      }
      return Response.json({ receipt: { id: receipt.id } });
    };
    let delivery = new OperationDelivery(config, fetcher);
    await delivery.deliver(delivery.prepare(order));
    expectedToken = config.tokens.alpha.actor;
    await expect(delivery.deliver(prepared)).rejects.toThrow('Lost native cancellation response');
    delivery = new OperationDelivery(config, fetcher);
    const retried = await delivery.deliver(prepared);
    expect(receipts.size).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(retried.receiptId).toBe(attempts[0]!.receiptId);
    const { key, body } = attempts[0]!;
    expect(key).toBe(`operation:${fact.sourceSessionId}:${fact.sequence}:cancellation`);
    expect(body).toMatchObject({
      kind: 'flight.observation',
      sourceId: 'simulation-person-alpha',
      sourceSessionId: fact.sourceSessionId,
      occurredAt: fact.at,
      subject: { originationKey: fact.attemptId },
      payload: {
        activity: 'cancelled',
        personId: fact.personId,
        personName: fact.personName,
        personRole: 'dispatcher',
        reason: fact.reason,
        note: fact.note,
      },
    });
    expect(body.payload).not.toHaveProperty('landingTime');
    expect(Buffer.from(uploads.get(body.artifactId!)!).toString('base64')).toBe(prepared.bytesBase64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains an unfulfilled cancellation through lost acceptance, compaction and delivery restart', async () => {
  const ajv = new Ajv({ strict: false });
  (addFormats as unknown as (instance: Ajv) => void)(ajv);
  const inputShape = ajv.compile(InputSchema);
  const directory = await mkdtemp(join(tmpdir(), 'ledger-cancelled-demand-'));
  try {
    const path = join(directory, 'world.json');
    const config = { ...scenarioConfig({}), stateDirectory: `${path}.delivery` };
    const world = createOperation({
      runId: 'cancelled-delivery',
      start: '2026-10-17T14:00:00.000Z',
      demandIntervalMs: 3_600_000,
      fleet: { alpha: 1, beta: 1 },
    });
    const start = world.now;
    holdAircraft(world, world.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.id, start + 600_000);
    let store = new OperationStore(
      path,
      initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
    );
    await store.update((state) => advanceOperation(state.world, start + 120_001));
    const [accepted, cancelled] = Object.values(store.state.pending).flat();
    if (accepted?.fact.kind !== 'order' || cancelled?.fact.kind !== 'order')
      throw new Error('Expected accepted and cancelled original order revisions');
    expect(store.state.world.demand).toEqual([]);
    expect(store.state.world.attempts).toEqual([]);
    expect(store.pendingHeads()).toEqual([accepted]);
    expect(cancelled.fact.order.schedule).toEqual(accepted.fact.order.schedule);
    const uploads = new Map<string, Uint8Array>();
    const uploadIds = new Map<string, string>();
    const uploadRecords = new Map<string, Upload>();
    const receipts = new Map<string, { id: string; body: Input }>();
    const attempts: Array<{ key: string; body: Input; receiptId: string }> = [];
    let loseCancellationResponse = true;
    const fetcher: typeof fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${config.tokens.alpha.source}`);
      const key = headers.get('idempotency-key') ?? '';
      if (pathname === '/v1/me') return Response.json({ principal: { id: 'alpha-source', tenantId: 'tenant-alpha' } });
      if (pathname === '/v1/uploads') {
        const body = JSON.parse(init!.body as string) as UploadCreate;
        if (!uploadIds.has(key)) {
          const id = `upload-${uploadIds.size}`;
          uploadIds.set(key, id);
          uploadRecords.set(id, { id, status: 'pending', contentType: body.contentType, byteLength: body.byteLength });
        }
        const upload = uploadRecords.get(uploadIds.get(key)!)!;
        expect(upload).toMatchObject({ contentType: body.contentType, byteLength: body.byteLength });
        return Response.json({ upload });
      }
      const content = pathname.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (content) {
        const bytes = Uint8Array.from(init!.body as Uint8Array);
        if (uploads.has(content[1]!)) expect(bytes).toEqual(uploads.get(content[1]!));
        uploads.set(content[1]!, bytes);
        const upload = uploadRecords.get(content[1]!)!;
        expect(bytes.byteLength).toBe(upload.byteLength);
        upload.status = 'stored';
        upload.sha256 = createHash('sha256').update(bytes).digest('hex');
        return Response.json({ upload });
      }
      const finalized = pathname.match(/^\/v1\/uploads\/([^/]+)\/finalize$/);
      if (finalized) {
        const upload = uploadRecords.get(finalized[1]!)!;
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
      if (pathname !== '/v1/inputs') throw new Error(`Unexpected public request ${pathname}`);
      const body = JSON.parse(init!.body as string) as Input;
      expect(inputShape(body), JSON.stringify(inputShape.errors)).toBe(true);
      const previous = receipts.get(key);
      if (previous) expect(body).toEqual(previous.body);
      const receipt = previous ?? { id: `receipt-${receipts.size}`, body };
      receipts.set(key, receipt);
      attempts.push({ key, body, receiptId: receipt.id });
      if (body.sourceRevision === 2 && loseCancellationResponse) {
        loseCancellationResponse = false;
        throw new Error('Lost cancellation response after acceptance');
      }
      return Response.json({ receipt: { id: receipt.id } });
    };
    let delivery = new OperationDelivery(config, fetcher);
    await store.accept(accepted, (await delivery.deliver(accepted)).receiptId);
    await expect(delivery.deliver(cancelled)).rejects.toThrow('Lost cancellation response');
    expect(store.pendingHeads()).toEqual([cancelled]);
    store = new OperationStore(path, (await readOperationCheckpoint(path))!);
    delivery = new OperationDelivery(config, fetcher);
    expect(store.pendingHeads()).toEqual([cancelled]);
    const retried = await delivery.deliver(store.pendingHeads()[0]!);
    await store.accept(cancelled, retried.receiptId);
    expect(store.state.pending).toEqual({});
    expect(store.state.accepted).toBe(2);
    expect(receipts.size).toBe(2);
    const cancellationAttempts = attempts.filter((attempt) => attempt.body.sourceRevision === 2);
    expect(cancellationAttempts).toHaveLength(2);
    expect(cancellationAttempts[1]).toEqual(cancellationAttempts[0]);
    expect(retried.receiptId).toBe(cancellationAttempts[0]!.receiptId);
    const { key, body } = cancellationAttempts[0]!;
    expect(key).toBe(`order:${cancelled.fact.order.order_id}:2:webhook`);
    expect(body).toMatchObject({
      kind: 'order.revision',
      sourceRevision: 2,
      sourceId: 'partner-orders',
      sourceSessionId: accepted.fact.sourceSessionId,
      subject: { orderId: accepted.fact.order.order_id },
      payload: {
        status: 'cancelled',
        fulfillments: [],
        scheduledStart: accepted.fact.order.schedule.start,
        scheduledEnd: accepted.fact.order.schedule.end,
        cancellation: {
          reason: 'requested_window_unreachable',
          note: expect.stringContaining('medical delivery'),
          decidedAt: new Date(start + 120_001).toISOString(),
          dispatcher: { id: 'cancelled-delivery-dispatcher-alpha', name: 'Alpha dispatch' },
        },
      },
    });
    expect(Buffer.from(uploads.get(body.artifactId!)!).toString('base64')).toBe(cancelled.bytesBase64);
    expect(JSON.parse(Buffer.from(cancelled.bytesBase64, 'base64').toString('utf8'))).toEqual(cancelled.fact.order);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
