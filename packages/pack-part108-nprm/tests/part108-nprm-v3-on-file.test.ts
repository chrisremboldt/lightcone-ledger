import { describe, expect, it } from 'vitest';
import { documentTypeValues, isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import {
  flownCheckedEntries,
  onFileCheckedEntries,
  onFileUncheckedEntries,
  safetyManagementRemainder,
} from '../src/part108-nprm-v3.js';

// What is on file for a certificate application and a safety management system, and height, airspace and area from
// what was flown (docs/design/on-file-checks.md, docs/design/observed-values.md).

const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };

function leaf(id: string): CheckedRuleLeaf {
  const found = pack.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
/** What Ledger records about the organization when a record is put in or out of force. */
function onFile(
  values: Record<string, unknown>,
  interval: { start: string; end?: string },
  occurredAt = '2026-09-01T00:00:00.000Z',
): CheckObservation {
  const full = { purposes: [], ...values };
  return {
    id: `on-file-${++sequence}`,
    type: 'organization.record-in-force',
    version: 1,
    occurredAt,
    interval,
    observation: { occurredAt, interval, values: full },
  };
}

/** An issued revision; of the type `procedure`, which serves no purpose by itself, unless another is given. */
const issued = (
  title: string,
  revision: string,
  purposes: string[],
  interval: { start: string; end?: string },
  documentType = 'procedure',
) =>
  onFile(
    {
      recordKind: 'document',
      recordId: `document-${title}`,
      decisionId: `issue-${++sequence}`,
      title,
      revision,
      documentType,
      purposes,
    },
    interval,
  );

function record(recordType: string, body: Record<string, unknown>, interval?: { start: string; end?: string }) {
  const occurredAt = interval?.start ?? '2026-10-19T08:00:00.000Z';
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt,
    ...(interval ? { interval } : {}),
    observation: {
      occurredAt,
      ...(interval ? { interval } : {}),
      values: { recordType, recordVersion: 1, record: body },
    },
  } satisfies CheckObservation;
}

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/** Gathers each read as the engine does: about a related subject from `related`, the rest from the target's. */
function run(
  id: string,
  target: CheckObservation[],
  related: Record<string, CheckObservation[]> = {},
  parameters: Record<string, unknown> = {},
) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads) {
    const about = typeof read.about === 'object' && 'related' in read.about ? related[read.about.related] : target;
    inputs[read.name] = narrowRead(
      read,
      (about ?? []).filter((item) => item.type === read.type).sort(newestFirst),
      inputs,
    );
  }
  return runCheckedRule(rule, { ...rule.check.params, ...parameters }, inputs, clock);
}

const policy = 'ledger.nprm.108.560.a.safety-policy';
const policyPurpose = 'part108-nprm.safety-policy';

describe('What version 3 looks for on file', () => {
  it('declares each purpose once, quoting the paragraph it serves, and every rule asks for one or reads a record', () => {
    const ids = pack.purposes!.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const purpose of pack.purposes!) {
      expect(purpose.source.kind, purpose.id).toBe('proposed_regulation');
      expect(purpose.source.reference, purpose.id).toMatch(/^Proposed 14 CFR 108\.(505\(b\)\(\d+\)|560\(a\))$/);
    }
    for (const entry of onFileCheckedEntries) {
      const rule = leaf(entry.id);
      expect(rule.population, entry.id).toEqual({ of: 'on_record' });
      expect(rule.target.subjectKind, entry.id).toBe('organization');
      const named = rule.reads.filter((read) => read.required && read.onFile);
      expect(named, entry.id).toHaveLength(1);
      const purpose = named[0]!.where?.find((condition) => condition.field === 'values.purposes');
      if (purpose && 'oneOf' in purpose) expect(ids, entry.id).toContain(purpose.oneOf[0]);
      expect(entry.answers, entry.id).toMatch(/^Per organization: /);
      expect(entry.forAPerson.length, entry.id).toBeGreaterThan(0);
      expect(rule.wording?.pass, entry.id).toMatch(/for a person to review/);
      expect(JSON.stringify(rule.wording), entry.id).not.toMatch(/\b(compliant|conform|ready|complete program)\b/i);
    }
    // Every item of 108.505(b) is a rule: a check for the first sixteen, a person for the seventeenth.
    const items = pack.leaves
      .filter((item) => item.id.startsWith('ledger.nprm.108.505.b.'))
      .map((item) => Number(item.id.slice('ledger.nprm.108.505.b.'.length)))
      .sort((a, b) => a - b);
    expect(items).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    expect(pack.leaves.find((item) => item.id === 'ledger.nprm.108.505.b.17')).toMatchObject({ coverage: 'manual' });
    // Of 108.560, what no record bears on is a person's check with its sentence; nothing is left unsupported.
    for (const entry of [...onFileUncheckedEntries, safetyManagementRemainder])
      expect(
        pack.leaves.find((item) => item.id === entry.id),
        entry.id,
      ).toMatchObject({
        coverage: 'manual',
        waitingFor: entry.waitingFor,
      });
    expect(pack.leaves.filter((item) => item.coverage === 'unsupported')).toEqual([]);
  });

  it('names the document in effect serving the purpose: its title, revision and the date it came into force', () => {
    const document = issued('Safety policy', 'Rev 3', [policyPurpose], { start: '2026-03-01T00:00:00.000Z' });
    const result = run(policy, [document]);
    expect(result).toMatchObject({ evidenceState: 'supported', outcome: 'pass', reasonCode: 'record_in_force' });
    expect(result.evidence).toEqual([document.id]);
    expect(result.summary).toBe(
      'In force: “Safety policy”, revision Rev 3, since 2026-03-01, ticked as serving it. Ledger does not read the document: whether it is a safety policy that meets part 5, signed by the accountable executive is for a person to review.',
    );
    expect(result.details).toMatchObject({ servedBy: 'ticked as serving it' });
  });

  it('counts a document whose type is one the purpose names, with no tick, and says so', () => {
    expect(pack.purposes!.find(({ id }) => id === policyPurpose)!.documentTypes).toEqual(['safety_policy']);
    const typed = issued('Safety policy', 'Rev 1', [], { start: '2026-03-01T00:00:00.000Z' }, 'safety_policy');
    const result = run(policy, [typed]);
    expect(result).toMatchObject({ outcome: 'pass', details: { servedBy: 'its type' } });
    expect(result.summary).toMatch(
      /^In force: “Safety policy”, revision Rev 1, since 2026-03-01, serving it by its type\./,
    );
    // A document of another type serves the purpose only when ticked; a safety policy type serves no other purpose.
    expect(run(policy, [issued('Policy statement', 'A', [], { start: '2026-03-01T00:00:00Z' })])).toMatchObject({
      reasonCode: 'record_not_on_file',
    });
    expect(run('ledger.nprm.108.505.b.6', [typed])).toMatchObject({ reasonCode: 'record_not_on_file' });
    // Every type a purpose names is a controlled-document type.
    for (const purpose of pack.purposes!)
      for (const type of purpose.documentTypes ?? []) expect(documentTypeValues, purpose.id).toContain(type);
  });

  it('says no record is on file when no document serves the purpose', () => {
    expect(run(policy, [])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No safety policy on file.',
    });
    // A document ticked for another purpose does not count, nor does any other record in force.
    const other = issued('Company manual', 'B', ['part108-nprm.company-manual'], { start: '2026-03-01T00:00:00Z' });
    const matrix = onFile(
      { recordKind: 'risk_matrix', recordId: 'matrix-1', title: 'Matrix', revision: 'Version 1' },
      {
        start: '2026-03-01T00:00:00Z',
      },
    );
    expect(run(policy, [other, matrix])).toMatchObject({ reasonCode: 'record_not_on_file' });
  });

  it('no longer counts a revision superseded, expired or retired, and names the latest that was', () => {
    const superseded = issued('Safety policy', 'Rev 2', [policyPurpose], {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-10-01T00:00:00.000Z',
    });
    const result = run(policy, [superseded]);
    expect(result).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
    expect(result.summary).toBe(
      'No safety policy on file. The latest, “Safety policy”, revision Rev 2, was in force from 2026-01-01 until 2026-10-01.',
    );
    // Its successor in effect is named instead.
    const successor = issued('Safety policy', 'Rev 3', [policyPurpose], { start: '2026-10-01T00:00:00.000Z' });
    expect(run(policy, [superseded, successor]).summary).toMatch(
      /^In force: “Safety policy”, revision Rev 3, since 2026-10-01, ticked as serving it\./,
    );
  });

  it('does not count a revision issued to take effect later, and evaluates again when it does', () => {
    const scheduled = issued('Safety policy', 'Rev 4', [policyPurpose], { start: '2026-11-01T00:00:00.000Z' });
    const result = run(policy, [scheduled]);
    expect(result).toMatchObject({
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      nextBoundary: '2026-11-01T00:00:00.000Z',
    });
    expect(result.summary).toBe(
      'No safety policy on file. “Safety policy”, revision Rev 4 takes effect on 2026-11-01.',
    );
    // A purpose ticked on a draft is not recorded at all until the revision is issued, so the rule sees nothing.
  });

  it('names the adopted risk matrix and counts the hazards on file, assessed and accepted', () => {
    const matrix = onFile(
      {
        recordKind: 'risk_matrix',
        recordId: 'matrix-1',
        decisionId: 'adopt-1',
        title: 'Operations risk matrix',
        revision: 'Version 2',
      },
      { start: '2026-05-01T00:00:00.000Z' },
    );
    expect(run('ledger.nprm.108.560.a.risk-matrix', [matrix]).summary).toMatch(
      /^In force: “Operations risk matrix”, revision Version 2, since 2026-05-01\. Whether its severity/,
    );
    expect(run('ledger.nprm.108.560.a.risk-matrix', []).summary).toBe('No adopted risk matrix on file.');
    const hazard = (riskAssessed: boolean, riskAccepted: boolean, end?: string) =>
      onFile(
        { recordKind: 'hazard', recordId: `hazard-${++sequence}`, riskAssessed, riskAccepted },
        {
          start: '2026-06-01T00:00:00.000Z',
          ...(end ? { end } : {}),
        },
      );
    const hazards = [
      hazard(true, true),
      hazard(true, false),
      hazard(false, false),
      hazard(true, true, '2026-07-01T00:00:00Z'),
    ];
    const counted = run('ledger.nprm.108.560.a.hazards', hazards);
    expect(counted).toMatchObject({ outcome: 'pass', reasonCode: 'record_in_force' });
    expect(counted.summary).toBe(
      '3 hazard record(s) on file. 2 of them assessed on the risk matrix; 1 of them with the assessed risk accepted. These are counts of what is on file; whether the hazards identified are the ones the operation has, and whether each assessment is sound, are for a person to review.',
    );
    expect(run('ledger.nprm.108.560.a.hazards', []).summary).toBe('No hazard on file.');
  });

  it('reads the accountable executive and the operations supervisor from role assignments, not documents', () => {
    const assignment = (role: string) =>
      record(
        'operation.role-assignment',
        { personId: { id: 'PER-1', scope: 'source' }, role, startsAt: '2026-01-01T00:00:00Z' },
        {
          start: '2026-01-01T00:00:00.000Z',
        },
      );
    const executive = run('ledger.nprm.108.560.a.accountable-executive', [assignment('accountable_executive')]);
    expect(executive).toMatchObject({ outcome: 'pass', reasonCode: 'window_covered' });
    expect(run('ledger.nprm.108.560.a.accountable-executive', [])).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No accountable executive role assignment on file.',
    });
    const supervisor = run('ledger.nprm.108.505.b.3', [assignment('operations_supervisor')]);
    expect(supervisor.summary).toMatch(/^Ledger holds this as a role assignment rather than a document/);
    expect(run('ledger.nprm.108.505.b.3', [assignment('accountable_executive')])).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No operations supervisor role assignment on file.',
    });
  });
});

describe('Height, airspace and area of operations, flown or else planned', () => {
  const window = { start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z' };
  const plan = () =>
    record(
      'flight.plan',
      {
        windowStartsAt: window.start,
        windowEndsAt: window.end,
        operationKind: 'inspection',
        plannedMaxHeightAboveGroundMeters: 100,
      },
      window,
    );
  const position = (minute: number, meters: number, datum: string, latitudeDegrees = 39.74) => {
    const occurredAt = new Date(Date.parse(window.start) + minute * 60_000).toISOString();
    const observed = {
      occurredAt,
      position: { latitudeDegrees, longitudeDegrees: -104.99, altitude: { meters, datum } },
      values: { fix: 'three_dimensional' },
    };
    return {
      id: `fix-${++sequence}`,
      type: 'position.fix',
      version: 1,
      occurredAt,
      observation: observed,
    } satisfies CheckObservation;
  };

  it('quotes its paragraph, covers the flights in the adoption’s dates and needs their plan', () => {
    for (const entry of flownCheckedEntries) {
      const rule = leaf(entry.id);
      expect(rule.population, entry.id).toEqual({ of: 'in_adoption_dates' });
      expect(
        rule.reads.find((read) => read.onFile === 'flight plan'),
        entry.id,
      ).toBeDefined();
      expect(entry.answers, entry.id).toMatch(/^Per flight: /);
    }
  });

  it('108.175(a): reads the plan with no flown height, and a takeoff-point height named as such once reported', () => {
    expect(run('ledger.nprm.108.175.a', [plan()]).details).toMatchObject({ basis: 'planned' });
    const flown = run('ledger.nprm.108.175.a', [plan()], { aircraft: [position(10, 110, 'takeoff_point')] });
    expect(flown).toMatchObject({
      outcome: 'pass',
      details: { basis: 'flown', measured: 'flown height above the takeoff point' },
    });
    expect(flown.summary).toMatch(/A height above the takeoff point is not a height above ground level/);
    // A height above the ellipsoid is never compared with a limit above ground.
    const ellipsoid = run('ledger.nprm.108.175.a', [plan()], { aircraft: [position(10, 1700, 'wgs84_ellipsoid')] });
    expect(ellipsoid).toMatchObject({ outcome: 'pass', details: { basis: 'planned' } });
    expect(run('ledger.nprm.108.175.a', [plan()], { aircraft: [position(10, 130, 'ground_level')] })).toMatchObject({
      outcome: 'attention',
    });
  });

  it('108.180(d)(1): with no authorization on record, says none is on file', () => {
    expect(run('ledger.nprm.108.180.d.1', [plan()])).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No airspace authorization on file.',
    });
  });

  it('108.165(a): places flown positions against the operating areas the organization has on file', () => {
    const id = 'ledger.nprm.108.165.a.flown';
    const circle = record(
      'organization.operating-area',
      {
        areaId: 'RIDGE-AREA-1',
        shape: 'circle',
        center: '39.74, -104.99',
        radiusMeters: 1000,
        startsAt: '2026-06-01T06:00:00Z',
      },
      { start: '2026-06-01T06:00:00.000Z' },
    );
    const inside = [position(10, 50, 'ground_level'), position(11, 50, 'ground_level')];
    expect(run(id, [plan(), circle], { aircraft: inside })).toMatchObject({ outcome: 'pass' });
    const outside = [position(10, 50, 'ground_level', 39.8), position(11, 50, 'ground_level', 39.8)];
    const away = run(id, [plan(), circle], { aircraft: outside });
    expect(away).toMatchObject({ outcome: 'attention', reasonCode: 'excursion' });
    expect(away.summary).toMatch(/outside every operating area in force \(operating area RIDGE-AREA-1\)/);
    expect(run(id, [plan(), circle], {})).toMatchObject({ outcome: 'not_applicable' });
    // No adoption value sets the area any more: the rule reads the organization's records.
    expect(leaf(id).adoptionParameters).toEqual([]);
    expect(run(id, [plan()], { aircraft: inside })).toMatchObject({ reasonCode: 'record_not_on_file' });
  });
});
