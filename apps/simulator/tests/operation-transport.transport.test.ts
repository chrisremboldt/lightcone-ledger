import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { LedgerClient, PartnerOrderAdapter, digest } from '@ledger/adapters';
import type { Input, TelemetrySegment } from '@ledger/contracts';
import { createEmulator, DjiOsdEmulator, emulatorConfig } from '@ledger/emulators';
import {
  advanceOperation,
  createOperation,
  type WorldFact,
} from '../../../packages/simulation-models/src/operation.js';
import { acquireControlLease } from '../src/control-lease.js';
import { OperationDelivery, prepareWorldFact, type PreparedWorldFact } from '../src/operation-delivery.js';
import { prepareOperationBroker } from '../src/operation-broker.js';
import { initialOperationCheckpoint, OperationStore, readOperationCheckpoint } from '../src/operation-state.js';
import { OperationTransport } from '../src/operation-transport.js';
import { scenarioConfig } from '../src/scenario.js';

const execute = promisify(execFile);
const image = 'eclipse-mosquitto:2.0.22@sha256:199ea8ef2e35ec2b1b37e59cfd1dbae538ed4dfa4a2251a121a52215a6248a21';

function apiFixture() {
  const uploads = new Map<string, Uint8Array>();
  const uploadIds = new Map<string, string>();
  const inputIds = new Map<string, number>();
  const inputs: Array<{ label: string; body: Input; receiptId: string }> = [];
  const flights = new Map<string, { id: string; originationKey: string; externalId: string; tenantId: string }>();
  let projected = true;
  let sessionProof = true;
  const fetcher =
    (label: string): typeof fetch =>
    async (url, init) => {
      const request = new URL(String(url));
      const path = request.pathname;
      const headers = new Headers(init?.headers);
      const principal = headers.get('authorization')!.replace('Bearer ', '');
      const tenantId = principal.includes('-beta-') ? 'tenant-beta' : 'tenant-alpha';
      const key = `${principal}:${headers.get('idempotency-key') ?? ''}`;
      if (path === '/v1/me') return Response.json({ principal: { id: principal, tenantId } });
      if (path === '/v1/flights')
        return Response.json({
          flights: [...flights.values()].filter(
            (flight) => flight.tenantId === tenantId && flight.externalId === request.searchParams.get('search'),
          ),
          meta: { outstandingWork: 0 },
        });
      if (path === '/v1/uploads') {
        if (!uploadIds.has(key)) uploadIds.set(key, `upload-${uploadIds.size}`);
        return Response.json({ upload: { id: uploadIds.get(key) } });
      }
      const content = path.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (content) {
        uploads.set(content[1]!, Uint8Array.from(init!.body as Uint8Array));
        return Response.json({ upload: { id: content[1] } });
      }
      const finalized = path.match(/^\/v1\/uploads\/([^/]+)\/finalize$/);
      if (finalized) return Response.json({ artifact: { id: finalized[1] } });
      if (path === '/v1/inputs') {
        const body = JSON.parse(init!.body as string) as Input;
        const previous = inputIds.get(key);
        if (previous !== undefined) {
          expect(body).toEqual(inputs[previous]!.body);
          return Response.json({ receipt: { id: inputs[previous]!.receiptId } });
        }
        const receiptId = `receipt-${inputs.length}`;
        inputIds.set(key, inputs.length);
        inputs.push({ label, body, receiptId });
        if (body.kind === 'order.revision') {
          for (const fulfillment of body.payload.fulfillments as Array<{ originationKey: string }>) {
            flights.set(fulfillment.originationKey, {
              id: `flight-${digest(fulfillment.originationKey).slice(0, 12)}`,
              originationKey: fulfillment.originationKey,
              externalId: body.payload.externalId as string,
              tenantId,
            });
          }
        }
        return Response.json({ receipt: { id: receiptId } });
      }
      const telemetry = path.match(/^\/v1\/flights\/([^/]+)\/telemetry$/);
      if (telemetry) {
        const retained = inputs.filter(
          (input) => input.body.kind === 'telemetry.segment' && input.body.subject.flightId === telemetry[1],
        );
        const segments = retained.map((input) => ({
          segment: JSON.parse(Buffer.from(uploads.get(input.body.artifactId!)!).toString()) as TelemetrySegment,
          receiptId: input.receiptId,
          artifactId: input.body.artifactId,
        }));
        const samples = segments
          .flatMap(({ segment, receiptId }) =>
            segment.samples.map((sample) => ({
              ...sample,
              sourceId: segment.sourceId,
              sourceSessionId: segment.sourceSessionId,
              deviceId: segment.deviceId,
              receiptId,
            })),
          )
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.sequence - left.sequence);
        const sessions = [
          ...new Map(
            segments.map(({ segment }) => {
              const matching = samples.filter(
                (sample) => sample.sourceSessionId === segment.sourceSessionId && sample.deviceId === segment.deviceId,
              );
              return [
                segment.sourceSessionId,
                {
                  id: segment.sourceSessionId,
                  sourceId: segment.sourceId,
                  sourceSessionId: segment.sourceSessionId,
                  deviceId: segment.deviceId,
                  sessionStartSequence: 1,
                  sequenceBasis: 'adapter_capture',
                  highestSequence: Math.max(...matching.map((sample) => sample.sequence)),
                  latestSample: matching[0],
                  lastReceivedAt: matching[0]!.occurredAt,
                  gapCount: 0,
                  missingSequenceCount: 0,
                  conflictCount: 0,
                  duplicateCount: 0,
                },
              ] as const;
            }),
          ).values(),
        ];
        return Response.json({
          window: {
            sampleLimit: 240,
            sessionLimit: 16,
            segmentLimit: 20,
            gapLimit: 128,
            truncated: segments.length > 20 || samples.length > 240 || sessions.length > 16,
          },
          sessions: sessionProof ? sessions.slice(0, 16) : [],
          samples: samples.slice(0, 240),
          segments: segments
            .slice(-20)
            .reverse()
            .map(({ segment, receiptId, artifactId }) => ({
              id: receiptId,
              receiptId,
              artifactId,
              sourceId: segment.sourceId,
              sourceSessionId: segment.sourceSessionId,
              deviceId: segment.deviceId,
              sampleCount: segment.samples.length,
              firstSequence: segment.samples[0]!.sequence,
              lastSequence: segment.samples.at(-1)!.sequence,
              processing: { status: projected ? 'completed' : 'pending', attempts: 1 },
            })),
          gaps: [],
        });
      }
      const receipt = inputs.find((input) => path === `/v1/receipts/${input.receiptId}`);
      if (receipt)
        return Response.json({
          receipt: {
            id: receipt.receiptId,
            kind: receipt.body.kind,
            sourceId: receipt.body.sourceId,
            flightId: receipt.body.subject.flightId,
            processing: { status: projected ? 'completed' : 'pending' },
          },
        });
      throw new Error(`Unexpected fixture API request ${path}`);
    };
  const ledger = (label: string) => new LedgerClient('http://fixture.invalid', 'source', fetcher(label));
  return {
    fetcher,
    ledger,
    uploads,
    inputs,
    projectionReady(value: boolean) {
      projected = value;
    },
    sessionProofReady(value: boolean) {
      sessionProof = value;
    },
  };
}

describe('world HTTP and MQTT transports', () => {
  it('retains callback and broker bytes, refreshes the delivery ledger, and proves an old session before handoff after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-transport-'));
    const world = createOperation({ runId: 'wire-fixture', start: '2026-10-15T14:00:00.000Z' });
    advanceOperation(world, world.now + 10_000);
    const positions = world.facts.filter((fact) => fact.kind === 'position');
    const first = positions[0]!;
    const second = positions.find((fact) => fact.attemptId === first.attemptId && fact.sequence !== first.sequence)!;
    const brokerDirectory = join(directory, 'broker');
    const broker = await prepareOperationBroker(world, brokerDirectory, 1883);
    const credentials = broker.bindings[first.aircraftId]!;
    let container: string | undefined;
    let transport: OperationTransport | undefined;
    const config = emulatorConfig({ EMULATOR_PORT: '0' });
    const emulator = createEmulator(config);
    let releaseLease: (() => Promise<void>) | undefined;
    try {
      container = (
        await execute('docker', [
          'run',
          '--rm',
          '-d',
          '--pull=never',
          '--user',
          '0:0',
          '-p',
          '127.0.0.1::1883',
          '--mount',
          `type=bind,source=${brokerDirectory},target=/mosquitto/config/operation,readonly`,
          image,
          'mosquitto',
          '-c',
          '/mosquitto/config/operation/mosquitto.conf',
        ])
      ).stdout.trim();
      const binding = (await execute('docker', ['port', container, '1883/tcp'])).stdout.trim();
      const mqttUrl = `mqtt://${binding}`;
      await new Promise<void>((resolve) => emulator.server.listen(0, '127.0.0.1', resolve));
      const address = emulator.server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP emulator did not bind');
      const emulatorUrl = `http://127.0.0.1:${address.port}`;
      const lease = await acquireControlLease(emulatorUrl, config.adminKey, 'scenario');
      releaseLease = () => lease.release();
      const transportConfig = {
        emulatorUrl,
        adminKey: config.adminKey,
        partnerKey: config.partnerKey,
        callbackHost: '127.0.0.1',
        callbackPort: 0,
        mqttUrl,
        bindings: broker.bindings,
        stateDirectory: directory,
        controlHeaders: () => lease.headers(),
      };
      transport = new OperationTransport(transportConfig);
      await transport.start();
      config.callbackOrigins.push(transport.callbackUrl);
      const api = apiFixture();
      const order = world.facts.find((fact) => fact.kind === 'order')!;
      const preparedOrder = prepareWorldFact(order);
      const partner = new PartnerOrderAdapter({
        ledger: api.ledger('partner'),
        sourceId: 'partner-orders',
        sourceSessionId: order.sourceSessionId,
        baseUrl: emulatorUrl,
        apiKey: config.partnerKey,
      });
      const realFetch = globalThis.fetch;
      let callbackStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        callbackStarted = resolve;
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const request = realFetch(url, init);
        if (!String(url).endsWith('/_simulation/partner/deliver')) return request;
        void request.catch(() => {});
        await started;
        throw new Error('Injected lost emulator response while callback is running');
      });
      try {
        const delivered = await transport.partnerOrder(preparedOrder, async (raw) => {
          expect(Buffer.from(raw).toString('base64')).toBe(preparedOrder.bytesBase64);
          callbackStarted();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return partner.ingest(raw);
        });
        expect(delivered.receipt.receipt.id).toBeTruthy();
      } finally {
        fetchSpy.mockRestore();
      }
      expect(api.inputs).toHaveLength(1);
      expect(api.inputs[0]!.body.kind).toBe('order.revision');
      const oldPath = join(directory, 'old-capture.json');
      const captureConfig = (label: string, fact: typeof first, flightId: string, statePath: string) => ({
        ledger: api.ledger(label),
        tenantId: 'tenant-alpha',
        sourceId: 'dji-osd',
        sourceSessionId: fact.sourceSessionId,
        deviceId: fact.aircraftId,
        gatewayId: `GW-${fact.aircraftId}`,
        subject: { flightId },
        statePath,
      });
      await transport.position(prepareWorldFact(first), captureConfig('first', first, 'flight-one', oldPath));
      await transport.position(prepareWorldFact(second), captureConfig('second', second, 'flight-one', oldPath));
      expect(api.inputs.filter((input) => input.body.kind === 'telemetry.segment').map((input) => input.label)).toEqual(
        ['first', 'second'],
      );
      const before = JSON.parse(await readFile(oldPath, 'utf8')) as { seen: string[]; nextSequence: number };
      const original = Buffer.from(prepareWorldFact(first).bytesBase64, 'base64');
      expect(before.seen).toContain(
        digest(Buffer.concat([Buffer.from(`thing/product/${first.aircraftId}/osd`), Buffer.from([0]), original])),
      );
      expect(before.nextSequence).toBe(3);
      const segments = api.inputs
        .filter((input) => input.body.kind === 'telemetry.segment')
        .map(
          (input) => JSON.parse(Buffer.from(api.uploads.get(input.body.artifactId!)!).toString()) as TelemetrySegment,
        );
      expect(segments.map((segment) => segment.samples[0]!.original.bytesBase64)).toEqual([
        prepareWorldFact(first).bytesBase64,
        prepareWorldFact(second).bytesBase64,
      ]);
      const next: Extract<WorldFact, { kind: 'position' }> = {
        ...first,
        sequence: 1000,
        attemptId: 'next-attempt',
        sourceSessionId: 'next-capture',
        at: '2026-10-15T14:10:00.000Z',
        point: { ...first.point, occurredAt: '2026-10-15T14:10:00.000Z' },
      };
      const nextPath = join(directory, 'next-capture.json');
      const positionAt = (base: typeof first, index: number) => {
        const at = new Date(Date.parse(base.point.occurredAt) + index * 10_000).toISOString();
        return { ...base, sequence: base.sequence + index, at, point: { ...base.point, occurredAt: at } };
      };
      const firstFlightFacts = [
        first,
        second,
        ...Array.from({ length: 21 }, (_, index) => positionAt(first, index + 2)),
      ];
      for (const fact of firstFlightFacts.slice(2)) {
        await transport.position(prepareWorldFact(fact), captureConfig('first', fact, 'flight-one', oldPath));
      }
      const firstCapture = await readFile(oldPath, 'utf8');
      expect(JSON.parse(firstCapture).nextSequence).toBe(24);
      const firstView = await api.ledger('read-only').telemetry('flight-one');
      expect(firstView.window.truncated).toBe(true);
      expect(firstView.segments).toHaveLength(20);
      expect(firstView.samples).toHaveLength(23);
      expect(firstView.sessions[0]).toMatchObject({
        highestSequence: 23,
        gapCount: 0,
        missingSequenceCount: 0,
        conflictCount: 0,
      });
      await transport.stop();
      transport = new OperationTransport(transportConfig);
      await transport.start();
      api.projectionReady(false);
      await expect(
        transport.position(prepareWorldFact(next), captureConfig('next', next, 'flight-two', nextPath)),
      ).rejects.toThrow('not completed');
      await expect(readFile(nextPath)).rejects.toMatchObject({ code: 'ENOENT' });
      api.projectionReady(true);
      api.sessionProofReady(false);
      await expect(
        transport.position(prepareWorldFact(next), captureConfig('next', next, 'flight-two', nextPath)),
      ).rejects.toThrow();
      await expect(readFile(nextPath)).rejects.toMatchObject({ code: 'ENOENT' });
      api.sessionProofReady(true);
      await transport.position(prepareWorldFact(next), captureConfig('next', next, 'flight-two', nextPath));
      expect(await readFile(oldPath, 'utf8')).toBe(firstCapture);
      expect(JSON.parse(await readFile(nextPath, 'utf8')).nextSequence).toBe(2);
      expect(api.inputs.at(-1)!.body.sourceSessionId).toBe(next.sourceSessionId);
      const secondFlightFacts = Array.from({ length: 23 }, (_, index) => positionAt(next, index));
      for (const fact of secondFlightFacts.slice(1)) {
        await transport.position(prepareWorldFact(fact), captureConfig('next', fact, 'flight-two', nextPath));
      }
      const secondCapture = await readFile(nextPath, 'utf8');
      expect(JSON.parse(secondCapture).nextSequence).toBe(24);
      const third = {
        ...next,
        sequence: 2000,
        attemptId: 'third-attempt',
        sourceSessionId: 'third-capture',
        at: '2026-10-15T14:20:00.000Z',
        point: { ...next.point, occurredAt: '2026-10-15T14:20:00.000Z' },
      };
      const thirdPath = join(directory, 'third-capture.json');
      await transport.position(prepareWorldFact(third), captureConfig('third', third, 'flight-three', thirdPath));
      expect(await readFile(oldPath, 'utf8')).toBe(firstCapture);
      expect(await readFile(nextPath, 'utf8')).toBe(secondCapture);
      expect(JSON.parse(await readFile(thirdPath, 'utf8')).nextSequence).toBe(2);
      const retainedFacts = [...firstFlightFacts, ...secondFlightFacts, third];
      const retainedSamples = api.inputs
        .filter((input) => input.body.kind === 'telemetry.segment')
        .flatMap((input) => {
          const segment = JSON.parse(
            Buffer.from(api.uploads.get(input.body.artifactId!)!).toString(),
          ) as TelemetrySegment;
          return segment.samples.map((sample) => sample.original.bytesBase64);
        });
      expect(retainedSamples).toEqual(retainedFacts.map((fact) => prepareWorldFact(fact).bytesBase64));
      const metadata = await readFile(
        join(directory, 'transport-sessions', `${digest(first.aircraftId)}.json`),
        'utf8',
      );
      expect(JSON.parse(metadata)).toMatchObject({
        sourceSessionId: third.sourceSessionId,
        subject: { flightId: 'flight-three' },
      });
      expect(metadata).not.toContain(credentials.adapter.password);
      expect(metadata).not.toContain(credentials.device.password);
    } finally {
      vi.restoreAllMocks();
      await transport?.stop();
      await releaseLease?.();
      emulator.server.closeAllConnections();
      await new Promise<void>((resolve) => emulator.server.close(() => resolve()));
      if (container) await execute('docker', ['rm', '-f', container]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it('holds one publisher for 90 world seconds across restart, then replays original frames once before the next flight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-world-wire-interruption-'));
    const world = createOperation({
      runId: 'wire-interruption',
      start: '2026-10-15T14:00:00.000Z',
      seed: 6,
      fleet: { alpha: 1, beta: 1 },
      profile: 'telemetry-delivery-interruption',
      sampleIntervalMs: 30_000,
      cruiseMetersPerSecond: 25,
    });
    const start = world.now;
    const checkpointPath = join(directory, 'world.json');
    const deliveryDirectory = join(directory, 'delivery-state');
    let store = new OperationStore(
      checkpointPath,
      initialOperationCheckpoint(world, { mode: 'live', wallAt: start, paused: false }),
    );
    const retained = new Map<number, PreparedWorldFact>();
    const accepted: PreparedWorldFact[] = [];
    const brokerDirectory = join(directory, 'broker');
    const broker = await prepareOperationBroker(world, brokerDirectory, 1883);
    const config = emulatorConfig({ EMULATOR_PORT: '0' });
    const emulator = createEmulator(config);
    const api = apiFixture();
    const publications = vi.spyOn(DjiOsdEmulator.prototype, 'publishBytes');
    let container: string | undefined;
    let transport: OperationTransport | undefined;
    let delivery: OperationDelivery;
    let releaseLease: (() => Promise<void>) | undefined;
    try {
      container = (
        await execute('docker', [
          'run',
          '--rm',
          '-d',
          '--pull=never',
          '--user',
          '0:0',
          '-p',
          '127.0.0.1::1883',
          '--mount',
          `type=bind,source=${brokerDirectory},target=/mosquitto/config/operation,readonly`,
          image,
          'mosquitto',
          '-c',
          '/mosquitto/config/operation/mosquitto.conf',
        ])
      ).stdout.trim();
      const binding = (await execute('docker', ['port', container, '1883/tcp'])).stdout.trim();
      await new Promise<void>((resolve) => emulator.server.listen(0, '127.0.0.1', resolve));
      const address = emulator.server.address();
      if (!address || typeof address === 'string') throw new Error('HTTP emulator did not bind');
      const emulatorUrl = `http://127.0.0.1:${address.port}`;
      const lease = await acquireControlLease(emulatorUrl, config.adminKey, 'scenario');
      releaseLease = () => lease.release();
      const transportConfig = {
        emulatorUrl,
        adminKey: config.adminKey,
        partnerKey: config.partnerKey,
        callbackHost: '127.0.0.1',
        callbackPort: 0,
        mqttUrl: `mqtt://${binding}`,
        bindings: broker.bindings,
        stateDirectory: join(deliveryDirectory, 'transport'),
        controlHeaders: () => lease.headers(),
      };
      const connect = async (interruptedDevice?: string) => {
        transport = new OperationTransport(transportConfig);
        await transport.start();
        config.callbackOrigins.push(transport.callbackUrl);
        if (interruptedDevice) await transport.setTelemetryDeliveryInterrupted(interruptedDevice, true);
        delivery = new OperationDelivery(
          {
            ...scenarioConfig({}),
            apiUrl: 'http://fixture.invalid',
            emulatorUrl,
            partnerKey: config.partnerKey,
            stateDirectory: deliveryDirectory,
            transport,
          },
          api.fetcher('operation'),
        );
      };
      const advance = async (at: number) => {
        await store.update((state) => advanceOperation(state.world, at));
        for (const prepared of Object.values(store.state.pending).flat())
          retained.set(prepared.fact.sequence, structuredClone(prepared));
      };
      const deliver = async (prepared: PreparedWorldFact) => {
        const result = await delivery.deliver(prepared);
        await store.accept(prepared, result.receiptId);
        accepted.push(prepared);
        return result;
      };
      const drain = async () => {
        while (store.pendingHeads().length) {
          for (const head of store.pendingHeads().sort((left, right) => left.fact.sequence - right.fact.sequence))
            await deliver(head);
        }
      };
      const restart = async (interruptedDevice?: string) => {
        await transport!.stop();
        const checkpoint = await readOperationCheckpoint(checkpointPath);
        if (!checkpoint) throw new Error('World checkpoint was not retained');
        store = new OperationStore(checkpointPath, checkpoint);
        await connect(interruptedDevice);
      };
      const segments = () =>
        api.inputs
          .filter((input) => input.body.kind === 'telemetry.segment')
          .map(
            (input) => JSON.parse(Buffer.from(api.uploads.get(input.body.artifactId!)!).toString()) as TelemetrySegment,
          );
      await connect();
      await advance(start + 30_000);
      const interruption = store.state.world.telemetryDeliveryInterruption!;
      expect(Date.parse(interruption.startsAt)).toBe(start + 60_000);
      expect(Date.parse(interruption.endsAt) - Date.parse(interruption.startsAt)).toBe(90_000);
      const firstAttempt = store.state.world.attempts.find((attempt) => attempt.id === interruption.attemptId)!;
      expect(Date.parse(firstAttempt.landing)).toBeGreaterThan(Date.parse(interruption.startsAt));
      expect(Date.parse(firstAttempt.landing)).toBeLessThan(Date.parse(interruption.endsAt));
      const nextFlightAt = store.state.world.aircraft.find(
        (aircraft) => aircraft.id === interruption.aircraftId,
      )!.availableAt;
      const selected = (prepared: PreparedWorldFact) =>
        prepared.fact.kind === 'position' && prepared.fact.attemptId === interruption.attemptId;
      const published = () =>
        publications.mock.calls
          .map(([bytes]) => Buffer.from(bytes).toString('base64'))
          .filter(
            (bytes) => JSON.parse(Buffer.from(bytes, 'base64').toString()).gateway === `GW-${interruption.aircraftId}`,
          );
      const capturePath = join(deliveryDirectory, 'captures', `${digest(interruption.sourceSessionId)}.json`);
      await drain();
      expect(published()).toHaveLength(2);
      const publisherIndex = publications.mock.calls.findIndex(
        ([bytes]) => JSON.parse(Buffer.from(bytes).toString()).gateway === `GW-${interruption.aircraftId}`,
      );
      const publisher = publications.mock.contexts[publisherIndex] as DjiOsdEmulator;
      expect(publisher.connections).toBe(1);
      const stoppedPublisher = vi.spyOn(publisher, 'stop');
      const beforeInterruption = await readFile(capturePath, 'utf8');
      await transport!.setTelemetryDeliveryInterrupted(interruption.aircraftId, true);
      expect(stoppedPublisher).toHaveBeenCalledOnce();
      await advance(start + 100_000);
      const firstBuffered = store.state.pending[interruption.attemptId]!.filter(selected);
      expect(firstBuffered).toHaveLength(2);
      expect(store.pendingHeads().some(selected)).toBe(false);
      await expect(delivery.deliver(firstBuffered[0]!)).rejects.toThrow('Telemetry delivery is interrupted');
      await drain();
      expect(
        api.inputs.some(
          (input) => input.body.kind === 'order.revision' && Date.parse(input.body.occurredAt) >= start + 60_000,
        ),
      ).toBe(true);
      expect(published()).toHaveLength(2);
      expect(await readFile(capturePath, 'utf8')).toBe(beforeInterruption);

      await restart(interruption.aircraftId);
      expect(store.state.pending[interruption.attemptId]!.filter(selected)).toEqual(firstBuffered);
      await advance(start + 135_000);
      await drain();
      expect(
        accepted.some(
          (prepared) => prepared.fact.kind === 'landing' && prepared.fact.attemptId === interruption.attemptId,
        ),
      ).toBe(true);
      expect(
        segments().some(
          (segment) =>
            segment.deviceId !== interruption.aircraftId &&
            segment.samples.some((sample) => Date.parse(sample.occurredAt) >= start + 120_000),
        ),
      ).toBe(true);
      const buffered = store.state.pending[interruption.attemptId]!.filter(selected);
      expect(buffered.length).toBeGreaterThan(firstBuffered.length);
      expect(store.pendingHeads()).toEqual([]);
      expect(published()).toHaveLength(2);
      expect(await readFile(capturePath, 'utf8')).toBe(beforeInterruption);
      const checkpoint = await readOperationCheckpoint(checkpointPath);
      expect(checkpoint!.pending[interruption.attemptId]).toEqual(buffered);
      expect(checkpoint!.world.telemetryDeliveryInterruption).toEqual(interruption);

      await advance(Date.parse(interruption.endsAt));
      await transport!.setTelemetryDeliveryInterrupted(interruption.aircraftId, false);
      expect(store.pendingHeads().find(selected)).toEqual(buffered[0]);
      await deliver(buffered[0]!);
      const ambiguous = buffered[1]!;
      const receivedBeforeRestart = await delivery.deliver(ambiguous);
      expect(store.pendingHeads().find(selected)).toEqual(ambiguous);
      const receivedCount = api.inputs.length;
      const publicationCount = published().length;
      await restart();
      expect(await deliver(ambiguous)).toEqual(receivedBeforeRestart);
      expect(api.inputs).toHaveLength(receivedCount);
      expect(published()).toHaveLength(publicationCount);
      await drain();
      const expectedFrames = [...retained.values()]
        .filter(selected)
        .sort((left, right) => left.fact.sequence - right.fact.sequence);
      const selectedSegments = segments().filter((segment) => segment.sourceSessionId === interruption.sourceSessionId);
      const selectedSamples = selectedSegments.flatMap((segment) => segment.samples);
      expect(published()).toEqual(expectedFrames.map((prepared) => prepared.bytesBase64));
      expect(selectedSamples.map((sample) => sample.original.bytesBase64)).toEqual(
        expectedFrames.map((prepared) => prepared.bytesBase64),
      );
      expect(selectedSamples.map((sample) => sample.sequence)).toEqual(expectedFrames.map((_, index) => index + 1));
      expect(
        selectedSegments.every(
          (segment) => segment.sourceId === 'dji-osd' && segment.deviceId === interruption.aircraftId,
        ),
      ).toBe(true);
      const completedCapture = await readFile(capturePath, 'utf8');
      expect(JSON.parse(completedCapture)).toMatchObject({
        binding: JSON.parse(beforeInterruption).binding,
        nextSequence: expectedFrames.length + 1,
      });
      expect(JSON.parse(completedCapture).seen).toHaveLength(expectedFrames.length);

      await advance(nextFlightAt);
      const nextPosition = Object.values(store.state.pending)
        .flat()
        .find(
          (prepared) =>
            prepared.fact.kind === 'position' &&
            prepared.fact.aircraftId === interruption.aircraftId &&
            prepared.fact.sourceSessionId !== interruption.sourceSessionId,
        )!;
      expect(nextPosition).toBeTruthy();
      await drain();
      expect(await readFile(capturePath, 'utf8')).toBe(completedCapture);
      const nextCapture = JSON.parse(
        await readFile(
          join(deliveryDirectory, 'captures', `${digest(nextPosition.fact.sourceSessionId)}.json`),
          'utf8',
        ),
      );
      expect(nextCapture.nextSequence).toBe(2);
      expect(nextCapture.binding).not.toBe(JSON.parse(completedCapture).binding);
      const metadata = JSON.parse(
        await readFile(
          join(transportConfig.stateDirectory, 'transport-sessions', `${digest(interruption.aircraftId)}.json`),
          'utf8',
        ),
      );
      expect(metadata).toMatchObject({
        sourceSessionId: nextPosition.fact.sourceSessionId,
        sourceId: 'dji-osd',
        deviceId: interruption.aircraftId,
      });
      expect(
        segments()
          .filter((segment) => segment.sourceSessionId === nextPosition.fact.sourceSessionId)
          .flatMap((segment) => segment.samples)
          .map((sample) => ({ sequence: sample.sequence, bytes: sample.original.bytesBase64 })),
      ).toEqual([{ sequence: 1, bytes: nextPosition.bytesBase64 }]);
    } finally {
      vi.restoreAllMocks();
      await transport?.stop();
      await releaseLease?.();
      emulator.server.closeAllConnections();
      await new Promise<void>((resolve) => emulator.server.close(() => resolve()));
      if (container) await execute('docker', ['rm', '-f', container]);
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
