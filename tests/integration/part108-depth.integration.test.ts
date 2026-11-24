import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AdoptionRuleCoverageResponse,
  CoverageResult,
  RuleCoverage,
  RuleCoverageSubjectsResponse,
} from '../../packages/contracts/src/index.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// The proposed Part 108 rules for the paragraphs an applicant looks for, and the operating areas, from records a
// fictional operator imports, adopted in shadow: what each finds, read through the coverage read, section by section.
describe.runIf(process.env.LEDGER_ENV !== 'staging')('Part 108 depth, from imported records', () => {
  let tenant: CoverageTenant;
  let coverage: AdoptionRuleCoverageResponse;
  let adoptionId: string;
  const started = Date.now();
  const at = (minutes: number) => new Date(started + minutes * 60_000).toISOString().slice(0, 19) + 'Z';
  const id = (name: string) => `${tenant.prefix}-${name}`;
  const rule = (leafId: string): RuleCoverage => {
    const found = coverage.rules.find((item) => item.leafId === leafId);
    expect(found, leafId).toBeDefined();
    return found!;
  };
  async function behind(leafId: string, result: CoverageResult): Promise<RuleCoverageSubjectsResponse> {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${leafId}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return read.json() as RuleCoverageSubjectsResponse;
  }

  beforeAll(async () => {
    tenant = await coverageTenant('part108-depth');
    const supervisor = id('P-05');
    const coordinator = id('P-02');
    await tenant.importRecords('aircraft.identity', [
      { subjectId: id('AC-1'), aircraftMakeModel: 'Fictional Survey Quad X8', registrationNumber: 'FA3EXAMPLE01' },
      { subjectId: id('AC-2'), aircraftMakeModel: 'Fictional Survey Quad X8', registrationNumber: 'FA3EXAMPLE02' },
    ]);
    // One aircraft's detect-and-avoid unit is inoperative and determined not to be a hazard; the other's is not.
    await tenant.importRecords('aircraft.detect-and-avoid', [
      {
        subjectId: id('AC-1'),
        checkedAt: at(-180),
        equipmentReference: 'Fictional DAA receiver unit 1',
        equipmentState: 'inoperative',
        hazardDeterminedByName: 'Sam Example',
        hazardDeterminedAt: at(-170),
      },
      {
        subjectId: id('AC-2'),
        checkedAt: at(-180),
        equipmentReference: 'Fictional DAA receiver unit 2',
        equipmentState: 'inoperative',
      },
    ]);
    // One aircraft's latest maintenance is returned to service; the other's is not.
    await tenant.importRecords('maintenance.action', [
      {
        subjectId: id('AC-1'),
        subjectKind: 'aircraft',
        actionDescription: 'Propellers replaced',
        performedAt: at(-300),
        performedByName: 'Sam Example',
        returnedToService: true,
        returnToServiceByName: 'Sam Example',
      },
      {
        subjectId: id('AC-2'),
        subjectKind: 'aircraft',
        actionDescription: 'Replaced rear left motor after vibration warning',
        performedAt: at(-300),
        performedByName: 'Sam Example',
      },
    ]);
    await tenant.importRecords('occurrence.mechanical-irregularity', [
      {
        subjectId: id('AC-2'),
        subjectKind: 'aircraft',
        occurredAt: at(-240),
        irregularityDescription: 'Fictional: the deconfliction service returned no intent for 4 minutes.',
        correctiveAction: 'Held on the ground until the service recovered.',
        dataServiceFailure: 'yes',
      },
    ]);
    await tenant.importRecords('person.aircraft-experience', [
      {
        subjectId: coordinator,
        role: 'flight_coordinator',
        aircraftMakeModel: 'fictional survey quad x8',
        supervisedHours: 12,
        supervisorReference: 'Fictional supervision log 7',
        recentHours: 6,
        recentPeriodStartsOn: '2025-12-01',
        recentPeriodEndsOn: '2026-11-30',
        qualificationReference: 'Fictional qualification record 7',
      },
    ]);
    await tenant.importRecords('organization.procedure', [
      {
        procedureKind: 'battery_monitoring',
        title: 'Battery monitoring program',
        documentReference: 'OPS-MAN section 9.4',
        revision: '2',
        effectiveAt: at(-600),
      },
    ]);
    // Two operating areas: a circle complete, and a corridor along a line with no takeoff and landing areas yet.
    await tenant.importRecords('organization.operating-area', [
      {
        areaId: 'RIDGE-AREA-1',
        shape: 'circle',
        center: '39.5000, -105.2000',
        radiusMeters: 5000,
        startsAt: at(-600),
        areaApprovalReference: 'COA-EX-2026-0101',
        alternateLandingAreas: 'Gravel lot beside the north substation',
        takeoffLandingAreas: 'North substation pad: fenced, gravel, lit',
      },
      {
        areaId: 'RIDGE-AREA-2',
        shape: 'corridor',
        corridorPoints: '39.5200, -105.2600; 39.5600, -105.1900; 39.6100, -105.1500',
        corridorHalfWidthMeters: 150,
        startsAt: at(-600),
        areaApprovalReference: 'COA-EX-2026-0102',
        alternateLandingAreas: 'Ridge road pullout',
      },
    ]);
    const plan = (flight: string, aircraft: string) => ({
      subjectId: flight,
      secondarySubjectId: aircraft,
      windowStartsAt: at(60),
      windowEndsAt: at(120),
      operationKind: 'inspection',
      plannedOriginDescription: 'Ridge road pullout',
      plannedDestinationDescription: 'Ridge road pullout',
      routeSummary: 'Transmission line segment 15',
    });
    await tenant.importRecords('flight.plan', [plan(id('FLT-1'), id('AC-1')), plan(id('FLT-2'), id('AC-2'))]);
    // Taken just before the adoption, whose dates start a minute before it is recorded, so the change is inside them.
    const now = new Date().toISOString().slice(0, 19) + 'Z';
    await tenant.importRecords('operation.role-assignment', [
      {
        subjectId: id('FLT-2'),
        subjectKind: 'flight',
        personId: coordinator,
        role: 'flight_coordinator',
        startsAt: at(60),
        endsAt: at(120),
      },
      // A new operations supervisor, inside the adoption's dates, with no notice to the authority recorded yet.
      { subjectKind: 'organization', personId: supervisor, role: 'operations_supervisor', startsAt: now },
    ]);
    adoptionId = await tenant.adopt(getRulePackVersion('ledger.part108-nprm', 3)!, 'shadow');
    await tenant.settle();
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.statusCode, read.body).toBe(200);
    coverage = read.json() as AdoptionRuleCoverageResponse;
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('returns the rules grouped by section, in the order of the proposed part, each with its paragraph', () => {
    const pack = getRulePackVersion('ledger.part108-nprm', 3)!;
    expect(coverage.sections.map(({ id: section, title }) => ({ id: section, title }))).toEqual(pack.sections);
    expect(coverage.sections[0]).toMatchObject({ id: '108.40', title: '§ 108.40 Operator recordkeeping requirements' });
    expect(coverage.rules.map(({ leafId }) => leafId)).toEqual(coverage.sections.flatMap(({ leafIds }) => leafIds));
    const areas = coverage.sections.find((section) => section.id === '108.165')!;
    expect(areas.leafIds).toEqual([
      'ledger.nprm.108.165.a',
      'ledger.nprm.108.165.a.flown',
      'ledger.nprm.108.165.b',
      'ledger.nprm.108.165.c',
      'ledger.nprm.108.165.d',
      'ledger.nprm.108.165.e',
    ]);
    expect(areas.checkedBy).toEqual({ automatic: 5, person: 1, not_supported: 0 });
    expect(areas.needingAttention).toBe(1);
    for (const item of coverage.rules) {
      expect(item.section, item.leafId).toBe(
        coverage.sections.find(({ leafIds }) => leafIds.includes(item.leafId))!.id,
      );
      expect(item.paragraph, item.leafId).toMatch(/^§ 108\.\d+/);
    }
    expect(rule('ledger.nprm.108.165.c').paragraph).toBe('§ 108.165(c)');
  });

  it('reads every operating area on file, once for the organization, and names the one lacking a value', async () => {
    expect(rule('ledger.nprm.108.165.a')).toMatchObject({ subjectKind: 'organization', counts: { supported: 1 } });
    expect(rule('ledger.nprm.108.165.b')).toMatchObject({ counts: { supported: 1 } });
    expect(rule('ledger.nprm.108.165.c')).toMatchObject({ counts: { attention: 1 } });
    const [lacking] = (await behind('ledger.nprm.108.165.c', 'attention')).subjects;
    expect(lacking!.evaluation!.summary).toBe(
      '2 operating areas in force: RIDGE-AREA-1, RIDGE-AREA-2. Operating area RIDGE-AREA-2 states no takeoff, landing and loading areas.',
    );
    // The flown-inside rule finds the areas on file; with no positions reported its flights are not placed.
    expect(rule('ledger.nprm.108.165.a.flown')).toMatchObject({ counts: { not_applicable: 2, no_record: 0 } });
  });

  it('finds the flight of an aircraft after maintenance not returned to service, and the inoperative equipment', async () => {
    expect(rule('ledger.nprm.108.630.a.flight')).toMatchObject({ counts: { supported: 1, attention: 1 } });
    const [afterMaintenance] = (await behind('ledger.nprm.108.630.a.flight', 'attention')).subjects;
    expect(afterMaintenance!.subject.id).toBe(id('FLT-2'));
    expect(afterMaintenance!.evaluation!.summary).toMatch(/^The latest maintenance recorded on the planned aircraft/);
    expect(rule('ledger.nprm.108.555.a')).toMatchObject({ counts: { supported: 1, attention: 1 } });
    const [inoperative] = (await behind('ledger.nprm.108.555.a', 'attention')).subjects;
    expect(inoperative!.subject.id).toBe(id('FLT-2'));
  });

  it('reads the coordinator’s recency, the new operations supervisor and who needs a security threat assessment', async () => {
    expect(rule('ledger.nprm.108.310.f')).toMatchObject({ counts: { supported: 1, not_applicable: 1 } });
    // The notice to the authority is not due for 10 days: the result waits for it.
    expect(rule('ledger.nprm.108.305.b')).toMatchObject({ subjectKind: 'organization', counts: { pending: 1 } });
    expect(rule('ledger.nprm.108.335.b')).toMatchObject({ counts: { supported: 1 } });
  });

  it('says what the organization has on file: the battery program, and no physical security procedure', async () => {
    expect(rule('ledger.nprm.108.620.a')).toMatchObject({ counts: { supported: 1 } });
    expect(rule('ledger.nprm.108.150.c')).toMatchObject({ counts: { no_record: 1 } });
    const [none] = (await behind('ledger.nprm.108.150.c', 'no_record')).subjects;
    expect(none!.missing).toEqual(['physical security policies and processes']);
    expect(rule('ledger.nprm.108.45.d.2')).toMatchObject({ populationSize: 1, counts: { attention: 1 } });
  });
});
