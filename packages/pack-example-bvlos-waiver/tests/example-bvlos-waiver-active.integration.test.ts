import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import {
  reliefStatement,
  type AdoptionParameterValues,
  type AdoptionRuleCoverageResponse,
  type MissionReleaseFindingsResponse,
  type OperatorRecordCommitResponse,
  type SubjectsOnRecordResponse,
  type OrganizationCoverageResponse,
  type PackAdoptionCommand,
  type RuleEvaluationRecord,
  type RulePackVersion,
} from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext, type Pool } from '../../persistence/src/index.js';
import { PART107_PACK_ID } from '../../pack-part107/src/index.js';
import { PART108_NPRM_PACK_ID } from '../../pack-part108-nprm/src/index.js';
import { EXAMPLE_BVLOS_WAIVER_PACK_ID, exampleBvlosWaiverV1, RELIEVED_RULE_IDS } from '../src/index.js';
import {
  databaseNow,
  projectOwnedWork,
  runOwnedWork,
  settleOwnedWork,
} from '../../../tests/integration/worker-queue.js';

const VLOS_RULE = RELIEVED_RULE_IDS[0]!;
const MINUTE = 60_000;
const HOUR = 3_600_000;

type Interval = PackAdoptionCommand['effectiveInterval'];
type Subject = { kind: string; id: string; scope: 'ledger' | 'source' };

/** One fictional organization: its people, its source of records and one Ledger flight. */
class Operator {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly actor: AuthContext;
  readonly source: AuthContext;
  readonly worker: AuthContext;
  flightId = '';
  private artifactId = '';

  constructor(
    readonly prefix: string,
    private readonly app: () => Awaited<ReturnType<typeof createApp>>,
    private readonly admin: Pool,
    private readonly workerPool: Pool,
  ) {
    this.tenantId = `${prefix}:operator`;
    this.sourceId = `${prefix}-records`;
    // The person who adopts is the waiver's fictional responsible person.
    const base = { tenantId: this.tenantId, revision: 1, kind: 'human', name: 'Dana Ortiz' };
    this.actor = {
      ...base,
      id: `${this.tenantId}:actor`,
      capabilities: ['flight:create', 'flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
    };
    this.source = {
      ...base,
      id: `${this.tenantId}:source`,
      kind: 'source',
      name: 'Alpha Dispatch records',
      capabilities: ['input:write', 'flight:read', 'evidence:read'],
    };
    this.worker = {
      ...base,
      id: `${this.tenantId}:worker`,
      kind: 'worker',
      name: 'Worker',
      capabilities: ['flight:read', 'evidence:read'],
    };
  }

  call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return this.app().inject({
      method,
      url,
      headers: {
        authorization: `Bearer ledger-dev-${principal.id}`,
        'idempotency-key': randomUUID(),
        ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async setUp(): Promise<void> {
    await this.admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [this.tenantId, 'Alpha Dispatch']);
    for (const principal of [this.actor, this.source, this.worker]) {
      await this.admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        this.tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
      await this.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${principal.id}`),
        principal.id,
      ]);
    }
    const current = await this.call(
      this.actor,
      'GET',
      `/v1/authority/principals/${encodeURIComponent(this.source.id)}`,
    );
    expect(current.statusCode, current.body).toBe(200);
    const types = ['operator.record', 'flight.report', 'weather.wind', 'position.fix'];
    const granted = await this.call(this.actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: this.source.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: types.map((observationType) => ({ sourceId: this.sourceId, observationType })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional records for an invented waiver' }));
    const created = await this.call(this.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    expect((await this.call(this.source, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
    const finalized = await this.call(this.source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    this.artifactId = finalized.json().artifact.id as string;
  }

  async createFlight(start: string, end: string): Promise<void> {
    const created = await this.call(this.actor, 'POST', '/v1/flights', {
      originationKey: `${this.prefix}:flight`,
      aircraft: `${this.prefix}-aircraft`,
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(created.statusCode, created.body).toBe(201);
    this.flightId = created.json().flight.id as string;
    await this.settle();
  }

  get flight(): Subject {
    return { kind: 'flight', id: this.flightId, scope: 'ledger' };
  }
  get aircraft(): Subject {
    return { kind: 'aircraft', id: `${this.prefix}-aircraft`, scope: 'source' };
  }
  get site(): Subject {
    return { kind: 'site', id: `${this.prefix}-site`, scope: 'source' };
  }
  get organization(): Subject {
    return { kind: 'organization', id: `organization:${this.tenantId}`, scope: 'ledger' };
  }

  async submit(
    type: string,
    subject: Subject,
    occurredAt: string,
    content: Record<string, unknown>,
    secondarySubject?: Subject,
    replaces?: string,
  ): Promise<string> {
    const response = await this.call(this.source, 'POST', '/v1/inputs', {
      sourceId: this.sourceId,
      kind: 'observation',
      occurredAt,
      ...(replaces ? { replaces } : {}),
      payload: {
        type,
        version: 1,
        subject,
        ...(secondarySubject ? { secondarySubject } : {}),
        occurredAt,
        sourceEventId: randomUUID(),
        fidelity: 'synthetic_contract',
        limitations: ['Fictional records for an invented waiver.'],
        originalArtifactId: this.artifactId,
        ...content,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt.eventId as string;
  }

  async record(
    recordType: string,
    subject: Subject,
    occurredAt: string,
    record: Record<string, unknown>,
    options: { interval?: { start: string; end?: string }; secondarySubject?: Subject; replaces?: string } = {},
  ): Promise<string> {
    return this.submit(
      'operator.record',
      subject,
      occurredAt,
      {
        ...(options.interval ? { interval: options.interval } : {}),
        values: { recordType, recordVersion: 1, record },
      },
      options.secondarySubject,
      options.replaces,
    );
  }

  /** Imports records of one type from a JSON file, as the Records screen's import and entry form do. */
  async importRecords(recordType: string, records: Record<string, unknown>[]): Promise<OperatorRecordCommitResponse> {
    const bytes = Buffer.from(JSON.stringify({ recordType, recordVersion: 1, records }));
    const created = await this.call(this.source, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    expect((await this.call(this.source, 'PUT', `/v1/uploads/${id}/content`, bytes)).statusCode).toBe(200);
    const finalized = await this.call(this.source, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    const committed = await this.call(this.source, 'POST', '/v1/operator-records/imports', {
      artifactId: finalized.json().artifact.id,
      recordType,
      recordVersion: 1,
      sourceId: this.sourceId,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    return committed.json();
  }

  async adopt(pack: RulePackVersion, mode: PackAdoptionCommand['mode'], interval: Interval, revises?: string) {
    const shown = await this.call(this.actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = {
      ...adoptShownPack(
        shown.json<OrganizationCoverageResponse>(),
        pack,
        interval,
        `Fictional ${mode} adoption.`,
        mode,
      ),
      ...(parametersFor(pack) ? { parameters: parametersFor(pack) } : {}),
      ...(revises ? { revises } : {}),
    };
    const adopted = await this.call(this.actor, 'POST', '/v1/commands', command);
    expect(adopted.statusCode, adopted.body).toBe(201);
    await this.settle();
    return adopted.json().command.id as string;
  }

  /** Projects what was recorded, queueing its evaluations without running them. */
  async project(): Promise<void> {
    await projectOwnedWork(this.admin, this.workerPool, [this.prefix]);
  }

  async settle(): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await runOwnedWork(this.admin, this.workerPool, [this.prefix])) continue;
      const pending = await this.admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp()) AS count`,
        [this.tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }

  /** Holds the queued evaluations of one rule until `release`, so another rule is evaluated first. */
  async hold(ruleId: string): Promise<void> {
    await this.admin.query(
      `UPDATE rule_evaluation_work SET due_at=clock_timestamp()+interval '1 hour',
         available_at=clock_timestamp()+interval '1 hour' WHERE tenant_id=$1 AND leaf_id=$2 AND state='pending'
         AND trigger_kind<>'deadline'`,
      [this.tenantId, ruleId],
    );
  }

  async release(ruleId: string): Promise<void> {
    await this.admin.query(
      `UPDATE rule_evaluation_work SET due_at=clock_timestamp(),available_at=clock_timestamp()
       WHERE tenant_id=$1 AND leaf_id=$2 AND state='pending' AND trigger_kind<>'deadline'`,
      [this.tenantId, ruleId],
    );
    await this.settle();
  }

  /** Every evaluation of one rule about the flight, newest first. */
  async evaluationsOf(ruleId: string): Promise<RuleEvaluationRecord[]> {
    const query = new URLSearchParams({ subjectKind: 'flight', subjectId: this.flightId, limit: '100' });
    const response = await this.call(this.actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).filter(
      (evaluation) => evaluation.rule.id === ruleId,
    );
  }

  async latest(ruleId: string): Promise<RuleEvaluationRecord> {
    const [latest] = await this.evaluationsOf(ruleId);
    expect(latest, ruleId).toBeDefined();
    return latest!;
  }

  /** The latest evaluation of one rule about the organization itself. */
  async latestForOrganization(ruleId: string): Promise<RuleEvaluationRecord> {
    const query = new URLSearchParams({ subjectKind: 'organization', subjectId: this.organization.id, limit: '100' });
    const response = await this.call(this.actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const latest = (response.json().evaluations as RuleEvaluationRecord[]).find(
      (evaluation) => evaluation.rule.id === ruleId,
    );
    expect(latest, ruleId).toBeDefined();
    return latest!;
  }

  async releaseFindings(): Promise<MissionReleaseFindingsResponse> {
    const response = await this.call(this.actor, 'GET', `/v1/flights/${this.flightId}/mission-release-findings`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /**
   * A flight planned beyond visual line of sight on the aircraft at the site, starting at `start`, citing the waiver's
   * certificate as its operating authority unless `cites` says otherwise; `replaces` corrects an earlier plan.
   */
  async plan(start: number, end: number, cites: string | null = 'BVW-0001', replaces?: string): Promise<string> {
    const windowStartsAt = new Date(start).toISOString();
    const windowEndsAt = new Date(end).toISOString();
    return this.record(
      'flight.plan',
      this.flight,
      windowStartsAt,
      {
        windowStartsAt,
        windowEndsAt,
        operationKind: 'package_delivery',
        plannedOriginDescription: 'Canal District depot',
        plannedDestinationDescription: 'Canal District pier',
        routeSummary: 'Parcel delivery along the canal, beyond visual line of sight',
        siteId: { id: this.site.id, scope: 'source' },
        visualMode: 'beyond_visual_line_of_sight',
        ...(cites ? { operatingAuthorityReference: cites } : {}),
      },
      {
        interval: { start: windowStartsAt, end: windowEndsAt },
        secondarySubject: this.aircraft,
        ...(replaces ? { replaces } : {}),
      },
    );
  }
}

/** Every adoption parameter a pack asks for, with a value valid for it. */
function parametersFor(pack: RulePackVersion): AdoptionParameterValues | undefined {
  const values: AdoptionParameterValues = {};
  for (const leaf of pack.leaves)
    if ('adoptionParameters' in leaf && leaf.adoptionParameters.length)
      values[leaf.id] = Object.fromEntries(
        leaf.adoptionParameters.map((parameter) => [
          parameter.name,
          parameter.options?.[0] ??
            (parameter.valueType === 'string'
              ? 'UTC'
              : parameter.valueType === 'boolean'
                ? true
                : (parameter.minimum ?? 1)),
        ]),
      );
  return Object.keys(values).length ? values : undefined;
}

// The fictional Alpha Dispatch adopts the Part 107 pack in active mode and the invented BVLOS waiver, first in shadow
// and then in active mode. A flight planned beyond visual line of sight is relieved of the Part 107 visual-line-of-sight
// rule only while the waiver is active, and each of the waiver's own conditions is evaluated for the flight.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Invented BVLOS waiver relieving a Part 107 rule', () => {
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const part107 = getRulePackVersion(PART107_PACK_ID, 1)!;
  const waiver = getRulePackVersion(EXAMPLE_BVLOS_WAIVER_PACK_ID, 1)!;
  let app: Awaited<ReturnType<typeof createApp>>;
  const alpha = new Operator(`bvlos-${randomUUID()}`, () => app, admin, workerPool);
  const ending = new Operator(`bvlos-end-${randomUUID()}`, () => app, admin, workerPool);
  const citing = new Operator(`bvlos-cite-${randomUUID()}`, () => app, admin, workerPool);
  const ruleFirst = new Operator(`bvlos-rule-first-${randomUUID()}`, () => app, admin, workerPool);
  const provisionFirst = new Operator(`bvlos-provision-first-${randomUUID()}`, () => app, admin, workerPool);
  const shadowing = new Operator(`bvlos-shadow-${randomUUID()}`, () => app, admin, workerPool);
  const procedures = new Operator(`bvlos-procedures-${randomUUID()}`, () => app, admin, workerPool);
  const operators = [alpha, ending, citing, ruleFirst, provisionFirst, shadowing, procedures];
  const PROVISION = `${EXAMPLE_BVLOS_WAIVER_PACK_ID}.provision-1`;

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    for (const operator of operators) await operator.setUp();
  });
  afterAll(async () => {
    await settleOwnedWork(operators.map((operator) => operator.prefix));
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('counts the rule with the waiver in shadow, relieves it once active, and evaluates every condition', async () => {
    const now = Date.parse(await databaseNow(pool));
    const adopted = { start: new Date(now - MINUTE).toISOString(), end: new Date(now + HOUR).toISOString() };
    await alpha.createFlight(new Date(now - 30 * MINUTE).toISOString(), new Date(now + 30 * MINUTE).toISOString());
    await alpha.adopt(part107, 'active', adopted);
    const shadowId = await alpha.adopt(waiver, 'shadow', adopted);

    const at = (offset: number) => new Date(now + offset).toISOString();
    await alpha.plan(now - 30 * MINUTE, now + 30 * MINUTE);
    await alpha.record(
      'operation.role-assignment',
      alpha.flight,
      at(-HOUR),
      {
        personId: { id: 'ALPHA-PILOT-01', scope: 'source' },
        role: 'pilot_in_command',
        startsAt: at(-HOUR),
        endsAt: at(HOUR),
      },
      { interval: { start: at(-HOUR), end: at(HOUR) } },
    );
    await alpha.record('operation.notification', alpha.flight, at(-30 * HOUR), {
      notifiedAt: at(-30 * HOUR),
      recipient: 'Canal District harbor office',
      means: 'email',
    });
    await alpha.record('flight.preflight-assessment', alpha.flight, at(-HOUR), {
      assessedAt: at(-HOUR),
      weatherDetermination: 'Wind 6 m/s, no precipitation',
      airspaceDetermination: 'No flight restrictions along the canal',
      groundHazardsDetermination: 'Pier closed to the public during the flight',
      participantsBriefing: 'Pilot briefed on the route and the lost-link procedure',
      linkEnergyLoadDetermination: 'Link checked, batteries full, parcel secured',
      visibilityMeters: 9000,
    });
    await alpha.record('aircraft.detect-and-avoid', alpha.aircraft, at(-2 * HOUR), {
      checkedAt: at(-2 * HOUR),
      equipmentReference: 'Traffic receiver, configuration 3',
      equipmentState: 'serviceable',
    });
    await alpha.record('organization.procedure', alpha.organization, at(-30 * 24 * HOUR), {
      procedureKind: 'lost_link',
      title: 'Lost control link',
      documentReference: 'Operations manual chapter 7',
      revision: 'C',
      effectiveAt: at(-30 * 24 * HOUR),
    });
    await alpha.submit('flight.report', alpha.flight, at(-20 * MINUTE), {
      values: { activity: 'active', takeoffAt: at(-20 * MINUTE) },
    });
    await alpha.submit('weather.wind', alpha.site, at(-25 * MINUTE), {
      values: { method: 'measured', speedMetersPerSecond: 6 },
    });
    for (const offset of [-15, -14, -13])
      await alpha.submit('position.fix', alpha.aircraft, at(offset * MINUTE), {
        position: { latitudeDegrees: 41.88, longitudeDegrees: -87.627 },
        values: { fix: 'three_dimensional' },
      });
    await alpha.settle();

    // In shadow the rule's own answer stands and counts, with what the waiver would relieve beside it.
    const shadow = await alpha.latest(VLOS_RULE);
    expect(shadow).toMatchObject({
      outcome: 'attention',
      relief: {
        mode: 'shadow',
        coverage: { covered: true },
        waiver: { adoptionId: shadowId, pack: { id: EXAMPLE_BVLOS_WAIVER_PACK_ID } },
        provision: { ruleId: `${EXAMPLE_BVLOS_WAIVER_PACK_ID}.provision-1` },
      },
    });
    expect(shadow.relief!.otherwise).toBeUndefined();
    const counted = await alpha.releaseFindings();
    expect(counted.basis.findings.map((finding) => finding.rule.id)).toContain(VLOS_RULE);
    expect(counted.relieved).toEqual([]);

    // Made active, the waiver relieves the rule: the adoption change evaluates it again with no new record.
    const activeId = await alpha.adopt(waiver, 'active', adopted, shadowId);
    const relieved = await alpha.latest(VLOS_RULE);
    const provision = waiver.leaves.find(({ id }) => id === PROVISION)!;
    expect(relieved).toMatchObject({
      outcome: 'relieved',
      reasonCode: 'relieved_by_waiver',
      evidenceState: 'supported',
      summary: `Relieved by Special provision 1: Relief from visual line of sight, ${waiver.title}, adopted by Dana Ortiz.`,
      relief: {
        mode: 'active',
        coverage: { covered: true, provisionResult: { outcome: 'pass', evidenceState: 'supported' } },
        waiver: {
          adoptionId: activeId,
          pack: { id: EXAMPLE_BVLOS_WAIVER_PACK_ID, version: 1, digest: waiver.digest, title: waiver.title },
          adoptedBy: { id: alpha.actor.id, name: 'Dana Ortiz' },
        },
        provision: {
          ruleId: provision.id,
          ruleDigest: provision.digest,
          source: { kind: 'waiver_or_exemption', text: provision.source.text },
        },
        otherwise: { outcome: 'attention', reasonCode: 'value_unexpected' },
      },
      nextBoundary: adopted.end,
    });
    // What the rule found is kept: it read the same plan.
    expect(relieved.evidence).toEqual(shadow.evidence);
    expect(relieved.summary).not.toMatch(/\b(compliant|authori[sz]ed|permitted)\b/i);

    // Not counted in the release's open findings; listed apart as relieved.
    const release = await alpha.releaseFindings();
    expect(release.basis.findings.map((finding) => finding.rule.id)).not.toContain(VLOS_RULE);
    expect(release.proposed.map((finding) => finding.rule.id)).not.toContain(VLOS_RULE);
    expect(release.relieved).toEqual([
      expect.objectContaining({
        rule: expect.objectContaining({ packId: PART107_PACK_ID, id: VLOS_RULE }),
        statement: relieved.summary,
        evaluation: expect.objectContaining({ id: relieved.id }),
      }),
    ]);
    expect(release.basis.digest).not.toBe(counted.basis.digest);

    // Each of the waiver's own conditions is evaluated for the flight, as ordinary rules under the active adoption;
    // the lost-link procedure once, for the organization.
    for (const { number } of exampleBvlosWaiverV1.provisions) {
      const ruleId = `${EXAMPLE_BVLOS_WAIVER_PACK_ID}.provision-${number}`;
      const condition = number === '4' ? await alpha.latestForOrganization(ruleId) : await alpha.latest(ruleId);
      expect(condition, `provision ${number}`).toMatchObject({
        adoption: { id: activeId, mode: 'active' },
        pack: { id: EXAMPLE_BVLOS_WAIVER_PACK_ID, digest: waiver.digest },
        outcome: 'pass',
      });
    }
  });

  it('stops relieving the rule at the instant the waiver adoption ends', async () => {
    const now = Date.parse(await databaseNow(pool));
    const end = new Date(now + 25_000).toISOString();
    await ending.createFlight(new Date(now - 30 * MINUTE).toISOString(), new Date(now + 30 * MINUTE).toISOString());
    await ending.adopt(part107, 'active', {
      start: new Date(now - MINUTE).toISOString(),
      end: new Date(now + HOUR).toISOString(),
    });
    await ending.adopt(waiver, 'active', { start: new Date(now - MINUTE).toISOString(), end });
    await ending.plan(now - 30 * MINUTE, now + 30 * MINUTE);
    await ending.settle();
    const relieved = await ending.latest(VLOS_RULE);
    expect(relieved).toMatchObject({ outcome: 'relieved', nextBoundary: end });
    expect((await ending.releaseFindings()).basis.findings.map((finding) => finding.rule.id)).not.toContain(VLOS_RULE);

    while (Date.parse(await databaseNow(pool)) <= Date.parse(end)) await new Promise((r) => setTimeout(r, 500));
    await ending.settle();
    const after = await ending.latest(VLOS_RULE);
    expect(after).toMatchObject({ outcome: 'attention', trigger: { kind: 'deadline', dueAt: end } });
    expect(after.relief).toBeUndefined();
    expect(Date.parse(after.clock.evaluatedAt)).toBeGreaterThanOrEqual(Date.parse(end));
    expect((await ending.releaseFindings()).basis.findings.map((finding) => finding.rule.id)).toContain(VLOS_RULE);
  });
  /** Adopts Part 107 and the waiver for an hour from a minute ago, with a flight under way, and returns the time. */
  async function underWay(operator: Operator, mode: 'active' | 'shadow' = 'active'): Promise<number> {
    const now = Date.parse(await databaseNow(pool));
    const adopted = { start: new Date(now - MINUTE).toISOString(), end: new Date(now + HOUR).toISOString() };
    await operator.createFlight(new Date(now - 30 * MINUTE).toISOString(), new Date(now + 30 * MINUTE).toISOString());
    await operator.adopt(part107, 'active', adopted);
    await operator.adopt(waiver, mode, adopted);
    return now;
  }

  it('relieves a flight only while its plan cites the certificate', async () => {
    const now = await underWay(citing);
    const first = await citing.plan(now - 30 * MINUTE, now + 30 * MINUTE, null);
    await citing.settle();

    // The plan cites nothing: the provision does not cover the flight, so the rule's own result stands and counts.
    const uncovered = await citing.latest(VLOS_RULE);
    const provisionResult = await citing.latest(PROVISION);
    expect(provisionResult.outcome).not.toBe('pass');
    expect(uncovered).toMatchObject({
      outcome: 'attention',
      reasonCode: 'value_unexpected',
      relief: {
        mode: 'active',
        provision: { ruleId: PROVISION },
        coverage: {
          covered: false,
          provisionResult: { evaluationId: provisionResult.id, outcome: provisionResult.outcome },
        },
      },
    });
    expect(uncovered.relief!.otherwise).toBeUndefined();
    expect(reliefStatement(uncovered.relief!)).toContain('does not cover this subject');
    expect(reliefStatement(uncovered.relief!)).toContain(provisionResult.summary);
    let release = await citing.releaseFindings();
    expect(release.basis.findings.map((finding) => finding.rule.id)).toContain(VLOS_RULE);
    expect(release.relieved).toEqual([]);

    // A correction makes the plan cite the certificate: the provision's changed result relieves the rule.
    const cited = await citing.plan(now - 30 * MINUTE, now + 30 * MINUTE, 'BVW-0001', first);
    await citing.settle();
    const relieved = await citing.latest(VLOS_RULE);
    expect(relieved).toMatchObject({
      outcome: 'relieved',
      relief: { coverage: { covered: true }, otherwise: { outcome: 'attention' } },
    });
    release = await citing.releaseFindings();
    expect(release.basis.findings.map((finding) => finding.rule.id)).not.toContain(VLOS_RULE);
    expect(release.relieved!.map((item) => item.rule.id)).toEqual([VLOS_RULE]);

    // A correction that removes the citation ends the relief.
    await citing.plan(now - 30 * MINUTE, now + 30 * MINUTE, null, cited);
    await citing.settle();
    expect(await citing.latest(VLOS_RULE)).toMatchObject({
      outcome: 'attention',
      relief: { coverage: { covered: false } },
    });
    release = await citing.releaseFindings();
    expect(release.basis.findings.map((finding) => finding.rule.id)).toContain(VLOS_RULE);
    expect(release.relieved).toEqual([]);
  });

  it('records the same relief whichever of the rule and the provision is evaluated first', async () => {
    const results: RuleEvaluationRecord[] = [];
    for (const [operator, held] of [
      [ruleFirst, PROVISION],
      [provisionFirst, VLOS_RULE],
    ] as const) {
      const now = await underWay(operator);
      await operator.plan(now - 30 * MINUTE, now + 30 * MINUTE);
      await operator.project();
      await operator.hold(held);
      await operator.settle();
      if (held === PROVISION)
        // Evaluated before the provision, the rule finds no result of it for the flight and is not relieved yet.
        expect(await operator.latest(VLOS_RULE)).toMatchObject({
          outcome: 'attention',
          relief: { coverage: { covered: false } },
        });
      await operator.release(held);
      results.push(await operator.latest(VLOS_RULE));
    }
    for (const result of results)
      expect(result).toMatchObject({
        outcome: 'relieved',
        reasonCode: 'relieved_by_waiver',
        relief: { mode: 'active', coverage: { covered: true, provisionResult: { outcome: 'pass' } } },
      });
    expect(results[0]!.summary).toBe(results[1]!.summary);
  });

  it('records in shadow that the waiver would not relieve a flight its provision does not cover', async () => {
    const now = await underWay(shadowing, 'shadow');
    await shadowing.plan(now - 30 * MINUTE, now + 30 * MINUTE, 'Some other authority');
    await shadowing.settle();
    const result = await shadowing.latest(VLOS_RULE);
    expect(result).toMatchObject({ outcome: 'attention', relief: { mode: 'shadow', coverage: { covered: false } } });
    expect(reliefStatement(result.relief!)).toMatch(/^Would not be relieved by /);
  });
  it('reads a procedure imported or entered without a subject id as the organization’s own', async () => {
    const now = await underWay(procedures);
    const part108 = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
    const shadow = await procedures.adopt(part108, 'shadow', {
      start: new Date(now - MINUTE).toISOString(),
      end: new Date(now + HOUR).toISOString(),
    });
    await procedures.plan(now - 30 * MINUTE, now + 30 * MINUTE);
    const effectiveAt = new Date(now - 30 * 24 * HOUR).toISOString();
    const procedure = {
      title: 'Lost control link',
      documentReference: 'Operations manual 7',
      revision: 'C',
      effectiveAt,
    };
    // A file made from an older template still names the operator's own id: it is told the column is not used.
    const imported = await procedures.importRecords('organization.procedure', [
      { subjectId: 'ALPHA-OPS', procedureKind: 'lost_link', ...procedure },
    ]);
    const own = { kind: 'organization', id: procedures.organization.id, scope: 'ledger' };
    expect(imported.rows[0]).toMatchObject({
      status: 'recorded',
      subject: own,
      notes: [expect.stringContaining('the subjectId column is not used')],
    });
    // Entered by hand, as the form sends it: no subject id at all.
    const entered = await procedures.importRecords('organization.procedure', [
      { procedureKind: 'training_program', ...procedure, title: 'Training program' },
    ]);
    expect(entered.rows[0]).toMatchObject({ status: 'recorded', subject: own });
    expect(entered.rows[0]!.notes).toBeUndefined();
    await procedures.settle();

    // The waiver's procedure provision, about the organization, reads the organization's procedure.
    expect(await procedures.latestForOrganization(`${EXAMPLE_BVLOS_WAIVER_PACK_ID}.provision-4`)).toMatchObject({
      outcome: 'pass',
      evidenceState: 'supported',
    });
    // A Part 108 rule about the organization reads it too, and coverage counts one organization.
    const query = new URLSearchParams({ subjectKind: 'organization', subjectId: own.id, limit: '100' });
    const evaluations = await procedures.call(procedures.actor, 'GET', `/v1/evaluations?${query}`);
    expect(evaluations.statusCode, evaluations.body).toBe(200);
    const lostLink = (evaluations.json().evaluations as RuleEvaluationRecord[]).find(
      (item) => item.rule.id === 'ledger.nprm.108.165.d',
    );
    expect(lostLink).toMatchObject({ outcome: 'pass', adoption: { id: shadow } });
    const coverage = await procedures.call(procedures.actor, 'GET', `/v1/organization/coverage/adoptions/${shadow}`);
    expect(coverage.statusCode, coverage.body).toBe(200);
    const rule = (coverage.json() as AdoptionRuleCoverageResponse).rules.find(
      (item) => item.leafId === 'ledger.nprm.108.165.d',
    );
    expect(rule).toMatchObject({ populationSize: 1, counts: { supported: 1 } });
    const organizations = await procedures.call(procedures.actor, 'GET', '/v1/organization/subjects?kind=organization');
    expect(organizations.statusCode, organizations.body).toBe(200);
    expect((organizations.json() as SubjectsOnRecordResponse).subjects.map((item) => item.id)).toEqual([own.id]);
  });
});
