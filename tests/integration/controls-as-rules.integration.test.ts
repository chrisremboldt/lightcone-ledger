import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { adoptExampleRiskMatrix } from '../../apps/api/src/seed-risk-matrix.js';
import {
  ACCEPTED_CONTROL_PACK_ID,
  FlightControlsResponseSchema,
  type Capability,
  type FlightControlsResponse,
  type MissionAvoidanceResponse,
  type MissionReleaseFindingsResponse,
  type MissionReleaseRecordResponse,
  type MissionSource,
  type OrganizationCoverageResponse,
  type SmsDecisionInput,
  type SmsRecordDetailResponse,
  type SmsSigningPreviewResponse,
} from '../../packages/contracts/src/index.js';
import { missionReleasePolicy } from '../../packages/contracts/fixtures/demo/v1/mission-release.js';
import { operatingLimitControlType } from '../../packages/domain/src/control-type-library.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { leaseWork, processLease } from '../../apps/workers/src/index.js';
import { lockSubjects } from '../../packages/domain/src/cuts.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { lockWaitStarted, runOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';

// A fictional organization accepts a battery reserve limit on a hazard. The accepted limit becomes the organization's
// own rule, evaluated against battery observations and shown at release for a flight whose records name the aircraft.
// A new accepted version changes the rule and the next evaluation; withdrawing the control removes the rule.
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
      'flight:read',
      'flight:create',
      'mission:release',
      'authority:write',
    ],
  },
  executive: {
    kind: 'human',
    capabilities: ['sms:read', 'sms:adopt', 'decision:write', 'evidence:read', 'risk:accept:high'],
  },
  source: { kind: 'source', capabilities: ['input:write', 'mission:write', 'flight:read', 'evidence:read'] },
  worker: { kind: 'worker', capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write'] },
};

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Accepted controls as rules on PostgreSQL', () => {
  const prefix = `controls-as-rules-${randomUUID()}`;
  const tenantId = `${prefix}:org`;
  const telemetry = `${prefix}-telemetry`;
  const planner = `${prefix}-planner`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const who = {} as Record<Role, AuthContext>;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validControls = ajv.compile(FlightControlsResponseSchema);
  let app: Awaited<ReturnType<typeof createApp>>;
  let occurred = Date.parse('2026-11-03T09:00:00.000Z');

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers = {}) {
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function command(principal: AuthContext, payload: unknown, headers = {}) {
    const response = await call(principal, 'POST', '/v1/commands', payload, headers);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().command as { id: string; subject: { id: string } };
  }
  async function detail(id: string): Promise<SmsRecordDetailResponse> {
    const response = await call(who.safety, 'GET', `/v1/sms/records/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  function decide(id: string, shown: { revision: number; dependencyBasis: string }, decision: SmsDecisionInput) {
    return {
      kind: 'decision.record' as const,
      subject: { kind: 'sms' as const, id },
      expectedRevision: shown.revision,
      expectedDependencyBasis: shown.dependencyBasis,
      decision,
    };
  }
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await runOwnedWork(admin, workerPool, [prefix])) continue;
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }
  async function upload(bytes: Buffer): Promise<string> {
    const created = await call(who.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    expect((await call(who.source, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
    const finalized = await call(who.source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }
  async function grant(update: Record<string, unknown>): Promise<void> {
    const current = await call(who.safety, 'GET', `/v1/authority/principals/${encodeURIComponent(who.source.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    await command(who.safety, {
      kind: 'authority.update',
      principalId: who.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      ...update,
    });
  }

  /** A battery reading from the fictional telemetry source, each later than the last. */
  async function battery(percent: number, subject: Record<string, string>, secondarySubject?: Record<string, string>) {
    occurred += 60_000;
    const occurredAt = new Date(occurred).toISOString();
    const response = await call(who.source, 'POST', '/v1/inputs', {
      sourceId: telemetry,
      kind: 'observation',
      occurredAt,
      payload: {
        type: 'battery.state',
        version: 1,
        subject,
        ...(secondarySubject ? { secondarySubject } : {}),
        occurredAt,
        sourceEventId: randomUUID(),
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        values: { totalRemainingPercent: percent },
        originalArtifactId: await upload(Buffer.from(JSON.stringify({ entered: 'fictional battery log' }))),
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  async function plannedFlight(name = 'flight'): Promise<{ flightId: string; raw: MissionSource }> {
    const start = new Date(Date.now() + 60_000).toISOString();
    const end = new Date(Date.now() + 1_800_000).toISOString();
    const raw: MissionSource = {
      sourceMissionId: `${prefix}-${name}-mission`,
      sourceRevision: 1,
      aircraftId: `${prefix}-aircraft`,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      route: {
        coordinateReference: 'WGS84',
        coordinateOrder: 'longitude_latitude',
        segmentInterpolation: 'linear_longitude_latitude',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-87.65, 41.88],
            [-87.6398, 41.8873],
          ],
        },
      },
      lateralToleranceMeters: 20,
      altitude: { minimum: 45, maximum: 60, unit: 'm', reference: 'AGL' },
      operatingInterval: { start, end },
    };
    const created = await call(who.safety, 'POST', '/v1/flights', {
      originationKey: `${prefix}:${name}`,
      aircraft: raw.aircraftId,
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const { sourceRevision, occurredAt, ...payload } = raw;
    const accepted = await call(who.source, 'POST', '/v1/inputs', {
      kind: 'mission.revision',
      sourceId: planner,
      sourceRevision,
      occurredAt,
      subject: { flightId },
      artifactId: await upload(Buffer.from(`${JSON.stringify(raw)}\n`)),
      fidelity: 'synthetic_contract',
      payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    await settle();
    return { flightId, raw };
  }

  async function controls(flightId: string): Promise<FlightControlsResponse> {
    const response = await call(who.safety, 'GET', `/v1/flights/${flightId}/controls`);
    expect(response.statusCode, response.body).toBe(200);
    expect(validControls(response.json()), JSON.stringify(validControls.errors)).toBe(true);
    return response.json();
  }
  async function releaseFindings(flightId: string): Promise<MissionReleaseFindingsResponse> {
    const response = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-release-findings`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function acceptedControlAdoptions() {
    const response = await call(who.safety, 'GET', '/v1/organization/coverage');
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as OrganizationCoverageResponse).adoptions
      .filter((adoption) => adoption.pack.packId === ACCEPTED_CONTROL_PACK_ID)
      .sort((left, right) => left.pack.version - right.pack.version);
  }

  async function openHazard(title: string): Promise<string> {
    return (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title,
          ownerId: who.safety.id,
          body: {
            description: 'A fictional aircraft could run its battery below a safe reserve on a long inspection.',
            consequence: 'Forced landing of the fictional aircraft away from the work site.',
            source: { kind: 'manual_identification' },
          },
        },
      })
    ).subject.id;
  }
  async function evaluationsOf(leafId: string): Promise<number> {
    const rows = await admin.query('SELECT COUNT(*) AS count FROM rule_evaluations WHERE tenant_id=$1 AND leaf_id=$2', [
      tenantId,
      leafId,
    ]);
    return Number(rows.rows[0].count);
  }
  async function until(at: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, at - Date.now()) + 50));
  }

  /** Assesses the hazard with these control versions and has the executive accept it with a signature. */
  async function assessAndAccept(hazardId: string, listed: { recordId: string; versionNumber: number }[]) {
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed with the battery reserve in place.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: listed,
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    const assessment = (await detail(hazardId)).decisions.find((decision) => decision.kind === 'risk.assess')!;
    const preview = await call(who.executive, 'GET', `/v1/sms/records/${hazardId}/signing?meaning=risk.accept`);
    expect(preview.statusCode, preview.body).toBe(200);
    const signing = preview.json() as SmsSigningPreviewResponse;
    expect(signing.available, signing.reason).toBe(true);
    const reauthentication = await call(who.executive, 'POST', '/v1/local/reauthentications', {
      credential: `ledger-dev-${who.executive.id}`,
    });
    expect(reauthentication.statusCode, reauthentication.body).toBe(201);
    await command(
      who.executive,
      decide(hazardId, signing.basis, {
        kind: 'risk.accept',
        note: 'Residual risk accepted with the battery reserve in place.',
        assessmentId: assessment.id,
        signature: { intent: signing.intent!, contentDigest: signing.contentDigest!, reviewed: true },
      }),
      { 'x-ledger-reauthentication': reauthentication.json().grant as string },
    );
    await settle();
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional reserve organization']);
    for (const [role, person] of Object.entries(people) as [Role, (typeof people)[Role]][]) {
      who[role] = {
        id: `${tenantId}:${role}`,
        tenantId,
        name: `Fictional ${role}`,
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
    await grant({ missionSources: [planner] });
    await grant({ observationGrants: [{ sourceId: telemetry, observationType: 'battery.state' }] });
    const drafter = { id: who.safety.id, token: `ledger-dev-${who.safety.id}` };
    const adopter = { token: `ledger-dev-${who.executive.id}` };
    expect(await adoptExampleRiskMatrix(app, { drafter, adopter, note: 'Adopting the fictional matrix.' })).toBe(true);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('checks an accepted battery reserve at release, follows a new accepted version and drops a withdrawn one', async () => {
    const tail = { kind: 'aircraft', id: 'tail-7', scope: 'source' };
    const tailKey = `source/${encodeURIComponent(telemetry)}/aircraft/tail-7`;
    const { flightId, raw } = await plannedFlight();
    // The flight's own battery report names the aircraft, which puts the aircraft in scope for the flight.
    await battery(64, { kind: 'flight', id: flightId, scope: 'ledger' }, tail);
    expect((await controls(flightId)).controls).toEqual([]);

    const hazardId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: 'Battery exhausted before landing',
          ownerId: who.safety.id,
          body: {
            description: 'A fictional aircraft could run its battery below a safe reserve on a long inspection.',
            consequence: 'Forced landing of the fictional aircraft away from the work site.',
            source: { kind: 'manual_identification' },
          },
        },
      })
    ).subject.id;
    const types = (await detail(hazardId)).controlTypes!;
    const pinned = (id: string) => {
      const type = types.find((candidate) => candidate.id === id)!;
      return { id: type.id, version: type.version, digest: type.digest };
    };
    const reserve = {
      observationType: 'battery.state',
      observationVersion: 1,
      field: 'values.totalRemainingPercent',
      comparison: 'at_least',
      limit: 30,
      unit: 'percent',
      scope: 'subject_kind',
      subjectKind: 'aircraft',
    };
    const controlRecord = (title: string, controlType: object, parameters: object) => ({
      kind: 'control',
      schema: 'sms.control.1',
      title,
      ownerId: who.safety.id,
      body: { hazardId, controlType, parameters, effectiveFrom: '2026-01-01T00:00:00Z' },
    });
    const limitId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: controlRecord('Battery reserve', pinned(operatingLimitControlType.id), reserve),
      })
    ).subject.id;
    const briefingId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: controlRecord('Reserve briefing', pinned('control.described-measure'), {
          measure: 'Brief the crew on the battery reserve before each inspection.',
        }),
      })
    ).subject.id;
    await assessAndAccept(hazardId, [
      { recordId: limitId, versionNumber: 1 },
      { recordId: briefingId, versionNumber: 1 },
    ]);

    // The acceptance adopted the organization's rules in active mode, signed by the person who accepted.
    const [first] = await acceptedControlAdoptions();
    expect(first).toMatchObject({
      mode: 'active',
      state: 'effective',
      pack: { packId: ACCEPTED_CONTROL_PACK_ID, version: 1, status: 'assembled', review: 'accepted_and_signed' },
      actor: { id: who.executive.id, policyVersion: 'ledger.accepted-control-rules.1' },
    });
    expect(first!.pack.leaves.map((leaf) => [leaf.version, leaf.source.text])).toEqual([
      [
        1,
        'Keep the reported values.totalRemainingPercent of battery.state version 1 at least 30 percent, for every aircraft.',
      ],
    ]);
    const { digest, ...content } = first!.pack;
    expect(canonicalDigest(content)).toBe(digest);

    // Before a reading arrives under the rule, the release shows the limit as not yet evaluated.
    const waiting = await controls(flightId);
    expect(waiting.controls.map((item) => [item.control.title, item.check, item.results[0]!.result])).toEqual([
      ['Battery reserve', 'rule', 'insufficient'],
      ['Reserve briefing', 'person', 'needs_confirmation'],
    ]);
    // Beside the list, for display only, the limit in the titles a person knows; the pinned digest leaves it out.
    const listedLimit = waiting.controls.find((item) => item.control.id === limitId)!;
    expect(waiting.wording).toEqual({
      [listedLimit.control.bodyDigest]:
        'Keep the Battery remaining (%) of each Battery state at least 30 percent, for every aircraft.',
    });
    expect(waiting.digest).toBe(
      canonicalDigest({
        version: 'flight.controls-seen.1',
        controls: waiting.controls,
        notApplicable: waiting.notApplicable,
        complete: waiting.complete,
        mission: waiting.mission,
      }),
    );

    await battery(12, tail);
    const low = await controls(flightId);
    const limit = low.controls.find((item) => item.control.id === limitId)!;
    expect(limit).toMatchObject({
      hazard: { id: hazardId, title: 'Battery exhausted before landing' },
      control: { versionNumber: 1, type: { title: 'Operating limit' } },
      results: [
        {
          result: 'attention',
          subjectKey: tailKey,
          summary:
            'The latest reported value for the battery state’s Battery remaining (%) is 12; the limit is at least 30.',
          rule: { packId: ACCEPTED_CONTROL_PACK_ID, packVersion: 1, version: 1 },
        },
      ],
    });
    // The rule's result is an ordinary finding of an active adoption, so the release basis lists it.
    const findings = await releaseFindings(flightId);
    const listed = findings.basis.findings.find((finding) => finding.rule.packId === ACCEPTED_CONTROL_PACK_ID)!;
    expect(listed).toMatchObject({
      subjectKey: tailKey,
      rule: { title: 'Battery reserve' },
      answer: { outcome: 'attention' },
      evaluation: { id: limit.results[0]!.evaluation!.id, digest: limit.results[0]!.evaluation!.digest },
    });

    // A release records the list it pinned; nothing was blocked by the result.
    const avoidance = (await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-avoidance`)).json();
    const shown = avoidance as MissionAvoidanceResponse;
    const me = (await call(who.safety, 'GET', '/v1/me')).json().principal;
    const released = await command(who.safety, {
      kind: 'mission.release',
      flightId,
      aircraftId: raw.aircraftId,
      mission: shown.mission!,
      calculation: { id: shown.calculation.id, version: shown.calculation.version, digest: shown.calculation.digest },
      policy: {
        id: missionReleasePolicy.id,
        version: missionReleasePolicy.version,
        digest: missionReleasePolicy.digest,
      },
      expectedContextDigest: shown.contextDigest!,
      expectedFindingsDigest: findings.basis.digest,
      expectedPrincipalRevision: me.revision,
      departureWindow: raw.operatingInterval,
      note: 'Release this fictional inspection; the battery reserve result was reviewed.',
    });
    await settle();
    const read = await call(who.safety, 'GET', `/v1/flights/${flightId}/mission-releases/${released.id}`);
    const { release } = read.json() as MissionReleaseRecordResponse;
    expect(release.basis.findings.findings).toContainEqual(listed);

    // A new accepted version with a lower limit changes the rule and the next evaluation of the same reading.
    const shownLimit = await detail(limitId);
    await command(who.safety, {
      kind: 'sms.record.revise',
      recordId: limitId,
      expectedRevision: shownLimit.basis.revision,
      record: controlRecord('Battery reserve', pinned(operatingLimitControlType.id), { ...reserve, limit: 10 }),
    });
    await assessAndAccept(hazardId, [
      { recordId: limitId, versionNumber: 2 },
      { recordId: briefingId, versionNumber: 1 },
    ]);
    const second = (await acceptedControlAdoptions()).find((adoption) => adoption.pack.version === 2)!;
    expect(second).toMatchObject({ revises: first!.id, state: 'effective' });
    expect(second.pack.leaves.map((leaf) => [leaf.id, leaf.version])).toEqual([[first!.pack.leaves[0]!.id, 2]]);
    const lowered = (await controls(flightId)).controls.find((item) => item.control.id === limitId)!;
    expect(lowered.control.versionNumber).toBe(2);
    expect(lowered.results[0]).toMatchObject({
      result: 'pass',
      summary:
        'The latest reported value for the battery state’s Battery remaining (%) is 12; the limit is at least 10.',
      rule: { packVersion: 2, version: 2 },
    });
    // The earlier evaluation keeps the version it ran under.
    const earlier = await call(who.safety, 'GET', `/v1/evaluations/${limit.results[0]!.evaluation!.id}`);
    expect(earlier.json().evaluation).toMatchObject({
      pack: { version: 1 },
      rule: { version: 1 },
      outcome: 'attention',
    });

    // Withdrawing the control removes its rule; the person-confirmed control stays listed.
    const withdrawn = await detail(limitId);
    await command(
      who.safety,
      decide(limitId, withdrawn.basis, { kind: 'record.close', note: 'Replaced by a fleet procedure.' }),
    );
    await settle();
    const third = (await acceptedControlAdoptions()).find((adoption) => adoption.pack.version === 3)!;
    expect(third).toMatchObject({ revises: second.id, actor: { id: who.safety.id } });
    expect(third.pack.leaves).toEqual([]);
    expect((await controls(flightId)).controls.map((item) => item.control.title)).toEqual(['Reserve briefing']);
    expect((await acceptedControlAdoptions()).map((adoption) => adoption.state)).toEqual([
      'revised',
      'revised',
      'effective',
    ]);
  });

  it('evaluates an accepted limit only within its effective interval', async () => {
    const tail = { kind: 'aircraft', id: 'tail-9', scope: 'source' };
    const { flightId } = await plannedFlight('interval-flight');
    await battery(64, { kind: 'flight', id: flightId, scope: 'ledger' }, tail);
    const hazardId = await openHazard('Battery exhausted on a scheduled route');
    const type = (await detail(hazardId)).controlTypes!.find(
      (candidate) => candidate.id === operatingLimitControlType.id,
    )!;
    // The limit takes effect a few seconds after its acceptance and ends a few seconds later.
    const starts = Date.now() + 8_000;
    const ends = starts + 6_000;
    const limitId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Scheduled battery reserve',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: type.id, version: type.version, digest: type.digest },
            parameters: {
              observationType: 'battery.state',
              observationVersion: 1,
              field: 'values.totalRemainingPercent',
              comparison: 'at_least',
              limit: 30,
              unit: 'percent',
              scope: 'listed_subjects',
              subjectKind: 'aircraft',
              subjectIds: 'tail-9',
            },
            effectiveFrom: new Date(starts).toISOString(),
            effectiveUntil: new Date(ends).toISOString(),
          },
        },
      })
    ).subject.id;
    const versionsBefore = (await acceptedControlAdoptions()).length;
    await assessAndAccept(hazardId, [{ recordId: limitId, versionNumber: 1 }]);
    const leafId = `ledger.accepted-control.${limitId}.aircraft`;
    const listedNow = async () => (await controls(flightId)).controls.find((item) => item.control.id === limitId)!;

    // Before its interval: listed as taking effect later, not in the pack, not evaluated.
    expect(await acceptedControlAdoptions()).toHaveLength(versionsBefore);
    expect(await listedNow()).toMatchObject({
      control: { period: 'upcoming' },
      results: [{ result: 'not_applicable' }],
    });
    await battery(12, tail);
    expect(await evaluationsOf(leafId)).toBe(0);

    // At its start the workers reassemble the pack; the next reading is evaluated.
    await until(starts);
    await settle();
    const started = (await acceptedControlAdoptions()).at(-1)!;
    expect(started).toMatchObject({
      state: 'effective',
      actor: { policyVersion: 'ledger.accepted-control-interval.1', boundaryAt: new Date(starts).toISOString() },
    });
    expect(started.pack.leaves.map((leaf) => leaf.id)).toContain(leafId);
    await battery(11, tail);
    expect(await evaluationsOf(leafId)).toBeGreaterThan(0);
    expect(await listedNow()).toMatchObject({ control: { period: 'current' }, results: [{ result: 'attention' }] });

    // At its end the pack is reassembled without it; later readings are not evaluated, earlier ones are kept.
    await until(ends);
    await settle();
    const ended = (await acceptedControlAdoptions()).at(-1)!;
    expect(ended).toMatchObject({ revises: started.id, state: 'effective' });
    expect(ended.pack.leaves.map((leaf) => leaf.id)).not.toContain(leafId);
    const evaluated = await evaluationsOf(leafId);
    await battery(10, tail);
    expect(await evaluationsOf(leafId)).toBe(evaluated);
    expect(await listedNow()).toMatchObject({ control: { period: 'ended' }, results: [{ result: 'not_applicable' }] });
    expect((await acceptedControlAdoptions()).filter((adoption) => adoption.id === started.id)).toMatchObject([
      { state: 'revised' },
    ]);
  });
  it('queues once the boundary work of controls accepted before it was scheduled, and reassembles at the boundary', async () => {
    const hazardId = await openHazard('Battery exhausted on a late inspection');
    const type = (await detail(hazardId)).controlTypes!.find(
      (candidate) => candidate.id === operatingLimitControlType.id,
    )!;
    const starts = Date.now() + 10_000;
    const limitId = (
      await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Late inspection battery reserve',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: type.id, version: type.version, digest: type.digest },
            parameters: {
              observationType: 'battery.state',
              observationVersion: 1,
              field: 'values.totalRemainingPercent',
              comparison: 'at_least',
              limit: 30,
              unit: 'percent',
              scope: 'listed_subjects',
              subjectKind: 'aircraft',
              subjectIds: 'tail-11',
            },
            effectiveFrom: new Date(starts).toISOString(),
          },
        },
      })
    ).subject.id;
    await assessAndAccept(hazardId, [{ recordId: limitId, versionNumber: 1 }]);
    const boundaryWork = async () =>
      (
        await admin.query<{ subject_key: string; trigger_event_id: string; due_at: Date }>(
          `SELECT subject_key,trigger_event_id,due_at FROM rule_evaluation_work
           WHERE tenant_id=$1 AND trigger_kind='control-boundary' AND due_at>clock_timestamp() ORDER BY due_at`,
          [tenantId],
        )
      ).rows;
    const queued = await boundaryWork();
    expect(queued.map((row) => row.due_at.toISOString())).toEqual([new Date(starts).toISOString()]);

    // The state before migration 0069: the acceptance is recorded, its boundary work is not.
    await admin.query(
      `DELETE FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_kind='control-boundary' AND due_at>clock_timestamp()`,
      [tenantId],
    );
    expect(await boundaryWork()).toEqual([]);
    const versionsBefore = (await acceptedControlAdoptions()).length;

    // The one-time step queues the same work the projection did, once, however often it runs.
    const step = await readFile(
      new URL('../../packages/persistence/migrations/0072_queue_missed_control_boundaries.sql', import.meta.url),
      'utf8',
    );
    await admin.query(step);
    await admin.query(step);
    expect(await boundaryWork()).toEqual(queued);

    // At the boundary the workers reassemble the pack with the control's rule.
    await until(starts);
    await settle();
    const adoptions = await acceptedControlAdoptions();
    expect(adoptions).toHaveLength(versionsBefore + 1);
    expect(adoptions.at(-1)).toMatchObject({
      state: 'effective',
      actor: { policyVersion: 'ledger.accepted-control-interval.1', boundaryAt: new Date(starts).toISOString() },
    });
    expect(adoptions.at(-1)!.pack.leaves.map((leaf) => leaf.id)).toContain(
      `ledger.accepted-control.${limitId}.aircraft`,
    );
    await admin.query(step);
    expect(
      (
        await admin.query(
          `SELECT COUNT(*)::int AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_kind='control-boundary' AND due_at=$2`,
          [tenantId, new Date(starts)],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it('projects a control’s opening while a decision on its hazard holds the hazard, in one lock order', async () => {
    const type = (types: NonNullable<SmsRecordDetailResponse['controlTypes']>) =>
      types.find((candidate) => candidate.id === 'control.described-measure')!;
    // The projection of the control's opening takes the control's subject and every subject that rests on that
    // opening, among them the hazard assessed with it; the cycle needs the hazard to sort first, so pairs are opened
    // until one does.
    let hazardId = '';
    let controlId = '';
    let openingId = '';
    for (let attempt = 0; attempt < 20 && !(hazardId && hazardId < controlId); attempt++) {
      await settle();
      hazardId = await openHazard('Battery exhausted while a control is opened');
      const pinned = type((await detail(hazardId)).controlTypes!);
      const opened = await command(who.safety, {
        kind: 'sms.record.open',
        record: {
          kind: 'control',
          schema: 'sms.control.1',
          title: 'Reserve briefing while projecting',
          ownerId: who.safety.id,
          body: {
            hazardId,
            controlType: { id: pinned.id, version: pinned.version, digest: pinned.digest },
            parameters: { measure: 'Brief the crew on the battery reserve.' },
            effectiveFrom: '2026-01-01T00:00:00Z',
          },
        },
      });
      controlId = opened.subject.id;
      openingId = opened.id;
    }
    expect(hazardId < controlId).toBe(true);
    const current = await detail(hazardId);
    await command(
      who.safety,
      decide(hazardId, current.basis, {
        kind: 'risk.assess',
        note: 'Assessed with the briefing in place.',
        matrix: { recordId: current.matrix!.record.id, versionNumber: current.matrix!.version.versionNumber },
        initial: { severity: 'major', likelihood: 'remote' },
        controls: [{ recordId: controlId, versionNumber: 1 }],
        residual: { severity: 'minor', likelihood: 'remote' },
        newHazardCheck: { answer: 'none_identified' },
      }),
    );
    const leases = await withOwnedWork(admin, [prefix], () => leaseWork(workerPool, { limit: 100 }));
    const opening = leases.find((lease) => lease.event_id === openingId)!;
    expect(opening).toBeDefined();
    // A decision on the hazard locks its subject and then, in id order, the subjects its basis rests on: the control.
    let projected: Promise<boolean> | undefined;
    await withScope(pool, who.safety, async (client) => {
      await lockSubjects(client, tenantId, [hazardId], 'UPDATE');
      projected = processLease(workerPool, opening);
      projected.catch(() => undefined);
      await lockWaitStarted(admin);
      await lockSubjects(client, tenantId, [controlId], 'SHARE');
    });
    expect(await projected).toBe(true);
    for (const lease of leases.filter((lease) => lease !== opening)) await processLease(workerPool, lease);
    await settle();
    expect((await detail(controlId)).record.projectedRevision).toBe(1);
  });
});
