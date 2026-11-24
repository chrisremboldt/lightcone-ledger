import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import {
  FINDING_PACKET_FORMAT,
  FINDING_PACKET_LIMITS,
  FindingPacketSchema,
  FindingPacketV2Schema,
  type Capability,
  type EvidenceEnvelope,
  type FindingPacket,
  type FindingPacketRecord,
  type FindingPacketV2,
  type OrganizationCoverageResponse,
  type SmsFindingPromotionResponse,
  type SmsRecordDetailResponse,
  type SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  BATTERY_RESERVE_LEAF_ID,
  EXAMPLE_OPERATIONS_PACK_ID,
} from '../../packages/pack-example-operations/src/index.js';
import { canonicalDigest, canonicalize, sha256 } from '../../packages/integrity/src/index.js';
import { assembleFindingPacket } from '../../packages/evidence/src/finding-packet-assembly.js';
import { loadFindingPacketSources } from '../../packages/evidence/src/finding-packets.js';
import {
  appendEvent,
  createPool,
  MemoryObjectStore,
  withScope,
  writeBoundedObject,
  type AuthContext,
} from '../../packages/persistence/src/index.js';
import { runOwnedWork, settleOwnedWork } from './worker-queue.js';

// A packet for a battery-reserve finding from the example pack, issued through the public API. The packet code names
// no rule; this test names the example pack only to adopt it.
type Role = 'safety' | 'executive' | 'source' | 'worker';
const people: Record<Role, { kind: string; capabilities: Capability[] }> = {
  safety: {
    kind: 'human',
    capabilities: [
      'sms:read',
      'sms:write',
      'sms:configure',
      'decision:write',
      'evidence:read',
      'input:write',
      'flight:read',
      'authority:write',
      'pack:adopt',
      'risk:accept:low',
      'risk:accept:medium',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  source: { kind: 'source', capabilities: ['input:write', 'flight:read', 'evidence:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

// Stands in for storage whose kept bytes changed after issue.
class TamperableStore extends MemoryObjectStore {
  readonly tampered = new Set<string>();
  override async get(key: string, options?: Parameters<MemoryObjectStore['get']>[1]): Promise<Uint8Array> {
    const bytes = await super.get(key, options);
    if (this.tampered.has(key)) bytes[0] = bytes[0]! ^ 1;
    return bytes;
  }
}

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Finding packets on PostgreSQL', () => {
  const store = new TamperableStore();
  const prefix = `finding-packet-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-telemetry`;
  const tail = 'fictional-tail-28';
  let app: Awaited<ReturnType<typeof createApp>>;
  const tenants = {} as Record<'a' | 'b', { id: string; who: Record<Role, AuthContext>; artifactId: string }>;
  let firstReading: { id: string; eventId: string };

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown, key = randomUUID()) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': key },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function command(principal: AuthContext, payload: unknown) {
    const response = await call(principal, 'POST', '/v1/commands', payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }

  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const completed = await runOwnedWork(admin, workerPool, [prefix]);
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id LIKE $1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id LIKE $1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [`${prefix}%`],
      );
      if (Number(pending.rows[0].count) === 0) return;
      if (!completed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }

  const originalLog = Buffer.from(JSON.stringify({ entered: 'fictional battery log' }));
  async function upload(principal: AuthContext): Promise<string> {
    const bytes = originalLog;
    const created = await call(principal, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(principal, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function tenant(name: string, mode: 'shadow' | 'active') {
    const tenantId = `${prefix}:${name}`;
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, `Fictional ${name}`]);
    const who = {} as Record<Role, AuthContext>;
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role} of ${name}`,
        kind: person.kind,
        revision: 1,
        capabilities: person.capabilities,
      };
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        who[role].id,
        tenantId,
        who[role].name,
        person.kind,
        person.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${who[role].id}`),
        who[role].id,
      ]);
    }
    const current = await call(who.safety, 'GET', `/v1/authority/principals/${encodeURIComponent(who.source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    await command(who.safety, {
      kind: 'authority.update',
      principalId: who.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: [{ sourceId, observationType: 'battery.state' }],
    });
    const shown = await call(who.safety, 'GET', '/v1/organization/coverage');
    const pack = await call(who.safety, 'GET', `/v1/rule-packs/${EXAMPLE_OPERATIONS_PACK_ID}/versions/1`);
    expect(pack.statusCode, pack.body).toBe(200);
    const now = Date.now();
    await command(who.safety, {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        pack.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the example procedures for fictional testing.',
        mode,
      ),
      parameters: { [BATTERY_RESERVE_LEAF_ID]: { limit: 30 } },
    });
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the matrix for fictional testing.' });
    await settle();
    return { id: tenantId, who, artifactId: await upload(who.source) };
  }

  async function submit(t: (typeof tenants)['a'], sourceEventId: string, percent: number, occurredAt: string) {
    const response = await call(t.who.source, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'battery.state',
        version: 1,
        subject: { kind: 'aircraft', id: tail, scope: 'source' },
        occurredAt,
        sourceEventId,
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: t.artifactId,
        values: { totalRemainingPercent: percent },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
    return response.json().receipt as { id: string; eventId: string };
  }

  async function finding(t: (typeof tenants)['a']): Promise<SubjectFindingRecord> {
    const query = new URLSearchParams({ subjectKind: 'aircraft', subjectId: tail, subjectScope: 'source', sourceId });
    const response = await call(t.who.safety, 'GET', `/v1/findings?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const [found] = response.json().findings as SubjectFindingRecord[];
    expect(found).toBeDefined();
    return found!;
  }

  async function issue(t: (typeof tenants)['a'], findingId: string, key = randomUUID()) {
    const response = await call(t.who.safety, 'POST', '/v1/finding-packets', { findingId }, key);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['x-evidence-format']).toBe('ledger.finding-packet.2');
    return response.json().record as FindingPacketRecord;
  }

  async function content(t: (typeof tenants)['a'], record: FindingPacketRecord): Promise<FindingPacketV2> {
    const response = await call(t.who.safety, 'GET', `/v1/finding-packets/${record.id}/content`);
    expect(response.statusCode, response.body).toBe(200);
    expect(sha256(response.rawPayload)).toBe(record.packetSha256);
    expect(response.headers['x-manifest-sha256']).toBe(record.manifestDigest);
    expect(response.headers['x-evidence-format']).toBe(record.format);
    const packet = response.json() as FindingPacketV2;
    const ajv = new Ajv({ strict: false });
    (addFormats as unknown as (instance: Ajv) => void)(ajv);
    const schema = record.format === FINDING_PACKET_FORMAT ? FindingPacketSchema : FindingPacketV2Schema;
    expect(ajv.validate(schema, packet), JSON.stringify(ajv.errors)).toBe(true);
    expect(canonicalDigest(packet.manifest)).toBe(packet.manifestDigest);
    expect(verifyDownloaded(response.rawPayload, record.manifestDigest)).toMatchObject({
      status: 'verified',
      findingId: record.findingId,
      manifestDigest: record.manifestDigest,
      counts: record.counts,
    });
    return packet;
  }

  // The offline verifier CLI, run on the downloaded bytes in a separate process with an empty environment.
  function verifyDownloaded(bytes: Uint8Array, manifestDigest: string) {
    const directory = mkdtempSync(join(tmpdir(), 'ledger-finding-packet-'));
    try {
      const path = join(directory, 'packet.json');
      writeFileSync(path, bytes);
      const cli = fileURLToPath(new URL('../../tools/verifier/finding-packet-cli.mjs', import.meta.url));
      const args = [cli, path, '--expected-manifest-sha256', manifestDigest];
      try {
        return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', cwd: directory, env: {} }));
      } catch (error) {
        // A failed verification exits non-zero; its output names the failing check.
        return JSON.parse((error as { stdout: string }).stdout);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /**
   * Issues a version 1 packet the way Ledger issued them before version 2: from the same records, with digests of the
   * source originals only. It stands in for a packet issued earlier.
   */
  async function issueVersionOne(t: (typeof tenants)['a'], findingId: string): Promise<FindingPacketRecord> {
    return withScope(pool, t.who.safety, async (client, principal) => {
      const sources = await loadFindingPacketSources(client, principal.tenantId, findingId);
      const id = randomUUID();
      let bytes!: Buffer;
      let packet!: FindingPacket;
      const event = await appendEvent(client, principal, {
        id,
        type: 'finding-packet.issue',
        stream: `finding-packet:${findingId}`,
        payload: ({ receivedAt }) => {
          packet = assembleFindingPacket(sources, { packetId: id, issuedBy: principal.id, issuedAt: receivedAt });
          bytes = Buffer.from(canonicalize(packet), 'utf8');
          return { kind: 'finding-packet.issue', packetId: id, findingId, format: FINDING_PACKET_FORMAT };
        },
      });
      const record: FindingPacketRecord = {
        id,
        format: FINDING_PACKET_FORMAT,
        tenantId: principal.tenantId,
        findingId,
        subjectKey: sources.finding.subjectKey,
        eventId: event.id,
        issuedBy: principal.id,
        issuedAt: packet.manifest.issuedAt,
        byteLength: bytes.length,
        packetSha256: sha256(bytes),
        manifestDigest: packet.manifestDigest,
        counts: packet.manifest.counts,
        limits: { ...FINDING_PACKET_LIMITS },
      };
      const key = `${principal.tenantId}/finding-packets/${id}/packet`;
      await writeBoundedObject(store, key, bytes, 'application/json', 10000);
      await client.query(
        `INSERT INTO finding_packet_records(id,tenant_id,finding_id,subject_key,format,event_id,idempotency_key,
           issued_by,issued_at,packet_object_key,packet_sha256,manifest_digest,byte_length,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          principal.tenantId,
          findingId,
          record.subjectKey,
          record.format,
          event.id,
          randomUUID(),
          principal.id,
          record.issuedAt,
          key,
          record.packetSha256,
          record.manifestDigest,
          record.byteLength,
          record,
        ],
      );
      return record;
    });
  }

  const envelopes = (packet: FindingPacket | FindingPacketV2) =>
    packet.events.map((entry) => JSON.parse(entry.canonicalEnvelope) as EvidenceEnvelope);

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: store });
    await app.ready();
    tenants.a = await tenant('a', 'shadow');
    tenants.b = await tenant('b', 'active');
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('issues a packet for a battery-reserve finding with its evaluation, observation, adoption and mode', async () => {
    const a = tenants.a;
    const reading = await submit(a, 'battery-1', 12, '2026-11-03T09:30:00.000Z');
    firstReading = reading;
    const found = await finding(a);
    expect(found).toMatchObject({ ruleId: BATTERY_RESERVE_LEAF_ID, mode: 'shadow' });
    const key = randomUUID();
    const record = await issue(a, found.id, key);
    expect(record).toMatchObject({ findingId: found.id, tenantId: a.id, issuedBy: a.who.safety.id });
    // The same key replays the same packet; the record reads back as issued.
    expect(await issue(a, found.id, key)).toEqual(record);
    const read = await call(a.who.safety, 'GET', `/v1/finding-packets/${record.id}`);
    expect(read.json().record).toEqual(record);

    const packet = await content(a, record);
    const evaluation = packet.manifest.evaluations.at(-1)!;
    expect(packet.manifest.finding).toMatchObject({
      id: found.id,
      packId: EXAMPLE_OPERATIONS_PACK_ID,
      ruleId: BATTERY_RESERVE_LEAF_ID,
      latestEvaluationId: found.latestEvaluation.id,
    });
    expect(evaluation).toMatchObject({
      id: found.latestEvaluation.id,
      digest: canonicalDigest(found.latestEvaluation),
      mode: 'shadow',
      observations: [{ observationId: reading.eventId, receiptId: reading.id, artifactId: a.artifactId }],
    });
    expect(packet.manifest.statements[0]).toMatch(/adopted in shadow/);
    const recorded = envelopes(packet).find((event) => event.eventId === evaluation.id)!;
    expect(recorded.payload.evaluation).toMatchObject({
      parameters: { limit: 30 },
      adoption: { mode: 'shadow' },
      outcome: 'attention',
    });
    const adoption = envelopes(packet).find((event) => event.eventId === evaluation.adoptionId)!;
    expect(adoption.type).toBe('rule-pack.adopt');
    expect(packet.receipts.map((item) => item.id)).toEqual([reading.id]);
    expect(packet.artifacts.map((item) => item.id)).toEqual([a.artifactId]);
    // Version 2 carries the original bytes the observation came from, checked against the receipt's source.
    expect(Buffer.from(packet.artifacts[0]!.bytesBase64!, 'base64')).toEqual(originalLog);
    expect(packet.manifest.leftOutOriginals).toEqual([]);
    expect(record).toMatchObject({
      format: 'ledger.finding-packet.2',
      counts: { originalBytes: originalLog.byteLength, leftOutOriginals: 0 },
      limits: { maxOriginalBytes: 1048576 },
    });

    // The issue is kept as a record and appears in the journal with who and when.
    const row = (
      await admin.query('SELECT * FROM finding_packet_records WHERE tenant_id=$1 AND id=$2', [a.id, record.id])
    ).rows[0];
    expect(row).toMatchObject({
      finding_id: found.id,
      subject_key: found.subjectKey,
      event_id: record.eventId,
      idempotency_key: key,
      issued_by: a.who.safety.id,
      packet_sha256: record.packetSha256,
      manifest_digest: record.manifestDigest,
      byte_length: record.byteLength,
    });
    const journal = (
      await admin.query(
        'SELECT event_type,principal_id,received_at,payload FROM journal_events WHERE tenant_id=$1 AND id=$2',
        [a.id, record.eventId],
      )
    ).rows[0];
    expect(journal).toMatchObject({
      event_type: 'finding-packet.issue',
      principal_id: a.who.safety.id,
      payload: { findingId: found.id, packetId: record.id, manifestDigest: record.manifestDigest },
    });
    expect(journal.received_at.toISOString()).toBe(record.issuedAt);
    await expect(
      admin.query('UPDATE finding_packet_records SET byte_length=1 WHERE id=$1', [record.id]),
    ).rejects.toThrow();

    // Issued packets are listed for their finding, newest first and paged.
    const second = await issue(a, found.id);
    const page = await call(
      a.who.safety,
      'GET',
      `/v1/finding-packets?findingId=${encodeURIComponent(found.id)}&limit=1`,
    );
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().records).toEqual([second]);
    expect(page.json().page).toMatchObject({ limit: 1, returned: 1, hasMore: true });
    const rest = await call(
      a.who.safety,
      'GET',
      `/v1/finding-packets?findingId=${encodeURIComponent(found.id)}&limit=1&cursor=${page.json().page.nextCursor}`,
    );
    expect(rest.json().records).toEqual([record]);
    expect(rest.json().page.hasMore).toBe(false);

    // Kept bytes that differ from the recorded content digest are refused.
    store.tampered.add(`${a.id}/finding-packets/${second.id}/packet`);
    const tampered = await call(a.who.safety, 'GET', `/v1/finding-packets/${second.id}/content`);
    expect(tampered.statusCode).toBe(409);
    expect(tampered.json().error.code).toBe('finding_packet_integrity_failure');

    // Records, contents and lists stay within their tenant.
    const b = tenants.b.who.safety;
    expect((await call(b, 'GET', `/v1/finding-packets/${record.id}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', `/v1/finding-packets/${record.id}/content`)).statusCode).toBe(404);
    const otherList = await call(b, 'GET', `/v1/finding-packets?findingId=${encodeURIComponent(found.id)}`);
    expect(otherList.json().records).toEqual([]);
    expect((await call(b, 'POST', '/v1/finding-packets', { findingId: found.id })).statusCode).toBe(404);
    const unknown = await call(a.who.safety, 'POST', '/v1/finding-packets', { findingId: 'finding:missing' });
    expect(unknown.statusCode).toBe(404);
  });

  it('carries corrections within the cut and the hazard opened from the finding with its assessment', async () => {
    const a = tenants.a;
    // A later reading is read, then withdrawn; the rule returns to the reading it read before.
    const later = await submit(a, 'battery-2', 8, '2026-11-03T09:40:00.000Z');
    await command(a.who.source, {
      kind: 'observation.withdraw',
      observationId: later.eventId,
      reason: 'The fictional reading came from the wrong aircraft.',
    });
    await settle();
    const found = await finding(a);
    const shown = (
      await call(a.who.safety, 'GET', `/v1/sms/findings/${encodeURIComponent(found.id)}/promotion`)
    ).json() as SmsFindingPromotionResponse;
    const opened = await command(a.who.safety, {
      kind: 'sms.record.open',
      record: {
        kind: 'hazard',
        schema: 'sms.hazard.1',
        title: 'Battery below the adopted reserve',
        ownerId: a.who.safety.id,
        body: {
          description: `Raised from: ${shown.evaluation.summary}`,
          consequence: 'Forced landing of the fictional aircraft.',
          source: { kind: 'finding' },
        },
      },
      origin: {
        kind: 'finding',
        findingId: found.id,
        evaluationId: shown.origin.evaluationId,
        expectedDependencyBasis: shown.basis.dependencyBasis,
      },
    });
    const hazardId = opened.subject.id;
    const detail = (await call(a.who.safety, 'GET', `/v1/sms/records/${hazardId}`)).json() as SmsRecordDetailResponse;
    const assessed = await command(a.who.safety, {
      kind: 'decision.record',
      subject: { kind: 'sms', id: hazardId },
      expectedRevision: detail.basis.revision,
      expectedDependencyBasis: detail.basis.dependencyBasis,
      decision: {
        kind: 'risk.assess',
        note: 'Assessed against the finding evaluation shown.',
        matrix: { recordId: detail.matrix!.record.id, versionNumber: detail.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
        evidence: { evaluationId: shown.origin.evaluationId },
      },
    });

    const packet = await content(a, await issue(a, found.id));
    const latest = packet.manifest.evaluations.at(-1)!;
    expect(packet.manifest.evaluations.length).toBeGreaterThanOrEqual(2);
    expect(latest.observations.map((item) => item.observationId)).toEqual([firstReading.eventId]);
    expect(latest.corrections).toContainEqual({
      kind: 'withdrawal',
      eventId: expect.any(String),
      observationId: later.eventId,
    });
    const reasons = Object.fromEntries(packet.manifest.inventory.map((item) => [item.id, item.reason]));
    expect(reasons[later.eventId]).toBe('read_observation');
    expect(reasons[latest.corrections[0]!.eventId]).toBe('observation_correction');
    expect(packet.manifest.decisions.hazards).toEqual([
      expect.objectContaining({
        recordId: hazardId,
        evaluationId: shown.origin.evaluationId,
        assessmentIds: [assessed.id],
        acceptanceIds: [],
      }),
    ]);
    expect(packet.origins).toEqual([{ recordId: hazardId, origin: shown.origin }]);
    expect(reasons[assessed.id]).toBe('hazard_assessment');
  });

  it('keeps a version 1 packet issued earlier readable, listed and verifiable beside version 2 packets', async () => {
    const a = tenants.a;
    const found = await finding(a);
    const older = await issueVersionOne(a, found.id);
    const read = await call(a.who.safety, 'GET', `/v1/finding-packets/${older.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().record).toEqual(older);
    const packet = await content(a, older);
    expect(packet.format).toBe(FINDING_PACKET_FORMAT);
    expect(verifyDownloaded(Buffer.from(canonicalize(packet)), older.manifestDigest)).toMatchObject({
      status: 'verified',
      format: FINDING_PACKET_FORMAT,
    });
    const newer = await issue(a, found.id);
    const listed = await call(a.who.safety, 'GET', `/v1/finding-packets?findingId=${encodeURIComponent(found.id)}`);
    expect(listed.json().records.slice(0, 2)).toEqual([newer, older]);
  });
});
