import { describe, expect, it } from 'vitest';
import { isCheckedRuleLeaf, type CheckedRuleLeaf } from '@ledger/contracts';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion } from '../../domain/src/rule-pack-registry.js';
import { PART108_NPRM_PACK_ID } from '../src/index.js';
import { flightRecordCheckedEntries } from '../src/part108-nprm-v3.js';

// The items of the record of each flight, each from an invented flight of a fictional survey operator.

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-20T12:00:00.000Z' };
const pack = getRulePackVersion(PART108_NPRM_PACK_ID, 3)!;

function leaf(id: string): CheckedRuleLeaf {
  const found = pack.leaves.find((item) => item.id === id);
  if (!found || !isCheckedRuleLeaf(found)) throw new Error(`No checked rule ${id}`);
  return found;
}

let sequence = 0;
function record(
  recordType: string,
  body: Record<string, unknown>,
  start = '2026-10-19T08:00:00.000Z',
): CheckObservation {
  const values = { recordType, recordVersion: 1, record: body };
  return {
    id: `${recordType}-${++sequence}`,
    type: 'operator.record',
    version: 1,
    occurredAt: start,
    observation: { occurredAt: start, values },
  };
}

function flightReport(values: Record<string, unknown>, at: string): CheckObservation {
  return {
    id: `report-${++sequence}`,
    type: 'flight.report',
    version: 1,
    occurredAt: at,
    observation: { occurredAt: at, values },
  };
}

const flightRecord = (body: Record<string, unknown> = {}) =>
  record('flight.record', {
    takeoffAt: '2026-10-19T09:00:00Z',
    landingAt: '2026-10-19T09:42:00Z',
    takeoffLocation: 'Ridge road pullout',
    landingLocations: 'Ridge road pullout',
    maxHeightFlownAboveGroundMeters: 72,
    ...body,
  });

/** Gathers each read as the engine does: reads about the target from the target's, about a relation from its own. */
function run(id: string, target: CheckObservation[], related: Record<string, CheckObservation[]> = {}) {
  const rule = leaf(id);
  const inputs: Record<string, CheckObservation[]> = {};
  for (const read of rule.reads) {
    const about = typeof read.about === 'object' && 'related' in read.about ? related[read.about.related] : target;
    inputs[read.name] = narrowRead(
      read,
      (about ?? []).filter((item) => item.type === read.type),
      inputs,
    );
  }
  return runCheckedRule(rule, rule.check.params, inputs, clock);
}

describe('Part 108 NPRM version 3: the record of each flight, item by item', () => {
  it('quotes items (i), (ii), (iii), (v) and (vi), one rule each, beside item (iv)', () => {
    expect(flightRecordCheckedEntries.map(({ id }) => id)).toEqual([
      'ledger.nprm.108.40.a.3.i',
      'ledger.nprm.108.40.a.3.ii',
      'ledger.nprm.108.40.a.3.iii',
      'ledger.nprm.108.40.a.3.v',
      'ledger.nprm.108.40.a.3.vi',
    ]);
    for (const { id } of flightRecordCheckedEntries) {
      const rule = leaf(id);
      expect(rule.population, id).toEqual({ of: 'in_adoption_dates' });
      const item = id.split('.').at(-1)!;
      expect(rule.source.text.trimStart().startsWith(`(${item}) `), id).toBe(true);
    }
    expect(pack.leaves.some((item) => item.id === 'ledger.nprm.108.40.a.3.iv')).toBe(true);
  });

  it('(i): reads the reported times, else the flight record’s, and says which', () => {
    const id = 'ledger.nprm.108.40.a.3.i';
    const logged = run(id, [flightRecord()]);
    expect(logged).toMatchObject({ evidenceState: 'supported', outcome: 'pass', details: { basis: 'fallback' } });
    expect(logged.summary).toBe(
      'On file for this flight, from the operator’s flight record: takeoff 2026-10-19T09:00:00Z, landing 2026-10-19T09:42:00Z, a duration of 42 minutes. Whether the times are right, and the date in the operator’s own time zone, are for a person to review.',
    );
    const reported = run(id, [
      flightRecord(),
      flightReport(
        { activity: 'landed', takeoffAt: '2026-10-19T09:00:00Z', landingAt: '2026-10-19T09:41:00Z' },
        '2026-10-19T09:41:00Z',
      ),
    ]);
    expect(reported.details).toMatchObject({ basis: 'primary', differing: 1, durationMinutes: 41 });
    expect(reported.summary).toMatch(
      /The landing in the operator’s flight record is 2026-10-19T09:42:00Z, which differs; the one in the flight’s reports is read\./,
    );
    expect(run(id, [])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No takeoff or landing on file for this flight in the flight’s reports or the operator’s flight record.',
    });
  });

  it('(ii): reads the registration of the aircraft the flight record names', () => {
    const id = 'ledger.nprm.108.40.a.3.ii';
    const identity = record('aircraft.identity', {
      aircraftMakeModel: 'Example Quad 4',
      serialNumber: 'SN-0001',
      registrationNumber: 'FA-EXAMPLE-01',
    });
    const passed = run(id, [flightRecord()], { aircraft: [identity] });
    expect(passed).toMatchObject({ outcome: 'pass', evidence: [identity.id] });
    expect(passed.summary).toMatch(
      /^On file for this flight, from the identity record of the aircraft its flight record names: registration number FA-EXAMPLE-01\./,
    );
    expect(run(id, [flightRecord()], { aircraft: [] })).toMatchObject({
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary:
        'No registration number on file for this flight in the identity record of the aircraft its flight record names.',
    });
    expect(run(id, [], { aircraft: [identity] })).toMatchObject({
      reasonCode: 'record_not_on_file',
      summary: 'No flight record on file.',
    });
  });

  it('(iii) and (v): the plan’s type of operation and the people assigned, for a flight with a flight record', () => {
    const plan = record('flight.plan', { operationKind: 'inspection', windowStartsAt: '2026-10-19T08:30:00Z' });
    const assignments = [
      record('operation.role-assignment', { personId: { id: 'EX-P-1', scope: 'source' }, role: 'pilot_in_command' }),
      record('operation.role-assignment', { personId: { id: 'EX-P-2', scope: 'source' }, role: 'visual_observer' }),
    ];
    const kind = run('ledger.nprm.108.40.a.3.iii', [flightRecord(), plan]);
    expect(kind).toMatchObject({ outcome: 'pass' });
    expect(kind.summary).toMatch(/^On file for this flight, from its flight plan: type of operation Inspection\./);
    const people = run('ledger.nprm.108.40.a.3.v', [flightRecord(), ...assignments]);
    expect(people).toMatchObject({ outcome: 'pass', details: { valuesOnFile: 2 } });
    expect(people.summary).toMatch(
      /^On file for this flight, from its role assignments: EX-P-\d, (Pilot in command|Visual observer); EX-P-\d/,
    );
    // A planned flight with no record of having been flown has no item of the record of the flight on file.
    for (const id of ['ledger.nprm.108.40.a.3.iii', 'ledger.nprm.108.40.a.3.v'])
      expect(run(id, [plan, ...assignments]), id).toMatchObject({
        outcome: 'pending',
        reasonCode: 'record_not_on_file',
        summary: 'No flight record on file.',
      });
  });

  it('(vi): the landing places in the flight record', () => {
    const id = 'ledger.nprm.108.40.a.3.vi';
    expect(run(id, [flightRecord()]).summary).toMatch(
      /^On file for this flight, from the operator’s flight record: landing places Ridge road pullout\./,
    );
    expect(run(id, [flightRecord({ landingLocations: undefined })])).toMatchObject({
      outcome: 'pending',
      reasonCode: 'record_not_on_file',
      summary: 'No landing places on file for this flight in the operator’s flight record.',
    });
    expect(run(id, [])).toMatchObject({ reasonCode: 'record_not_on_file', summary: 'No flight record on file.' });
  });
});
