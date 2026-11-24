import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type TranslationContext,
  type VendorMessage,
  InMemoryObservationSink,
  translateAndSubmit,
} from '../src/adapter-contract.js';
import { assertAdapterConformance } from '../src/conformance.js';
import { crewRosterDutyAdapter, translateCrewRosterDuty } from '../src/crew-roster-duty.js';

const context: TranslationContext = { subjects: { scope: 'source' }, binding: undefined };
const sample = join(import.meta.dirname, '../../contracts/fixtures/crew-roster/alpha-crew-roster.json');

function message(bytes: Uint8Array): VendorMessage {
  return {
    bytes,
    contentType: 'application/json',
    transport: { path: '/imports/roster' },
    capturedAt: '2026-10-19T08:00:00.000Z',
  };
}

describe('crew roster export adapter', () => {
  it('passes the conformance kit against its golden files', async () => {
    const report = await assertAdapterConformance({
      adapter: crewRosterDutyAdapter,
      context,
      goldenDirectory: join(import.meta.dirname, '../src/golden/crew-roster-duty'),
    });
    expect(report.checked).toMatchObject({ goldens: 9, observations: 5 });
  });

  it('reads the sample fortnight for three people: one period per entry, each citing its entry', () => {
    const { drafts, rejections, unmapped } = translateCrewRosterDuty(message(readFileSync(sample)), context);
    expect(rejections).toEqual([]);
    expect(unmapped).toEqual([]);
    expect(drafts).toHaveLength(63);
    const byPerson = Map.groupBy(drafts, (draft) => (draft as { subject: { id: string } }).subject.id);
    expect([...byPerson.keys()].sort()).toEqual(['ALPHA-OBSERVER-01', 'ALPHA-PILOT-01', 'ALPHA-PILOT-02']);
    for (const periods of byPerson.values()) {
      const kinds = periods.map((draft) => (draft as { values: { period: string } }).values.period);
      expect(kinds.filter((kind) => kind === 'duty')).toHaveLength(10);
      expect(kinds.filter((kind) => kind === 'rest')).toHaveLength(11);
    }
    expect(drafts[0]).toMatchObject({
      sourceEventId: 'R-0001@1',
      originalLocator: { kind: 'json_pointer', value: '/entries/0' },
    });
    // The over-long duty period and the short rest the sample is built around.
    const longest = drafts.find((draft) => (draft as { sourceEventId: string }).sourceEventId === 'R-0059@1');
    expect(longest).toMatchObject({
      subject: { id: 'ALPHA-PILOT-02' },
      interval: { start: '2026-10-16T06:00:00Z', end: '2026-10-16T18:30:00Z' },
      values: { period: 'duty', role: 'remote_pilot' },
    });
  });

  it('retains the export once and submits every period citing it, idempotently', async () => {
    const sink = new InMemoryObservationSink();
    const exported = message(readFileSync(sample));
    const first = await translateAndSubmit(crewRosterDutyAdapter, exported, context, sink);
    await translateAndSubmit(crewRosterDutyAdapter, exported, context, sink);
    expect(sink.originals.size).toBe(1);
    expect(sink.observations).toHaveLength(63);
    expect(first.submitted.every(({ observation }) => observation.originalArtifactId === first.artifactId)).toBe(true);
    expect(first.submitted[0]!.observation).toMatchObject({ fidelity: 'synthetic_contract' });
  });

  it('names people by their Ledger ids when bound, and refuses an employee it has no id for', () => {
    const bound: TranslationContext = {
      subjects: { scope: 'ledger', ids: { person: { 'ALPHA-PILOT-01': 'person-1' } } },
      binding: undefined,
    };
    const exported = new TextEncoder().encode(
      JSON.stringify({
        format: 'crew-roster-export',
        formatVersion: 1,
        entries: [
          { entryId: 'A', employeeId: 'ALPHA-PILOT-01', kind: 'REST', start: '2026-10-16T00:00:00Z' },
          { entryId: 'B', employeeId: 'ALPHA-PILOT-09', kind: 'REST', start: '2026-10-16T00:00:00Z' },
        ],
      }),
    );
    const { drafts, rejections } = translateCrewRosterDuty(message(exported), bound);
    expect(drafts).toMatchObject([{ subject: { kind: 'person', id: 'person-1', scope: 'ledger' }, interval: {} }]);
    expect((drafts[0] as { interval: object }).interval).toEqual({ start: '2026-10-16T00:00:00Z' });
    expect(rejections).toEqual([
      { reason: 'No Ledger person is bound to this employee', locator: { kind: 'json_pointer', value: '/entries/1' } },
    ]);
  });
});
