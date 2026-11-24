import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import { depthCheckedEntries, depthUncheckedEntries } from '../src/part108-nprm-v3.js';

// The paragraphs version 3 now reads that the walk found missing, and the rules that say what is not on file where a
// population would be empty.

const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;
const adoption = { start: '2026-08-01T06:00:00.000Z', end: '2027-08-01T06:00:00.000Z' };
const now = '2026-11-20T12:00:00.000Z';

function leaf(id: string): CheckedRuleLeaf {
  const found = pack.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
function record(recordType: string, body: Record<string, unknown>, at: string, end?: string | null): CheckObservation {
  const interval = end === undefined ? undefined : { start: at, ...(end ? { end } : {}) };
  const values = { recordType, recordVersion: 1, record: body };
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt: at,
    ...(interval ? { interval } : {}),
    observation: { occurredAt: at, ...(interval ? { interval } : {}), values },
  };
}

function newestFirst(a: CheckObservation, b: CheckObservation) {
  const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
  return start(b) - start(a) || (a.id < b.id ? 1 : -1);
}

/** Gathers each read as the engine does: about the organization, a related subject, or the target. */
function run(
  id: string,
  target: CheckObservation[],
  {
    related = {},
    organization = [],
    parameters = {},
  }: {
    related?: Record<string, CheckObservation[]>;
    organization?: CheckObservation[];
    parameters?: Record<string, unknown>;
  } = {},
) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads) {
    const about =
      read.about === 'organization'
        ? organization
        : typeof read.about === 'object' && 'related' in read.about
          ? (related[read.about.related] ?? [])
          : target;
    inputs[read.name] = narrowRead(read, about.filter((item) => item.type === read.type).sort(newestFirst), inputs);
  }
  return runCheckedRule(rule, { ...rule.check.params, ...parameters }, inputs, {
    mode: 'wall',
    evaluatedAt: now,
    adoption,
  });
}

const window = { start: '2026-11-12T16:00:00.000Z', end: '2026-11-12T17:30:00.000Z' };
const plan = () =>
  record(
    'flight.plan',
    {
      windowStartsAt: window.start,
      windowEndsAt: window.end,
      operationKind: 'inspection',
      plannedOriginDescription: 'Ridge road pullout',
      plannedDestinationDescription: 'Ridge road pullout',
      routeSummary: 'Transmission line segment 15',
    },
    window.start,
    window.end,
  );

describe('Part 108 version 3: the paragraphs the walk found missing', () => {
  it('quotes each paragraph, says what it shows and what is left to a person, and words nothing as a verdict', () => {
    for (const entry of depthCheckedEntries) {
      const rule = leaf(entry.id);
      expect(rule.source.reference, entry.id).toBe(entry.paragraph.reference);
      expect(entry.answers, entry.id).toMatch(/^Per (organization|flight|aircraft)/);
      expect(rule.wording?.pass, entry.id).toMatch(/for a person to (review|confirm)/);
      expect(JSON.stringify([rule.title, rule.wording]), entry.id).not.toMatch(
        /\b(compliant|compliance|authori[sz]ed|go|no-go)\b/i,
      );
    }
    for (const entry of depthUncheckedEntries)
      expect(pack.leaves.find((item) => item.id === entry.id)).toMatchObject({ coverage: 'manual' });
  });

  it('§ 108.310(f): each assigned coordinator’s recent hours as flight coordinator in the planned make and model', () => {
    const id = 'ledger.nprm.108.310.f';
    const assignment = record(
      'operation.role-assignment',
      { personId: { id: 'RIDGE-P-02', scope: 'source' }, role: 'flight_coordinator', startsAt: window.start },
      window.start,
      window.end,
    );
    const aircraft = [record('aircraft.identity', { aircraftMakeModel: 'Fictional Survey Quad X8' }, adoption.start)];
    const experience = (role: string, recentHours: number) =>
      record(
        'person.aircraft-experience',
        { role, aircraftMakeModel: 'fictional survey quad x8', supervisedHours: 12, recentHours },
        '2026-11-01T00:00:00.000Z',
      );
    const related = (coordinator: CheckObservation[]) => ({ aircraft, coordinator });
    const passed = run(id, [plan(), assignment], { related: related([experience('flight_coordinator', 6)]) });
    expect(passed).toMatchObject({ outcome: 'pass' });
    expect(passed.summary).toContain('holds 6 hours in its recent period, at least 5');
    expect(run(id, [plan(), assignment], { related: related([experience('flight_coordinator', 4)]) })).toMatchObject({
      outcome: 'attention',
    });
    // Hours in another role do not count as a coordinator's recency.
    expect(run(id, [plan(), assignment], { related: related([experience('pilot_in_command', 9)]) })).not.toMatchObject({
      outcome: 'pass',
    });
  });

  it('§ 108.305(b): each new operations supervisor notified to the authority within 10 days', () => {
    const id = 'ledger.nprm.108.305.b';
    const supervisor = (startsAt: string, authorityNotifiedAt?: string) =>
      record(
        'operation.role-assignment',
        {
          personId: { id: 'RIDGE-P-05', scope: 'source' },
          role: 'operations_supervisor',
          startsAt,
          ...(authorityNotifiedAt ? { authorityNotifiedAt } : {}),
        },
        startsAt,
        null,
      );
    const zone = { timeZone: 'America/Denver' };
    expect(run(id, [supervisor('2026-10-01T15:00:00Z', '2026-10-08T15:00:00Z')], { parameters: zone })).toMatchObject({
      outcome: 'pass',
    });
    expect(run(id, [supervisor('2026-10-01T15:00:00Z', '2026-10-20T15:00:00Z')], { parameters: zone })).toMatchObject({
      outcome: 'attention',
    });
    expect(run(id, [supervisor('2026-10-01T15:00:00Z')], { parameters: zone })).toMatchObject({
      outcome: 'attention',
    });
    // A supervisor assigned before the adoption's dates is not counted as a change under it.
    expect(run(id, [supervisor('2026-05-01T15:00:00Z')], { parameters: zone })).toMatchObject({
      outcome: 'not_applicable',
    });
  });

  it('§ 108.150(c) and § 108.620(a): a physical security procedure and a battery monitoring program on file', () => {
    for (const [id, procedureKind, words] of [
      ['ledger.nprm.108.150.c', 'physical_security', 'physical security policies and processes'],
      ['ledger.nprm.108.620.a', 'battery_monitoring', 'battery monitoring program'],
    ] as const) {
      const procedure = record(
        'organization.procedure',
        {
          procedureKind,
          title: 'Fictional procedure',
          documentReference: 'OPS-MAN 9',
          revision: '1',
          effectiveAt: '2026-06-01T06:00:00Z',
        },
        '2026-06-01T06:00:00.000Z',
      );
      expect(run(id, [procedure]), id).toMatchObject({ outcome: 'pass' });
      const missing = run(id, []);
      expect(missing, id).toMatchObject({ reasonCode: 'record_not_on_file' });
      expect(missing.summary, id).toBe(`No ${words} on file.`);
    }
  });

  it('§ 108.335(b): says when no one is in a role that needs a security threat assessment', () => {
    const id = 'ledger.nprm.108.335.b';
    const role = (roleName: string) =>
      record(
        'operation.role-assignment',
        { personId: { id: 'RIDGE-P-05', scope: 'source' }, role: roleName, startsAt: '2026-06-01T06:00:00Z' },
        '2026-06-01T06:00:00.000Z',
        null,
      );
    expect(run(id, [role('operations_supervisor')])).toMatchObject({ outcome: 'pass' });
    const none = run(id, [role('pilot_in_command')]);
    expect(none.outcome).not.toBe('pass');
    const empty = run(id, []);
    expect(empty).toMatchObject({ reasonCode: 'record_not_on_file' });
    expect(empty.summary).toBe('No operations supervisor or flight coordinator role assignment on file.');
  });

  it('§ 108.555(a): inoperative detect-and-avoid equipment needs a recorded hazard determination before the flight', () => {
    const id = 'ledger.nprm.108.555.a';
    const equipment = (equipmentState: string, determination = false, at = '2026-11-12T15:10:00.000Z') =>
      record(
        'aircraft.detect-and-avoid',
        {
          checkedAt: at.replace('.000Z', 'Z'),
          equipmentReference: 'Fictional DAA receiver unit 2',
          equipmentState,
          ...(determination
            ? { hazardDeterminedByName: 'Sam Example', hazardDeterminedAt: '2026-11-12T15:30:00Z' }
            : {}),
        },
        at,
      );
    const flight = (records: CheckObservation[]) => run(id, [plan()], { related: { aircraft: records } });
    expect(flight([equipment('inoperative')])).toMatchObject({ outcome: 'attention' });
    expect(flight([equipment('inoperative', true)])).toMatchObject({ outcome: 'pass' });
    expect(flight([equipment('serviceable')])).toMatchObject({ outcome: 'not_applicable' });
    // A later check after the flight's planned start is not read for it.
    expect(
      flight([equipment('serviceable'), equipment('inoperative', false, '2026-11-12T18:00:00.000Z')]),
    ).toMatchObject({
      outcome: 'not_applicable',
    });
    expect(run(id, [])).toMatchObject({ reasonCode: 'record_not_on_file' });
  });

  it('§ 108.630(a), per flight: a flight after maintenance with no return to service recorded needs attention', () => {
    const id = 'ledger.nprm.108.630.a.flight';
    const maintenance = (performedAt: string, returned?: boolean) =>
      record(
        'maintenance.action',
        {
          actionDescription: 'Replaced rear left motor after vibration warning',
          performedAt: performedAt.replace('.000Z', 'Z'),
          performedByName: 'Sam Example',
          ...(returned === undefined ? {} : { returnedToService: returned }),
        },
        performedAt,
      );
    const flight = (records: CheckObservation[]) => run(id, [plan()], { related: { aircraft: records } });
    const waiting = flight([maintenance('2026-11-05T17:00:00.000Z')]);
    expect(waiting).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    expect(waiting.summary).toContain('is not recorded as returned to service, and the flight is planned after it');
    expect(flight([maintenance('2026-11-05T17:00:00.000Z', false)])).toMatchObject({ outcome: 'attention' });
    expect(flight([maintenance('2026-11-05T17:00:00.000Z', true)])).toMatchObject({ outcome: 'pass' });
    // Maintenance after the flight is not read for it; with none before, the rule does not apply.
    expect(flight([maintenance('2026-11-20T09:00:00.000Z')])).toMatchObject({ outcome: 'not_applicable' });
  });

  it('§ 108.45(d)(2): each failure of an approved data service recorded as reported to its provider', () => {
    const id = 'ledger.nprm.108.45.d.2';
    const failure = (dataServiceFailure: string, reportedToServiceProviderAt?: string) =>
      record(
        'occurrence.mechanical-irregularity',
        {
          occurredAt: '2026-11-12T16:42:00Z',
          irregularityDescription: 'Strategic deconfliction service returned no intent for 4 minutes',
          correctiveAction: 'Held at the pullout until the service recovered',
          dataServiceFailure,
          ...(reportedToServiceProviderAt ? { reportedToServiceProviderAt } : {}),
        },
        '2026-11-12T16:42:00.000Z',
      );
    expect(run(id, [failure('yes', '2026-11-13T09:00:00Z')])).toMatchObject({ outcome: 'pass' });
    expect(run(id, [failure('yes')])).toMatchObject({ outcome: 'attention' });
    expect(run(id, [failure('no')])).toMatchObject({ outcome: 'not_applicable' });
  });
});
