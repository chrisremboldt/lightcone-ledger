import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Input, TelemetrySegment, Upload, UploadCreate } from '@ledger/contracts';
import {
  advanceOperation,
  createOperation,
  holdAircraft,
  operationCapacityPreset,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { OperationDelivery } from '../src/operation-delivery.js';
import { scenarioConfig } from '../src/scenario.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('world observations through production adapters', () => {
  it('retains only exact command-link source fields and refuses delivery before any journal or API mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-command-link-delivery-'));
    directories.push(directory);
    const world = createOperation({
      ...operationCapacityPreset('illustrative-25.1'),
      runId: 'command-link-source',
      start: '2026-10-15T14:00:00.000Z',
      commandLinkEpisode: 'canal-market-relay.1',
    });
    advanceOperation(world, world.now + 121_000);
    const reports = world.facts.filter((fact) => fact.kind === 'command-link');
    expect(reports.length).toBeGreaterThanOrEqual(4);
    const delivery = new OperationDelivery({ ...scenarioConfig({}), stateDirectory: directory }, async () => {
      throw new Error('Command-link delivery must not make public requests');
    });
    for (const fact of reports) {
      if (fact.kind !== 'command-link') throw new Error('Command-link report missing');
      const prepared = delivery.prepare(fact);
      expect(Buffer.from(prepared.bytesBase64, 'base64').toString('utf8')).toBe(
        JSON.stringify({
          sourceSessionId: fact.sourceSessionId,
          occurredAt: fact.at,
          sourceEventId: fact.sourceEventId,
          incidentId: fact.incidentId,
          aircraftId: fact.aircraftId,
          status: fact.status,
          position: fact.position,
        }),
      );
      await expect(delivery.deliver(prepared)).rejects.toThrow('requires its HTTP transport');
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it('retains queued demand, assignment and disagreeing native reports in one stable attempt journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-delivery-'));
    directories.push(directory);
    const config = { ...scenarioConfig({}), stateDirectory: directory };
    const world = createOperation({
      runId: 'queued-report',
      start: '2026-10-15T14:00:00.000Z',
      fleet: { alpha: 1, beta: 1 },
      incident: 'landing-disagreement',
      sampleIntervalMs: 60_000,
      demandIntervalMs: 120_000,
    });
    const start = world.now;
    holdAircraft(world, world.aircraft.find((aircraft) => aircraft.tenant === 'alpha')!.id, start + 60_000);
    advanceOperation(world, start);
    const queued = world.facts.find((fact) => fact.kind === 'order')!;
    if (queued.kind !== 'order') throw new Error('Queued world order missing');
    const uploads = new Map<string, Uint8Array>();
    const uploadIds = new Map<string, string>();
    const uploadRecords = new Map<string, Upload>();
    const accepted = new Map<string, { id: string; body: Input }>();
    const reportAttempts: Input[] = [];
    let visible = false;
    let loseReportResponse = true;
    const fetcher: typeof fetch = async (url, init) => {
      const request = new URL(String(url));
      const headers = new Headers(init?.headers);
      const key = headers.get('idempotency-key') ?? '';
      const principal = headers.get('authorization')!.replace('Bearer ', '');
      if (request.pathname === '/v1/me')
        return Response.json({ principal: { id: principal, tenantId: 'tenant-alpha' } });
      if (request.pathname === '/v1/flights') {
        expect(request.searchParams.get('search')).toBe(queued.order.order_id);
        return Response.json({
          flights: visible ? [{ id: 'flight-queued', originationKey: queued.attemptId }] : [],
          meta: { outstandingWork: 0 },
        });
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
      if (request.pathname === '/v1/inputs') {
        const body = JSON.parse(init!.body as string) as Input;
        const previous = accepted.get(`${principal}:${key}`);
        if (previous) expect(body).toEqual(previous.body);
        const result = previous ?? { id: `receipt-${accepted.size}`, body };
        accepted.set(`${principal}:${key}`, result);
        if (body.kind === 'order.revision') visible ||= body.payload.revision === 2;
        if (body.sourceId === 'simulation-person-alpha-buffered') {
          expect(principal).toBe(config.tokens.alpha.actor);
          reportAttempts.push(body);
          if (loseReportResponse) {
            loseReportResponse = false;
            throw new Error('Injected lost crew-report response after acceptance');
          }
        }
        return Response.json({ receipt: { id: result.id, processing: { status: 'pending' } } });
      }
      throw new Error(`Unexpected public request ${request.pathname}`);
    };
    let delivery = new OperationDelivery(config, fetcher);
    await delivery.deliver(delivery.prepare(queued));
    expect(queued).not.toHaveProperty('aircraftId');
    expect(visible).toBe(false);
    expect([...accepted.values()][0]!.body).toMatchObject({
      kind: 'order.revision',
      payload: { externalId: queued.order.order_id, revision: 1, fulfillments: [] },
    });
    const journalPath = join(directory, 'delivery', (await readdir(join(directory, 'delivery')))[0]!);
    expect(JSON.parse(await readFile(journalPath, 'utf8'))).not.toHaveProperty('aircraftId');

    advanceOperation(world, start + 60_000);
    const assignment = world.facts.find((fact) => fact.kind === 'order' && fact.order.version === 2)!;
    const attempt = world.attempts[0]!;
    delivery = new OperationDelivery(config, fetcher);
    await delivery.deliver(delivery.prepare(assignment));
    expect(visible).toBe(true);
    expect([...accepted.values()][1]!.body).toMatchObject({
      kind: 'order.revision',
      payload: {
        externalId: queued.order.order_id,
        revision: 2,
        fulfillments: [
          {
            originationKey: queued.attemptId,
            aircraft: attempt.aircraftId,
            scheduledStart: queued.order.schedule.start,
          },
        ],
      },
    });
    await expect(
      delivery.deliver(delivery.prepare({ ...assignment, sequence: 999, aircraftId: 'different-aircraft' })),
    ).rejects.toThrow('retained aircraft identity');

    advanceOperation(world, Date.parse(attempt.landing) + 90_000);
    const landing = world.facts.find((fact) => fact.kind === 'landing' && fact.attemptId === attempt.id)!;
    const report = world.facts.find((fact) => fact.kind === 'landing-report')!;
    if (report.kind !== 'landing-report') throw new Error('Buffered crew report missing');
    await delivery.deliver(delivery.prepare(landing));
    const preparedReport = delivery.prepare(report);
    await expect(delivery.deliver(preparedReport)).rejects.toThrow('lost crew-report response');
    delivery = new OperationDelivery(config, fetcher);
    await delivery.deliver(preparedReport);
    expect(accepted.size).toBe(4);
    expect(reportAttempts).toHaveLength(2);
    expect(reportAttempts[0]).toEqual(reportAttempts[1]);
    const observations = [...accepted.values()].filter((receipt) => receipt.body.kind === 'flight.observation');
    expect(
      observations.map((receipt) => ({
        sourceId: receipt.body.sourceId,
        session: receipt.body.sourceSessionId,
        occurredAt: receipt.body.occurredAt,
        landingTime: receipt.body.payload.landingTime,
      })),
    ).toEqual([
      {
        sourceId: 'simulation-person-alpha',
        session: attempt.sourceSessionId,
        occurredAt: attempt.landing,
        landingTime: attempt.landing,
      },
      {
        sourceId: 'simulation-person-alpha-buffered',
        session: `${attempt.sourceSessionId}-buffered-person`,
        occurredAt: report.reportAt,
        landingTime: new Date(Date.parse(attempt.landing) + 30_000).toISOString(),
      },
    ]);
    const input = reportAttempts[0]!;
    expect(input).toMatchObject({
      kind: 'flight.observation',
      fidelity: 'synthetic_contract',
      subject: { originationKey: attempt.id },
      payload: {
        activity: 'landed',
        title: 'Ground crew landing report',
        aircraft: attempt.aircraftId,
        personId: report.personId,
        personName: report.personName,
        reportRecordedAt: report.reportAt,
        incidentId: report.incidentId,
      },
    });
    const original = uploads.get(input.artifactId!)!;
    expect(Buffer.from(original).toString('base64')).toBe(preparedReport.bytesBase64);
    expect(JSON.parse(Buffer.from(original).toString('utf8'))).toEqual(input.payload);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    expect(journal).toMatchObject({
      version: 2,
      primarySessionId: attempt.sourceSessionId,
      aircraftId: attempt.aircraftId,
    });
    expect(Object.keys(journal.facts)).toHaveLength(4);
    expect(Object.values(journal.facts).every((fact) => Boolean((fact as { receiptId?: string }).receiptId))).toBe(
      true,
    );
  });

  it('retains a complete flight and recovers exact source bytes after ambiguous acceptance and restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-delivery-'));
    directories.push(directory);
    const config = { ...scenarioConfig({}), stateDirectory: directory };
    const identity = {
      tenant: 'alpha' as const,
      attemptId: 'run-alpha-intent-1:attempt:1',
      aircraftId: 'run-alpha-aircraft-01',
      sourceSessionId: 'run-alpha-capture-1',
    };
    const start = '2026-10-15T14:00:00.000Z';
    const end = '2026-10-15T14:02:00.000Z';
    const order: WorldFact = {
      ...identity,
      sequence: 0,
      kind: 'order',
      at: start,
      order: {
        order_id: 'run-order-1',
        version: 1,
        updated_at: start,
        state: 'accepted',
        schedule: { start, end },
        requested_work: { name: 'Lab courier · Mercy North' },
        flights: [
          {
            flight_intent_id: 'run-alpha-intent-1',
            attempt: 1,
            order_refs: ['run-order-1'],
            aircraft_id: identity.aircraftId,
          },
        ],
      },
    };
    const departure: WorldFact = {
      ...identity,
      sequence: 1,
      at: start,
      kind: 'departure',
      personId: 'run-alpha-person-1',
      personName: 'Maya Chen',
    };
    const position: WorldFact = {
      ...identity,
      sequence: 2,
      at: '2026-10-15T14:00:10.000Z',
      kind: 'position',
      point: {
        occurredAt: '2026-10-15T14:00:10.000Z',
        latitude: 41.88,
        longitude: -87.63,
        height: 220,
        horizontalSpeed: 8,
      },
    };
    const landing: WorldFact = { ...departure, sequence: 3, kind: 'landing', at: end };
    const uploads = new Map<string, Uint8Array>();
    const uploadIds = new Map<string, string>();
    const uploadRecords = new Map<string, Upload>();
    const accepted = new Map<string, { id: string; body: Input }>();
    const attempts: Array<{ key: string; body: Input }> = [];
    let visible = false;
    let loseTelemetryResponse = true;
    const fetcher: typeof fetch = async (url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      const key = headers.get('idempotency-key') ?? '';
      const principal = headers.get('authorization')!.replace('Bearer ', '');
      if (path === '/v1/me') return Response.json({ principal: { id: principal, tenantId: 'tenant-alpha' } });
      if (path === '/v1/flights') {
        expect(new URL(String(url)).searchParams.get('search')).toBe(order.order.order_id);
        return Response.json({
          flights: visible ? [{ id: 'flight-one', originationKey: identity.attemptId }] : [],
          meta: { outstandingWork: visible ? 0 : 1 },
        });
      }
      if (path === '/v1/uploads') {
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
      const content = path.match(/^\/v1\/uploads\/([^/]+)\/content$/);
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
        attempts.push({ key, body });
        const previous = accepted.get(`${principal}:${key}`);
        if (previous) expect(body).toEqual(previous.body);
        const receipt = previous ?? { id: `receipt-${accepted.size}`, body };
        accepted.set(`${principal}:${key}`, receipt);
        if (body.kind === 'telemetry.segment' && loseTelemetryResponse) {
          loseTelemetryResponse = false;
          throw new Error('Injected lost response after acceptance');
        }
        return Response.json({ receipt: { id: receipt.id, processing: { status: 'pending' } } });
      }
      throw new Error(`Unexpected public request ${path}`);
    };

    let delivery = new OperationDelivery(config, fetcher);
    await delivery.deliver(delivery.prepare(order));
    await expect(delivery.deliver(delivery.prepare(departure))).rejects.toThrow(
      'until its originated flight is visible',
    );
    expect(accepted.size).toBe(1);
    visible = true;
    await delivery.deliver(delivery.prepare(departure));
    const prepared = delivery.prepare(position);
    await expect(delivery.deliver(prepared)).rejects.toThrow('lost response');
    const capturePath = join(directory, 'captures', (await readdir(join(directory, 'captures')))[0]!);
    const before = JSON.parse(await readFile(capturePath, 'utf8'));
    expect(before.nextSequence).toBe(2);
    expect(before.pending).toHaveLength(1);

    delivery = new OperationDelivery(config, fetcher);
    const recovered = await delivery.deliver(prepared);
    const telemetryAttempts = attempts.filter((attempt) => attempt.body.kind === 'telemetry.segment');
    expect(telemetryAttempts).toHaveLength(2);
    expect(telemetryAttempts[0]).toEqual(telemetryAttempts[1]);
    expect(JSON.parse(await readFile(capturePath, 'utf8'))).toMatchObject({ nextSequence: 2, pending: [], buffer: [] });
    const segment = JSON.parse(
      Buffer.from(uploads.get(telemetryAttempts[0]!.body.artifactId!)!).toString(),
    ) as TelemetrySegment;
    expect(segment.sourceSessionId).toBe(identity.sourceSessionId);
    expect(segment.samples[0]!.original.bytesBase64).toBe(prepared.bytesBase64);
    expect(segment.samples[0]!.sequence).toBe(1);

    const journalPath = join(directory, 'delivery', (await readdir(join(directory, 'delivery')))[0]!);
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    delete journal.facts[position.sequence].receiptId;
    await writeFile(journalPath, JSON.stringify(journal));
    delivery = new OperationDelivery(config, fetcher);
    expect(await delivery.deliver(prepared)).toEqual(recovered);
    expect(attempts.filter((attempt) => attempt.body.kind === 'telemetry.segment')).toHaveLength(2);
    await expect(
      delivery.deliver(delivery.prepare({ ...position, point: { ...position.point, height: 230 } })),
    ).rejects.toThrow('cannot change on retry');
    const captured = await readFile(capturePath, 'utf8');
    await unlink(capturePath);
    await expect(
      delivery.deliver(delivery.prepare({ ...position, sequence: 4, point: { ...position.point, height: 240 } })),
    ).rejects.toThrow('checkpoint is missing');
    await writeFile(capturePath, captured);

    await delivery.deliver(delivery.prepare(landing));
    expect(accepted.size).toBe(4);
    const observations = [...accepted.values()].filter((receipt) => receipt.body.kind === 'flight.observation');
    expect(observations.map((receipt) => receipt.body.occurredAt)).toEqual([start, end]);
    expect(observations.map((receipt) => receipt.body.payload)).toEqual([
      {
        activity: 'active',
        title: 'Departure reported',
        aircraft: identity.aircraftId,
        personId: departure.personId,
        personName: departure.personName,
      },
      {
        activity: 'landed',
        title: 'Landing reported',
        aircraft: identity.aircraftId,
        personId: departure.personId,
        personName: departure.personName,
        landingTime: end,
      },
    ]);
    expect([...accepted.values()].every((receipt) => receipt.body.sourceSessionId === identity.sourceSessionId)).toBe(
      true,
    );
    expect(await readFile(journalPath, 'utf8')).not.toContain(config.partnerKey);
  });
});
