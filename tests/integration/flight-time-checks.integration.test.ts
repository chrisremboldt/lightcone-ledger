import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RuleCoverageSubjectsResponse, RulePackVersion } from '../../packages/contracts/src/index.js';
import { getRulePackVersion, registerRulePack } from '../../packages/domain/src/rule-pack-registry.js';
import { buildPackFile, registerStandardPacks, verifiedPackFile } from '../../packages/standard-packs/src/index.js';
import { coverageTenant, type CoverageTenant } from './coverage-tenant.js';
import { settleOwnedWork } from './worker-queue.js';

// An invented operator whose waiver asks for things only a flight's own time can answer: a detect-and-avoid check
// before each flight, an inspection within 30 days before it, at most two aircraft under one pilot at once, three
// recent flights, listed sites, a notice not more than 72 hours before, and flights within the certificate's dates.
// Its people also hold a Part 107 recurrent course beside a company one. Each case is planted once and absent once
// (docs/design/record-check-kinds.md, "Evaluated as of each flight").

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PARTY = 'Example County dispatch';

describe.runIf(process.env.LEDGER_ENV !== 'staging')('Checks as of each flight', () => {
  let tenant: CoverageTenant;
  let pack: RulePackVersion;
  let waiverAdoption: string;
  let part107Adoption: string;
  const id = (name: string) => `${tenant.prefix}-${name}`;
  const started = Date.now();
  /** An instant whole days and hours from when the test started, in UTC. */
  const at = (days: number, hours = 0) => new Date(started + days * DAY + hours * HOUR).toISOString();
  const dateOf = (days: number) => at(days).slice(0, 10);

  async function behind(adoptionId: string, ruleId: string, result: string) {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${ruleId}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return Object.fromEntries(
      (read.json() as RuleCoverageSubjectsResponse).subjects.map((item) => [item.subject.id, item]),
    );
  }
  const provision = (number: number, result: string) =>
    behind(waiverAdoption, `${pack.packId}.provision-${number}`, result);
  const summaryOf = (rows: Awaited<ReturnType<typeof behind>>, name: string) => rows[id(name)]?.evaluation?.summary;

  beforeAll(async () => {
    registerStandardPacks({ examples: true });
    tenant = await coverageTenant('flight-time');
    const source = `Certificate of Waiver EX-0122 (invented for this test)

1. The detect-and-avoid equipment is checked before each flight and the check is recorded.

2. Each aircraft is inspected within 30 days before each flight.

3. No remote pilot in command operates more than 2 aircraft at the same time.

4. Each remote pilot in command has flown at least 3 flights in the preceding 90 days.

5. Operations are conducted only at the sites ${id('SITE-A')} and ${id('SITE-B')}.

6. ${PARTY} is notified not more than 72 hours before each operation.

7. Operations beyond visual line of sight are permitted only under Certificate of Waiver EX-0122.

8. Each dock is inspected within 30 days before each flight it launches.
`;
    const description = {
      pack: { id: `test-${process.pid}.waiver-ex-0122`, version: 1, title: 'Waiver EX-0122 (invented)' },
      source: { file: 'source.txt', kind: 'waiver', reference: 'Certificate of Waiver EX-0122' },
      waiver: {
        certificateNumber: 'EX-0122',
        effective: { from: dateOf(-30), through: dateOf(300) },
        conditionsCover: 'every flight',
      },
      provisions: [
        {
          number: 1,
          title: 'Detect and avoid',
          quote: 'The detect-and-avoid equipment is checked before each flight and the check is recorded.',
          obligation: 'equipment.detect-and-avoid',
        },
        {
          number: 2,
          title: 'Inspection',
          quote: 'Each aircraft is inspected within 30 days before each flight.',
          obligation: 'maintenance.inspected-within-days',
          parameters: { days: 30, inspectionKinds: ['scheduled'] },
        },
        {
          number: 3,
          title: 'Aircraft per pilot',
          quote: 'No remote pilot in command operates more than 2 aircraft at the same time.',
          obligation: 'operation.aircraft-per-pilot',
          parameters: { maxAircraft: 2 },
        },
        {
          number: 4,
          title: 'Recent flights',
          quote: 'Each remote pilot in command has flown at least 3 flights in the preceding 90 days.',
          obligation: 'qualification.recent-flights',
          parameters: { flights: 3, days: 90 },
        },
        {
          number: 5,
          title: 'Sites',
          quote: `Operations are conducted only at the sites ${id('SITE-A')} and ${id('SITE-B')}.`,
          obligation: 'condition.site-listed',
          parameters: { siteIds: [id('SITE-A'), id('SITE-B')] },
        },
        {
          number: 6,
          title: 'Notice',
          quote: `${PARTY} is notified not more than 72 hours before each operation.`,
          obligation: 'notification.not-more-than-before-operations',
          parameters: { party: PARTY, maxLeadHours: 72 },
        },
        {
          number: 7,
          title: 'Relief from visual line of sight',
          quote: 'Operations beyond visual line of sight are permitted only under Certificate of Waiver EX-0122.',
          obligation: 'authority.flight-cites-certificate',
          parameters: { certificateNumber: 'EX-0122', effectiveFrom: dateOf(-30), effectiveThrough: dateOf(300) },
          relieves: [{ packId: 'ledger.part107', ruleIds: ['ledger.part107.107.31.a'] }],
        },
        {
          number: 8,
          title: 'Dock inspection',
          quote: 'Each dock is inspected within 30 days before each flight it launches.',
          obligation: 'maintenance.dock-inspected-within-days',
          parameters: { days: 30, inspectionKinds: ['scheduled'] },
        },
      ],
    };
    pack = verifiedPackFile(buildPackFile(description as never, source).file).version;
    registerRulePack({ packId: pack.packId, versions: [pack] });
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('reads each flight as of its own time, and says which records it read', async () => {
    // Each flight: day, start hour, minutes flown, aircraft, pilot, site, and whether the operator logged it as flown.
    const flights = [
      { flight: 'F-R1', day: -70, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-A' },
      { flight: 'F-R2', day: -50, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-A' },
      { flight: 'F-OLD', day: -40, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-A' },
      { flight: 'F-R3', day: -35, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-A' },
      { flight: 'F-N1', day: -12, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-2', site: 'SITE-B' },
      { flight: 'F-A', day: -10, hour: 15, minutes: 30, aircraft: 'AC-1', pilot: 'P-1', site: 'SITE-A' },
      { flight: 'F-B', day: -10, hour: 17, minutes: 30, aircraft: 'AC-1', pilot: 'P-1', site: 'SITE-A' },
      // Three aircraft under P-1 at once: from 16:15 all three are in the air.
      { flight: 'F-1', day: -8, hour: 16, minutes: 35, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-B' },
      { flight: 'F-2', day: -8, hour: 16 + 8 / 60, minutes: 30, aircraft: 'AC-3', pilot: 'P-1', site: 'SITE-B' },
      { flight: 'F-3', day: -8, hour: 16.25, minutes: 28, aircraft: 'AC-4', pilot: 'P-1', site: 'SITE-B' },
      { flight: 'F-SITE-C', day: -6, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-1', site: 'SITE-C' },
      { flight: 'F-NEW', day: -5, hour: 15, minutes: 30, aircraft: 'AC-2', pilot: 'P-2', site: 'SITE-A' },
    ];
    const start = (item: (typeof flights)[number]) => at(item.day, item.hour);
    const end = (item: (typeof flights)[number]) => at(item.day, item.hour + item.minutes / 60);
    await tenant.importRecords(
      'flight.plan',
      flights.map((item) => ({
        subjectId: id(item.flight),
        secondarySubjectId: id(item.aircraft),
        windowStartsAt: start(item),
        windowEndsAt: end(item),
        operationKind: 'inspection',
        plannedOriginDescription: 'Pad',
        plannedDestinationDescription: 'Pad',
        routeSummary: 'Fictional line survey',
        siteId: id(item.site),
        // F-A launches from dock D-03 and F-1 from D-04; the other plans name no dock.
        ...(item.flight === 'F-A' ? { dockId: id('D-03') } : item.flight === 'F-1' ? { dockId: id('D-04') } : {}),
        visualMode: 'beyond_visual_line_of_sight',
        operatingAuthorityReference: 'EX-0122',
      })),
    );
    await tenant.importRecords(
      'flight.record',
      flights.map((item) => ({
        subjectId: id(item.flight),
        secondarySubjectId: id(item.aircraft),
        takeoffAt: start(item),
        landingAt: end(item),
        takeoffLocation: 'Pad',
        landingLocations: 'Pad',
        maxHeightFlownAboveGroundMeters: 90,
      })),
    );
    await tenant.importRecords(
      'operation.role-assignment',
      flights.map((item) => ({
        subjectId: id(item.flight),
        subjectKind: 'flight',
        personId: id(item.pilot),
        role: 'pilot_in_command',
        startsAt: start(item),
        endsAt: end(item),
      })),
    );
    // P-3 flies none of these flights but is designated a remote pilot in command, so the Part 107 rules about
    // remote pilots cover them.
    await tenant.importRecords('operation.role-assignment', [
      {
        subjectId: `organization:${tenant.tenantId}`,
        subjectKind: 'organization',
        personId: id('P-3'),
        role: 'pilot_in_command',
        startsAt: at(-400),
      },
    ]);
    // A detect-and-avoid check before F-A; none after F-A landed and before F-B.
    await tenant.importRecords('aircraft.detect-and-avoid', [
      {
        subjectId: id('AC-1'),
        checkedAt: at(-10, 14.5),
        equipmentReference: 'Fictional receiver unit 1',
        equipmentState: 'serviceable',
      },
    ]);
    // A log with a tick per flight and no time: AC-2's tick for F-1, dated and naming it, and a tick dated the day
    // before F-SITE-C that names no flight, which counts for no flight on a later day.
    await tenant.importRecords('aircraft.detect-and-avoid', [
      {
        subjectId: id('AC-2'),
        secondarySubjectId: id('F-1'),
        checkedAt: dateOf(-9),
        equipmentReference: 'Fictional receiver unit 2',
        equipmentState: 'serviceable',
      },
      {
        subjectId: id('AC-2'),
        checkedAt: dateOf(-7),
        equipmentReference: 'Fictional receiver unit 2',
        equipmentState: 'serviceable',
      },
    ]);
    // AC-1 was last inspected 45 days ago; AC-2 20 days ago.
    await tenant.importRecords('aircraft.inspection', [
      {
        subjectId: id('AC-1'),
        inspectionKind: 'scheduled',
        inspectedAt: at(-45),
        nextDueAt: at(200),
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      },
      {
        subjectId: id('AC-2'),
        inspectionKind: 'scheduled',
        inspectedAt: at(-20),
        nextDueAt: at(200),
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      },
    ]);
    // Dock D-03 was last inspected 45 days ago, D-04 10 days ago.
    await tenant.importRecords(
      'component.inspection',
      [
        { dock: 'D-03', days: -45 },
        { dock: 'D-04', days: -10 },
      ].map((item) => ({
        subjectId: id(item.dock),
        inspectionKind: 'scheduled',
        inspectedAt: at(item.days),
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      })),
    );
    // F-1's notice a day before; F-2's more than 72 hours before.
    await tenant.importRecords('operation.notification', [
      { subjectId: id('F-1'), subjectKind: 'flight', notifiedAt: at(-9, 16), recipient: PARTY, means: 'online_form' },
      { subjectId: id('F-2'), subjectKind: 'flight', notifiedAt: at(-13, 16), recipient: PARTY, means: 'online_form' },
    ]);
    // P-1's Part 107 recurrent course and a company recurrent course on another date; P-3's two Part 107 records
    // disagree.
    const training = (
      person: string,
      completedOn: string,
      program: string,
      courseTitle: string,
      evidenceReference = `${person}-${completedOn}`,
    ) => ({
      subjectId: id(person),
      trainingKind: 'recurrent',
      courseTitle,
      completedOn,
      program,
      evidenceReference,
    });
    await tenant.importRecords('person.training', [
      training('P-1', dateOf(-200), 'remote_pilot_certificate', 'Part 107 recurrent online course'),
      training('P-1', dateOf(-400), 'operator_program', 'Company BVLOS recurrent'),
      training('P-3', dateOf(-100), 'remote_pilot_certificate', 'Part 107 recurrent online course'),
      // The same completion, by its evidence, entered again with another date.
      training(
        'P-3',
        dateOf(-500),
        'remote_pilot_certificate',
        'Part 107 recurrent online course',
        `P-3-${dateOf(-100)}`,
      ),
    ]);

    waiverAdoption = await tenant.adopt(pack, 'active', { effectiveInterval: { start: at(-30), end: at(1) } });
    part107Adoption = await tenant.adopt(getRulePackVersion('ledger.part107', 2)!, 'active', {
      effectiveInterval: { start: at(-120), end: at(1) },
    });
    await tenant.settle();

    // 1. Detect and avoid: F-A's check was made before it took off; none is on file for F-B since F-A landed.
    expect(summaryOf(await provision(1, 'supported'), 'F-A')).toMatch(
      new RegExp(
        `^The detect-and-avoid check of ${id('AC-1')} made at .+, 0\\.5 h before takeoff at .+, records the detect-and-avoid equipment’s State as Installed and serviceable\\.`,
      ),
    );
    const noCheck = await provision(1, 'no_record');
    expect(summaryOf(noCheck, 'F-B')).toMatch(
      new RegExp(
        `^No detect-and-avoid check of ${id('AC-1')} is on file between the aircraft’s previous flight in the operator’s flight records, which ended at .+, and takeoff at .+ in the operator’s flight record; the latest was made at .+\\.$`,
      ),
    );
    expect(noCheck[id('F-B')]!.finding).toBeFalsy();
    expect(summaryOf(await provision(1, 'supported'), 'F-1')).toMatch(
      new RegExp(
        `^The detect-and-avoid check of ${id('AC-2')} made for this flight, ${id('F-1')}, on ${dateOf(-9)} \\(only the date is on record\\), for takeoff at .+, records the detect-and-avoid equipment’s State as Installed and serviceable\\.`,
      ),
    );
    expect(summaryOf(noCheck, 'F-SITE-C')).toMatch(
      new RegExp(
        `^No detect-and-avoid check of ${id('AC-2')} is on file for takeoff at .+; the latest, made on ${dateOf(-7)}, names no flight and gives a date only, so it counts only for flights that took off on ${dateOf(-7)}\\.$`,
      ),
    );

    // 2. Inspection age: AC-1's inspection was 35 days old at F-A's takeoff; AC-2's 12 days at F-1's.
    const old = await provision(2, 'attention');
    expect(Object.keys(old).sort()).toEqual([id('F-A'), id('F-B')]);
    expect(summaryOf(old, 'F-A')).toMatch(
      new RegExp(
        `^The latest inspection of ${id('AC-1')} on file before takeoff at .+ was made at .+, 3\\d(\\.\\d)? days before it; the rule allows at most 30 days\\.$`,
      ),
    );
    expect(summaryOf(await provision(2, 'supported'), 'F-1')).toMatch(/12(\.\d)? days before takeoff/);

    // 3. Aircraft per pilot: P-1 had F-1, F-2 and F-3 in the air at once; F-A alone.
    const atOnce = await provision(3, 'attention');
    expect(Object.keys(atOnce).sort()).toEqual([id('F-1'), id('F-2'), id('F-3')]);
    expect(summaryOf(atOnce, 'F-3')).toMatch(
      new RegExp(
        `^${id('P-1')} held 3 flights as remote pilot in command at once from .+, during the flight as the operator recorded it, .+: this flight and ${id('F-1')}, ${id('F-2')}; the rule allows at most 2\\.$`,
      ),
    );
    expect(summaryOf(await provision(3, 'supported'), 'F-A')).toMatch(
      new RegExp(
        `none of ${id('P-1')}’s other flights as remote pilot in command on file overlaps it\\. The rule allows at most 2 at once\\.`,
      ),
    );

    // 4. Recent flights: P-2 has one flight before F-NEW in 90 days; P-1 has several before F-A.
    const recent = await provision(4, 'attention');
    expect(Object.keys(recent).sort()).toEqual([id('F-N1'), id('F-NEW')]);
    expect(summaryOf(recent, 'F-NEW')).toMatch(
      new RegExp(
        `^1 of ${id('P-2')}’s other flights as remote pilot in command on file started in the 90 days before takeoff at .+: ${id('F-N1')}; the rule asks for at least 3\\.$`,
      ),
    );
    expect(summaryOf(await provision(4, 'supported'), 'F-A')).toContain(
      `${id('F-R1')}, ${id('F-R2')}, ${id('F-OLD')}, ${id('F-R3')}`,
    );

    // 5. Sites: F-SITE-C's plan names a site the waiver does not list.
    const site = await provision(5, 'attention');
    expect(Object.keys(site)).toEqual([id('F-SITE-C')]);
    expect(summaryOf(site, 'F-SITE-C')).toBe(
      `The latest recorded value for the flight plan’s Operating site is ${id('SITE-C')}. Expected ${id('SITE-A')} or ${id('SITE-B')}.`,
    );
    expect(Object.keys(await provision(5, 'supported'))).toContain(id('F-A'));

    // 6. Notice: F-2's notice was given more than 72 hours before; F-1's a day before.
    const notice = await provision(6, 'attention');
    expect(summaryOf(notice, 'F-2')).toMatch(
      /^The latest record was made at .+, before .+; it was due from .+ to the start at .+, not more than 72 h before it\.$/,
    );
    expect(notice[id('F-2')]!.evaluation!.reasonCode).toBe('made_early');
    expect(summaryOf(await provision(6, 'supported'), 'F-1')).toMatch(
      /^A notice to Example County dispatch is recorded at /,
    );

    // 7. Certificate dates: F-OLD cites EX-0122 before its dates and is listed; it is not relieved under Part 107.
    const outside = await provision(7, 'attention');
    expect(Object.keys(outside).sort()).toEqual([id('F-OLD'), id('F-R1'), id('F-R2'), id('F-R3')].sort());
    expect(summaryOf(outside, 'F-OLD')).toMatch(
      new RegExp(
        `^The flight plan’s Operating authority reference is EX-0122\\. The flight’s time is takeoff at .+ in the operator’s flight record, on ${at(-40, 15).slice(0, 10)}, before the dates certificate EX-0122 states it is effective, from ${dateOf(-30)} through ${dateOf(300)}\\.$`,
      ),
    );
    expect(summaryOf(await provision(7, 'supported'), 'F-A')).toContain('is within the dates it states');
    const visualLine = await behind(part107Adoption, 'ledger.part107.107.31.a', 'attention');
    expect(Object.keys(visualLine)).toContain(id('F-OLD'));
    expect(Object.keys(visualLine)).not.toContain(id('F-A'));

    // Provision 8, dock inspection: D-03 was inspected 35 days before F-A, D-04 2 days before F-1; F-B's plan names
    // no dock.
    expect(summaryOf(await provision(8, 'attention'), 'F-A')).toMatch(
      new RegExp(
        `^The latest inspection of ${id('D-03')} on file before takeoff at .+ was made at .+, 3\\d(\\.\\d)? days before it; the rule allows at most 30 days\\.$`,
      ),
    );
    expect(Object.keys(await provision(8, 'supported'))).toEqual([id('F-1')]);
    expect(summaryOf(await provision(8, 'pending'), 'F-B')).toBe(
      'No dock or ground station is named on the flight plan, so its inspection is not checked.',
    );

    // 8. Two recurrent courses: P-1's company course is another program; P-3's one Part 107 completion has two dates.
    expect(Object.keys(await behind(part107Adoption, 'ledger.part107.107.65', 'supported'))).toContain(id('P-1'));
    const training107 = await behind(part107Adoption, 'ledger.part107.107.65', 'attention');
    expect(summaryOf(training107, 'P-3')).toBe(
      `2 records made at the same time give different dates for the training’s Completed on: ${dateOf(-500)} (Part 107 recurrent online course), ${dateOf(-100)} (Part 107 recurrent online course). Correct the date that is wrong, or record the older one as replaced by the newer, so one date stands.`,
    );
    expect(Object.keys(training107)).not.toContain(id('P-1'));
  }, 300_000);
});
