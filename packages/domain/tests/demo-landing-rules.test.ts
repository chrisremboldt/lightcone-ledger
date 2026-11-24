import { describe, expect, it } from 'vitest';
import type { CheckObservation } from '../src/check-kinds.js';
import { checkedRuleProblem, runCheckedRule } from '../src/checked-rules.js';
import { getRulePackVersion } from '../src/rule-pack-registry.js';
import '../src/rules/demo-procedures-pack.js';
import { landingDisagreementLeafV2, missingLandingEvidenceLeafV2 } from '../src/rules/demo-landing-v2.js';

// The cases of the former built-in flight evaluator, run through the generic engine on the checked landing rules.

function report(id: string, values: Record<string, unknown>): CheckObservation {
  const occurredAt = '2026-10-15T14:20:00.000Z';
  return {
    id,
    type: 'flight.report',
    version: 1,
    occurredAt,
    observation: { type: 'flight.report', version: 1, occurredAt, values },
  };
}

function state(status: string, scheduledEnd?: string): CheckObservation {
  const occurredAt = '2026-10-15T14:24:59.999Z';
  return {
    id: `state-${status}`,
    type: 'flight.state',
    version: 1,
    occurredAt,
    observation: { status, ...(scheduledEnd ? { scheduledEnd } : {}) },
  };
}

const scheduled = state('active', '2026-10-15T14:20:00.000Z');
const clock = (evaluatedAt = '2026-10-15T14:24:59.999Z') => ({ mode: 'wall' as const, evaluatedAt });

function disagreement(reports: CheckObservation[], flight = scheduled, at?: string) {
  return runCheckedRule(
    landingDisagreementLeafV2,
    landingDisagreementLeafV2.check.params,
    { reports, state: [flight] },
    clock(at),
  );
}

function overdue(evidence: CheckObservation[], flight = scheduled, at?: string) {
  return runCheckedRule(
    missingLandingEvidenceLeafV2,
    missingLandingEvidenceLeafV2.check.params,
    { evidence, state: [flight] },
    clock(at),
  );
}

describe('demo landing rules on the generic evaluator', () => {
  it('are checked rules of pack version 4, while versions 1 to 3 keep their built-in leaves', () => {
    for (const leaf of [landingDisagreementLeafV2, missingLandingEvidenceLeafV2])
      expect(checkedRuleProblem(leaf)).toBeUndefined();
    const four = getRulePackVersion('ledger.demo-procedures', 4)!;
    expect(four.leaves.map((leaf) => leaf.digest)).toEqual(
      expect.arrayContaining([landingDisagreementLeafV2.digest, missingLandingEvidenceLeafV2.digest]),
    );
    expect(four.bindings.map((binding) => binding.id)).not.toContain('ledger.flight-observation');
    for (const version of [1, 2, 3])
      expect(getRulePackVersion('ledger.demo-procedures', version)!.leaves.every((leaf) => 'bindingId' in leaf)).toBe(
        true,
      );
  });

  it('records distinct valid landing times as conflicting with the reports that state them', () => {
    const first = report('landing-a', { activity: 'landed', landingAt: '2026-10-15T14:20:00Z' });
    const second = report('landing-b', { activity: 'landed', landingAt: '2026-10-15T14:22:00Z' });
    const result = disagreement([second, first], state('landed', '2026-10-15T14:20:00.000Z'));
    expect(result).toMatchObject({
      applicability: 'applicable',
      evidenceState: 'conflicting',
      outcome: 'attention',
      summary: '2 distinct landing times are reported. Review the retained observations.',
      details: { valueCount: 2, reportCount: 2 },
    });
    expect([...result.evidence].sort()).toEqual(['landing-a', 'landing-b']);
    expect(overdue([second, first])).toMatchObject({ evidenceState: 'supported', outcome: 'pass' });
  });

  it('compares equivalent UTC instants as one landing time', () => {
    const result = disagreement([
      report('landing-a', { landingAt: '2026-10-15T14:20:00Z' }),
      report('landing-correction', { landingAt: '2026-10-15T14:20:00.000Z' }),
    ]);
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
      summary: 'The valid recorded landing times do not disagree.',
      details: { values: '2026-10-15T14:20:00.000Z', valueCount: 1 },
    });
  });

  it('awaits landing evidence until five minutes after the scheduled end and then needs attention', () => {
    const pending = overdue([]);
    expect(pending).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'pending',
      nextBoundary: '2026-10-15T14:25:00.000Z',
      details: { dueAt: '2026-10-15T14:25:00.000Z', graceSeconds: 300 },
      summary: 'Landing evidence is awaited until 2026-10-15T14:25:00.000Z, five minutes after the scheduled end.',
    });
    const late = overdue([], scheduled, '2026-10-15T14:25:00.000Z');
    expect(late).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
      summary: 'No valid UTC landing time is recorded after the five-minute grace period.',
    });
    expect(late.nextBoundary).toBeUndefined();
    const landed = overdue(
      [report('late-log', { landingAt: '2026-10-15T14:19:00.000Z' })],
      scheduled,
      '2026-10-15T14:25:00.000Z',
    );
    expect(landed).toMatchObject({ evidenceState: 'supported', outcome: 'pass', evidence: ['late-log'] });
    expect(landed.nextBoundary).toBeUndefined();
  });

  it('stays insufficient without a landing time and does not fabricate an absent schedule', () => {
    const activityOnly = report('activity-only', { activity: 'landed' });
    expect(disagreement([activityOnly])).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending' });
    expect(overdue([activityOnly], scheduled, '2026-10-15T14:26:00Z')).toMatchObject({
      evidenceState: 'insufficient',
      outcome: 'attention',
    });
    const unscheduled = overdue([], state('active'));
    expect(unscheduled).toMatchObject({ evidenceState: 'insufficient', outcome: 'pending' });
    expect(unscheduled.nextBoundary).toBeUndefined();
    expect(() => overdue([], scheduled, 'invalid-clock')).toThrow(TypeError);
  });

  it('does not apply to a cancelled flight', () => {
    const reports = [
      report('landing-a', { landingAt: '2026-10-15T14:20:00Z' }),
      report('landing-b', { landingAt: '2026-10-15T14:22:00Z' }),
    ];
    const cancelled = state('cancelled', '2026-10-15T14:20:00.000Z');
    for (const result of [
      disagreement(reports, cancelled, '2026-10-15T15:00:00Z'),
      overdue([], cancelled, '2026-10-15T15:00:00Z'),
    ]) {
      expect(result).toMatchObject({
        applicability: 'not_applicable',
        evidenceState: 'not_applicable',
        outcome: 'not_applicable',
      });
      expect(result.nextBoundary).toBeUndefined();
    }
  });
});
