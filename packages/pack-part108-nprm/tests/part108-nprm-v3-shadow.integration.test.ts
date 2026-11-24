import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../apps/api/src/index.js';
import { adoptShownPack } from '../../contracts/fixtures/demo/v1/ready.js';
import {
  isCheckedRuleLeaf,
  type AdoptionRuleCoverageResponse,
  type OrganizationCoverageResponse,
  type RuleEvaluationRecord,
} from '../../contracts/src/index.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { sha256 } from '../../integrity/src/index.js';
import { createPool, MemoryObjectStore, type AuthContext } from '../../persistence/src/index.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import { addedCheckedEntries, newlyCheckedEntries, planReadingIds } from '../src/part108-nprm-v3.js';
import { runOwnedWork, settleOwnedWork } from '../../../tests/integration/worker-queue.js';

// Version 3 of the Part 108 NPRM pack, adopted in shadow by a fictional organization. The rules version 3 adds read
// a related subject (the aircraft a part is installed on, the aircraft and coordinators a flight names) or combine
// many records; each evaluation cites the records it read, including those about the related subject.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Part 108 NPRM version 3 in shadow on sample records', () => {
  const prefix = `part108-nprm-v3-${randomUUID()}`;
  const tenantId = `${prefix}:operator`;
  const sourceId = 'operator-records';
  const pool = createPool();
  const admin = createPool(process.env.DATABASE_ADMIN_URL);
  const workerPool = createPool(process.env.WORKER_DATABASE_URL);
  const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
  const subjects = {
    flight: `${prefix}-FLT-1`,
    coordinator: `${prefix}-PER-1`,
    aircraft: `${prefix}-AC-1`,
    part: `${prefix}-PART-1`,
    organization: `${prefix}-ORG-1`,
    site: `${prefix}-SITE-1`,
    planned: `${prefix}-FLT-PLANNED`,
  };
  const base = { tenantId, revision: 1, kind: 'human', name: 'Fictional Part 108 operator' };
  const actor: AuthContext = {
    ...base,
    id: `${tenantId}:actor`,
    capabilities: ['flight:read', 'evidence:read', 'authority:write', 'pack:adopt'],
  };
  const operator: AuthContext = {
    ...base,
    id: `${tenantId}:records`,
    capabilities: ['input:write', 'flight:read', 'evidence:read'],
  };
  /** Ledger's id of each imported record or observation, by record type or observation type. */
  const recorded = new Map<string, string[]>();
  let app: Awaited<ReturnType<typeof createApp>>;

  const started = Date.now();
  const hoursAgo = (hours: number) => new Date(started - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
  /** UTC midnight this many days before the test started. */
  const midnight = (daysAgo: number) => {
    const day = new Date(started - daysAgo * 86_400_000);
    return `${day.toISOString().slice(0, 10)}T00:00:00Z`;
  };
  // The week counted for 108.330(c) starts three UTC days before today, so it holds two whole past days.
  const weekStartsOn = ((new Date(started - 3 * 86_400_000).getUTCDay() + 6) % 7) + 1;
  const parameters: Record<string, Record<string, unknown>> = {
    ...Object.fromEntries(
      pack.leaves
        .filter(isCheckedRuleLeaf)
        .filter((leaf) => leaf.adoptionParameters.some(({ name }) => name === 'timeZone'))
        .map((leaf) => [leaf.id, { timeZone: 'UTC' }]),
    ),
    'ledger.nprm.108.330.c': { timeZone: 'UTC', weekStartsOn },
  };
  const hoursAhead = (hours: number) => hoursAgo(-hours);
  let adoptionId: string;

  function call(principal: AuthContext, method: 'GET' | 'POST', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ledger-dev-${principal.id}`, 'idempotency-key': randomUUID() },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  }

  async function upload(bytes: Buffer): Promise<string> {
    const created = await call(operator, 'POST', '/v1/uploads', {
      contentType: 'application/json',
      byteLength: bytes.byteLength,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().upload.id as string;
    const stored = await app.inject({
      method: 'PUT',
      url: `/v1/uploads/${id}/content`,
      headers: {
        authorization: `Bearer ledger-dev-${operator.id}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const finalized = await call(operator, 'POST', `/v1/uploads/${id}/finalize`);
    expect(finalized.statusCode, finalized.body).toBe(201);
    return finalized.json().artifact.id as string;
  }

  /** Imports one JSON file of one record type and keeps the Ledger id of each record. */
  async function importRecords(recordType: string, records: Record<string, unknown>[]) {
    const artifactId = await upload(Buffer.from(JSON.stringify({ recordType, recordVersion: 1, records })));
    const committed = await call(operator, 'POST', '/v1/operator-records/imports', {
      artifactId,
      recordType,
      recordVersion: 1,
    });
    expect(committed.statusCode, committed.body).toBe(201);
    expect(committed.json().summary, recordType).toMatchObject({ recorded: records.length, incomplete: 0, refused: 0 });
    recorded.set(recordType, [
      ...(recorded.get(recordType) ?? []),
      ...committed.json().rows.map((row: { observationId: string }) => row.observationId),
    ]);
  }

  /** Submits one observation through the public intake and keeps its Ledger id under its type. */
  async function submit(payload: Record<string, unknown>, occurredAt: string, interval?: Record<string, string>) {
    const artifactId = await upload(Buffer.from(JSON.stringify(payload)));
    const response = await call(operator, 'POST', '/v1/inputs', {
      sourceId,
      kind: 'observation',
      occurredAt,
      payload: {
        ...payload,
        occurredAt,
        ...(interval ? { interval } : {}),
        fidelity: 'documented_schema_conformant',
        limitations: [],
        originalArtifactId: artifactId,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  async function observationIds(type: string): Promise<string[]> {
    const rows = await admin.query<{ id: string }>(
      'SELECT id FROM observations WHERE tenant_id=$1 AND observation_type=$2',
      [tenantId, type],
    );
    return rows.rows.map((row) => row.id);
  }

  async function settle(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
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

  async function evaluations(kind: string, subjectId: string): Promise<RuleEvaluationRecord[]> {
    // A record about the organization is about the Ledger organization itself, whatever id the file gave.
    const query =
      kind === 'organization'
        ? new URLSearchParams({ subjectKind: kind, subjectId: `organization:${tenantId}`, limit: '100' })
        : new URLSearchParams({ subjectKind: kind, subjectId, subjectScope: 'source', sourceId, limit: '100' });
    const response = await call(actor, 'GET', `/v1/evaluations?${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return response.json().evaluations;
  }

  beforeAll(async () => {
    app = await createApp({ pool, env: 'test', objectStore: new MemoryObjectStore() });
    await app.ready();
    await admin.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'Fictional Part 108 operator']);
    const worker = {
      ...base,
      id: `${tenantId}:worker`,
      kind: 'worker',
      capabilities: ['flight:read', 'evidence:read', 'input:write'],
    };
    for (const principal of [actor, operator, worker]) {
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
    const current = await call(actor, 'GET', `/v1/authority/principals/${encodeURIComponent(operator.id)}`);
    expect(current.statusCode, current.body).toBe(200);
    const granted = await call(actor, 'POST', '/v1/commands', {
      kind: 'authority.update',
      principalId: operator.id,
      expectedRevision: current.json().principal.revision,
      capabilities: current.json().principal.capabilities,
      observationGrants: ['operator.record', 'crew.duty-period', 'flight.report'].map((observationType) => ({
        sourceId,
        observationType,
      })),
    });
    expect(granted.statusCode, granted.body).toBe(201);
  });
  afterAll(async () => {
    await settleOwnedWork([prefix]);
    if (app) await app.close();
    await pool.end();
    await admin.end();
    await workerPool.end();
  });

  it('is adopted in shadow with the time zone and week the organization counts days in', async () => {
    const shown = await call(actor, 'GET', '/v1/organization/coverage');
    expect(shown.statusCode, shown.body).toBe(200);
    const command = adoptShownPack(
      shown.json() as OrganizationCoverageResponse,
      pack,
      { start: new Date(started - 60_000).toISOString(), end: new Date(started + 30 * 86_400_000).toISOString() },
      'Fictional review of the proposed Part 108 checks.',
      'shadow',
    );
    const unset = await call(actor, 'POST', '/v1/commands', command);
    expect(unset.statusCode, unset.body).toBe(400);
    const adopted = await call(actor, 'POST', '/v1/commands', { ...command, parameters });
    expect(adopted.statusCode, adopted.body).toBe(201);
    adoptionId = adopted.json().command.id as string;
    await settle();
  });

  it('runs each rule version 3 adds, each citing the records it read', async () => {
    const { flight, coordinator, aircraft, part } = subjects;
    await importRecords('aircraft.time-in-service', [
      {
        subjectId: aircraft,
        entryKind: 'opening_balance',
        totalTimeHours: 120,
        coveredThroughAt: hoursAgo(200),
        sourceReference: 'Fictional logbook 1',
        coverage: 'complete',
        coverageNotes: 'Every flight since delivery is in the logbook.',
      },
      {
        subjectId: aircraft,
        entryKind: 'running_total',
        totalTimeHours: 121.5,
        coveredThroughAt: hoursAgo(10),
        sourceReference: 'Fictional logbook 1',
        coverage: 'complete',
        coverageNotes: 'Every flight since delivery is in the logbook.',
      },
    ]);
    await submit(
      {
        type: 'flight.report',
        version: 1,
        subject: { kind: 'flight', id: flight, scope: 'source' },
        secondarySubject: { kind: 'aircraft', id: aircraft, scope: 'source' },
        values: { activity: 'landed', takeoffAt: hoursAgo(3), landingAt: hoursAgo(2) },
      },
      hoursAgo(1.9),
    );
    await importRecords('component.life-limit', [
      {
        subjectId: part,
        partName: 'Rotor arm',
        aircraftId: aircraft,
        installedAt: hoursAgo(150),
        lifeLimitHours: 300,
        partTimeAtInstallHours: 0,
      },
    ]);
    await importRecords('flight.plan', [
      {
        subjectId: flight,
        secondarySubjectId: aircraft,
        windowStartsAt: hoursAgo(3),
        windowEndsAt: hoursAgo(2),
        operationKind: 'aerial_survey',
        plannedOriginDescription: 'North pad',
        plannedDestinationDescription: 'North pad',
        routeSummary: 'Survey grid over the fictional quarry',
      },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        personId: coordinator,
        role: 'flight_coordinator',
        startsAt: hoursAgo(3.5),
        endsAt: hoursAgo(1.5),
      },
    ]);
    await importRecords('aircraft.identity', [
      {
        subjectId: aircraft,
        aircraftMakeModel: 'Fictional Hex 6',
        serialNumber: 'SN-0108',
        registrationNumber: 'FA0000108',
      },
    ]);
    await importRecords('person.aircraft-experience', [
      {
        subjectId: coordinator,
        role: 'flight_coordinator',
        aircraftMakeModel: 'Fictional Hex 6',
        supervisedHours: 6,
        supervisorReference: 'Supervised by the fictional operations supervisor, sign-off 7',
        recentHours: 3,
        recentPeriodStartsOn: '2026-07-01',
        recentPeriodEndsOn: '2026-09-30',
        qualificationReference: 'Qualification record Q-7',
      },
    ]);
    // A whole UTC day of rest, two days ago.
    await submit(
      {
        type: 'crew.duty-period',
        version: 1,
        subject: { kind: 'person', id: coordinator, scope: 'source' },
        values: { period: 'rest' },
      },
      midnight(2),
      { start: midnight(2), end: midnight(1) },
    );
    // A past deviation, so the count stays inside the years the holiday list covers whenever the test runs.
    await importRecords('occurrence.emergency-deviation', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        occurredAt: '2026-03-02T15:00:00Z',
        summary: 'Fictional deviation to land clear of a sudden ground hazard',
        reportedToAuthorityAt: '2026-03-06T16:00:00Z',
      },
    ]);
    await settle();
    recorded.set('flight.report', await observationIds('flight.report'));
    recorded.set('crew.duty-period', await observationIds('crew.duty-period'));

    const cited: Record<string, { subject: [string, string]; types: string[]; related?: string }> = {
      'ledger.nprm.108.40.a.1': {
        subject: ['aircraft', aircraft],
        types: ['aircraft.time-in-service', 'flight.report'],
      },
      'ledger.nprm.108.330.c': { subject: ['person', coordinator], types: ['crew.duty-period'] },
      'ledger.nprm.108.45.f': { subject: ['flight', flight], types: ['occurrence.emergency-deviation'] },
      'ledger.nprm.108.615.a': {
        subject: ['component', part],
        types: ['component.life-limit', 'aircraft.time-in-service'],
      },
      'ledger.nprm.108.310.e': {
        subject: ['flight', flight],
        types: ['aircraft.identity', 'person.aircraft-experience'],
        related: coordinator,
      },
    };
    expect(Object.keys(cited).sort()).toEqual(newlyCheckedEntries.map(({ id }) => id).sort());

    for (const [id, expected] of Object.entries(cited)) {
      const [kind, subjectId] = expected.subject;
      const latest = (await evaluations(kind, subjectId)).find(
        (evaluation) =>
          evaluation.rule.id === id && (expected.related ? evaluation.related?.subject.id === expected.related : true),
      );
      expect(latest, id).toBeDefined();
      expect(latest, id).toMatchObject({
        adoption: { mode: 'shadow' },
        pack: { id: PART108_NPRM_PACK_ID, version: 3, digest: pack.digest },
        rule: {
          id,
          version: pack.leaves.find((item) => item.id === id)!.version,
          source: { kind: 'proposed_regulation' },
        },
        evidenceState: 'supported',
        outcome: 'pass',
      });
      expect(latest!.summary, id).toMatch(/for a person to (review|confirm)/);
      const evidence = latest!.evidence.map((item) => item.observationId);
      for (const type of expected.types)
        expect(
          evidence.some((observationId) => recorded.get(type)!.includes(observationId)),
          `${id} cites a ${type} record`,
        ).toBe(true);
    }

    // The part reads its aircraft's records as a related subject, and the coordinator rule fans out per person.
    const [partResult] = (await evaluations('component', part)).filter(
      (item) => item.rule.id === 'ledger.nprm.108.615.a',
    );
    expect(partResult!.inputs.find((input) => input.name === 'quantity')).toMatchObject({
      about: { related: 'aircraft' },
      subject: { scope: 'source', kind: 'aircraft', id: aircraft, sourceId },
    });
    const [coordinatorResult] = (await evaluations('flight', flight)).filter(
      (item) => item.rule.id === 'ledger.nprm.108.310.e' && item.related,
    );
    expect(coordinatorResult!.related).toMatchObject({
      name: 'coordinator',
      subject: { scope: 'source', kind: 'person', id: coordinator, sourceId },
      namedBy: [{ observationId: recorded.get('operation.role-assignment')![0], field: 'values.record.personId' }],
    });
    const [timeInService] = (await evaluations('aircraft', aircraft)).filter(
      (item) => item.rule.id === 'ledger.nprm.108.40.a.1',
    );
    expect(timeInService!.summary).toMatch(/^A total time in service of 122\.5 hours is derived/);
  });

  it('runs the rules version 3 adds on records of their own, and the coverage read counts each population', async () => {
    const { flight, coordinator, aircraft, organization, site } = subjects;
    // Events inside the adoption's dates, which started a minute before the test.
    const instant = (time: number) => new Date(time).toISOString().slice(0, 19) + 'Z';
    const eventTime = Math.max(Date.now() - 4_000, started - 30_000);
    const eventAt = instant(eventTime);
    const answeredAt = instant(eventTime + 2_000);
    const today = new Date().toISOString().slice(0, 10);
    await importRecords('organization.report', [
      {
        subjectId: organization,
        reportKind: 'flight_hours',
        recipient: 'Civil aviation authority',
        providedAt: answeredAt,
      },
      {
        subjectId: organization,
        reportKind: 'reliability_data',
        recipient: 'Fictional manufacturer',
        providedAt: answeredAt,
      },
      {
        subjectId: organization,
        reportKind: 'aircraft_list',
        recipient: 'Civil aviation authority',
        providedAt: answeredAt,
      },
    ]);
    const procedure = (procedureKind: string, title: string) => ({
      subjectId: organization,
      procedureKind,
      title,
      documentReference: `Fictional operations manual, ${title.toLowerCase()}`,
      revision: 'A',
      effectiveAt: hoursAgo(500),
    });
    await importRecords('organization.procedure', [
      procedure('lost_link', 'Lost link'),
      procedure('cybersecurity', 'Cybersecurity policies'),
      procedure('training_program', 'Training program'),
    ]);
    await importRecords('organization.review', [
      {
        subjectId: organization,
        reviewKind: 'cybersecurity_policy',
        documentReference: 'Fictional cybersecurity policies',
        reviewedAt: answeredAt,
        reviewedByName: 'Fictional Reviewer',
        recordedOutcome: 'no_change',
      },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: organization,
        subjectKind: 'organization',
        personId: coordinator,
        role: 'training_designee',
        startsAt: hoursAgo(500),
      },
    ]);
    await importRecords('occurrence.security', [
      {
        subjectId: organization,
        occurredAt: eventAt,
        summary: 'Fictional: an unknown person tried the dock enclosure door.',
        breachKind: 'physical_access',
        reportedToAuthorityAt: answeredAt,
      },
    ]);
    await importRecords('occurrence.mechanical-irregularity', [
      {
        subjectId: aircraft,
        subjectKind: 'aircraft',
        occurredAt: eventAt,
        irregularityDescription: 'Fictional: control link lost for 20 seconds.',
        correctiveAction: 'Link module replaced.',
        lossOfControlOrCommunication: 'yes',
        reportedToManufacturerAt: answeredAt,
      },
    ]);
    await importRecords('occurrence.operation-anomaly', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        occurredAt: eventAt,
        summary: 'Fictional: landed at the alternate area.',
        interruptionKind: 'landing_away',
        includedInSummaryAt: answeredAt,
      },
    ]);
    await importRecords('occurrence.property-or-area', [
      {
        subjectId: flight,
        subjectKind: 'flight',
        occurredAt: eventAt,
        summary: 'Fictional: a hard landing bent a fence panel.',
        eventKind: 'property_damage',
        meetsReportingCriteria: 'yes',
        reportedToAuthorityAt: answeredAt,
      },
    ]);
    await importRecords('organization.operating-area', [
      {
        subjectId: organization,
        areaId: `${prefix}-AREA-1`,
        shape: 'circle',
        center: '39.7400, -104.9900',
        radiusMeters: 5000,
        startsAt: hoursAgo(500),
        takeoffLandingAreas: 'North pad, gravel, lit, fenced.',
        alternateLandingAreas: 'South pad inside the fence.',
        areaApprovalReference: 'Fictional area approval AA-0108',
      },
    ]);
    await importRecords('aircraft.inspection', [
      {
        subjectId: aircraft,
        inspectionKind: 'manufacturer_interval',
        inspectedAt: hoursAgo(100),
        nextDueAt: hoursAhead(1000),
        recordedResult: 'serviceable',
        inspectorName: 'Fictional Inspector',
      },
    ]);
    await importRecords('aircraft.system-availability', [
      {
        subjectId: aircraft,
        assessedAt: hoursAgo(1),
        dockId: `${prefix}-DOCK-1`,
        dockStatus: 'available',
        controlLinkStatus: 'available',
        batteryId: `${prefix}-BAT-1`,
        batteryStatus: 'available',
        sensorStatus: 'available',
        firmwareVersion: '4.2.0',
        configurationReference: 'Fictional configuration 12',
      },
    ]);
    await importRecords('person.training', [
      {
        subjectId: coordinator,
        trainingKind: 'recurrent',
        courseTitle: 'Fictional recurrent operations course',
        completedOn: today,
        evidenceReference: 'TRN-FICT-0108',
      },
    ]);
    await importRecords('person.certificate', [
      {
        subjectId: coordinator,
        credentialKind: 'security_threat_assessment',
        credentialNumber: 'STA-FICT-0108',
        recordedStatus: 'held',
      },
    ]);
    await settle();

    const subjectOf: Record<string, [string, string]> = {
      organization: ['organization', organization],
      site: ['site', site],
      aircraft: ['aircraft', aircraft],
      person: ['person', coordinator],
      flight: ['flight', flight],
    };
    // A month only partly inside the adoption's dates is not counted, so the monthly reports wait for the first whole one.
    const awaited = ['ledger.nprm.108.45.h.1.flight-hours', 'ledger.nprm.108.45.h.1.reliability-data'];
    for (const entry of addedCheckedEntries) {
      const [kind, subjectId] = subjectOf[entry.check.target.subjectKind]!;
      const latest = (await evaluations(kind, subjectId)).find((evaluation) => evaluation.rule.id === entry.id);
      expect(latest, entry.id).toBeDefined();
      expect(latest, entry.id).toMatchObject({
        adoption: { mode: 'shadow' },
        pack: { id: PART108_NPRM_PACK_ID, version: 3, digest: pack.digest },
        rule: { id: entry.id, version: 1, source: { kind: 'proposed_regulation' } },
        ...(awaited.includes(entry.id)
          ? { evidenceState: 'insufficient', outcome: 'pending', reasonCode: 'period_open' }
          : { evidenceState: 'supported', outcome: 'pass' }),
      });
    }

    const read = await call(actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.statusCode, read.body).toBe(200);
    const rules = (read.json() as AdoptionRuleCoverageResponse).rules;
    for (const entry of addedCheckedEntries) {
      const rule = rules.find((item) => item.leafId === entry.id);
      expect(rule, entry.id).toMatchObject({
        checkedBy: 'automatic',
        subjectKind: entry.check.target.subjectKind,
        population: entry.check.population,
      });
      expect(rule!.populationSize, entry.id).toBeGreaterThan(0);
      const counted = awaited.includes(entry.id) ? rule!.counts!.pending : rule!.counts!.supported;
      expect(counted, entry.id).toBeGreaterThan(0);
      expect(rule!.counts!.attention, entry.id).toBe(0);
    }
    for (const id of ['ledger.nprm.108.165.e', 'ledger.nprm.108.530.a'])
      expect(
        rules.find((item) => item.leafId === id),
        id,
      ).toMatchObject({ checkedBy: 'person', counts: null });
    // In shadow nothing these rules found needs a person, so no finding is opened.
    const findings = await admin.query('SELECT leaf_id FROM findings WHERE tenant_id=$1 AND leaf_id=ANY($2)', [
      tenantId,
      addedCheckedEntries.map(({ id }) => id),
    ]);
    expect(findings.rows).toEqual([]);
  });

  it('checks a planned flight as soon as its plan and the records for it are on file', async () => {
    const { planned, coordinator, aircraft } = subjects;
    // The window starts three days from now, inside the adoption's dates.
    await importRecords('flight.plan', [
      {
        subjectId: planned,
        secondarySubjectId: aircraft,
        windowStartsAt: hoursAhead(72),
        windowEndsAt: hoursAhead(73),
        operationKind: 'aerial_survey',
        plannedOriginDescription: 'North pad',
        plannedDestinationDescription: 'North pad',
        routeSummary: 'Survey grid over the fictional quarry',
      },
    ]);
    await importRecords('organization.coordinator-requirement', [
      { subjectId: planned, subjectKind: 'flight', coordinatorRequired: true, basis: 'manufacturer_instructions' },
    ]);
    await importRecords('operation.role-assignment', [
      {
        subjectId: planned,
        subjectKind: 'flight',
        personId: coordinator,
        role: 'flight_coordinator',
        startsAt: hoursAhead(71.5),
        endsAt: hoursAhead(73.5),
      },
    ]);
    await importRecords('operation.multiple-aircraft', [
      {
        subjectId: planned,
        subjectKind: 'flight',
        simultaneousAircraftCount: 1,
        manufacturerLimitCount: 2,
        methodLimitCount: 1,
        methodReference: 'Fictional operations manual 5.2',
      },
    ]);
    await importRecords('flight.preflight-assessment', [
      {
        subjectId: planned,
        assessedAt: hoursAgo(0.01),
        weatherDetermination: 'Forecast for the window within the fictional limits.',
        airspaceDetermination: 'Class G; no flight restrictions published for the window.',
        groundHazardsDetermination: 'Quarry closed to staff during the window.',
        participantsBriefing: 'Crew briefed on the survey grid.',
        linkEnergyLoadDetermination: 'Two charged batteries; link survey done last week.',
      },
    ]);
    await settle();

    const results = await evaluations('flight', planned);
    for (const id of planReadingIds.filter((item) => item !== 'ledger.nprm.108.310.c')) {
      const latest = results.find((evaluation) => evaluation.rule.id === id && !evaluation.related);
      const fanned = results.find((evaluation) => evaluation.rule.id === id && evaluation.related);
      const result = latest ?? fanned;
      expect(result, id).toBeDefined();
      expect(result!.reasonCode, id).not.toBe('record_not_on_file');
      if (id !== 'ledger.nprm.108.310.e')
        expect(result, id).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
    }
    // The handover rule does not apply to a plan without a handover; it is evaluated all the same.
    expect(results.find((evaluation) => evaluation.rule.id === 'ledger.nprm.108.310.c')).toBeDefined();
    const flightRecord = results.find((evaluation) => evaluation.rule.id === 'ledger.nprm.108.40.a.3.iv');
    // A flight not yet flown has no flight record: that rule asks what was flown, so it does not read plans.
    expect(flightRecord?.reasonCode).toBe('record_not_on_file');
  });
});
