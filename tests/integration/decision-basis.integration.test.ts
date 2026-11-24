import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import type {
  AdoptionParameterValues,
  Command,
  OrganizationCoverageResponse,
  OrganizationDecisionsResponse,
  RulePackVersion,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import type { AuthContext } from '../../packages/persistence/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// A decision goes stale only when something it rests on changed (docs/design/decision-basis.md). The organization's
// own rule evaluations and Ledger's records of what is on file are not evidence about a flight, a finding on a flight
// or an adoption, so the workers evaluating an organization rule between a person's read and their decision does not
// refuse it. A change to what the decision does rest on still does.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('what a decision rests on', () => {
  let tenant: CoverageTenant;
  let person: AuthContext;
  let flightCount = 0;

  beforeAll(async () => {
    tenant = await coverageTenant('decision-basis');
    person = {
      tenantId: tenant.tenantId,
      id: `${tenant.tenantId}:person`,
      revision: 1,
      kind: 'human',
      name: 'Fictional dispatcher',
      capabilities: [
        'flight:create',
        'flight:read',
        'input:write',
        'decision:write',
        'evidence:read',
        'pack:adopt',
        'sms:read',
        'sms:write',
      ],
    };
    await tenant.admin.query(
      "INSERT INTO principals(id,tenant_id,name,kind,capabilities) VALUES($1,$2,$3,'human',$4)",
      [person.id, tenant.tenantId, person.name, person.capabilities],
    );
    await tenant.admin.query('INSERT INTO api_credentials(token_hash,principal_id) VALUES($1,$2)', [
      sha256(`ledger-dev-${person.id}`),
      person.id,
    ]);
    // The landing checks hold the flight's finding; the proposed Part 108 pack, in shadow, reads what is on file and
    // the organization's role assignments.
    await tenant.adopt(getRulePackVersion('ledger.demo-procedures', 4)!, 'active');
    await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow');
    await tenant.settle();
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  async function ok(response: Awaited<ReturnType<CoverageTenant['call']>>, status = 200) {
    expect(response.statusCode, response.body).toBe(status);
    return response.json();
  }
  const get = (url: string) => tenant.call(person, 'GET', url).then((response) => ok(response));
  const post = (url: string, payload: unknown) => tenant.call(person, 'POST', url, payload);

  async function organizationEvaluations(): Promise<number> {
    const rows = await tenant.admin.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM rule_evaluations WHERE tenant_id=$1 AND subject_id=$2',
      [tenant.tenantId, `organization:${tenant.tenantId}`],
    );
    return rows.rows[0]!.count;
  }

  /** Something is put on file (a hazard opened), and the workers evaluate the organization rule that reads it. */
  async function onFileEvaluated(): Promise<void> {
    const before = await organizationEvaluations();
    await ok(
      await post('/v1/commands', {
        kind: 'sms.record.open',
        record: {
          kind: 'hazard',
          schema: 'sms.hazard.1',
          title: `Fictional hazard ${before}`,
          ownerId: person.id,
          body: {
            description: 'A fictional hazard put on the register.',
            consequence: 'A fictional consequence.',
            source: { kind: 'manual_identification' },
          },
        },
      }),
      201,
    );
    await tenant.settle();
    expect(await organizationEvaluations()).toBeGreaterThan(before);
  }

  /**
   * A periodic organization rule reaching a deadline: an accountable executive assignment that ends a few seconds after
   * it is recorded. `arrange` records it before the person reads; `reached` waits for its end and runs the workers, and
   * the organization rule is evaluated again with nothing new recorded.
   */
  async function deadline() {
    const endsAt = new Date(Date.now() + 4_000).toISOString().slice(0, 19) + 'Z';
    await tenant.importRecords('operation.role-assignment', [
      {
        subjectId: `organization:${tenant.tenantId}`,
        subjectKind: 'organization',
        personId: `${tenant.prefix}-EXEC-${++flightCount}`,
        role: 'accountable_executive',
        startsAt: new Date(Date.now() - 3_600_000).toISOString().slice(0, 19) + 'Z',
        endsAt,
      },
    ]);
    await tenant.settle();
    return {
      async reached() {
        const before = await organizationEvaluations();
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(endsAt) - Date.now() + 500)));
        await tenant.settle();
        expect(await organizationEvaluations()).toBeGreaterThan(before);
      },
    };
  }

  /** Something an organization decision rests on: a record about the organization itself. */
  async function organizationRecorded(): Promise<void> {
    await tenant.importRecords('organization.procedure', [
      {
        subjectId: `organization:${tenant.tenantId}`,
        subjectKind: 'organization',
        procedureKind: 'emergency',
        title: `Fictional emergency procedure ${++flightCount}`,
        documentReference: 'OPS-9',
        revision: 'A',
        effectiveAt: new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + 'Z',
      },
    ]);
    await tenant.settle();
  }

  async function flightWithFinding(): Promise<string> {
    const label = `${tenant.prefix}-flight-${++flightCount}`;
    const created = await ok(
      await post('/v1/flights', {
        originationKey: label,
        label,
        scheduledEnd: new Date(Date.now() + 60_000).toISOString(),
      }),
      201,
    );
    await tenant.settle();
    for (const [source, landingTime] of [
      [`${label}:live`, '2026-10-15T14:20:00Z'],
      [`${label}:buffered`, '2026-10-15T14:22:00Z'],
    ])
      await landing(created.flight.id, source!, landingTime!);
    return created.flight.id as string;
  }
  async function landing(flightId: string, sourceId: string, landingTime: string): Promise<void> {
    await ok(
      await post('/v1/inputs', {
        sourceId,
        kind: 'flight.observation',
        occurredAt: landingTime,
        subject: { flightId },
        payload: { activity: 'landed', landingTime },
      }),
      201,
    );
    await tenant.settle();
  }
  const timeline = (id: string): Promise<TimelineResponse> => get(`/v1/flights/${id}/timeline`);

  function flightDecision(shown: TimelineResponse, treat: boolean): Command {
    const finding = shown.findings![0]!;
    return {
      kind: 'decision.record',
      flightId: shown.flight.id,
      expectedRevision: shown.flight.revision,
      expectedBasisRevision: shown.flight.basisRevision,
      inputCut: shown.meta.inputCut,
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      ...(treat
        ? {
            findingTreatment: {
              findingId: finding.id,
              evaluationId: finding.latestEvaluation.id,
              action: 'acknowledge',
            },
            decision: { kind: 'finding.acknowledge', note: 'Reviewed the retained finding evidence.' },
          }
        : { decision: { kind: 'fictional-review', note: 'Reviewed the flight.' } }),
    } as Command;
  }

  /** The adoption a person would send from the coverage they read. */
  function adoption(shown: OrganizationCoverageResponse, pack: RulePackVersion, day = 0) {
    const parameters: AdoptionParameterValues = Object.fromEntries(
      pack.leaves.flatMap((leaf) =>
        'adoptionParameters' in leaf && leaf.adoptionParameters.length
          ? [
              [
                leaf.id,
                Object.fromEntries(
                  leaf.adoptionParameters.map((item) => [
                    item.name,
                    item.valueType === 'string' ? 'UTC' : (item.minimum ?? 1),
                  ]),
                ),
              ],
            ]
          : [],
      ),
    );
    return {
      ...adoptShownPack(
        shown,
        pack,
        {
          start: new Date(Date.now() - 60_000 + day * 2 * 86_400_000).toISOString(),
          end: new Date(Date.now() + 86_400_000 + day * 2 * 86_400_000).toISOString(),
        },
        'Fictional adoption.',
        'shadow',
      ),
      ...(Object.keys(parameters).length ? { parameters } : {}),
    };
  }

  function review(shown: OrganizationDecisionsResponse, coverage: OrganizationCoverageResponse) {
    const adopted = coverage.adoptions[0]!;
    return {
      kind: 'decision.record',
      subject: { kind: 'organization' },
      expectedRevision: shown.organization.revision,
      inputCut: {
        streams: shown.meta.inputCut.streams,
        basisRevision: shown.organization.revision,
        principalRevision: shown.meta.inputCut.principalRevision!,
      },
      expectedDependencyBasis: shown.meta.dependencyBasis!,
      adoption: {
        id: adopted.id,
        acceptedRevision: adopted.acceptedRevision,
        pack: { packId: adopted.pack.packId, version: adopted.pack.version, digest: adopted.pack.digest },
      },
      decision: { kind: 'adoption.review', note: 'Reviewed the fictional adoption.' },
    };
  }

  for (const treat of [false, true]) {
    const what = treat ? 'a finding treatment on a flight' : 'a flight decision';
    it(`records ${what} after an organization rule reads something put on file, and after one reaches a deadline`, async () => {
      const id = await flightWithFinding();
      let shown = await timeline(id);
      await onFileEvaluated();
      await ok(await post('/v1/commands', flightDecision(shown, treat)), 201);
      await tenant.settle();

      const due = await deadline();
      shown = await timeline(id);
      await due.reached();
      if (treat) {
        // The finding is acknowledged; its next treatment is a response.
        const command = flightDecision(shown, true) as Command & { findingTreatment: { action: string } };
        command.findingTreatment.action = 'respond';
        (command as { decision: { kind: string } }).decision.kind = 'finding.respond';
        await ok(await post('/v1/commands', command), 201);
      } else await ok(await post('/v1/commands', flightDecision(shown, false)), 201);
    });

    it(`refuses ${what} when the flight's own evidence changed`, async () => {
      const id = await flightWithFinding();
      const shown = await timeline(id);
      await landing(id, `${tenant.prefix}-late-${++flightCount}`, '2026-10-15T14:25:00Z');
      const refused = await post('/v1/commands', flightDecision(shown, treat));
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.code).toBe('stale_basis');
    });
  }

  it('records an adoption after an organization rule is evaluated, and refuses one after a record about the organization', async () => {
    let shown: OrganizationCoverageResponse = await get('/v1/organization/coverage');
    await onFileEvaluated();
    await ok(await post('/v1/commands', adoption(shown, getRulePackVersion('ledger.part107', 2)!)), 201);
    await tenant.settle();

    const due = await deadline();
    shown = await get('/v1/organization/coverage');
    await due.reached();
    await ok(await post('/v1/commands', adoption(shown, getRulePackVersion('ledger.part107', 2)!, 1)), 201);
    await tenant.settle();

    shown = await get('/v1/organization/coverage');
    await organizationRecorded();
    const refused = await post('/v1/commands', adoption(shown, getRulePackVersion('ledger.part107', 2)!, 2));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('stale_basis');
  });

  it('records an organization decision after an organization rule is evaluated, and refuses one after a record about the organization', async () => {
    const coverage: OrganizationCoverageResponse = await get('/v1/organization/coverage');
    let shown: OrganizationDecisionsResponse = await get('/v1/organization/decisions');
    await onFileEvaluated();
    await ok(await post('/v1/commands', review(shown, coverage)), 201);
    await tenant.settle();

    const due = await deadline();
    shown = await get('/v1/organization/decisions');
    await due.reached();
    await ok(await post('/v1/commands', review(shown, coverage)), 201);
    await tenant.settle();

    shown = await get('/v1/organization/decisions');
    await organizationRecorded();
    const refused = await post('/v1/commands', review(shown, coverage));
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('stale_basis');
  });
});
