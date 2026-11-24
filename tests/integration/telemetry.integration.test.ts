import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApp } from '../../apps/api/src/index.js';
import { authenticate, createPool, MemoryObjectStore, withScope } from '../../packages/persistence/src/index.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { openApiDocument } from '../../packages/contracts/src/openapi.js';
import { parseEventStream } from '../../packages/contracts/src/event-stream.js';
import type { TelemetrySegment, TelemetrySegmentDescriptor } from '../../packages/contracts/src/index.js';
import { verifyBundle } from '../../tools/verifier/index.mjs';
import { drainOwnedWork, settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL durable telemetry and authenticated resume', () => {
  const prefix = `telemetry-${randomUUID()}`,
    tenant = `tenant-${prefix}`,
    otherTenant = `tenant-other-${prefix}`,
    actor = `actor-${prefix}`,
    viewer = `viewer-${prefix}`;
  const credential = `ledger-dev-${prefix}`,
    viewerCredential = `ledger-dev-viewer-${prefix}`,
    otherCredential = `ledger-dev-other-${prefix}`;
  const pool = createPool(),
    admin = createPool(process.env.DATABASE_ADMIN_URL),
    worker = createPool(process.env.WORKER_DATABASE_URL),
    store = new MemoryObjectStore();
  let app: Awaited<ReturnType<typeof createApp>>, base: string;
  const headers = (credentialValue = credential) => ({ authorization: `Bearer ${credentialValue}` });
  const write = (credentialValue = credential) => ({ ...headers(credentialValue), 'idempotency-key': randomUUID() });
  const caps = [
    'input:write',
    'flight:create',
    'flight:read',
    'order:read',
    'evidence:read',
    'decision:write',
    'correction:write',
    'identity:write',
    'authority:write',
  ];
  beforeAll(async () => {
    for (const id of [tenant, otherTenant])
      await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, 'Fictional telemetry isolation']);
    for (const [id, t, c] of [
      [actor, tenant, credential],
      [viewer, tenant, viewerCredential],
      [`other-${actor}`, otherTenant, otherCredential],
    ]) {
      await admin.query(
        "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Synthetic telemetry operator','human',$3)",
        [id, t, caps],
      );
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [sha256(c), id]);
    }
    await admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,'Synthetic telemetry worker','worker',$3)",
      [`worker-${prefix}`, tenant, caps],
    );
    app = await createApp({ pool, objectStore: store, env: 'test' });
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await settleOwnedWork([tenant, otherTenant], { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await worker.end();
  });
  async function call(method: string, url: string, payload?: unknown, customHeaders = headers()) {
    return app.inject({ method: method as any, url, headers: customHeaders, payload: payload as any });
  }
  async function flight() {
    const made = await call(
      'POST',
      '/v1/flights',
      { originationKey: randomUUID(), label: 'Telemetry observed coordinates' },
      write(),
    );
    expect(made.statusCode).toBe(201);
    return made.json().flight.id as string;
  }
  async function drain() {
    await drainOwnedWork(admin, worker, [tenant, otherTenant], { objectStore: store });
  }
  function blob(
    session: string,
    sequences: { sequence: number; timestamp?: number; longitude?: number }[],
  ): TelemetrySegment {
    return {
      format: 'ledger.telemetry-segment.1',
      sourceId: 'synthetic-dji',
      sourceSessionId: session,
      deviceId: 'fictional-device',
      gatewayId: 'fictional-dock',
      decoderVersion: 'dji-osd.synthetic.1',
      fidelity: 'synthetic_contract',
      coordinateReference: 'WGS84',
      sequenceBasis: 'adapter_capture',
      sessionStartSequence: 1,
      samples: sequences.map(({ sequence, timestamp = 1790856000000 + sequence * 1000, longitude = -87.6 }) => {
        const raw = Buffer.from(
          ` ${JSON.stringify({ tid: `message-${sequence}`, bid: 'batch', gateway: 'fictional-dock', timestamp, data: { latitude: 41.8, longitude, height: 183, horizontal_speed: 2 } })}\r\n`,
        );
        return {
          sequence,
          occurredAt: new Date(timestamp).toISOString(),
          latitude: 41.8,
          longitude,
          altitudeMeters: 183,
          altitudeReference: 'ellipsoid',
          speedMetersPerSecond: 2,
          original: { topic: 'thing/product/fictional-device/osd', bytesBase64: raw.toString('base64') },
        };
      }),
    };
  }
  async function retain(
    flightId: string | undefined,
    value: TelemetrySegment,
    raw = Buffer.from(JSON.stringify(value)),
    descriptorOverrides: Record<string, unknown> = {},
  ) {
    const upload = await call(
      'POST',
      '/v1/uploads',
      { byteLength: raw.length, contentType: 'application/json' },
      write(),
    );
    expect(upload.statusCode).toBe(201);
    const id = upload.json().upload.id;
    const bytes = await call('PUT', `/v1/uploads/${id}/content`, raw, {
      ...write(),
      'content-type': 'application/octet-stream',
    });
    expect(bytes.statusCode).toBe(200);
    const finalized = await call('POST', `/v1/uploads/${id}/finalize`, undefined, write());
    expect(finalized.statusCode).toBe(201);
    const times = value.samples.map((s) => Date.parse(s.occurredAt)),
      sequences = value.samples.map((s) => s.sequence);
    const descriptor: TelemetrySegmentDescriptor = {
      format: value.format,
      deviceId: value.deviceId,
      gatewayId: value.gatewayId,
      decoderVersion: value.decoderVersion,
      sequenceBasis: value.sequenceBasis,
      sessionStartSequence: value.sessionStartSequence,
      sampleCount: value.samples.length,
      firstSequence: Math.min(...sequences),
      lastSequence: Math.max(...sequences),
      firstOccurredAt: new Date(Math.min(...times)).toISOString(),
      lastOccurredAt: new Date(Math.max(...times)).toISOString(),
      ...descriptorOverrides,
    };
    const input = {
      sourceId: value.sourceId,
      sourceSessionId: value.sourceSessionId,
      kind: 'telemetry.segment',
      occurredAt: descriptor.lastOccurredAt,
      subject: flightId ? { flightId } : {},
      artifactId: finalized.json().artifact.id,
      fidelity: 'synthetic_contract',
      payload: descriptor,
    };
    const response = await call('POST', '/v1/inputs', input, write());
    return { response, input, raw, artifact: finalized.json().artifact };
  }
  async function snapshot(id: string) {
    const result = await call('GET', `/v1/flights/${id}/telemetry`);
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  }
  async function watch(id: string, cursor: string, credentialValue = credential) {
    const controller = new AbortController(),
      response = await fetch(`${base}/v1/flights/${id}/watch?cursor=${cursor}`, {
        headers: headers(credentialValue),
        signal: controller.signal,
      });
    expect(response.status).toBe(200);
    // The frames are read only when the caller asks for one. Until then the response is kept with them: fetch cancels
    // the unread body of a response that has been garbage collected, which ends the stream before its first frame.
    return { controller, response, frames: parseEventStream(response.body!) };
  }
  async function next(stream: Awaited<ReturnType<typeof watch>>) {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        stream.frames.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            stream.controller.abort();
            reject(new Error('Watch frame deadline exceeded'));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  const close = (stream: Awaited<ReturnType<typeof watch>>) => stream.controller.abort();
  // Collects garbage until an object dropped now has been finalized, so finalizers due for anything else unreachable
  // by now have run too.
  async function collectGarbage() {
    setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    let finalized = false;
    const registry = new FinalizationRegistry(() => (finalized = true));
    registry.register({}, undefined);
    while (!finalized) {
      collect();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  it('retains pending metadata, commits independently validated WGS84 claims and advances accepted decision basis once per segment', async () => {
    const id = await flight();
    await drain();
    const shown = (await call('GET', `/v1/flights/${id}/timeline`)).json(),
      value = blob(randomUUID(), [{ sequence: 1 }, { sequence: 3 }]);
    const accepted = await retain(id, value);
    expect(accepted.response.statusCode, accepted.response.body).toBe(201);
    const receipt = accepted.response.json().receipt;
    const pending = await snapshot(id);
    expect(pending.samples).toEqual([]);
    expect(pending.segments[0].processing.status).toBe('pending');
    expect(pending.meta.inputCut.basisRevision).toBe(shown.flight.basisRevision + 1);
    expect(pending.flightRevision).toBe(shown.flight.revision);
    const stale = await call(
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        flightId: id,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
        inputCut: shown.meta.inputCut,
        expectedDependencyBasis: shown.meta.dependencyBasis!,
        decision: { kind: 'review', note: 'Stale pending segment basis' },
      },
      write(),
    );
    expect(stale.statusCode).toBe(409);
    await drain();
    const durable = await snapshot(id);
    expect(durable.status).toBe('durable_only');
    expect(durable.samples).toHaveLength(2);
    expect(durable.gaps).toMatchObject([{ fromSequence: 2, toSequence: 2 }]);
    expect(durable.sessions[0]).toMatchObject({
      sequenceBasis: 'adapter_capture',
      gapCount: 1,
      missingSequenceCount: 1,
      highestSequence: 3,
    });
    expect(durable.samples[0]).toMatchObject({
      receiptId: receipt.id,
      eventId: receipt.eventId,
      artifactId: accepted.artifact.id,
      durable: true,
      altitudeReference: 'ellipsoid',
    });
    expect(durable.samples[0].original).toEqual({ topic: 'thing/product/fictional-device/osd' });
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const definition = (openApiDocument.paths as any)['/v1/flights/{id}/telemetry'].get.responses['200'].content[
        'application/json'
      ].schema,
      validate = ajv.compile(definition);
    expect(validate(durable), JSON.stringify(validate.errors)).toBe(true);
    const retained = await call('GET', `/v1/artifacts/${accepted.artifact.id}/content`);
    expect(retained.rawPayload).toEqual(accepted.raw);
    expect(retained.headers['x-content-sha256']).toBe(sha256(accepted.raw));
    const data = (
      await admin.query(
        'SELECT s.name,ST_SRID(t.position::geometry) AS srid,ST_X(t.position::geometry) AS longitude FROM journal_events e JOIN streams s ON s.id=e.stream_id JOIN telemetry_segments g ON g.event_id=e.id JOIN telemetry_samples t ON t.segment_id=g.id WHERE e.id=$1',
        [receipt.eventId],
      )
    ).rows;
    expect(data[0].name.startsWith('telemetry:')).toBe(true);
    expect(data[0]).toMatchObject({ srid: 4326, longitude: -87.6 });
    const thread = (await call('GET', `/v1/flights/${id}/timeline`)).json();
    expect(durable.flightRevision).toBe(thread.flight.revision);
    expect(durable.flightRevision).toBe(pending.flightRevision + 1);
    expect(thread.flight.activity).toBe('planned');
    expect(thread.items.find((item: any) => item.id === receipt.eventId)?.artifactId).toBe(accepted.artifact.id);
    const decision = await call(
      'POST',
      '/v1/commands',
      {
        kind: 'decision.record',
        flightId: id,
        expectedRevision: thread.flight.revision,
        expectedBasisRevision: thread.flight.basisRevision,
        inputCut: thread.meta.inputCut,
        expectedDependencyBasis: thread.meta.dependencyBasis!,
        decision: { kind: 'review', note: 'Reviewed durable coordinates' },
      },
      write(),
    );
    expect(decision.statusCode).toBe(201);
    await drain();
    const issued = await call(
      'POST',
      '/v1/exports',
      { flightId: id, decisionId: decision.json().command.id, scope: 'whole_tenant_prefixes' },
      write(),
    );
    expect(issued.statusCode, issued.body).toBe(201);
    const content = await call('GET', `/v1/exports/${issued.json().record.id}/content`);
    expect(content.statusCode).toBe(200);
    expect(verifyBundle(content.json(), { expectedManifestDigest: issued.json().record.manifestDigest }).status).toBe(
      'verified',
    );
  });
  it('rejects changed session baseline/gateway before publication and isolates telemetry under RLS', async () => {
    const id = await flight(),
      session = randomUUID();
    expect((await retain(id, blob(session, [{ sequence: 1 }]))).response.statusCode).toBe(201);
    const baseline = await retain(id, blob(session, [{ sequence: 2 }]), undefined, { sessionStartSequence: 2 });
    expect(baseline.response.statusCode).toBe(409);
    expect(baseline.response.json().error.code).toBe('telemetry_session_conflict');
    expect(
      (await retain(id, blob(session, [{ sequence: 2 }]), undefined, { gatewayId: 'different-dock' })).response
        .statusCode,
    ).toBe(409);
    expect((await call('GET', `/v1/flights/${id}/telemetry`, undefined, headers(otherCredential))).statusCode).toBe(
      404,
    );
    const outsider = await authenticate(pool, { token: otherCredential });
    await withScope(pool, outsider!, async (c) => {
      expect((await c.query('SELECT id FROM telemetry_segments WHERE tenant_id=$1', [tenant])).rows).toEqual([]);
      expect((await c.query('SELECT id FROM telemetry_samples WHERE tenant_id=$1', [tenant])).rows).toEqual([]);
    });
    const receipt = (await snapshot(id)).segments[0];
    const principal = await authenticate(pool, { token: credential });
    await expect(
      withScope(pool, principal!, (c) =>
        c.query("UPDATE telemetry_segments SET descriptor='{}' WHERE id=$1", [receipt.id]),
      ),
    ).rejects.toThrow();
  });
  it('reads a bounded historical occurrence window beyond the recent snapshot without crossing flight or tenant scope', async () => {
    const id = await flight();
    const session = randomUUID();
    const start = Date.parse('2026-10-18T14:00:00.000Z');
    for (const sequences of [
      [
        { sequence: 1, timestamp: start },
        { sequence: 2, timestamp: start + 10_000 },
      ],
      Array.from({ length: 120 }, (_, index) => ({ sequence: index + 3, timestamp: start + 600_000 + index * 1000 })),
      Array.from({ length: 120 }, (_, index) => ({
        sequence: index + 123,
        timestamp: start + 1_200_000 + index * 1000,
      })),
    ])
      expect((await retain(id, blob(session, sequences))).response.statusCode).toBe(201);
    await drain();
    const recent = await snapshot(id);
    expect(recent.samples).toHaveLength(240);
    expect(recent.samples.some((sample: { sequence: number }) => sample.sequence <= 2)).toBe(false);
    expect(recent.window.occurrence).toBeUndefined();
    const query = new URLSearchParams({ around: '2026-10-18T14:00:05.000Z', windowSeconds: '10' });
    const historical = await call('GET', `/v1/flights/${id}/telemetry?${query}`);
    expect(historical.statusCode, historical.body).toBe(200);
    expect(historical.json().samples.map((sample: { sequence: number }) => sample.sequence)).toEqual([1, 2]);
    expect(historical.json().window).toMatchObject({
      truncated: false,
      occurrence: {
        around: '2026-10-18T14:00:05.000Z',
        from: '2026-10-18T13:59:55.000Z',
        until: '2026-10-18T14:00:15.000Z',
      },
    });
    expect(
      (await call('GET', `/v1/flights/${id}/telemetry?${query}`, undefined, headers(otherCredential))).statusCode,
    ).toBe(404);
    const anotherFlight = await flight();
    expect((await call('GET', `/v1/flights/${anotherFlight}/telemetry?${query}`)).json().samples).toEqual([]);
    const emptyQuery = new URLSearchParams({ around: '2026-10-18T13:00:00.000Z' });
    expect((await call('GET', `/v1/flights/${id}/telemetry?${emptyQuery}`)).json().samples).toEqual([]);
    for (const invalid of ['windowSeconds=30', 'around=not-a-date', `${query}&windowSeconds=301`])
      expect((await call('GET', `/v1/flights/${id}/telemetry?${invalid}`)).statusCode).toBe(400);
  });
  it('resumes from a consistent snapshot across intake and worker completion without exposing original byte payloads', async () => {
    const id = await flight();
    await drain();
    const before = await snapshot(id),
      stream = await watch(id, before.cursor);
    // Garbage is collected before the first read, as a full run does at some point: the stream must still be open.
    await collectGarbage();
    try {
      const accepted = await retain(id, blob(randomUUID(), [{ sequence: 1 }]));
      const first = await next(stream);
      expect(first.value?.event).toBe('telemetry.updated');
      const data = JSON.parse(first.value!.data);
      expect(data.type).toBe('telemetry.updated');
      expect(data.receiptId).toBe(accepted.response.json().receipt.id);
      expect(first.value?.id).toBe(data.cursor);
      expect(JSON.stringify(data)).not.toMatch(/bytesBase64|latitude|longitude|ledger-dev|Bearer/);
      await drain();
      const second = await next(stream);
      expect(JSON.parse(second.value!.data).revision).toBeGreaterThan(data.revision);
      close(stream);
      const resumed = await watch(id, data.cursor);
      try {
        expect((await next(resumed)).value?.id).toBe(second.value?.id);
      } finally {
        close(resumed);
      }
    } finally {
      close(stream);
    }
  });
});
