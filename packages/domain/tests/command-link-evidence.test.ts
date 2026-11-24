import { describe, expect, it } from 'vitest';
import {
  COMMAND_LINK_LOSS_LEAF_ID,
  commandLinkEvidenceLeafV1,
  commandLinkStatusBindingV1,
  evaluateCommandLinkEvidence,
  type CommandLinkEvidenceReport,
} from '../src/rules/command-link-evidence-v1.js';

const flightId = 'fictional-flight';
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T11:00:00.000Z' };
function report(eventId: string, fields: Partial<CommandLinkEvidenceReport> = {}): CommandLinkEvidenceReport {
  return {
    flightId,
    eventId,
    receiptId: `receipt:${eventId}`,
    sourceId: 'command-link',
    sourceSessionId: 'session-one',
    sourceEventId: `source:${eventId}`,
    incidentId: 'incident-one',
    aircraftId: 'aircraft-one',
    occurredAt: '2026-10-15T10:00:00Z',
    status: 'lost',
    ...fields,
  };
}
const evaluate = (reports: CommandLinkEvidenceReport[]) => evaluateCommandLinkEvidence({ flightId, reports, clock });

describe('draft reported command-link loss procedure', () => {
  it('keeps absent and restoration-only evidence pending rather than claiming healthy flight coverage', () => {
    for (const reports of [[], [report('restoration-only', { status: 'restored' })]]) {
      expect(evaluate(reports)).toMatchObject({
        flightId,
        leafId: COMMAND_LINK_LOSS_LEAF_ID,
        leafVersion: 1,
        bindingId: commandLinkStatusBindingV1.id,
        bindingVersion: 1,
        evidenceState: 'insufficient',
        outcome: 'pending',
        explanation: { kind: 'command_link', code: 'command_link_reports_unavailable' },
      });
    }
    expect(commandLinkEvidenceLeafV1).toMatchObject({
      review: 'ai_drafted',
      adopted: false,
      source: { kind: 'operator_procedure', reference: 'ledger.demo-procedures.3' },
    });
    expect(() =>
      evaluateCommandLinkEvidence({ flightId, reports: [], clock: { ...clock, evaluatedAt: 'invalid' } }),
    ).toThrow('explicit valid UTC wall clock');
  });

  it('requires a restoration in the exact flight, source, session, incident and aircraft scope', () => {
    const loss = report('loss');
    const restoration = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    const unrelated = [
      { ...restoration, eventId: 'other-flight', flightId: 'other-flight', occurredAt: 'invalid' },
      { ...restoration, eventId: 'other-source', sourceId: 'other-source' },
      { ...restoration, eventId: 'other-session', sourceSessionId: 'other-session' },
      { ...restoration, eventId: 'other-incident', incidentId: 'other-incident' },
      { ...restoration, eventId: 'other-aircraft', aircraftId: 'other-aircraft' },
    ];
    const missing = evaluate([loss, ...unrelated]);
    expect(missing).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    expect(missing.explanation.groups.find((group) => group.lossEventIds.includes('loss'))?.state).toBe('unresolved');
    expect(missing.explanation.evidence.some((item) => item.flightId === 'other-flight')).toBe(false);
    const restored = evaluate([restoration, ...unrelated, loss]);
    expect(restored).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
    expect(restored.explanation.groups.find((group) => group.lossEventIds.includes('loss'))).toMatchObject({
      state: 'restored',
      lossEventIds: ['loss'],
      restorationEventIds: ['restoration'],
    });
    expect(restored).toEqual(evaluate([loss, ...unrelated].reverse().concat(restoration)));
  });

  it('retains delayed historical losses and requires restoration after every known loss scope', () => {
    const loss = report('late-loss');
    const restoration = report('already-restored', { status: 'restored', occurredAt: '2026-10-15T10:02:00Z' });
    const restored = evaluate([restoration, loss]);
    expect(restored).toMatchObject({
      outcome: 'pass',
      explanation: { code: 'command_link_losses_restored', evaluatedAt: clock.evaluatedAt },
    });
    expect(restored.explanation.evidence).toContainEqual(loss);
    const secondLoss = report('another-incident', { incidentId: 'incident-two', occurredAt: '2026-10-15T10:03:00Z' });
    expect(evaluate([restoration, loss, secondLoss])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
    });
    expect(
      evaluate([
        restoration,
        loss,
        secondLoss,
        report('second-restoration', {
          incidentId: 'incident-two',
          status: 'restored',
          occurredAt: '2026-10-15T10:04:00Z',
        }),
      ]),
    ).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
  });

  it('keeps simultaneous statuses conflicting until a strictly later restoration clarifies them', () => {
    const loss = report('loss');
    const tied = report('tied-restoration', { status: 'restored', occurredAt: '2026-10-15T10:00:00.000Z' });
    expect(evaluate([tied, loss])).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      explanation: { code: 'command_link_reports_conflicting', groups: [{ state: 'conflicting' }] },
    });
    const later = report('later-restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    expect(evaluate([tied, loss, later])).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
    expect(evaluate([later, tied, loss, report('new-loss', { occurredAt: '2026-10-15T10:02:00Z' })])).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
    });
  });

  it('does not skip future or unorderable scoped evidence to return an older restored result', () => {
    const loss = report('loss');
    const restored = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    for (const occurredAt of ['2026-10-15T11:01:00Z', '2026-02-30T10:00:00Z']) {
      const uncertain = report('uncertain-restoration', { status: 'restored', occurredAt });
      expect(evaluate([loss, restored, uncertain])).toMatchObject({
        evidenceState: 'insufficient',
        outcome: 'attention',
        explanation: { code: 'command_link_reports_invalid', groups: [{ state: 'insufficient' }] },
      });
      expect(evaluate([loss, restored, uncertain]).explanation.evidence).toContainEqual(uncertain);
    }
  });
});
