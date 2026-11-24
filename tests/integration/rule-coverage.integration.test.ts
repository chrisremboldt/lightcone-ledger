import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  RuleCoverage,
  RuleCoverageSubjectsResponse,
  SubjectsOnRecordResponse,
} from '../../packages/contracts/src/index.js';
import { continueAdoptionRuleEvaluations } from '../../packages/domain/src/rule-evaluations.js';
import { getAdoptionRuleCoverage } from '../../packages/domain/src/rule-coverage.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { createPool, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, trainingRecords, type CoverageTenant } from './coverage-tenant.js';
import { projectOwnedWork, settleOwnedWork } from './worker-queue.js';

const CERTIFICATE_RULE = 'ledger.part107.107.12.b';
const PERSONNEL_FILE_RULE = 'ledger.nprm.108.40.b.1-3';

/** Standing designations of the people as remote pilot in command, about the organization. */
async function designatePilots(tenant: CoverageTenant, people: readonly string[]): Promise<void> {
  await tenant.importRecords(
    'operation.role-assignment',
    people.map((personId) => ({
      subjectId: `organization:${tenant.tenantId}`,
      subjectKind: 'organization',
      personId,
      role: 'pilot_in_command',
      startsAt: '2026-01-01T00:00:00Z',
    })),
  );
}

async function ruleCoverage(tenant: CoverageTenant, adoptionId: string, leafId: string): Promise<RuleCoverage> {
  const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
  expect(read.statusCode, read.body).toBe(200);
  const rule = (read.json() as AdoptionRuleCoverageResponse).rules.find((item) => item.leafId === leafId);
  expect(rule, leafId).toBeDefined();
  return rule!;
}

async function subjectsBehind(
  tenant: CoverageTenant,
  adoptionId: string,
  leafId: string,
  result: string,
): Promise<RuleCoverageSubjectsResponse> {
  const read = await tenant.call(
    tenant.actor,
    'GET',
    `/v1/organization/coverage/adoptions/${adoptionId}/rules/${leafId}/subjects?result=${result}`,
  );
  expect(read.statusCode, read.body).toBe(200);
  return read.json() as RuleCoverageSubjectsResponse;
}

describe('coverage of the Part 107 pack for pilots with only training records and a designation', () => {
  let tenant: CoverageTenant;
  let people: string[];
  let adoptionId: string;

  beforeAll(async () => {
    tenant = await coverageTenant('coverage-part107');
    people = ['PILOT-A', 'PILOT-B', 'PILOT-C'].map((id) => `${tenant.prefix}-${id}`);
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('shows three pilots with no remote pilot certificate on file, without anyone typing an id', async () => {
    // A maintenance lead with training records and no role as a pilot is not one of the people the rule is about.
    const maintenanceLead = `${tenant.prefix}-MAINT-A`;
    await tenant.importRecords('person.training', trainingRecords([...people, maintenanceLead]));
    await designatePilots(tenant, people);
    adoptionId = await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await tenant.settle();

    const rule = await ruleCoverage(tenant, adoptionId, CERTIFICATE_RULE);
    expect(rule).toMatchObject({
      checkedBy: 'automatic',
      subjectKind: 'person',
      population: { of: 'designated' },
      populationSize: 3,
      complete: true,
      counts: { no_record: 3, supported: 0, attention: 0, not_evaluated: 0 },
    });
    const behind = await subjectsBehind(tenant, adoptionId, CERTIFICATE_RULE, 'no_record');
    expect(behind.subjects.map((item) => item.subject.name).sort()).toEqual(people);
    for (const item of behind.subjects)
      expect(item).toMatchObject({
        result: 'no_record',
        missing: ['remote pilot certificate'],
        evaluation: {
          evidenceState: 'insufficient',
          outcome: 'pending',
          reasonCode: 'record_not_on_file',
          summary: 'No remote pilot certificate on file.',
        },
        finding: null,
      });

    // A rule a person reviews is listed with how it is checked and no counts.
    const manual = await ruleCoverage(tenant, adoptionId, 'ledger.part107.107.15.b');
    expect(manual).toMatchObject({ checkedBy: 'person', populationSize: null, counts: null });
    // A missing record opens no finding that needs an owner.
    const findings = await tenant.admin.query('SELECT COUNT(*)::int AS count FROM findings WHERE tenant_id=$1', [
      tenant.tenantId,
    ]);
    expect(findings.rows[0].count).toBe(0);
  });

  it('lists the people on record by name for picking one', async () => {
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/subjects?kind=person&search=pilot-b`);
    expect(read.statusCode, read.body).toBe(200);
    const listed = read.json() as SubjectsOnRecordResponse;
    expect(listed.subjects).toEqual([
      { scope: 'source', kind: 'person', id: people[1], sourceId: tenant.sourceId, name: people[1] },
    ]);
    expect(listed.truncated).toBe(false);
  });

  it('evaluates a person who joins after the adoption, and counts a certificate once it is on file', async () => {
    const joining = `${tenant.prefix}-PILOT-D`;
    await tenant.importRecords('person.training', trainingRecords([joining]));
    await designatePilots(tenant, [joining]);
    await tenant.settle();
    expect(await ruleCoverage(tenant, adoptionId, CERTIFICATE_RULE)).toMatchObject({
      populationSize: 4,
      complete: true,
      counts: { no_record: 4 },
    });

    await tenant.importRecords('person.certificate', [
      {
        subjectId: people[0],
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'RP-FICT-1',
        recordedStatus: 'held',
      },
    ]);
    await tenant.settle();
    expect(await ruleCoverage(tenant, adoptionId, CERTIFICATE_RULE)).toMatchObject({
      populationSize: 4,
      counts: { no_record: 3, supported: 1 },
    });
    const supported = await subjectsBehind(tenant, adoptionId, CERTIFICATE_RULE, 'supported');
    expect(supported.subjects.map((item) => [item.subject.id, item.missing])).toEqual([[people[0], []]]);
  });
});

describe('coverage of the Part 108 pack in shadow for people with only training records', () => {
  let tenant: CoverageTenant;

  beforeAll(async () => {
    tenant = await coverageTenant('coverage-part108');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('records three people with no personnel file on file, labelled shadow and never counted', async () => {
    const people = ['CREW-A', 'CREW-B', 'CREW-C'].map((id) => `${tenant.prefix}-${id}`);
    await tenant.importRecords('person.training', trainingRecords(people));
    const adoptionId = await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow');
    await tenant.settle();

    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.json()).toMatchObject({ mode: 'shadow' });
    expect(await ruleCoverage(tenant, adoptionId, PERSONNEL_FILE_RULE)).toMatchObject({
      populationSize: 3,
      complete: true,
      counts: { no_record: 3 },
    });
    const behind = await subjectsBehind(tenant, adoptionId, PERSONNEL_FILE_RULE, 'no_record');
    expect(behind.subjects.map((item) => [item.subject.id, item.missing, item.finding])).toEqual(
      people.map((id) => [id, ['personnel file'], null]),
    );
    // The organization itself has no operations supervisor assignment on file.
    expect(await ruleCoverage(tenant, adoptionId, 'ledger.nprm.108.305.a')).toMatchObject({
      subjectKind: 'organization',
      counts: { no_record: 1 },
    });
    const modes = await tenant.admin.query(
      `SELECT DISTINCT record->'adoption'->>'mode' AS mode FROM rule_evaluations WHERE tenant_id=$1 AND leaf_id=$2`,
      [tenant.tenantId, PERSONNEL_FILE_RULE],
    );
    expect(modes.rows).toEqual([{ mode: 'shadow' }]);
  });
});

describe('a pilot assigned to many flights', () => {
  let tenant: CoverageTenant;

  beforeAll(async () => {
    tenant = await coverageTenant('coverage-distinct');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('is one member of the population, counted, listed and queued once', async () => {
    const [busy, other] = ['PILOT-A', 'PILOT-B'].map((id) => `${tenant.prefix}-${id}`) as [string, string];
    await tenant.importRecords('person.training', trainingRecords([busy, other]));
    const assignments = [1, 2, 3, 4, 5].map((n) => ({
      subjectId: `${tenant.prefix}-FL-${n}`,
      subjectKind: 'flight',
      personId: busy,
      role: 'pilot_in_command',
      startsAt: `2026-03-0${n}T09:00:00Z`,
    }));
    await tenant.importRecords('operation.role-assignment', [
      ...assignments,
      { ...assignments[0]!, subjectId: `${tenant.prefix}-FL-6`, personId: other },
    ]);
    const adoptionId = await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await tenant.settle();

    expect(await ruleCoverage(tenant, adoptionId, CERTIFICATE_RULE)).toMatchObject({
      populationSize: 2,
      complete: true,
      counts: { no_record: 2 },
    });
    const behind = await subjectsBehind(tenant, adoptionId, CERTIFICATE_RULE, 'no_record');
    expect(behind.subjects.map((item) => item.subject.id)).toEqual([busy, other]);
    const queued = await tenant.admin.query(
      `SELECT COUNT(*)::int AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND leaf_id=$2
       AND trigger_kind='adoption'`,
      [tenant.tenantId, CERTIFICATE_RULE],
    );
    expect(queued.rows[0].count).toBe(2);

    // A further assignment of the same pilot after the adoption leaves the population as it was.
    await tenant.importRecords('operation.role-assignment', [
      { ...assignments[0]!, subjectId: `${tenant.prefix}-FL-7`, startsAt: '2026-03-07T09:00:00Z' },
    ]);
    await tenant.settle();
    expect(await ruleCoverage(tenant, adoptionId, CERTIFICATE_RULE)).toMatchObject({
      populationSize: 2,
      counts: { no_record: 2 },
    });
  });
});

describe('the bound on a population', () => {
  let tenant: CoverageTenant;
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const pool = createPool();

  beforeAll(async () => {
    tenant = await coverageTenant('coverage-bound');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
    await workerPool.end();
    await pool.end();
  });

  it('queues at most the bound and reads the count as incomplete above it', async () => {
    const people = ['P1', 'P2', 'P3', 'P4', 'P5'].map((id) => `${tenant.prefix}-${id}`);
    await tenant.importRecords('person.training', trainingRecords(people));
    await designatePilots(tenant, people);
    const adoptionId = await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active');
    await projectOwnedWork(tenant.admin, workerPool, [tenant.prefix]);
    const worker: AuthContext = {
      tenantId: tenant.tenantId,
      id: `${tenant.tenantId}:worker`,
      revision: 1,
      kind: 'worker',
      name: 'Fictional coverage operator',
      capabilities: ['flight:read', 'evidence:read', 'input:write'],
    };
    // The certificate rule reads certificates (step 0), then takes its population (step 1).
    let continuation: unknown = { step: 1, after: '' };
    const queued: number[] = [];
    for (let page = 0; page < 4 && continuation; page++) {
      const work = { packId: 'ledger.part107', leafId: CERTIFICATE_RULE, eventId: adoptionId, continuation };
      queued.push(
        await withScope(workerPool, worker, (client, principal) =>
          continueAdoptionRuleEvaluations(client, principal, work, 2, 3),
        ),
      );
      const next = await tenant.admin.query<{ continuation: { step: number; after: string; queued?: number } }>(
        `SELECT continuation FROM rule_evaluation_work WHERE tenant_id=$1 AND leaf_id=$2 AND trigger_kind='adoption-page'
           AND (continuation->>'step')::int=1 AND (continuation->>'queued')::int=$3`,
        [tenant.tenantId, CERTIFICATE_RULE, queued.reduce((sum, item) => sum + item, 0)],
      );
      continuation = next.rows[0]?.continuation;
    }
    expect(queued).toEqual([2, 1]);
    const work = await tenant.admin.query(
      `SELECT COUNT(*)::int AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND leaf_id=$2
       AND trigger_kind='adoption'`,
      [tenant.tenantId, CERTIFICATE_RULE],
    );
    expect(work.rows[0].count).toBe(3);

    const coverage = await withScope(pool, tenant.actor, (client, principal) =>
      getAdoptionRuleCoverage(client, principal, adoptionId, 3),
    );
    expect(coverage.populationLimit).toBe(3);
    expect(coverage.rules.find((rule) => rule.leafId === CERTIFICATE_RULE)).toMatchObject({
      populationSize: 4,
      complete: false,
      incomplete: 'population_limit',
    });
  });
});
