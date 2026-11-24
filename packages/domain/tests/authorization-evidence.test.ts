import { describe, expect, it } from 'vitest';
import {
  authorizationEvidenceLeafV1,
  authorizationStatusBindingV1,
  evaluateAuthorizationEvidence,
  type AuthorizationStatusClaim,
} from '../src/rules/authorization-evidence-v1.js';

const scope = { sourceId: 'airspace-one', authorizationId: 'authorization-one' };
const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T11:00:00.000Z' };

function report(overrides: Partial<AuthorizationStatusClaim> = {}): AuthorizationStatusClaim {
  return {
    ...scope,
    eventId: 'approval',
    receiptId: 'receipt-approval',
    occurredAt: '2026-10-15T09:00:00.000Z',
    status: 'STATUS_APPROVED',
    reportedInterval: { start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T12:00:00.000Z' },
    ...overrides,
  };
}

function evaluate(claims: AuthorizationStatusClaim[], evaluatedAt = clock.evaluatedAt) {
  return evaluateAuthorizationEvidence({ scope, claims, clock: { ...clock, evaluatedAt } });
}

describe('draft authorization evidence procedure', () => {
  it('supports only the selected source and authorization, coalescing equivalent report instants', () => {
    const approval = report();
    const duplicate = report({
      eventId: 'poll-duplicate',
      receiptId: 'receipt-poll',
      occurredAt: '2026-10-15T09:00:00Z',
      reportedInterval: { start: '2026-10-15T10:00:00Z', end: '2026-10-15T12:00:00Z' },
    });
    const result = evaluate([
      report({ sourceId: 'other-source', status: 'STATUS_DENIED', occurredAt: 'invalid' }),
      report({ authorizationId: 'other-authorization', status: 'STATUS_RESCINDED' }),
      duplicate,
      approval,
    ]);
    expect(result).toMatchObject({
      leafId: authorizationEvidenceLeafV1.id,
      leafVersion: 1,
      bindingId: authorizationStatusBindingV1.id,
      bindingVersion: 1,
      scope,
      applicability: 'applicable',
      evidenceState: 'supported',
      outcome: 'pass',
      explanation: { code: 'approval_recorded', evaluatedAt: clock.evaluatedAt },
    });
    expect(result.explanation.evidence).toEqual([approval, duplicate]);
    expect(authorizationEvidenceLeafV1).toMatchObject({
      review: 'ai_drafted',
      adopted: false,
      source: { kind: 'operator_procedure', reference: 'ledger.demo-procedures.2' },
    });
    expect(authorizationStatusBindingV1.callbackDurationUnit).toBe('minute');
  });

  it('uses occurrence time within the scope, keeping later rescission distinct from conflicting reports', () => {
    const approval = report();
    const rescission = report({
      eventId: 'rescission',
      occurredAt: '2026-10-15T10:30:00Z',
      status: 'STATUS_RESCINDED',
    });
    const future = report({ eventId: 'future-approval', occurredAt: '2026-10-15T11:01:00Z' });
    const result = evaluate([rescission, future, approval]);
    expect(result).toMatchObject({
      evidenceState: 'supported',
      outcome: 'attention',
      explanation: { code: 'nonapproval_recorded' },
    });
    expect(result.explanation.evidence).toEqual([rescission]);
    expect(evaluate([approval, rescission, future])).toEqual(result);
  });

  it('respects half-open intervals without reviving an older approval after a later interval revision', () => {
    const older = report();
    const latest = report({
      eventId: 'revised-window',
      occurredAt: '2026-10-15T09:30:00Z',
      reportedInterval: { start: '2026-10-15T10:00:00Z', end: '2026-10-15T11:00:00Z' },
    });
    expect(evaluate([older, latest], '2026-10-15T10:00:00Z')).toMatchObject({
      evidenceState: 'supported',
      outcome: 'pass',
    });
    const outside = evaluate([older, latest]);
    expect(outside).toMatchObject({
      applicability: 'undetermined',
      evidenceState: 'insufficient',
      outcome: 'attention',
      explanation: { code: 'interval_outside' },
    });
    expect(outside.explanation.evidence).toEqual([latest]);
  });

  it('keeps absent, unknown and unorderable evidence insufficient instead of falling back to approval', () => {
    expect(evaluate([])).toMatchObject({ evidenceState: 'insufficient', outcome: 'attention' });
    const older = report();
    for (const newest of [
      report({ eventId: 'unknown-status', occurredAt: '2026-10-15T10:30:00Z', status: 'approved' }),
      report({ eventId: 'missing-interval', occurredAt: '2026-10-15T10:30:00Z', reportedInterval: undefined }),
      report({
        eventId: 'invalid-interval',
        occurredAt: '2026-10-15T10:30:00Z',
        reportedInterval: { start: '2026-10-15T10:00:00Z', end: '2026-10-15T10:00:00Z' },
      }),
      report({ eventId: 'unorderable', occurredAt: '2026-02-30T10:30:00Z' }),
    ]) {
      const result = evaluate([older, newest]);
      expect(result).toMatchObject({
        applicability: 'undetermined',
        evidenceState: 'insufficient',
        outcome: 'attention',
      });
      expect(result.explanation.evidence).toEqual([newest]);
    }
    expect(evaluate([older], 'invalid-clock')).toMatchObject({
      evidenceState: 'insufficient',
      explanation: { code: 'clock_invalid' },
    });
  });

  it('retains simultaneous contradictory statuses or interval claims as conflicting', () => {
    const approval = report();
    const denied = report({ eventId: 'denied', status: 'STATUS_DENIED', occurredAt: '2026-10-15T09:00:00Z' });
    expect(evaluate([denied, approval])).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      explanation: { code: 'status_conflicting' },
    });
    const differentInterval = report({
      eventId: 'different-interval',
      reportedInterval: { start: '2026-10-15T10:00:00Z', end: '2026-10-15T11:30:00Z' },
    });
    expect(evaluate([approval, differentInterval])).toMatchObject({
      evidenceState: 'conflicting',
      outcome: 'attention',
      explanation: { code: 'status_conflicting' },
    });
  });
});
