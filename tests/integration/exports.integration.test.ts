import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { createPool, MemoryObjectStore } from '../../packages/persistence/src/index.js';
import { canonicalDigest, canonicalize, entryHash, sha256 } from '../../packages/integrity/src/index.js';
import type {
  DecisionEvidenceBundle,
  EvidenceEnvelope,
  ExportRecord,
  FlightEvidenceBundle,
} from '../../packages/contracts/src/index.js';
import { proposedCommandLinkLoss } from '../../packages/contracts/fixtures/demo/v1/proposed.js';
import { openApiDocument } from '../../packages/contracts/src/openapi.js';
import { interpretEvidenceCut } from '../../packages/evidence/src/evidence-cut.mjs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { BundleVerificationError, verifyBundle } from '../../tools/verifier/index.mjs';
import { drainOwnedWork, settleOwnedWork } from './worker-queue.js';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('PostgreSQL issued decision evidence', () => {
  const prefix = `export-${randomUUID()}`;
  const pool = createPool(),
    admin = createPool(process.env.DATABASE_ADMIN_URL),
    worker = createPool(process.env.WORKER_DATABASE_URL);
  const store = new MemoryObjectStore();
  const execute = promisify(execFile);
  const tenants = [`tenant-${prefix}-alpha`, `tenant-${prefix}-beta`, `tenant-${prefix}-legacy`];
  const credentials = [`ledger-dev-${prefix}-alpha`, `ledger-dev-${prefix}-beta`, `ledger-dev-${prefix}-legacy`];
  const caps = [
    'input:write',
    'flight:create',
    'flight:read',
    'order:read',
    'evidence:read',
    'decision:write',
    'correction:write',
    'identity:write',
  ];
  let app: Awaited<ReturnType<typeof createApp>>;
  const headers = (index = 0) => ({ authorization: `Bearer ${credentials[index]}` });
  const writes = (suffix: string, index = 0) => ({ ...headers(index), 'idempotency-key': `${prefix}:${suffix}` });
  beforeAll(async () => {
    for (let index = 0; index < tenants.length; index++) {
      await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
        tenants[index],
        `Fictional export isolation ${index}`,
      ]);
      const id = `principal-${prefix}-${index}`;
      await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)", [
        id,
        tenants[index],
        'Fictional evidence operator',
        caps,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(credentials[index]!),
        id,
      ]);
      await admin.query("INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'worker',$4)", [
        `worker-${prefix}-${index}`,
        tenants[index],
        'Fictional export worker',
        caps,
      ]);
    }
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
  });
  afterAll(async () => {
    await settleOwnedWork(tenants, { objectStore: store });
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await worker.end();
  });
  async function drain() {
    await drainOwnedWork(admin, worker, tenants, { objectStore: store });
  }
  async function thread(id: string) {
    const response = await app.inject({ method: 'GET', url: `/v1/flights/${id}/timeline`, headers: headers() });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  async function decisionFixture(suffix: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/flights',
      headers: writes(`${suffix}:flight`),
      payload: { originationKey: `${prefix}:${suffix}`, label: 'Export interpretation flight' },
    });
    expect(created.statusCode).toBe(201);
    const flightId = created.json().flight.id as string;
    await drain();
    const bytes = Buffer.from(`Exact original observer bytes: ${suffix}\n`);
    const upload = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: writes(`${suffix}:upload`),
      payload: { byteLength: bytes.length, contentType: 'text/plain' },
    });
    expect(upload.statusCode).toBe(201);
    const uploadId = upload.json().upload.id;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${uploadId}/content`,
      headers: { ...writes(`${suffix}:bytes`), 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(stored.statusCode).toBe(200);
    const artifact = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadId}/finalize`,
      headers: writes(`${suffix}:finalize`),
    });
    expect(artifact.statusCode).toBe(201);
    // Keep the exact timestamp spelling: PostgreSQL's normalized value differs.
    const observed = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: writes(`${suffix}:input`),
      payload: {
        sourceId: `observer-${prefix}`,
        kind: 'flight.observation',
        occurredAt: '2026-10-01T12:00:00-05:00',
        effectiveAt: '2026-10-01T17:00:00Z',
        subject: { flightId },
        artifactId: artifact.json().artifact.id,
        payload: { title: 'Original landing claim', activity: 'landed', landingTime: '2026-10-01T17:00:00Z' },
      },
    });
    expect(observed.statusCode).toBe(201);
    await drain();
    const shown = await thread(flightId);
    const recorded = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: writes(`${suffix}:decision`),
      payload: {
        kind: 'decision.record',
        flightId,
        expectedRevision: shown.flight.revision,
        expectedBasisRevision: shown.flight.basisRevision,
        inputCut: shown.meta.inputCut,
        expectedDependencyBasis: shown.meta.dependencyBasis!,
        decision: { kind: 'review', note: 'Reviewed the retained observer claim.' },
      },
    });
    expect(recorded.statusCode).toBe(201);
    await drain();
    return {
      flightId,
      decisionId: recorded.json().command.id as string,
      eventId: observed.json().receipt.eventId as string,
      artifactId: artifact.json().artifact.id as string,
      bytes,
    };
  }
  function schema(method: string, path: string, status: string, value: unknown) {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const definition = (openApiDocument.paths as any)[path][method].responses[status].content['application/json']
      .schema;
    const validate = ajv.compile(definition);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
  }
  async function issue(fixture: { flightId: string; decisionId: string }, suffix: string, target = app) {
    return target.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: writes(suffix),
      payload: { flightId: fixture.flightId, decisionId: fixture.decisionId, scope: 'whole_tenant_prefixes' },
    });
  }

  async function retainedLegacyFixture() {
    const tenantId = tenants[2]!;
    const principalId = `principal-${prefix}-2`;
    const flightId = `${prefix}:legacy-flight`;
    const streamId = `${prefix}:legacy-stream`;
    const decisionId = `${prefix}:legacy-decision`;
    const id = `${prefix}:legacy-export`;
    const time = '2026-10-01T17:00:00.000Z';
    const cut = { streams: { [streamId]: 1 }, basisRevision: 1, principalRevision: 1 };
    const decision = {
      id: decisionId,
      flightId,
      actorId: principalId,
      kind: 'review',
      note: 'Retained review issued before the flight format upgrade.',
      recordedAt: time,
      renderedInputCut: cut,
      acceptedInputCut: cut,
      acceptedBasisRevision: 1,
    };
    const events: EvidenceEnvelope[] = [
      { eventId: `${prefix}:legacy-created`, type: 'flight.created', payload: { flightId } },
      {
        eventId: decisionId,
        type: 'decision.record',
        payload: {
          flightId,
          inputCut: cut,
          acceptedInputCut: cut,
          expectedBasisRevision: 1,
          decision: { kind: decision.kind, note: decision.note },
        },
      },
    ].map((event, index) => ({
      ...event,
      tenantId,
      streamId,
      sequence: String(index + 1),
      schemaVersion: 1,
      principalId,
      sourceId: null,
      sourceSessionId: null,
      occurredAt: null,
      effectiveAt: null,
      receivedAt: time,
      causationId: null,
      artifactId: null,
    }));
    let previousHash = '';
    const entries = events.map((event) => {
      const canonicalEnvelope = canonicalize(event);
      const envelopeDigest = sha256(canonicalEnvelope);
      const entry = {
        canonicalEnvelope,
        envelopeDigest,
        previousHash,
        entryHash: entryHash(tenantId, streamId, BigInt(event.sequence), previousHash, envelopeDigest),
        encodingVersion: 'ledger.v6.sha256.jcs.1',
      };
      previousHash = entry.entryHash;
      return entry;
    });
    const cuts = { rendered: cut, accepted: cut, issuance: { streams: { [streamId]: 2 } } };
    const source = await readFile(new URL('../../packages/evidence/src/evidence-cut.mjs', import.meta.url), 'utf8');
    const runtimeContract = {
      name: 'node' as const,
      major: 24 as const,
      moduleFormat: 'esm' as const,
      dependencies: [] as [],
      network: 'none' as const,
      interpretation: 'evidence-cut.1' as const,
      canonicalization: 'ledger.v6.sha256.jcs.1' as const,
    };
    const interpretations = {
      rendered: interpretEvidenceCut(entries, cuts.rendered, tenantId),
      accepted: interpretEvidenceCut(entries, cuts.accepted, tenantId),
      issuance: interpretEvidenceCut(entries, cuts.issuance, tenantId),
    };
    const sections = {
      streams: [
        {
          tenantId,
          id: streamId,
          name: `flight:${flightId}`,
          headSequence: '2',
          headHash: entries[1]!.entryHash,
          cutHeads: {
            rendered: { sequence: '1', hash: entries[0]!.entryHash },
            accepted: { sequence: '1', hash: entries[0]!.entryHash },
            issuance: { sequence: '2', hash: entries[1]!.entryHash },
          },
        },
      ],
      entries,
      receipts: [],
      artifacts: [],
      decision,
      actor: { id: principalId, authorityRevision: 1, historicalProfile: 'not_retained' as const },
      cuts,
      snapshot: {
        kind: 'export_time_sql_snapshot' as const,
        capturedAt: time,
        projectorVersion: 'thread.1' as const,
        projectionCut: cuts.issuance,
        projectionRevision: 2,
        flight: {
          id: flightId,
          label: 'Retained legacy flight',
          originationKey: flightId,
          revision: 2,
          basisRevision: 1,
          activity: 'planned' as const,
          coverage: 'unknown' as const,
          orderIds: [],
          sourceIds: [],
          unresolvedCount: 0,
          conflictCount: 0,
          outstandingWork: 0,
        },
        items: [],
        decisions: [decision],
        limitations: [],
      },
      interpreter: {
        name: 'evidence-cut.1' as const,
        sourceEncoding: 'utf8' as const,
        source,
        sourceSha256: sha256(source),
        runtimeContract,
        runtimeContractDigest: canonicalDigest(runtimeContract),
      },
      interpretations,
    };
    const counts = { events: 2, streams: 1, receipts: 0, artifacts: 0, artifactBytes: 0 };
    const limits = {
      maxEvents: 5000,
      maxStreams: 2000,
      maxArtifacts: 1024,
      maxArtifactBytes: 16 * 1024 * 1024,
      maxBundleBytes: 32 * 1024 * 1024,
    };
    const manifest: DecisionEvidenceBundle['manifest'] = {
      format: 'ledger.decision-evidence.1',
      exportId: id,
      tenantId,
      scope: 'whole_tenant_prefixes',
      flightId,
      decisionId,
      issuedBy: principalId,
      issuedAt: time,
      versions: { integrity: 'ledger.v6.sha256.jcs.1', interpretation: 'evidence-cut.1', snapshot: 'thread.1' },
      counts,
      limits,
      sectionDigests: Object.fromEntries(
        Object.entries(sections).map(([name, value]) => [name, canonicalDigest(value)]),
      ) as DecisionEvidenceBundle['manifest']['sectionDigests'],
      interpretationDigests: {
        rendered: canonicalDigest(interpretations.rendered),
        accepted: canonicalDigest(interpretations.accepted),
        issuance: canonicalDigest(interpretations.issuance),
      },
      limitations: [],
    };
    const bundle: DecisionEvidenceBundle = {
      format: manifest.format,
      manifest,
      manifestDigest: canonicalDigest(manifest),
      ...sections,
    };
    const bytes = Buffer.from(canonicalize(bundle));
    const summary = (name: keyof typeof interpretations) => ({
      eventCount: interpretations[name].events.length,
      digest: manifest.interpretationDigests[name],
      causalClosure: 'closed' as const,
      missingCausationIds: [],
    });
    const metadata: Omit<ExportRecord, 'format'> = {
      id,
      tenantId,
      flightId,
      decisionId,
      issuedBy: principalId,
      issuedAt: time,
      scope: 'whole_tenant_prefixes',
      byteLength: bytes.length,
      bundleSha256: sha256(bytes),
      manifestDigest: bundle.manifestDigest,
      snapshotDigest: manifest.sectionDigests.snapshot,
      anchorStatus: 'not_externally_anchored',
      interpretation: 'evidence-cut.1',
      counts,
      limits,
      cuts,
      interpretations: { rendered: summary('rendered'), accepted: summary('accepted'), issuance: summary('issuance') },
      addedAcceptedEventIds: [],
      limitations: [],
    };
    await admin.query("INSERT INTO subjects(id,tenant_id,kind,label) VALUES($1,$2,'flight',$3)", [
      flightId,
      tenantId,
      sections.snapshot.flight.label,
    ]);
    await admin.query('INSERT INTO streams(id,tenant_id,name,sequence,head_hash) VALUES($1,$2,$3,2,$4)', [
      streamId,
      tenantId,
      sections.streams[0]!.name,
      previousHash,
    ]);
    for (const [index, event] of events.entries()) {
      const entry = entries[index]!;
      await admin.query(
        'INSERT INTO journal_events(tenant_id,id,stream_id,stream_sequence,event_type,principal_id,received_at,payload,envelope_digest,previous_hash,entry_hash,encoding_version,immutable_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [
          tenantId,
          event.eventId,
          streamId,
          event.sequence,
          event.type,
          principalId,
          time,
          event.payload,
          entry.envelopeDigest,
          entry.previousHash,
          entry.entryHash,
          entry.encodingVersion,
          entry.canonicalEnvelope,
        ],
      );
    }
    await admin.query(
      'INSERT INTO flight_views(id,tenant_id,origination_key,label,revision,basis_revision) VALUES($1,$2,$1,$3,2,1)',
      [flightId, tenantId, sections.snapshot.flight.label],
    );
    await admin.query(
      'INSERT INTO decisions(id,tenant_id,flight_id,actor_id,kind,note,recorded_at,rendered_input_cut,accepted_input_cut,accepted_basis_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,1)',
      [decisionId, tenantId, flightId, principalId, decision.kind, decision.note, time, cut],
    );
    const objectKey = `${tenantId}/exports/${id}/bundle`;
    await store.putIfAbsent(objectKey, bytes, 'application/json');
    await admin.query(
      'INSERT INTO export_records(id,tenant_id,decision_id,flight_id,issued_by,issued_at,object_key,bundle_sha256,manifest_digest,byte_length,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        id,
        tenantId,
        decisionId,
        flightId,
        principalId,
        time,
        objectKey,
        metadata.bundleSha256,
        bundle.manifestDigest,
        bytes.length,
        metadata,
      ],
    );
    const request = { flightId, decisionId, scope: 'whole_tenant_prefixes' };
    await admin.query(
      'INSERT INTO idempotency_keys(tenant_id,principal_id,endpoint,producer_key,digest,effect_id) VALUES($1,$2,$3,$4,$5,$6)',
      [tenantId, principalId, '/v1/exports', `${prefix}:legacy:issue`, canonicalDigest(request), id],
    );
    return { id, bytes, metadata, request };
  }

  it('serves a retained v1 export and original retry without rewriting its stored metadata or bytes', async () => {
    const legacy = await retainedLegacyFixture();
    const record = { ...legacy.metadata, format: 'ledger.decision-evidence.1' };
    const metadata = await app.inject({ method: 'GET', url: `/v1/exports/${legacy.id}`, headers: headers(2) });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json().record).toEqual(record);
    const content = await app.inject({ method: 'GET', url: `/v1/exports/${legacy.id}/content`, headers: headers(2) });
    expect(content.statusCode, content.body).toBe(200);
    expect(content.headers['x-evidence-format']).toBe(record.format);
    expect(content.rawPayload).toEqual(legacy.bytes);
    expect(verifyBundle(content.json(), { expectedManifestDigest: record.manifestDigest }).status).toBe('verified');
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: writes('legacy:issue', 2),
      payload: legacy.request,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.headers['x-evidence-format']).toBe(record.format);
    expect(replay.json().record).toEqual(record);
    const listed = await app.inject({ method: 'GET', url: '/v1/exports', headers: headers(2) });
    expect(listed.json().records).toEqual([record]);
    expect(
      (await admin.query('SELECT metadata FROM export_records WHERE id=$1', [legacy.id])).rows[0].metadata,
    ).toEqual(legacy.metadata);
    expect(await store.get(`${record.tenantId}/exports/${legacy.id}/bundle`)).toEqual(legacy.bytes);
  });

  it('issues one immutable record under concurrent retries and rebuilds the named cut from verified journal bytes offline', async () => {
    const fixture = await decisionFixture('primary');
    const responses = await Promise.all([issue(fixture, 'primary:issue'), issue(fixture, 'primary:issue')]);
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(response.headers['x-evidence-format']).toBe('ledger.flight-evidence.2');
      expect(response.json().record.format).toBe('ledger.flight-evidence.2');
      schema('post', '/v1/exports', '201', response.json());
    }
    const accepted = responses[0]!.json();
    expect(responses[1]!.json().record).toEqual(accepted.record);
    expect(accepted.meta.effectId).toBe(accepted.record.id);
    expect(responses[0]!.headers['x-request-id']).toBe(accepted.meta.requestId);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: writes('primary:issue'),
      payload: { flightId: fixture.flightId, decisionId: randomUUID(), scope: 'whole_tenant_prefixes' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    const metadata = await app.inject({ method: 'GET', url: `/v1/exports/${accepted.record.id}`, headers: headers() });
    expect(metadata.statusCode).toBe(200);
    schema('get', '/v1/exports/{id}', '200', metadata.json());
    expect(metadata.json().record).toEqual(accepted.record);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/subject-exports/${accepted.record.id}`, headers: headers() }))
        .statusCode,
    ).toBe(404);
    const content = await app.inject({
      method: 'GET',
      url: `/v1/exports/${accepted.record.id}/content`,
      headers: headers(),
    });
    expect(content.statusCode).toBe(200);
    schema('get', '/v1/exports/{id}/content', '200', content.json());
    expect(content.headers['x-content-sha256']).toBe(sha256(content.rawPayload));
    expect(content.headers['x-evidence-format']).toBe('ledger.flight-evidence.2');
    expect(content.headers['x-manifest-sha256']).toBe(accepted.record.manifestDigest);
    expect(content.rawPayload.length).toBe(accepted.record.byteLength);
    expect(sha256(content.rawPayload)).toBe(accepted.record.bundleSha256);
    const bundle = content.json<FlightEvidenceBundle>();
    expect(bundle.format).toBe('ledger.flight-evidence.2');
    expect(bundle.manifest.subject).toEqual({ kind: 'flight', id: fixture.flightId });
    expect(bundle.basisManifest).toEqual({ status: 'not_retained' });
    const result = verifyBundle(bundle, { expectedManifestDigest: accepted.record.manifestDigest });
    expect(result.status).toBe('verified');
    expect(result.tenantId).toBe(tenants[0]);
    expect(bundle.decision.actorId).toBe(`principal-${prefix}-0`);
    expect(bundle.actor.authorityRevision).toBe(bundle.decision.renderedInputCut.principalRevision);
    const envelope = bundle.entries
      .map((entry: any) => JSON.parse(entry.canonicalEnvelope))
      .find((entry: any) => entry.eventId === fixture.eventId);
    expect(envelope.occurredAt).toBe('2026-10-01T12:00:00-05:00');
    expect(envelope.effectiveAt).toBe('2026-10-01T17:00:00Z');
    expect(Buffer.from(bundle.artifacts.find((item) => item.id === fixture.artifactId)!.bytesBase64, 'base64')).toEqual(
      fixture.bytes,
    );
    const tampered = structuredClone(bundle);
    tampered.artifacts[0]!.bytesBase64 = Buffer.from('Different source bytes').toString('base64');
    expect(() => verifyBundle(tampered, { expectedManifestDigest: accepted.record.manifestDigest })).toThrow(
      BundleVerificationError,
    );
    const proposed = await app.inject({
      method: 'POST',
      url: '/v1/inputs',
      headers: writes('primary:proposed-link'),
      payload: { ...proposedCommandLinkLoss, subject: { flightId: fixture.flightId }, artifactId: fixture.artifactId },
    });
    // The retired command-link input kind is no longer accepted.
    expect(proposed.statusCode, proposed.body).toBe(400);
    expect(
      (await admin.query("SELECT id FROM receipts WHERE tenant_id=$1 AND kind='command-link.status'", [tenants[0]]))
        .rows,
    ).toEqual([]);
    expect(bundle.interpretations.rendered.events.some((event: any) => event.eventId === fixture.decisionId)).toBe(
      false,
    );
    expect(bundle.interpretations.accepted.events.some((event: any) => event.eventId === fixture.decisionId)).toBe(
      false,
    );
    expect(bundle.interpretations.issuance.events.some((event: any) => event.eventId === fixture.decisionId)).toBe(
      true,
    );
    const directory = await mkdtemp(join(tmpdir(), 'ledger-evidence-rebuild-'));
    try {
      const bundlePath = join(directory, 'bundle.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(bundlePath, content.rawPayload);
      const rebuilt = join(directory, 'rebuilt');
      const output = await execute(process.execPath, [
        'tools/verifier/cli.mjs',
        bundlePath,
        '--expected-manifest-sha256',
        accepted.record.manifestDigest,
        '--rebuild-dir',
        rebuilt,
      ]);
      expect(JSON.parse(output.stdout).status).toBe('verified');
      for (const name of ['rendered', 'accepted', 'issuance'])
        expect(JSON.parse(await readFile(join(rebuilt, `${name}.json`), 'utf8'))).toEqual(bundle.interpretations[name]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/exports?flightId=${fixture.flightId}&decisionId=${fixture.decisionId}`,
      headers: headers(),
    });
    expect(listed.statusCode).toBe(200);
    schema('get', '/v1/exports', '200', listed.json());
    expect(listed.json().records).toHaveLength(1);
  });

  it('enforces tenant RLS for metadata, original bytes and issuance', async () => {
    const fixture = await decisionFixture('scope');
    const issued = await issue(fixture, 'scope:issue');
    expect(issued.statusCode).toBe(201);
    for (const suffix of ['', '/content'])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/exports/${issued.json().record.id}${suffix}`,
            headers: headers(1),
          })
        ).statusCode,
      ).toBe(404);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/exports',
      headers: writes('scope:wrong-tenant', 1),
      payload: { flightId: fixture.flightId, decisionId: fixture.decisionId, scope: 'whole_tenant_prefixes' },
    });
    expect(denied.statusCode).toBe(404);
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/exports?decisionId=${fixture.decisionId}`,
      headers: headers(1),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().records).toEqual([]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [tenants[1]]);
      expect((await client.query('SELECT id FROM export_records WHERE id=$1', [issued.json().record.id])).rows).toEqual(
        [],
      );
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("SELECT set_config('ledger.tenant_id',$1,true)", [tenants[0]]);
      await expect(
        client.query('DELETE FROM export_records WHERE id=$1', [issued.json().record.id]),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('preserves old issued bytes and decision cuts when a later correction creates a supplement', async () => {
    const fixture = await decisionFixture('correction');
    const first = await issue(fixture, 'correction:issue');
    expect(first.statusCode).toBe(201);
    const record = first.json().record;
    const original = await app.inject({ method: 'GET', url: `/v1/exports/${record.id}/content`, headers: headers() });
    const current = await thread(fixture.flightId);
    const corrected = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: writes('correction:command'),
      payload: {
        kind: 'evidence.correct',
        flightId: fixture.flightId,
        correctionOf: fixture.eventId,
        expectedRevision: current.flight.revision,
        expectedBasisRevision: current.flight.basisRevision,
        inputCut: current.meta.inputCut,
        expectedDependencyBasis: current.meta.dependencyBasis!,
        occurredAt: '2026-10-01T17:00:00Z',
        note: 'Late transcription correction after issuance.',
        payload: { activity: 'landed', landingTime: '2026-10-01T17:01:00Z' },
      },
    });
    expect(corrected.statusCode).toBe(201);
    await drain();
    const retained = await app.inject({ method: 'GET', url: `/v1/exports/${record.id}/content`, headers: headers() });
    expect(retained.rawPayload).toEqual(original.rawPayload);
    const retry = await issue(fixture, 'correction:issue');
    expect(retry.json().record).toEqual(record);
    const supplement = await issue(fixture, 'correction:supplement');
    expect(supplement.statusCode).toBe(201);
    const newer = supplement.json().record;
    expect(newer.id).not.toBe(record.id);
    expect(newer.manifestDigest).not.toBe(record.manifestDigest);
    expect(newer.interpretations.rendered).toEqual(record.interpretations.rendered);
    expect(newer.interpretations.accepted).toEqual(record.interpretations.accepted);
    const newerContent = await app.inject({
      method: 'GET',
      url: `/v1/exports/${newer.id}/content`,
      headers: headers(),
    });
    expect(verifyBundle(newerContent.json(), { expectedManifestDigest: newer.manifestDigest }).status).toBe('verified');
    expect(
      newerContent
        .json()
        .interpretations.issuance.events.some((event: any) => event.eventId === corrected.json().command.id),
    ).toBe(true);
    expect(
      original
        .json()
        .interpretations.issuance.events.some((event: any) => event.eventId === corrected.json().command.id),
    ).toBe(false);
  });
});
