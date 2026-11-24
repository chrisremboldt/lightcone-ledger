import { describe, expect, test } from 'vitest';
import {
  FINDING_PACKET_FORMAT,
  FINDING_PACKET_V2_FORMAT,
  FINDING_PACKET_V2_LIMITATIONS,
  type HazardOrigin,
} from '../../packages/contracts/src/index.js';
import { canonicalDigest, sha256 } from '../../packages/integrity/src/index.js';
import { assembleFindingPacket, assembleFindingPacketV2 } from '../../packages/evidence/src/finding-packet-assembly.js';
import { toyFinding, toyIssue } from './finding-packet-fixture.js';

describe('finding packet assembly', () => {
  test('binds every included record by digest and states no verdict', () => {
    const { sources } = toyFinding();
    const packet = assembleFindingPacket(sources, toyIssue);
    expect(packet.format).toBe(FINDING_PACKET_FORMAT);
    const inventory = packet.manifest.inventory;
    expect(inventory.filter((item) => item.kind === 'event').map((item) => [item.id, item.reason])).toEqual([
      ['toy-adoption', 'evaluation_adoption'],
      ['toy-assessment', 'hazard_assessment'],
      ['toy-evaluation-1', 'finding_evaluation'],
      ['toy-hazard-opening', 'hazard_opening'],
      ['toy-observation-0', 'corrected_observation'],
      ['toy-observation-1', 'read_observation'],
      ['toy-withdrawal', 'observation_correction'],
    ]);
    for (const [index, entry] of packet.events.entries()) expect(inventory[index]!.digest).toBe(canonicalDigest(entry));
    expect(inventory.find((item) => item.kind === 'receipt')!.digest).toBe(canonicalDigest(packet.receipts[0]));
    expect(inventory.find((item) => item.kind === 'artifact')!.digest).toBe(canonicalDigest(packet.artifacts[0]));
    expect(inventory.find((item) => item.kind === 'origin')!.digest).toBe(
      packet.manifest.decisions.hazards[0]!.originDigest,
    );
    expect(packet.manifest.statements).toEqual([
      'This packet records what the evidence supported and what people decided. It does not determine whether any requirement is met.',
    ]);
    const words = JSON.stringify(packet.manifest).toLowerCase();
    for (const verdict of ['compliant', 'authorized', 'no-go']) expect(words).not.toContain(verdict);
  });

  test('says in plain words when the rule was adopted in shadow and its text is proposed', () => {
    const { sources } = toyFinding({ mode: 'shadow', sourceKind: 'proposed_regulation' });
    const statements = assembleFindingPacket(sources, toyIssue).manifest.statements;
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/adopted in shadow.*not counted/);
    expect(statements[1]).toMatch(/proposed text that is not in force/);
  });

  test('refuses records that do not belong to the finding', () => {
    const otherRule = toyFinding();
    otherRule.sources.finding = { ...otherRule.sources.finding, ruleId: 'toy.another-rule' };
    expect(() => assembleFindingPacket(otherRule.sources, toyIssue)).toThrow(/another subject or rule/);

    const missingReceipt = toyFinding();
    missingReceipt.sources.receipts = [];
    expect(() => assembleFindingPacket(missingReceipt.sources, toyIssue)).toThrow(/receipt/);

    const wrongPin = toyFinding();
    const origin = wrongPin.sources.hazards[0]!.origin as Extract<HazardOrigin, { kind: 'finding' }>;
    wrongPin.sources.hazards[0]!.origin = { ...origin, evaluationDigest: canonicalDigest({ toy: 'other' }) };
    expect(() => assembleFindingPacket(wrongPin.sources, toyIssue)).toThrow(/not this finding/);

    const outsideCut = toyFinding();
    outsideCut.sources.events = outsideCut.sources.events.map((event) =>
      event.envelope.eventId === 'toy-withdrawal'
        ? { ...event, envelope: { ...event.envelope, sequence: '9' } }
        : event,
    );
    expect(() => assembleFindingPacket(outsideCut.sources, toyIssue)).toThrow(/outside the input cut/);

    const extraEvent = toyFinding();
    extraEvent.sources.events = [
      ...extraEvent.sources.events,
      {
        ...extraEvent.sources.events[0]!,
        envelope: { ...extraEvent.sources.events[0]!.envelope, eventId: 'toy-unrelated' },
      },
    ];
    expect(() => assembleFindingPacket(extraEvent.sources, toyIssue)).toThrow(/differ from the events/);
  });

  test('refuses an adoption whose mode or pack differs from the evaluation', () => {
    const { sources } = toyFinding();
    sources.events = sources.events.map((event) =>
      event.envelope.eventId === 'toy-adoption'
        ? {
            ...event,
            envelope: {
              ...event.envelope,
              payload: {
                acceptance: { ...(event.envelope.payload.acceptance as Record<string, unknown>), mode: 'shadow' },
              },
            },
          }
        : event,
    );
    expect(() => assembleFindingPacket(sources, toyIssue)).toThrow(/differs from the adoption/);
  });

  test('version 2 carries each source original checked against its digest and length', () => {
    const { sources } = toyFinding();
    const original = Buffer.from('{"reading":"latest"}');
    sources.artifacts = [{ ...sources.artifacts[0]!, sha256: sha256(original), byteLength: original.byteLength }];
    const packet = assembleFindingPacketV2(sources, toyIssue, new Map([['toy-artifact-1', original]]), []);
    expect(packet.format).toBe(FINDING_PACKET_V2_FORMAT);
    expect(packet.artifacts[0]!.bytesBase64).toBe(original.toString('base64'));
    expect(packet.manifest.limitations).toEqual([...FINDING_PACKET_V2_LIMITATIONS]);
    expect(packet.manifest.counts).toMatchObject({ originalBytes: original.byteLength, leftOutOriginals: 0 });
    expect(packet.manifest.inventory.find((item) => item.kind === 'artifact')!.digest).toBe(
      canonicalDigest(packet.artifacts[0]),
    );
    const other = new Map([['toy-artifact-1', Buffer.from('{"reading":"earlier"}')]]);
    expect(() => assembleFindingPacketV2(sources, toyIssue, other, [])).toThrow(/differ from its digest or length/);
    expect(() => assembleFindingPacketV2(sources, toyIssue, new Map(), ['toy-artifact-0'])).toThrow(/largest first/);
  });
});
