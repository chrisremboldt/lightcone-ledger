import { describe, expect, it } from 'vitest';
import {
  missionBriefingAcknowledgementRecord,
  missionBriefingCases,
  missionBriefingRecord,
} from '../../packages/contracts/fixtures/demo/v1/mission-briefing.js';
import {
  assertMissionBriefingAcknowledgementRecord,
  assertMissionBriefingRecord,
} from '../../packages/domain/src/mission-briefing-integrity.js';
import { canonicalDigest } from '../../packages/integrity/src/index.js';

const integrityFailure = expect.objectContaining({ status: 409, code: 'briefing_integrity_failure' });

describe('retained mission briefing integrity', () => {
  it('retains personal acknowledgement authority independently of frozen population revision', () => {
    expect(missionBriefingRecord.population.recipients[0]!.principalRevision).toBe(1);
    expect(missionBriefingAcknowledgementRecord.actor.principalRevision).toBe(2);
    expect(() => assertMissionBriefingRecord(missionBriefingRecord)).not.toThrow();
    expect(() =>
      assertMissionBriefingAcknowledgementRecord(missionBriefingAcknowledgementRecord, missionBriefingRecord),
    ).not.toThrow();
  });

  it('rejects reordered populations and acknowledgements that substitute their exact briefing or recipient', () => {
    const reordered = structuredClone(missionBriefingCases.newPopulation.briefing);
    reordered.population.recipients.reverse();
    const { digest: _digest, ...population } = reordered.population;
    reordered.population.digest = canonicalDigest(population);
    expect(() => assertMissionBriefingRecord(reordered)).toThrowError(integrityFailure);

    const substituted = structuredClone(missionBriefingAcknowledgementRecord);
    substituted.briefing.digest = '0'.repeat(64);
    expect(() => assertMissionBriefingAcknowledgementRecord(substituted, missionBriefingRecord)).toThrowError(
      integrityFailure,
    );
    const proxy = structuredClone(missionBriefingAcknowledgementRecord);
    proxy.actor.id = 'fixture-principal-outsider';
    proxy.recipientPrincipalId = proxy.actor.id;
    expect(() => assertMissionBriefingAcknowledgementRecord(proxy, missionBriefingRecord)).toThrowError(
      integrityFailure,
    );
  });

  it('rejects missing retained authority and a rehashed replacement for the registered control type wording', () => {
    const unauthorized = structuredClone(missionBriefingAcknowledgementRecord);
    unauthorized.actor.capabilities = ['flight:read'];
    expect(() => assertMissionBriefingAcknowledgementRecord(unauthorized, missionBriefingRecord)).toThrowError(
      integrityFailure,
    );
    // Wording other than the registered control type gives these parameters.
    const reworded = structuredClone(missionBriefingRecord);
    reworded.content.controls[0]!.description = 'Substitute another avoidance instruction.';
    expect(() => assertMissionBriefingRecord(reworded)).toThrowError(integrityFailure);
    // A control type pinned by a digest other than the registered definition's.
    const rehashed = structuredClone(missionBriefingRecord);
    rehashed.content.controls[0]!.controlType.digest = canonicalDigest({
      substituted: rehashed.content.controls[0]!.controlType,
    });
    expect(() => assertMissionBriefingRecord(rehashed)).toThrowError(integrityFailure);
  });

  it('accepts a briefing listing its controls and rejects a list that repeats a control or loses its content', () => {
    expect(() => assertMissionBriefingRecord(missionBriefingRecord)).not.toThrow();
    const [reference] = missionBriefingRecord.context.controls;
    const [content] = missionBriefingRecord.content.controls;
    const repeated = structuredClone(missionBriefingRecord);
    repeated.context.controls = [reference, reference];
    repeated.content.controls = [content, content];
    expect(() => assertMissionBriefingRecord(repeated)).toThrowError(integrityFailure);
    const unmatched = structuredClone(missionBriefingRecord);
    unmatched.content.controls = [content, content];
    expect(() => assertMissionBriefingRecord(unmatched)).toThrowError(integrityFailure);
    const empty = structuredClone(missionBriefingRecord);
    empty.context.controls = [];
    empty.content.controls = [];
    expect(() => assertMissionBriefingRecord(empty)).toThrowError(integrityFailure);
    // A briefing names its controls only as a list.
    const both = {
      ...structuredClone(missionBriefingRecord),
      context: { ...missionBriefingRecord.context, control: reference },
    };
    expect(() => assertMissionBriefingRecord(both as never)).toThrowError(integrityFailure);
  });
});
