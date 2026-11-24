import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type {
  AdoptionRuleCoverageResponse,
  RuleCoverageSubjectsResponse,
  RulePackVersion,
} from '../../contracts/src/index.js';
import { registerRulePack } from '../../domain/src/rule-pack-registry.js';
import { coverageTenant, type CoverageTenant } from '../../../tests/integration/coverage-tenant.js';
import { settleOwnedWork } from '../../../tests/integration/worker-queue.js';
import { buildPackFile, packTemplate, registerStandardPacks, verifiedPackFile } from '../src/index.js';

// The procedure template `pnpm pack:new --kind procedure` writes, used as it is: an organization's own rules about
// its people, its aircraft and its flights, fed only by records imported as an operator imports them. The setup
// guide (docs/guides/set-up-your-organization.md) walks this example; if the two ever disagree, this test is right.
describe('The procedure template, adopted by a new organization', () => {
  let tenant: CoverageTenant;
  let pack: RulePackVersion;
  let adoptionId: string;
  const id = (name: string) => `${tenant.prefix}-${name}`;
  const rule = (name: string) => `${pack.packId}.${name}`;
  const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19) + 'Z';

  async function coverage(): Promise<AdoptionRuleCoverageResponse> {
    const read = await tenant.call(tenant.actor, 'GET', `/v1/organization/coverage/adoptions/${adoptionId}`);
    expect(read.statusCode, read.body).toBe(200);
    return read.json() as AdoptionRuleCoverageResponse;
  }

  async function behind(name: string, result: string): Promise<RuleCoverageSubjectsResponse['subjects']> {
    const read = await tenant.call(
      tenant.actor,
      'GET',
      `/v1/organization/coverage/adoptions/${adoptionId}/rules/${rule(name)}/subjects?result=${result}`,
    );
    expect(read.statusCode, read.body).toBe(200);
    return (read.json() as RuleCoverageSubjectsResponse).subjects;
  }

  beforeAll(async () => {
    registerStandardPacks({ examples: true });
    const files = packTemplate('procedure');
    const description = parse(files['pack.yaml']!);
    description.pack.id = `test-${process.pid}.operations-manual`;
    pack = verifiedPackFile(buildPackFile(description, files['source.txt']!).file).version;
    registerRulePack({ packId: pack.packId, versions: [pack] });
    tenant = await coverageTenant('procedure-template');
  });
  afterAll(async () => {
    if (tenant) await settleOwnedWork([tenant.prefix]);
    await tenant?.close();
  });

  it('checks people, aircraft and flights from imported records, and reports what is not on file', async () => {
    adoptionId = await tenant.adopt(pack, 'active', {
      parameters: { [rule('planned-height')]: { limit: 100 }, [rule('battery-at-landing')]: { limit: 25 } },
    });
    await tenant.importRecords('aircraft.identity', [
      {
        subjectId: id('AC-1'),
        aircraftMakeModel: 'Fictional Quad 4',
        serialNumber: 'SN-1',
        registrationNumber: 'FICT-1',
      },
      {
        subjectId: id('AC-2'),
        aircraftMakeModel: 'Fictional Quad 4',
        serialNumber: 'SN-2',
        registrationNumber: 'FICT-2',
      },
    ]);
    await tenant.importRecords('aircraft.inspection', [
      {
        subjectId: id('AC-1'),
        inspectionKind: 'scheduled',
        inspectedAt: daysFromNow(-30),
        nextDueAt: daysFromNow(150),
        recordedResult: 'serviceable',
        inspectorName: 'Riley Example',
      },
    ]);
    // One pilot with a recent course, one whose course is too old, and one known only by a certificate.
    await tenant.importRecords('person.training', [
      {
        subjectId: id('PILOT-1'),
        trainingKind: 'recurrent',
        courseTitle: 'Company recurrent course',
        completedOn: daysFromNow(-60).slice(0, 10),
        evidenceReference: 'TR-1',
      },
      {
        subjectId: id('PILOT-2'),
        trainingKind: 'recurrent',
        courseTitle: 'Company recurrent course',
        completedOn: daysFromNow(-500).slice(0, 10),
        evidenceReference: 'TR-2',
      },
    ]);
    await tenant.importRecords('person.certificate', [
      {
        subjectId: id('PILOT-3'),
        credentialKind: 'remote_pilot_certificate',
        credentialNumber: 'FICT-0003',
        recordedStatus: 'held',
      },
    ]);
    // Two flights still to come: a plan is read as soon as it is on file.
    const plan = (flight: string, aircraft: string, height: number, days: number) => ({
      subjectId: id(flight),
      secondarySubjectId: id(aircraft),
      windowStartsAt: daysFromNow(days),
      windowEndsAt: daysFromNow(days + 0.04),
      operationKind: 'aerial_survey',
      plannedOriginDescription: 'North pad',
      plannedDestinationDescription: 'North pad',
      routeSummary: 'Fictional ridge line survey',
      plannedMaxHeightAboveGroundMeters: height,
    });
    await tenant.importRecords('flight.plan', [plan('FLT-1', 'AC-1', 80, 0.2), plan('FLT-2', 'AC-2', 130, 0.4)]);
    await tenant.settle();

    const rules = Object.fromEntries((await coverage()).rules.map((item) => [item.leafId, item]));
    expect(rules[rule('pilot-training')]).toMatchObject({
      checkedBy: 'automatic',
      subjectKind: 'person',
      populationSize: 3,
      counts: { supported: 1, attention: 1, no_record: 1, not_evaluated: 0 },
    });
    expect(rules[rule('aircraft-inspection')]).toMatchObject({
      checkedBy: 'automatic',
      subjectKind: 'aircraft',
      populationSize: 2,
      counts: { supported: 1, attention: 0, no_record: 1, not_evaluated: 0 },
    });
    expect(rules[rule('planned-height')]).toMatchObject({
      checkedBy: 'automatic',
      subjectKind: 'flight',
      populationSize: 2,
      counts: { supported: 1, attention: 1, no_record: 0, not_evaluated: 0 },
    });
    expect(rules[rule('crew-briefing')]).toMatchObject({ checkedBy: 'person', populationSize: null, counts: null });

    // Each count opens the subjects behind it, by the organization's own ids and the names their records give them,
    // with the sentence a person reads.
    const untrained = await behind('pilot-training', 'no_record');
    expect(untrained.map((item) => item.subject.id)).toEqual([id('PILOT-3')]);
    expect(untrained[0]!.evaluation!.summary).toBe('No recurrent training record on file.');
    const uninspected = await behind('aircraft-inspection', 'no_record');
    expect(uninspected.map((item) => [item.subject.id, item.subject.name])).toEqual([
      [id('AC-2'), 'Fictional Quad 4, FICT-2'],
    ]);
    expect((await behind('planned-height', 'attention')).map((item) => item.subject.id)).toEqual([id('FLT-2')]);
  });
});
