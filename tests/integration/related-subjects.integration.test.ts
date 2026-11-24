import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import {
  leaseRuleEvaluations,
  leaseWork,
  processLease,
  processRuleEvaluationLease,
} from '../../apps/workers/src/index.js';
import {
  FidelitySchema,
  ObservationSubjectSchema,
  type FindingRecord,
  type ObservationTypeDefinition,
  type OrganizationCoverageResponse,
  type RuleEvaluationRecord,
  type RulePackVersion,
  type SubjectFindingRecord,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import {
  backfillObservationReferencesPage,
  defineCheckedRule,
  findCheckKind,
  registerObservationTypes,
  registerRulePack,
} from '../../packages/domain/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import {
  BATTERY_AT_LANDING_LEAF_ID,
  BATTERY_RESERVE_LEAF_ID,
  exampleOperationsVersionTwo,
} from '../../packages/pack-example-operations/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../packages/persistence/src/index.js';
import { runOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';

type Subject = { kind: string; id: string; scope: 'ledger' | 'source' };

// Fan-out and reads about a related subject (docs/design/fan-out-and-related-reads.md). Rules and packs live in
// this test; nothing in intake, the evaluator or the worker names them.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Reads about related subjects', () => {
  const prefix = `related-${randomUUID()}`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const sourceId = `${prefix}-records`;
  const tenantId = `${prefix}:tenant`;
  const laterType = `related.late-reference`;
  let laterTypeIndexed = false;
  let app: Awaited<ReturnType<typeof createApp>>;
  let artifactId: string;

  const source = {
    kind: 'operator_procedure' as const,
    reference: 'Fictional procedure 7.4 (invented for this test)',
    text: 'Each person assigned to a flight completes recurrent training within the months the organization sets, and each life-limited part stays within its life on the aircraft it is installed on.',
  };
  const trainingRule = defineCheckedRule({
    id: 'test.assigned-person-training',
    version: 1,
    title: 'Every assigned person’s recurrent training',
    source,
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'person',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'insufficient',
        from: { read: 'assignments', field: 'values.record.personId' },
      },
    ],
    reads: [
      {
        name: 'assignments',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
      },
      {
        name: 'subject',
        type: 'operator.record',
        versions: [1],
        about: { related: 'person' },
        required: false,
        select: 'all',
        where: [
          { field: 'values.recordType', oneOf: ['person.training'] },
          { field: 'values.record.trainingKind', oneOf: ['recurrent'] },
        ],
      },
    ],
    check: {
      kind: findCheckKind('date.within-months', 2)!,
      params: { select: { recordType: 'person.training', recordVersion: 1 }, field: 'values.record.completedOn' },
    },
    adoptionParameters: [
      { name: 'months', title: 'Months since recurrent training', valueType: 'integer', minimum: 1 },
    ],
  });
  const lifeLimitRule = defineCheckedRule({
    id: 'test.part-life-on-aircraft',
    version: 1,
    title: 'Life-limited part within its life on the aircraft',
    source,
    target: { subjectKind: 'component' },
    related: [
      {
        name: 'aircraft',
        subjectKind: 'aircraft',
        fanOut: false,
        whenNone: 'insufficient',
        from: { read: 'limit', field: 'values.record.aircraftId' },
      },
    ],
    reads: [
      {
        name: 'limit',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'latest',
        where: [{ field: 'values.recordType', oneOf: ['component.life-limit'] }],
      },
      {
        name: 'quantity',
        type: 'operator.record',
        versions: [1],
        about: { related: 'aircraft' },
        required: true,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['aircraft.time-in-service'] }],
      },
    ],
    check: {
      kind: findCheckKind('value.within-limit', 2)!,
      params: {
        field: 'values.record.totalTimeHours',
        comparison: 'at_most',
        limitField: 'values.record.lifeLimitHours',
        offsetField: 'values.record.partTimeAtInstallHours',
        measureFrom: 'limit_start',
      },
    },
  });
  // The same limit per aircraft: one result for each part whose life-limit record names the aircraft.
  const partsOnAircraftRule = defineCheckedRule({
    id: 'test.parts-life-per-aircraft',
    version: 1,
    title: 'Each life-limited part installed on the aircraft',
    source,
    target: { subjectKind: 'aircraft' },
    related: [
      {
        name: 'part',
        subjectKind: 'component',
        fanOut: true,
        whenNone: 'not_applicable',
        from: { read: 'limit', field: 'subject' },
      },
    ],
    reads: [
      {
        name: 'limit',
        type: 'operator.record',
        versions: [1],
        about: { referencing: 'values.record.aircraftId' },
        required: false,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['component.life-limit'] }],
      },
      {
        name: 'quantity',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['aircraft.time-in-service'] }],
      },
    ],
    check: {
      kind: findCheckKind('value.within-limit', 2)!,
      params: lifeLimitRule.check.params,
    },
  });
  const organizationRule = defineCheckedRule({
    id: 'test.coordinator-requirement-basis',
    version: 1,
    title: 'Coordinator requirement basis recorded',
    source,
    target: { subjectKind: 'flight' },
    reads: [
      {
        name: 'subject',
        type: 'operator.record',
        versions: [1],
        about: 'organization',
        required: true,
        select: 'latest',
        where: [{ field: 'values.recordType', oneOf: ['organization.coordinator-requirement'] }],
      },
      {
        name: 'assignments',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: false,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['operation.role-assignment'] }],
      },
    ],
    check: {
      kind: findCheckKind('value.one-of', 1)!,
      params: { field: 'values.record.basis', expected: ['operator_procedure', 'authority_documents'] },
    },
  });
  // Fans out over the people who supervise several aircraft at once, as one operation record names each.
  const supervisorRule = defineCheckedRule({
    id: 'test.supervisor-training',
    version: 1,
    title: 'Supervising person’s recurrent training',
    source,
    target: { subjectKind: 'flight' },
    related: [
      {
        name: 'supervisor',
        subjectKind: 'person',
        fanOut: true,
        whenNone: 'not_applicable',
        from: { read: 'operations', field: 'values.record.supervisingPersonId' },
      },
    ],
    reads: [
      {
        name: 'operations',
        type: 'operator.record',
        versions: [1],
        about: 'target',
        required: true,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['operation.multiple-aircraft'] }],
      },
      {
        name: 'subject',
        type: 'operator.record',
        versions: [1],
        about: { related: 'supervisor' },
        required: false,
        select: 'all',
        where: [{ field: 'values.recordType', oneOf: ['person.training'] }],
      },
    ],
    check: {
      kind: findCheckKind('date.within-months', 2)!,
      params: {
        select: { recordType: 'person.training', recordVersion: 1 },
        field: 'values.record.completedOn',
        months: 24,
      },
    },
  });
  // The training rule again, re-queued by a new training record only for flights whose assignment has not ended or
  // ended within the last week.
  const openFlightsRule = defineCheckedRule({
    id: 'test.open-flight-training',
    version: 1,
    title: 'Assigned person’s recurrent training, for flights still open',
    source,
    target: { subjectKind: 'flight' },
    related: [
      {
        ...trainingRule.related![0]!,
        requeue: { windowEnd: { read: 'assignments', field: 'values.record.endsAt' }, endedWithinDays: 7 },
      },
    ],
    reads: trainingRule.reads,
    check: {
      kind: findCheckKind('date.within-months', 2)!,
      params: { ...trainingRule.check.params, months: 24 },
    },
  });
  const windowContent = {
    packId: `${prefix}.window-pack`,
    version: 1,
    title: 'Fictional open-flight procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [openFlightsRule],
  };
  const windowPack: RulePackVersion = { ...windowContent, digest: canonicalDigest(windowContent) };
  const bulkContent = {
    packId: `${prefix}.bulk-pack`,
    version: 1,
    title: 'Fictional supervision procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [supervisorRule],
  };
  const bulkPack: RulePackVersion = { ...bulkContent, digest: canonicalDigest(bulkContent) };
  const packContent = {
    packId: `${prefix}.pack`,
    version: 1,
    title: 'Fictional crew and parts procedures',
    status: 'draft' as const,
    review: 'ai_drafted' as const,
    adopted: false as const,
    bindings: [],
    leaves: [trainingRule, lifeLimitRule, organizationRule, partsOnAircraftRule],
  };
  const testPack: RulePackVersion = { ...packContent, digest: canonicalDigest(packContent) };

  const actor: AuthContext = {
    tenantId,
    revision: 1,
    name: 'Fictional operations lead',
    id: `${tenantId}:actor`,
    kind: 'human',
    capabilities: [
      'flight:read',
      'flight:create',
      'evidence:read',
      'authority:write',
      'pack:adopt',
      'input:write',
      'sms:read',
      'sms:write',
    ],
  };
  const sourcePrincipal: AuthContext = {
    ...actor,
    id: `${tenantId}:source`,
    kind: 'source',
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  const worker: AuthContext = {
    ...actor,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'evidence:read', 'input:write'],
  };

  // A made-up type whose reference field is declared only after observations of it were accepted, as if the index
  // had been added to an existing database.
  function lateReferenceType(): ObservationTypeDefinition {
    return {
      type: laterType,
      version: 1,
      timing: 'instant',
      subjectKinds: ['flight'],
      secondarySubjectKinds: [],
      description: 'Made-up test type naming a person.',
      mayInfer: ['The source named this person.'],
      mayNotInfer: ['Nothing beyond the name.'],
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type',
          'version',
          'subject',
          'occurredAt',
          'fidelity',
          'limitations',
          'originalArtifactId',
          'values',
        ],
        properties: {
          type: { const: laterType },
          version: { const: 1 },
          subject: ObservationSubjectSchema,
          occurredAt: { type: 'string', format: 'date-time' },
          fidelity: FidelitySchema,
          limitations: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
          originalArtifactId: { type: 'string', minLength: 1, maxLength: 200 },
          values: {
            type: 'object',
            additionalProperties: false,
            properties: {
              personId: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'scope'],
                properties: { id: { type: 'string' }, scope: { enum: ['ledger', 'source'] } },
              },
            },
          },
        },
      } as unknown as ObservationTypeDefinition['schema'],
      referenceFields: () => (laterTypeIndexed ? [{ field: 'values.personId', referenceKind: 'person' }] : []),
    };
  }

  function call(principal: AuthContext, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function settle(): Promise<void> {
    for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
      const completed = await runOwnedWork(admin, workerPool, [tenantId]);
      const pending = await admin.query(
        `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
         +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
           AND r.due_at<=clock_timestamp() AND r.available_at<=clock_timestamp()) AS count`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      if (!completed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Worker did not settle');
  }

  async function upload(): Promise<string> {
    const bytes = Buffer.from(JSON.stringify({ entered: 'fictional operator records' }));
    const created = await call(sourcePrincipal, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${sourcePrincipal.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(sourcePrincipal, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  async function submitObservation(payload: Record<string, unknown>, occurredAt: string): Promise<string> {
    const response = await call(sourcePrincipal, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        ...payload,
        occurredAt,
        fidelity: 'synthetic_contract',
        limitations: ['Synthetic test data.'],
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().receipt.eventId as string;
  }

  /** Submits one operator record; the envelope time follows the record type's time fields. */
  async function record(
    subject: Subject,
    recordType: string,
    body: Record<string, unknown>,
    time: { occurredAt: string; interval?: { start: string; end?: string } },
    secondarySubject?: Subject,
  ): Promise<string> {
    return submitObservation(
      {
        type: 'operator.record',
        version: 1,
        subject,
        ...(secondarySubject ? { secondarySubject } : {}),
        ...(time.interval ? { interval: time.interval } : {}),
        values: { recordType, recordVersion: 1, record: body },
      },
      time.occurredAt,
    );
  }

  async function adopt(pack: RulePackVersion, parameters: Record<string, Record<string, number>>): Promise<void> {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call(
      actor,
      'GET',
      `/v1/rule-packs/${encodeURIComponent(pack.packId)}/versions/${pack.version}`,
    );
    expect(retained.statusCode, retained.body).toBe(200);
    const interval = { start: at(-24 * 60), end: at(24 * 60) };
    const adopted = await call(actor, 'POST', '/v1/commands', {
      ...adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        interval,
        'Adopt the fictional procedures.',
        'active',
      ),
      parameters,
    });
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  }

  async function flight(): Promise<string> {
    const created = await call(actor, 'POST', '/v1/flights', { originationKey: `${prefix}-${randomUUID()}` });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().flight.id as string;
  }

  function subjectQuery(subject: Subject): string {
    return new URLSearchParams({
      subjectKind: subject.kind,
      subjectId: subject.id,
      ...(subject.scope === 'source' ? { subjectScope: 'source', sourceId } : {}),
      limit: '100',
    }).toString();
  }
  async function evaluations(subject: Subject, ruleId: string): Promise<RuleEvaluationRecord[]> {
    const response = await call(actor, 'GET', `/v1/evaluations?${subjectQuery(subject)}`);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json().evaluations as RuleEvaluationRecord[]).filter((item) => item.rule.id === ruleId);
  }
  /** The latest result for each related subject (key '' for the subject itself). */
  async function latestByRelated(subject: Subject, ruleId: string): Promise<Map<string, RuleEvaluationRecord>> {
    const latest = new Map<string, RuleEvaluationRecord>();
    for (const item of await evaluations(subject, ruleId)) {
      const key = item.related?.subjectKey ?? '';
      if (!latest.has(key)) latest.set(key, item);
    }
    return latest;
  }
  async function findings(subject: Subject): Promise<SubjectFindingRecord[]> {
    const response = await call(actor, 'GET', `/v1/findings?${subjectQuery(subject)}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings as SubjectFindingRecord[];
  }
  async function workFor(eventId: string): Promise<{ subject_key: string; trigger_kind: string }[]> {
    const rows = await admin.query(
      `SELECT subject_key,trigger_kind FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2
       ORDER BY subject_key`,
      [tenantId, eventId],
    );
    return rows.rows;
  }
  function person(id: string): Subject {
    return { kind: 'person', id, scope: 'source' };
  }
  function personKey(id: string): string {
    return `source/${encodeURIComponent(sourceId)}/person/${id}`;
  }
  async function assign(flightId: string, personId: string, role = 'visual_observer'): Promise<string> {
    const startsAt = at(-120);
    return record(
      { kind: 'flight', id: flightId, scope: 'ledger' },
      'operation.role-assignment',
      { personId: { id: personId, scope: 'source' }, role, startsAt },
      { occurredAt: startsAt, interval: { start: startsAt } },
    );
  }
  async function train(personId: string, completedOn: string): Promise<string> {
    return record(
      person(personId),
      'person.training',
      {
        trainingKind: 'recurrent',
        courseTitle: 'Fictional recurrent course',
        completedOn,
        evidenceReference: `Fictional certificate ${randomUUID()}`,
      },
      { occurredAt: at(-30) },
    );
  }
  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  }

  async function referencesOf(observationId: string) {
    const rows = await admin.query(
      `SELECT field,reference_kind,reference_scope,reference_id,reference_source_id,reference_key
       FROM observation_references WHERE tenant_id=$1 AND observation_id=$2 ORDER BY field`,
      [tenantId, observationId],
    );
    return rows.rows;
  }

  beforeAll(async () => {
    registerObservationTypes(lateReferenceType());
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional related-subject tenant']);
    for (const principal of [actor, worker, sourcePrincipal]) {
      await admin.query('INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,$4,$5)', [
        principal.id,
        tenantId,
        principal.name,
        principal.kind,
        principal.capabilities,
      ]);
      await admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
        sha256(`ledger-dev-${principal.id}`),
        principal.id,
      ]);
    }
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(sourcePrincipal.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: sourcePrincipal.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['operator.record', 'battery.state', 'flight.report', laterType].map((observationType) => ({
        sourceId,
        observationType,
      })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
    artifactId = await upload();
    registerRulePack({ packId: testPack.packId, versions: [testPack] });
    registerRulePack({ packId: bulkPack.packId, versions: [bulkPack] });
    registerRulePack({ packId: windowPack.packId, versions: [windowPack] });
    await adopt(testPack, { [trainingRule.id]: { months: 12 } });
  });
  afterAll(async () => {
    await settleOwnedWork([tenantId]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('indexes the reference fields of an accepted record, and the backfill indexes earlier ones', async () => {
    const flightId = `${prefix}-indexed-flight`;
    const startsAt = at(-60);
    const assignment = await record(
      { kind: 'flight', id: flightId, scope: 'source' },
      'operation.role-assignment',
      {
        personId: { id: 'person-indexed', scope: 'source' },
        role: 'visual_observer',
        startsAt,
        handoverFromPersonId: { id: 'person-before', scope: 'source' },
      },
      { occurredAt: startsAt, interval: { start: startsAt } },
    );
    expect(await referencesOf(assignment)).toEqual([
      {
        field: 'values.record.handoverFromPersonId',
        reference_kind: 'person',
        reference_scope: 'source',
        reference_id: 'person-before',
        reference_source_id: sourceId,
        reference_key: `source/${encodeURIComponent(sourceId)}/person/person-before`,
      },
      {
        field: 'values.record.personId',
        reference_kind: 'person',
        reference_scope: 'source',
        reference_id: 'person-indexed',
        reference_source_id: sourceId,
        reference_key: `source/${encodeURIComponent(sourceId)}/person/person-indexed`,
      },
    ]);

    const earlier = await submitObservation(
      {
        type: laterType,
        version: 1,
        subject: { kind: 'flight', id: flightId, scope: 'source' },
        values: { personId: { id: 'person-late', scope: 'source' } },
      },
      at(-50),
    );
    expect(await referencesOf(earlier)).toEqual([]);
    laterTypeIndexed = true;
    const backfill = async () => {
      let added = 0;
      let after: string | null = '';
      while (after !== null) {
        const client = await admin.connect();
        try {
          const page = await backfillObservationReferencesPage(client, { after, limit: 1000 });
          added += page.indexed;
          after = page.after;
        } finally {
          client.release();
        }
      }
      return added;
    };
    expect(await backfill()).toBeGreaterThanOrEqual(1);
    expect(await referencesOf(earlier)).toMatchObject([
      { field: 'values.personId', reference_scope: 'source', reference_id: 'person-late' },
    ]);
    // A second run adds nothing for observations already indexed.
    await backfill();
    expect(await referencesOf(earlier)).toHaveLength(1);
    expect(await referencesOf(assignment)).toHaveLength(2);
    await settle();
  });

  it('gives one result and one finding per assigned person', async () => {
    const flightId = await flight();
    const target: Subject = { kind: 'flight', id: flightId, scope: 'ledger' };
    for (const id of ['crew-a', 'crew-b', 'crew-c']) await train(`${prefix}-${id}`, '2020-01-15');
    for (const id of ['crew-a', 'crew-b', 'crew-c']) await assign(flightId, `${prefix}-${id}`);
    await settle();
    const latest = await latestByRelated(target, trainingRule.id);
    expect([...latest.keys()].sort()).toEqual(['crew-a', 'crew-b', 'crew-c'].map((id) => personKey(`${prefix}-${id}`)));
    for (const [key, result] of latest) {
      expect(result).toMatchObject({
        subject: target,
        outcome: 'attention',
        reasonCode: 'date_outside_months',
        related: { name: 'person', subjectKey: key, subject: { scope: 'source', kind: 'person', sourceId } },
      });
      expect(result.related!.namedBy).toHaveLength(1);
      const read = result.inputs.find((input) => input.name === 'subject')!;
      expect(read).toMatchObject({ about: { related: 'person' }, subject: result.related!.subject });
      expect(read.observationIds).toHaveLength(1);
      // Each result reads only the assignment that named its person.
      expect(result.inputs.find((input) => input.name === 'assignments')!.observationIds).toEqual(
        result.related!.namedBy.map((item) => item.observationId),
      );
    }
    const flightFindings = await findings(target);
    expect(flightFindings).toHaveLength(3);
    expect(new Set(flightFindings.map((item) => item.id)).size).toBe(3);
    expect(flightFindings.map((item) => item.related?.subjectKey).sort()).toEqual([...latest.keys()].sort());
    // A finding belongs to the flight and is listed under the person too.
    const personFindings = await findings(person(`${prefix}-crew-b`));
    expect(personFindings).toHaveLength(1);
    expect(personFindings[0]).toMatchObject({
      subject: target,
      related: { subjectKey: personKey(`${prefix}-crew-b`) },
    });

    // A hazard opened from a finding names its related subject and rests on that subject's evidence too.
    const promotions = [];
    for (const finding of flightFindings) {
      const shown = await call(actor, 'GET', `/v1/sms/findings/${encodeURIComponent(finding.id)}/promotion`);
      expect(shown.statusCode, shown.body).toBe(200);
      expect(shown.json().origin).toMatchObject({ findingId: finding.id, subject: target, related: finding.related });
      promotions.push(shown.json().basis.dependencyBasis as string);
    }
    expect(new Set(promotions).size).toBe(3);

    // A new training record for one person queues only the flights whose assignments name that person.
    const other = await flight();
    const unrelated = await flight();
    await assign(other, `${prefix}-crew-b`, 'pilot_in_command');
    await assign(unrelated, `${prefix}-someone-else`);
    await settle();
    const renewed = await train(`${prefix}-crew-a`, daysAgo(10));
    await settle();
    expect(await workFor(renewed)).toEqual([{ subject_key: `ledger/flight/${flightId}`, trigger_kind: 'observation' }]);
    const renewedB = await train(`${prefix}-crew-b`, daysAgo(5));
    await settle();
    expect((await workFor(renewedB)).map((item) => item.subject_key)).toEqual(
      [`ledger/flight/${flightId}`, `ledger/flight/${other}`].sort(),
    );
    await settle();
    const after = await latestByRelated(target, trainingRule.id);
    expect(after.get(personKey(`${prefix}-crew-a`))).toMatchObject({
      outcome: 'pass',
      trigger: { kind: 'observation', eventId: renewed },
    });
    expect(after.get(personKey(`${prefix}-crew-c`))).toMatchObject({ outcome: 'attention' });
    // The renewed training resolves the finding: it closes by itself and names the evaluation that closed it.
    const closed = (await findings(person(`${prefix}-crew-a`))).find((item) => item.subject.id === flightId)!;
    expect(closed).toMatchObject({
      status: 'resolved',
      latestEvaluation: { outcome: 'pass' },
      closure: { by: 'record', evaluationId: closed.latestEvaluation.id },
    });

    // An unassigned person is recorded once as no longer named; the finding stays as it is.
    const assignment = after.get(personKey(`${prefix}-crew-c`))!.related!.namedBy[0]!.observationId;
    const withdrawn = await call(sourcePrincipal, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId: assignment,
      reason: 'The fictional assignment was entered for the wrong flight.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    await settle();
    const dropped = await latestByRelated(target, trainingRule.id);
    expect(dropped.get(personKey(`${prefix}-crew-c`))).toMatchObject({
      outcome: 'not_applicable',
      reasonCode: 'related_subject_not_named',
      related: { namedBy: [] },
    });
    expect((await findings(person(`${prefix}-crew-c`)))[0]).toMatchObject({ status: 'open' });
  });

  it('reads the time in service of the aircraft a life-limited part is installed on', async () => {
    const aircraft: Subject = { kind: 'aircraft', id: `${prefix}-aircraft`, scope: 'source' };
    const component: Subject = { kind: 'component', id: `${prefix}-rotor-hub`, scope: 'source' };
    const installedAt = at(-10 * 24 * 60);
    const hours = (totalTimeHours: number, coveredThroughAt: string) =>
      record(
        aircraft,
        'aircraft.time-in-service',
        {
          entryKind: 'running_total',
          totalTimeHours,
          coveredThroughAt,
          sourceReference: 'Fictional aircraft log',
          coverage: 'complete',
          coverageNotes: 'Every flight is entered in the fictional log.',
        },
        { occurredAt: coveredThroughAt },
      );
    const baseline = await hours(500, at(-11 * 24 * 60));
    const current = await hours(580, at(-60));
    const limit = await record(
      component,
      'component.life-limit',
      {
        partName: 'Fictional rotor hub',
        aircraftId: { id: aircraft.id, scope: 'source' },
        installedAt,
        lifeLimitHours: 100,
        partTimeAtInstallHours: 10,
      },
      { occurredAt: installedAt, interval: { start: installedAt } },
    );
    await settle();
    const [result] = await evaluations(component, lifeLimitRule.id);
    expect(result).toMatchObject({
      outcome: 'pass',
      reasonCode: 'value_within_limit',
      summary: expect.stringContaining('Total time in service through the cutoff is 90'),
    });
    expect(result!.related).toBeUndefined();
    const quantity = result!.inputs.find((input) => input.name === 'quantity')!;
    expect(quantity).toMatchObject({
      about: { related: 'aircraft' },
      subject: { scope: 'source', kind: 'aircraft', id: aircraft.id, sourceId },
    });
    expect(quantity.observationIds.sort()).toEqual([baseline, current].sort());
    expect(result!.inputs.find((input) => input.name === 'limit')!.observationIds).toEqual([limit]);

    // Per aircraft, the part's record that names the aircraft gives one result for that part.
    const perAircraft = await latestByRelated(aircraft, partsOnAircraftRule.id);
    const componentKey = `source/${encodeURIComponent(sourceId)}/component/${component.id}`;
    expect(perAircraft.get(componentKey)).toMatchObject({
      outcome: 'pass',
      related: { name: 'part', namedBy: [{ observationId: limit, field: 'subject' }] },
      summary: expect.stringContaining('Total time in service through the cutoff is 90'),
    });
    // A target-level result appears only to report a problem of the fan-out, or that one has cleared.
    expect(perAircraft.get('')?.reasonCode ?? 'evaluated_per_related_subject').toBe('evaluated_per_related_subject');
  });

  async function project(): Promise<void> {
    // Records from one source session share a stream, which projects in order, one event per lease round.
    for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
      const leases = await withOwnedWork(admin, [tenantId], () => leaseWork(workerPool, { limit: 100 }));
      for (const lease of leases) await processLease(workerPool, lease);
      const pending = await admin.query(
        `SELECT COUNT(*) AS count FROM work_items WHERE tenant_id=$1 AND state IN ('pending','leased')`,
        [tenantId],
      );
      if (Number(pending.rows[0].count) === 0) return;
      if (!leases.length) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Projections did not settle');
  }
  function supervision(flight: Subject, personId: string) {
    return record(
      flight,
      'operation.multiple-aircraft',
      {
        supervisingPersonId: { id: personId, scope: 'source' },
        simultaneousAircraftCount: 2,
        manufacturerLimitCount: 3,
        methodLimitCount: 3,
        methodReference: 'Fictional method 2.1',
      },
      { occurredAt: at(-90) },
    );
  }

  it('queues a thousand flights that name one person a page at a time, and reads at most fifty people', async () => {
    const supervisor = `${prefix}-bulk-supervisor`;
    const flights = Array.from({ length: 1000 }, (_, index): Subject => ({
      kind: 'flight',
      id: `${prefix}-bulk-flight-${index}`,
      scope: 'source',
    }));
    for (let start = 0; start < flights.length; start += 25)
      await Promise.all(flights.slice(start, start + 25).map((item) => supervision(item, supervisor)));
    const crowded = await flight();
    const crowd: Subject = { kind: 'flight', id: crowded, scope: 'ledger' };
    for (let index = 0; index < 50; index++) await supervision(crowd, `${prefix}-crowd-${index}`);
    await project();
    // The adoption evaluates the flight's fifty supervisors already on record.
    await adopt(bulkPack, {});
    const adopted = await latestByRelated(crowd, supervisorRule.id);
    expect([...adopted.keys()].filter(Boolean)).toHaveLength(50);

    // One more supervisor makes 51: one result for the flight says so, and no person's result is written.
    const extra = await supervision(crowd, `${prefix}-crowd-50`);
    await settle();
    const limited = await latestByRelated(crowd, supervisorRule.id);
    expect(new Set(limited.keys())).toEqual(new Set(['', ...adopted.keys()]));
    for (const [key, result] of adopted) if (key) expect(limited.get(key)).toEqual(result);
    expect(limited.get('')).toMatchObject({
      evidenceState: 'insufficient',
      reasonCode: 'related_subject_limit',
      summary: '51 related subjects are named; one evaluation reads at most 50.',
    });
    const withdrawn = await call(sourcePrincipal, 'POST', '/v1/commands', {
      kind: 'observation.withdraw',
      observationId: extra,
      reason: 'The fictional supervisor was entered twice.',
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(201);
    await settle();
    const fifty = await latestByRelated(crowd, supervisorRule.id);
    expect(fifty.size).toBe(51);
    expect(fifty.get('')).toMatchObject({ outcome: 'not_applicable', reasonCode: 'evaluated_per_related_subject' });

    // A training record for the supervisor of a thousand flights queues the first page with its event.
    const training = await train(supervisor, daysAgo(3));
    await project();
    const queuedFor = async (kind: string) =>
      Number(
        (
          await admin.query(
            `SELECT COUNT(*) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2
             AND trigger_kind=$3`,
            [tenantId, training, kind],
          )
        ).rows[0].count,
      );
    expect(await queuedFor('observation')).toBe(500);
    expect(await queuedFor('related')).toBe(1);
    // A worker continues from the position the 'related' row carries, in its own transaction.
    await admin.query(
      `UPDATE rule_evaluation_work SET available_at=clock_timestamp()+interval '1 hour'
       WHERE tenant_id=$1 AND state='pending' AND trigger_kind<>'related'`,
      [tenantId],
    );
    const [lease] = await withOwnedWork(admin, [tenantId], () => leaseRuleEvaluations(workerPool, { limit: 1 }));
    expect(lease).toMatchObject({ tenant_id: tenantId, trigger_kind: 'related', trigger_event_id: training });
    expect(await processRuleEvaluationLease(workerPool, lease!)).toBe(true);
    expect(await queuedFor('observation')).toBe(1000);
    expect(await queuedFor('related')).toBe(1);
    const keys = await admin.query(
      `SELECT COUNT(DISTINCT subject_key) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND trigger_event_id=$2
       AND trigger_kind='observation' AND subject_key LIKE $3`,
      [tenantId, training, `source/%/flight/${prefix}-bulk-flight-%`],
    );
    expect(Number(keys.rows[0].count)).toBe(1000);
    // The thousand evaluations are not needed here.
    await admin.query(
      `UPDATE rule_evaluation_work SET state='completed',completed_at=clock_timestamp()
       WHERE tenant_id=$1 AND state='pending' AND trigger_event_id=$2`,
      [tenantId, training],
    );
    await admin.query(
      `UPDATE rule_evaluation_work SET available_at=clock_timestamp() WHERE tenant_id=$1 AND state='pending'`,
      [tenantId],
    );
    await settle();
  }, 600_000);

  it('re-queues only the flights whose assignment window is open when a person’s record changes', async () => {
    await adopt(windowPack, {});
    const personId = `window-${randomUUID()}`;
    /** A flight whose assignment of the person ended the given days ago (negative: ends in the future). */
    async function assignedFlight(endedDaysAgo: number): Promise<string> {
      const flightId = await flight();
      const startsAt = at(-(endedDaysAgo + 1) * 24 * 60);
      const endsAt = at(-endedDaysAgo * 24 * 60);
      await record(
        { kind: 'flight', id: flightId, scope: 'ledger' },
        'operation.role-assignment',
        { personId: { id: personId, scope: 'source' }, role: 'visual_observer', startsAt, endsAt },
        { occurredAt: startsAt, interval: { start: startsAt, end: endsAt } },
      );
      return flightId;
    }
    const open = await assignedFlight(-1);
    const recent = await assignedFlight(3);
    const closed = await assignedFlight(30);
    await settle();
    const before = await evaluations({ kind: 'flight', id: closed, scope: 'ledger' }, openFlightsRule.id);
    expect(before.length).toBeGreaterThan(0);

    const trained = await train(personId, daysAgo(10));
    await settle();
    const queued = await admin.query(
      `SELECT subject_key,leaf_id,trigger_kind,state,continuation FROM rule_evaluation_work
       WHERE tenant_id=$1 AND trigger_event_id=$2 ORDER BY leaf_id,subject_key`,
      [tenantId, trained],
    );
    const flightsFor = (leafId: string) =>
      queued.rows
        .filter((row) => row.leaf_id === leafId && row.trigger_kind === 'observation')
        .map((row) => row.subject_key)
        .sort();
    const key = (id: string) => `ledger/flight/${encodeURIComponent(id)}`;
    // The open flight and the one that ended within the week are queued; the one that ended a month ago is not.
    expect(flightsFor(openFlightsRule.id)).toEqual([key(open), key(recent)].sort());
    // Without the declaration every flight that names the person is queued, as before.
    expect(flightsFor(trainingRule.id)).toEqual([key(open), key(recent), key(closed)].sort());
    // The skip is recorded on the queueing work for the event, with how many were skipped.
    expect(
      queued.rows.filter((row) => row.leaf_id === openFlightsRule.id && row.trigger_kind === 'related'),
    ).toMatchObject([{ state: 'completed', subject_key: personKey(personId), continuation: { skipped: 1 } }]);
    expect(queued.rows.some((row) => row.leaf_id === trainingRule.id && row.trigger_kind === 'related')).toBe(false);
    // The closed flight keeps its last evaluation; the open ones are evaluated again with the new record.
    expect(await evaluations({ kind: 'flight', id: closed, scope: 'ledger' }, openFlightsRule.id)).toEqual(before);
    const latest = await latestByRelated({ kind: 'flight', id: open, scope: 'ledger' }, openFlightsRule.id);
    expect(latest.get(personKey(personId))).toMatchObject({ outcome: 'pass' });
  });

  it('reads an organization record a source named by its own id once an alias resolves it', async () => {
    const flightId = await flight();
    const target: Subject = { kind: 'flight', id: flightId, scope: 'ledger' };
    const sourceOrganization: Subject = { kind: 'organization', id: `${prefix}-org-in-file`, scope: 'source' };
    const requirement = await record(
      sourceOrganization,
      'organization.coordinator-requirement',
      { coordinatorRequired: true, basis: 'operator_procedure' },
      { occurredAt: at(-300) },
    );
    await assign(flightId, `${prefix}-coordinator`, 'flight_coordinator');
    await settle();
    const [before] = await evaluations(target, organizationRule.id);
    expect(before).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'required_input_missing' });

    const aliased = await call(sourcePrincipal, 'POST', '/v1/commands', {
      kind: 'subject.alias',
      sourceId,
      subjectKind: 'organization',
      externalId: sourceOrganization.id,
      ledgerSubjectId: `organization:${tenantId}`,
      reason: 'The fictional file names the organization by its own code.',
    });
    expect(aliased.statusCode, aliased.body).toBe(201);
    await settle();
    const [after] = await evaluations(target, organizationRule.id);
    expect(after).toMatchObject({ outcome: 'pass', trigger: { kind: 'correction' } });
    expect(after!.inputs.find((input) => input.name === 'subject')!.observationIds).toEqual([requirement]);

    // A later record under the same code resolves at intake.
    const later = await record(
      sourceOrganization,
      'organization.coordinator-requirement',
      { coordinatorRequired: true, basis: 'none_found' },
      { occurredAt: at(-200) },
    );
    await settle();
    const [latest] = await evaluations(target, organizationRule.id);
    expect(latest).toMatchObject({ outcome: 'attention', trigger: { eventId: later } });
  });

  it('checks the battery at each landing on the aircraft the flight report names (example pack version 2)', async () => {
    await adopt(exampleOperationsVersionTwo(), {
      [BATTERY_RESERVE_LEAF_ID]: { limit: 25 },
      [BATTERY_AT_LANDING_LEAF_ID]: { limit: 25 },
    });
    const flightId = await flight();
    const target: Subject = { kind: 'flight', id: flightId, scope: 'ledger' };
    const aircraft: Subject = { kind: 'aircraft', id: `${prefix}-landing-aircraft`, scope: 'source' };
    await submitObservation(
      {
        type: 'flight.report',
        version: 1,
        subject: target,
        secondarySubject: aircraft,
        values: { activity: 'landed', landingAt: at(-30) },
      },
      at(-20),
    );
    await settle();
    const [waiting] = await evaluations(target, BATTERY_AT_LANDING_LEAF_ID);
    // Landed with no battery report yet: no battery is on file for the landing, and the flight record states none.
    expect(waiting).toMatchObject({ evidenceState: 'insufficient', reasonCode: 'values_missing' });

    // Battery reports about the aircraft queue the flight whose report names it.
    const battery = (totalRemainingPercent: number, minutes: number) =>
      submitObservation(
        { type: 'battery.state', version: 1, subject: aircraft, values: { totalRemainingPercent } },
        at(minutes),
      );
    await battery(40, -50);
    const atLanding = await battery(20, -32);
    await battery(90, -10);
    await settle();
    expect((await workFor(atLanding)).map((item) => item.subject_key)).toContain(`ledger/flight/${flightId}`);
    const [result] = await evaluations(target, BATTERY_AT_LANDING_LEAF_ID);
    expect(result).toMatchObject({ outcome: 'attention', reasonCode: 'values_outside_limit', pack: { version: 2 } });
    const read = result!.inputs.find((input) => input.name === 'values')!;
    expect(read).toMatchObject({
      about: { related: 'aircraft' },
      subject: { scope: 'source', kind: 'aircraft', id: aircraft.id, sourceId },
      observationIds: [atLanding],
    });

    // The reads name the subject of every input beside the records; what was recorded, and every digest, is untouched.
    const label = (
      await admin.query<{ label: string }>('SELECT label FROM subjects WHERE tenant_id=$1 AND id=$2', [
        tenantId,
        flightId,
      ])
    ).rows[0]!.label;
    const named = [
      { scope: 'ledger', kind: 'flight', id: flightId, name: label },
      { scope: 'source', kind: 'aircraft', id: aircraft.id, sourceId, name: aircraft.id },
      // The operator's own flight record is read about the flight too.
      { scope: 'ledger', kind: 'flight', id: flightId, name: label },
    ];
    expect(result!.inputs.map((input) => input.name)).toEqual(['window', 'values', 'recorded']);
    const listed = await call(actor, 'GET', `/v1/evaluations?${subjectQuery(target)}`);
    expect(listed.json().inputSubjects[result!.id]).toEqual(named);
    // This rule has no wording of its own: its check's own summary comes back with its instants as placeholders.
    expect(listed.json().summaryWording[result!.id]).toBe(
      '1 run(s) of the battery state’s Battery remaining (%) outside at least 25 % in the window from {windowStart} to {windowStart}, 0 s in all; the worst is 20 % at {windowStart}.',
    );
    const one = await call(actor, 'GET', `/v1/evaluations/${encodeURIComponent(result!.id)}`);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().inputSubjects).toEqual({ [result!.id]: named });
    const stored = (
      await admin.query<{ record: RuleEvaluationRecord }>(
        'SELECT record FROM rule_evaluations WHERE tenant_id=$1 AND id=$2',
        [tenantId, result!.id],
      )
    ).rows[0]!.record;
    expect(one.json().evaluation).toEqual(stored);
    expect(canonicalDigest(one.json().evaluation)).toBe(canonicalDigest(stored));
    const shownFindings = await call(actor, 'GET', `/v1/findings?${subjectQuery(target)}`);
    const finding = (shownFindings.json().findings as SubjectFindingRecord[]).find(
      (item) => item.ruleId === BATTERY_AT_LANDING_LEAF_ID,
    )!;
    expect(shownFindings.json().inputSubjects[finding.latestEvaluation.id]).toEqual(named);
    const onFlight = await call(actor, 'GET', `/v1/flights/${flightId}/findings`);
    expect(onFlight.statusCode, onFlight.body).toBe(200);
    const flightFinding = (onFlight.json().findings as FindingRecord[]).find(
      (item) => item.latestEvaluation.leafId === BATTERY_AT_LANDING_LEAF_ID,
    )!;
    expect(onFlight.json().inputSubjects[flightFinding.latestEvaluation.id]).toEqual(named);
  });

  function at(minutes: number): string {
    return new Date(Date.now() + minutes * 60_000).toISOString();
  }
});
