import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@ledger/contracts';
import { correctionEligibility, landingFields, reportPayload } from '../../apps/web/src/correction-presentation.js';

function item(kind: string, payload: Record<string, unknown> = {}): TimelineItem {
  return {
    id: 'report-a',
    kind,
    payload,
    title: 'Landing report',
    lane: 'observed',
    occurredAt: '2026-10-19T04:11:50.123Z',
    receivedAt: '2026-10-19T04:11:51Z',
    actorId: 'source-principal',
    linkStatus: 'linked',
  };
}

describe('source report correction presentation', () => {
  it('allows typed source evidence while keeping computed decisions and source plans out of the editor', () => {
    for (const kind of [
      'flight.observation',
      'source.observation',
      'airspace.status',
      'telemetry.segment',
      'command-link.status',
      'command-link.baseline',
      'evidence.correct',
    ])
      expect(correctionEligibility(item(kind)).allowed).toBe(true);
    for (const kind of [
      'evaluation.recorded',
      'decision.record',
      'mission.revision',
      'order.revision',
      'intent.revision',
      'flight.created',
    ]) {
      const eligibility = correctionEligibility(item(kind));
      expect(eligibility.allowed).toBe(false);
      expect(eligibility.reason.length).toBeGreaterThan(0);
    }
    expect(correctionEligibility(null).allowed).toBe(false);
    expect(correctionEligibility(item('telemetry.segment')).reason).toContain('annotation');
    expect(correctionEligibility(item('command-link.status')).reason).toContain('annotation');
  });

  it('copies the exact report values without exposing a correction command wrapper or mutating the retained claim', () => {
    const original = item('flight.observation', {
      landingTime: '2026-10-19T04:10:50.123Z',
      confidence: 0.9,
      confirmed: false,
      missing: null,
      metadata: { handset: 'crew-a' },
      note: 'Handset clock was fast.',
    });
    const correction = item('evidence.correct', {
      correctionOf: original.id,
      expectedRevision: 12,
      note: 'Checked with the crew.',
      payload: original.payload,
    });
    const values = reportPayload(correction);
    expect(values).toEqual(original.payload);
    expect(values).not.toHaveProperty('correctionOf');
    expect(values).not.toHaveProperty('expectedRevision');
    expect(reportPayload(original)).toEqual(values);
    (values.metadata as { handset: string }).handset = 'edited';
    expect(original.payload.metadata).toEqual({ handset: 'crew-a' });
    expect(reportPayload(item('evidence.correct', original.payload))).toEqual(original.payload);
  });

  it('finds both supported landing fields in report claims, including nested corrections, using typed semantics', () => {
    const values = { landingTime: '2026-10-19T04:10:20.123Z', landedAt: null, metadata: { retained: true } };
    expect(landingFields(item('flight.observation', values))).toEqual(['landingTime', 'landedAt']);
    expect(landingFields(item('evidence.correct', { payload: values }))).toEqual(['landingTime', 'landedAt']);
    expect(landingFields(item('flight.observation', { activity: 'landed' }))).toEqual([]);
    expect(landingFields(item('source.observation', values))).toEqual([]);
    expect(landingFields(item('evaluation.recorded', values))).toEqual([]);
  });
});
