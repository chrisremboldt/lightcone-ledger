import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.js';
import { leaseWork, processLease, runDueRuleEvaluations } from '../../apps/workers/src/index.js';
import type {
  AcceptedObservation,
  OrganizationCoverageResponse,
  SubjectFindingRecord,
  TimelineResponse,
} from '../../packages/contracts/src/index.js';
import { adoptShownPack } from '../../packages/contracts/fixtures/demo/v1/ready.js';
import { acceptCommand } from '../../packages/domain/src/index.js';
import { lockSubjects } from '../../packages/domain/src/cuts.js';
import { lockObservationCorrection } from '../../packages/domain/src/observation-corrections.js';
import { sha256 } from '../../packages/integrity/src/index.js';
import { createPool, MemoryObjectStore, withScope, type AuthContext } from '../../packages/persistence/src/index.js';
import { lockWaitStarted, runOwnedWork, settleOwnedWork, withOwnedWork } from './worker-queue.js';

// Reports on the older flight-observation input kind reach the generic evaluator as flight.report observations, and
// their corrections and identity links as the generic correction records.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('The legacy flight-report bridge on PostgreSQL', () => {
  const prefix = `legacy-report-${randomUUID()}`;
  const tenantId = `${prefix}:tenant`;
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  let app: Awaited<ReturnType<typeof createApp>>;
  const base = { tenantId, revision: 1, name: 'Fictional dispatcher' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    kind: 'human',
    capabilities: [
      'flight:read',
      'flight:create',
      'evidence:read',
      'input:write',
      'decision:write',
      'correction:write',
      'identity:write',
      'pack:adopt',
    ],
  };
  const worker: AuthContext = {
    ...base,
    id: `${tenantId}:worker`,
    kind: 'worker',
    capabilities: ['flight:read', 'flight:create', 'evidence:read', 'input:write', 'identity:write'],
  };

  function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${actor.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }
  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      const completed = await runOwnedWork(admin, workerPool, [prefix]);
      if (!completed) {
        const pending = await admin.query(
          `SELECT (SELECT COUNT(*) FROM work_items w WHERE w.tenant_id=$1 AND w.state IN ('pending','leased'))
           +(SELECT COUNT(*) FROM rule_evaluation_work r WHERE r.tenant_id=$1 AND r.state IN ('pending','leased')
             AND r.due_at<=clock_timestamp()) AS count`,
          [tenantId],
        );
        if (Number(pending.rows[0].count) === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('Worker did not settle');
  }
  async function findings(flightId: string): Promise<SubjectFindingRecord[]> {
    const query = new URLSearchParams({ subjectKind: 'flight', subjectId: flightId }).toString();
    const response = await call('GET', `/v1/findings?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().findings;
  }
  async function reports(flightId: string): Promise<AcceptedObservation[]> {
    const query = new URLSearchParams({
      subjectKind: 'flight',
      subjectId: flightId,
      type: 'flight.report',
      from: '2000-01-01T00:00:00Z',
      to: '2100-01-01T00:00:00Z',
    }).toString();
    const response = await call('GET', `/v1/observations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().observations;
  }
  async function report(subject: Record<string, string>, sourceId: string, landingTime: string) {
    const response = await call('POST', '/v1/inputs', {
      sourceId,
      kind: 'flight.observation',
      occurredAt: '2026-10-15T14:30:00Z',
      subject,
      payload: { title: 'Crew landing report', activity: 'landed', landingTime },
    });
    expect(response.statusCode, response.body).toBe(201);
    await settle();
    return response.json().receipt as { id: string; eventId: string };
  }
  function byRule(all: SubjectFindingRecord[], suffix: string) {
    return all.find((finding) => finding.ruleId.endsWith(suffix));
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional bridge tenant']);
    for (const principal of [actor, worker]) {
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
    const shown = await call('GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const retained = await call('GET', '/v1/rule-packs/ledger.demo-procedures/versions/4');
    expect(retained.statusCode, retained.body).toBe(200);
    const now = Date.now();
    const adopted = await call(
      'POST',
      '/v1/commands',
      adoptShownPack(
        shown.json() as OrganizationCoverageResponse,
        retained.json().pack,
        { start: new Date(now - 60_000).toISOString(), end: new Date(now + 3_600_000).toISOString() },
        'Adopt the fictional flight procedures.',
        'active',
      ),
    );
    expect(adopted.statusCode, adopted.body).toBe(201);
    await settle();
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('records older reports, corrections and links as observations the landing rules read', async () => {
    const created = await call('POST', '/v1/flights', {
      originationKey: `${prefix}:flight`,
      label: 'Bridge flight',
      scheduledEnd: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    expect(byRule(await findings(flightId), 'missing-landing-evidence')?.latestEvaluation.outcome).toBe('attention');

    const first = await report({ flightId }, `${prefix}-crew`, '2026-10-15T14:20:00Z');
    const second = await report({ flightId }, `${prefix}-log`, '2026-10-15T14:22:00Z');
    const recorded = await reports(flightId);
    expect(recorded.map((item) => item.eventId).sort()).toEqual([first.eventId, second.eventId].sort());
    expect(recorded.map((item) => item.receiptId).sort()).toEqual([first.id, second.id].sort());
    expect(recorded[0]!.observation).toMatchObject({ type: 'flight.report', values: { activity: 'landed' } });
    // The older report arrived without original bytes, so the submitted payload is retained as its artifact.
    const artifact = await call('GET', `/v1/artifacts/${recorded[0]!.artifactId}`);
    expect(artifact.statusCode, artifact.body).toBe(200);

    let shown = await findings(flightId);
    expect(byRule(shown, 'missing-landing-evidence')?.latestEvaluation.outcome).toBe('pass');
    const disagreement = byRule(shown, 'landing-disagreement')!;
    expect(disagreement.latestEvaluation).toMatchObject({
      outcome: 'attention',
      evidenceState: 'conflicting',
      summary: '2 distinct landing times are reported. Review the retained observations.',
    });
    expect(disagreement.latestEvaluation.evidence.map((item) => item.eventId).sort()).toEqual(
      [first.eventId, second.eventId].sort(),
    );

    const thread = (await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse;
    const corrected = await call('POST', '/v1/commands', {
      kind: 'evidence.correct',
      flightId,
      expectedRevision: thread.flight.revision,
      expectedBasisRevision: thread.flight.basisRevision,
      inputCut: thread.meta.inputCut,
      expectedDependencyBasis: thread.meta.dependencyBasis!,
      correctionOf: second.eventId,
      occurredAt: '2026-10-15T14:31:00Z',
      note: 'The aircraft log confirms the first landing time.',
      payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
    await settle();
    const current = await reports(flightId);
    expect(current.map((item) => item.eventId)).not.toContain(second.eventId);
    expect(current.find((item) => item.sourceId === 'operator-correction')?.observation).toMatchObject({
      values: { landingAt: '2026-10-15T14:20:00Z' },
    });
    shown = await findings(flightId);
    expect(byRule(shown, 'landing-disagreement')!.latestEvaluation.outcome).toBe('pass');

    // Correcting the same older report again, as the older path allowed, corrects the record that now stands for it.
    const again = (await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse;
    const recorrected = await call('POST', '/v1/commands', {
      kind: 'evidence.correct',
      flightId,
      expectedRevision: again.flight.revision,
      expectedBasisRevision: again.flight.basisRevision,
      inputCut: again.meta.inputCut,
      expectedDependencyBasis: again.meta.dependencyBasis!,
      correctionOf: second.eventId,
      occurredAt: '2026-10-15T14:32:00Z',
      note: 'A second look at the ground log gives a later time.',
      payload: { activity: 'landed', landingTime: '2026-10-15T14:21:00Z' },
    });
    expect(recorrected.statusCode, recorrected.body).toBe(201);
    await settle();
    const corrections = (await reports(flightId)).filter((item) => item.sourceId === 'operator-correction');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.replaces).toBe(current.find((item) => item.sourceId === 'operator-correction')!.id);
    expect(corrections[0]!.observation).toMatchObject({ values: { landingAt: '2026-10-15T14:21:00Z' } });
    expect(byRule(await findings(flightId), 'landing-disagreement')!.latestEvaluation.outcome).toBe('attention');

    const elsewhere = `${prefix}:unknown-flight`;
    const unlinked = await report({ originationKey: elsewhere }, `${prefix}-late`, '2026-10-15T14:25:00Z');
    expect((await reports(flightId)).map((item) => item.eventId)).not.toContain(unlinked.eventId);
    const before = ((await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse).flight;
    const linked = await call('POST', '/v1/commands', {
      kind: 'identity.link',
      flightId,
      receiptId: unlinked.id,
      expectedRevision: before.revision,
    });
    expect(linked.statusCode, linked.body).toBe(201);
    await settle();
    expect((await reports(flightId)).map((item) => item.eventId)).toContain(unlinked.eventId);
    expect(byRule(await findings(flightId), 'landing-disagreement')!.latestEvaluation.outcome).toBe('attention');
  });

  it('attaches a report that its projection, not its intake, linked to a flight', async () => {
    const originationKey = `${prefix}:flight-after-report`;
    // The report arrives before the flight exists; the flight is created before the report is projected.
    const sent = await call('POST', '/v1/inputs', {
      sourceId: `${prefix}-early`,
      kind: 'flight.observation',
      occurredAt: '2026-10-15T14:30:00Z',
      subject: { originationKey },
      payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const created = await call('POST', '/v1/flights', { originationKey, label: 'Flight after its report' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    expect((await reports(flightId)).map((item) => item.eventId)).toContain(sent.json().receipt.eventId);
  });

  it('projects a report while a link of the same report holds its flight, in one lock order', async () => {
    const created = await call('POST', '/v1/flights', { originationKey: `${prefix}:lock-order`, label: 'Held flight' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const sent = await call('POST', '/v1/inputs', {
      sourceId: `${prefix}-held`,
      kind: 'flight.observation',
      occurredAt: '2026-10-15T14:30:00Z',
      subject: { flightId },
      payload: { title: 'Crew landing report', activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const receipt = sent.json().receipt as { id: string; eventId: string };
    const leases = await withOwnedWork(admin, [prefix], () => leaseWork(workerPool, { limit: 100 }));
    const reportLease = leases.find((lease) => lease.event_id === receipt.eventId)!;
    const before = ((await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse).flight;
    // The link locks the flight first, as every flight command does; the report is projected while that lock is
    // held, and only then does the link take the report's receipt.
    let projected: Promise<boolean> | undefined;
    const linked = await withScope(pool, actor, async (client, who) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [flightId]);
      projected = processLease(workerPool, reportLease);
      projected.catch(() => undefined);
      await lockWaitStarted(admin);
      return acceptCommand(client, who, {
        kind: 'identity.link',
        flightId,
        receiptId: receipt.id,
        expectedRevision: before.revision,
      });
    });
    expect(linked.kind).toBe('identity.link');
    expect(await projected).toBe(true);
    for (const lease of leases.filter((lease) => lease !== reportLease))
      expect(await processLease(workerPool, lease)).toBe(true);
    await settle();
    expect((await reports(flightId)).map((item) => item.eventId)).toContain(receipt.eventId);
  });

  // A command on a report, sent while another transaction holds the correction lock of the report's observation, as
  // an observation correction does first; that transaction then wants the flight's subject, as a correction does.
  async function commandWhileCorrecting(observationId: string, flightId: string, command: unknown) {
    let sent: ReturnType<typeof call> | undefined;
    await withScope(pool, actor, async (client) => {
      await lockObservationCorrection(client, tenantId, observationId);
      sent = call('POST', '/v1/commands', command);
      sent.catch(() => undefined);
      await lockWaitStarted(admin);
      await lockSubjects(client, tenantId, [flightId], 'UPDATE');
    });
    const response = await sent!;
    expect(response.statusCode, response.body).toBe(201);
    await settle();
  }

  it('corrects a report while a correction of its observation is held, in one lock order', async () => {
    const created = await call('POST', '/v1/flights', { originationKey: `${prefix}:correction-order`, label: 'Held' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const sent = await report({ flightId }, `${prefix}-held-log`, '2026-10-15T14:22:00Z');
    const thread = (await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse;
    await commandWhileCorrecting(sent.eventId, flightId, {
      kind: 'evidence.correct',
      flightId,
      expectedRevision: thread.flight.revision,
      expectedBasisRevision: thread.flight.basisRevision,
      inputCut: thread.meta.inputCut,
      expectedDependencyBasis: thread.meta.dependencyBasis!,
      correctionOf: sent.eventId,
      occurredAt: '2026-10-15T14:31:00Z',
      note: 'The aircraft log gives the earlier landing time.',
      payload: { activity: 'landed', landingTime: '2026-10-15T14:20:00Z' },
    });
    const current = await reports(flightId);
    expect(current.map((item) => item.eventId)).not.toContain(sent.eventId);
    expect(current.find((item) => item.sourceId === 'operator-correction')?.observation).toMatchObject({
      values: { landingAt: '2026-10-15T14:20:00Z' },
    });
  });

  it('links a report while a correction of its observation is held, in one lock order', async () => {
    const created = await call('POST', '/v1/flights', { originationKey: `${prefix}:link-order`, label: 'Held link' });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await settle();
    const unlinked = await report(
      { originationKey: `${prefix}:link-order-unknown` },
      `${prefix}-held-late`,
      '2026-10-15T14:25:00Z',
    );
    const before = ((await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse).flight;
    await commandWhileCorrecting(unlinked.eventId, flightId, {
      kind: 'identity.link',
      flightId,
      receiptId: unlinked.id,
      expectedRevision: before.revision,
    });
    expect((await reports(flightId)).map((item) => item.eventId)).toContain(unlinked.eventId);
  });

  it('links reports between two flights in opposite directions, in one lock order', async () => {
    const flights: string[] = [];
    for (const name of ['one', 'two']) {
      const created = await call('POST', '/v1/flights', { originationKey: `${prefix}:swap-${name}`, label: name });
      expect(created.statusCode, created.body).toBe(201);
      flights.push(created.json().flight.id as string);
    }
    await settle();
    const [low, high] = flights.sort();
    const onLow = await report({ flightId: low! }, `${prefix}-swap-low`, '2026-10-15T14:20:00Z');
    const onHigh = await report({ flightId: high! }, `${prefix}-swap-high`, '2026-10-15T14:21:00Z');
    const revision = async (flightId: string) =>
      ((await call('GET', `/v1/flights/${flightId}/timeline`)).json() as TimelineResponse).flight.revision;
    const [lowRevision, highRevision] = [await revision(low!), await revision(high!)];
    // Each link moves a report off the flight the other link targets. One link holds the lower flight, which it
    // targets; the other, targeting the higher flight, is sent while it is held.
    let other: ReturnType<typeof call> | undefined;
    const linked = await withScope(pool, actor, async (client, who) => {
      await client.query('SELECT id FROM flight_views WHERE id=$1 FOR UPDATE', [low]);
      other = call('POST', '/v1/commands', {
        kind: 'identity.link',
        flightId: high,
        receiptId: onLow.id,
        expectedRevision: highRevision,
      });
      other.catch(() => undefined);
      await lockWaitStarted(admin);
      return acceptCommand(client, who, {
        kind: 'identity.link',
        flightId: low!,
        receiptId: onHigh.id,
        expectedRevision: lowRevision,
      });
    });
    expect(linked.kind).toBe('identity.link');
    // The second link waited for the first, which changed the flight it targets.
    const refused = await other!;
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('stale_revision');
    await settle();
    expect((await reports(low!)).map((item) => item.eventId).sort()).toEqual([onHigh.eventId, onLow.eventId].sort());
  });

  it('counts due generic evaluations about a flight as its outstanding work, but not a future deadline', async () => {
    const outstanding = async (flightId: string) => {
      const response = await call('GET', `/v1/flights/${flightId}`);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().flight.outstandingWork as number;
    };
    // Projects every pending event, but runs no generic evaluation.
    const project = async () => {
      for (let round = 0; round < 50; round++) {
        const leases = await withOwnedWork(admin, [prefix], () => leaseWork(workerPool, { limit: 100 }));
        if (!leases.length) return;
        for (const lease of leases) await processLease(workerPool, lease);
      }
    };
    const created = await call('POST', '/v1/flights', {
      originationKey: `${prefix}:outstanding`,
      label: 'Outstanding work flight',
      scheduledEnd: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const flightId = created.json().flight.id as string;
    await project();
    const queued = await admin.query(
      `SELECT COUNT(*) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND subject_id=$2 AND state='pending'
       AND due_at<=clock_timestamp()`,
      [tenantId, flightId],
    );
    expect(Number(queued.rows[0].count)).toBeGreaterThan(0);
    expect(await outstanding(flightId)).toBeGreaterThan(0);
    while (await withOwnedWork(admin, [prefix], () => runDueRuleEvaluations(workerPool, { limit: 100 })))
      await project();
    await settle();
    // Only the landing deadline after the scheduled end remains, and it is not due yet.
    const future = await admin.query(
      `SELECT COUNT(*) AS count FROM rule_evaluation_work WHERE tenant_id=$1 AND subject_id=$2 AND state='pending'
       AND due_at>clock_timestamp()`,
      [tenantId, flightId],
    );
    expect(Number(future.rows[0].count)).toBe(1);
    expect(await outstanding(flightId)).toBe(0);
  });
});
