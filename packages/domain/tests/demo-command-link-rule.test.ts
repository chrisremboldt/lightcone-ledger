import { describe, expect, it } from 'vitest';
import type { CheckObservation } from '../src/check-kinds.js';
import { checkKindDigest, findCheckKind } from '../src/check-kinds.js';
import { episodeOpenV1 } from '../src/check-kind-episodes.js';
import { checkedRuleProblem, narrowRead, runCheckedRule } from '../src/checked-rules.js';
import { getRulePackVersion } from '../src/rule-pack-registry.js';
import '../src/rules/demo-procedures-pack.js';
import {
  COMMAND_LINK_LOSS_LEAF_ID,
  evaluateCommandLinkEvidence,
  type CommandLinkEvidenceReport,
} from '../src/rules/command-link-evidence-v1.js';
import { commandLinkLossLeafV2 } from '../src/rules/demo-command-link-v2.js';

// The cases of the version 1 lost-link review, run through the generic engine on the version 2 checked rule.

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

/** The report as the adapter and the bridge record it: one link.status@1 transition. */
function observation(item: CommandLinkEvidenceReport): CheckObservation {
  const time = Date.parse(item.occurredAt);
  const occurredAt = Number.isFinite(time) ? new Date(time).toISOString() : item.occurredAt;
  return {
    id: item.eventId,
    sourceId: item.sourceId,
    type: 'link.status',
    version: 1,
    occurredAt,
    observation: {
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: flightId, scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: item.aircraftId, scope: 'source' },
      occurredAt,
      sourceEventId: item.sourceEventId,
      sourceSessionId: item.sourceSessionId,
      values: {
        link: 'command_control',
        state: item.status === 'lost' ? 'down' : 'up',
        report: 'transition',
        sourceEpisodeId: item.incidentId,
      },
    },
  };
}

function checked(reports: CommandLinkEvidenceReport[]) {
  const read = commandLinkLossLeafV2.reads[0]!;
  const transitions = narrowRead(read, reports.map(observation), {});
  return runCheckedRule(commandLinkLossLeafV2, commandLinkLossLeafV2.check.params, { transitions }, clock);
}

const reasonCodes: Record<string, string> = {
  command_link_reports_unavailable: 'episode_unavailable',
  command_link_restoration_missing: 'episode_open',
  command_link_reports_conflicting: 'episode_conflicting',
  command_link_reports_invalid: 'transition_unreadable',
  command_link_losses_restored: 'episodes_closed',
};

/** Version 2 gives version 1's evidence state, outcome and (renamed) reason for the same reports. */
function expectParity(reports: CommandLinkEvidenceReport[]) {
  const before = evaluateCommandLinkEvidence({ flightId, reports, clock });
  const after = checked(reports);
  expect({ evidenceState: after.evidenceState, outcome: after.outcome, reasonCode: after.reasonCode }).toEqual({
    evidenceState: before.evidenceState,
    outcome: before.outcome,
    reasonCode: reasonCodes[before.explanation.code],
  });
  return after;
}

describe('lost-link review version 2 on the generic evaluator', () => {
  it('is a checked rule of pack version 5 with the same id, while versions 3 and 4 keep version 1', () => {
    expect(checkedRuleProblem(commandLinkLossLeafV2)).toBeUndefined();
    expect(commandLinkLossLeafV2.id).toBe(COMMAND_LINK_LOSS_LEAF_ID);
    expect(checkKindDigest(findCheckKind('episode.open', 1)!)).toBe(checkKindDigest(episodeOpenV1));
    const five = getRulePackVersion('ledger.demo-procedures', 5)!;
    expect(five.leaves.find((leaf) => leaf.id === COMMAND_LINK_LOSS_LEAF_ID)?.digest).toBe(
      commandLinkLossLeafV2.digest,
    );
    expect(five.bindings.map((binding) => binding.inputKind)).toEqual(['airspace.status']);
    for (const version of [3, 4])
      expect(
        getRulePackVersion('ledger.demo-procedures', version)!.leaves.find(
          (leaf) => leaf.id === COMMAND_LINK_LOSS_LEAF_ID,
        )?.version,
      ).toBe(1);
  });

  it('keeps absent and restoration-only evidence pending', () => {
    expectParity([]);
    const restorationOnly = expectParity([report('restoration-only', { status: 'restored' })]);
    expect(restorationOnly.evidence).toEqual(['restoration-only']);
  });

  it('requires a restoration in the same session, incident and aircraft', () => {
    const loss = report('loss');
    const restoration = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    const unrelated = [
      { ...restoration, eventId: 'other-session', sourceSessionId: 'other-session' },
      { ...restoration, eventId: 'other-incident', incidentId: 'other-incident' },
      { ...restoration, eventId: 'other-aircraft', aircraftId: 'other-aircraft' },
    ];
    const missing = expectParity([loss, ...unrelated]);
    expect(missing.details).toMatchObject({
      episodeCount: 1,
      openEpisodeCount: 1,
      latestOpenedAt: loss.occurredAt.replace('Z', '.000Z'),
    });
    expect(missing.evidence[0]).toBe('loss');
    expect(missing.summary).toContain('1 with no restoration recorded');
    const restored = expectParity([restoration, ...unrelated, loss]);
    expect(restored.details).toMatchObject({ closedEpisodeCount: 1, latestOpenedAt: null });
    expect(restored.summary).toContain('may be resolved once a person has looked at it');
  });

  it('requires a restoration after every known loss', () => {
    const loss = report('late-loss');
    const restoration = report('already-restored', { status: 'restored', occurredAt: '2026-10-15T10:02:00Z' });
    expectParity([restoration, loss]);
    const secondLoss = report('another-incident', { incidentId: 'incident-two', occurredAt: '2026-10-15T10:03:00Z' });
    expectParity([restoration, loss, secondLoss]);
    expectParity([
      restoration,
      loss,
      secondLoss,
      report('second-restoration', {
        incidentId: 'incident-two',
        status: 'restored',
        occurredAt: '2026-10-15T10:04:00Z',
      }),
    ]);
  });

  it('keeps simultaneous statuses conflicting until a strictly later restoration clarifies them', () => {
    const loss = report('loss');
    const tied = report('tied-restoration', { status: 'restored', occurredAt: '2026-10-15T10:00:00.000Z' });
    expect(expectParity([tied, loss]).details).toMatchObject({ conflictingEpisodeCount: 1 });
    const later = report('later-restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    expectParity([tied, loss, later]);
    expectParity([later, tied, loss, report('new-loss', { occurredAt: '2026-10-15T10:02:00Z' })]);
  });

  it('does not skip future evidence to return an older restored result', () => {
    const loss = report('loss');
    const restored = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    const future = report('future-restoration', { status: 'restored', occurredAt: '2026-10-15T11:01:00Z' });
    const result = expectParity([loss, restored, future]);
    expect(result.evidence).toContain('future-restoration');
  });

  it('leaves out a report that names another aircraft in a session already bound to one', () => {
    const loss = report('loss');
    const restoration = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    const rebound = report('rebound', { aircraftId: 'aircraft-two', occurredAt: '2026-10-15T10:02:00Z' });
    const result = checked([loss, restoration, rebound]);
    expect(result).toMatchObject({ outcome: 'pass', details: { leftOutCount: 1, episodeCount: 1 } });
    expect(result.evidence).not.toContain('rebound');
    expect(
      checked([loss, report('other-session', { aircraftId: 'aircraft-two', sourceSessionId: 'two' })]),
    ).toMatchObject({ outcome: 'attention', details: { leftOutCount: 0, openEpisodeCount: 2 } });
  });

  it('names every recorded loss as an issue, restored or not, and keeps sources apart', () => {
    const loss = report('loss');
    const restoration = report('restoration', { status: 'restored', occurredAt: '2026-10-15T10:01:00Z' });
    const open = checked([loss]);
    const restored = checked([loss, restoration]);
    expect(open.issues).toEqual(restored.issues);
    expect(open.issues).toHaveLength(1);
    expect(restored).toMatchObject({ outcome: 'pass', details: { latestClosedAt: '2026-10-15T10:01:00.000Z' } });
    expect(restored.summary).toContain('the latest restored at 2026-10-15T10:01:00.000Z');
    expect(open.summary).toContain('1 with no restoration recorded');
    // Each loss says when it began, and when it ended once a strictly later restoration is reported.
    expect(open.issueTimes).toEqual([{ issue: open.issues![0], start: '2026-10-15T10:00:00.000Z' }]);
    expect(restored.issueTimes).toEqual([
      { issue: open.issues![0], start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T10:01:00.000Z' },
    ]);
    const tied = checked([loss, { ...restoration, occurredAt: loss.occurredAt }]);
    expect(tied.issueTimes).toEqual([{ issue: open.issues![0], start: '2026-10-15T10:00:00.000Z', endUnknown: true }]);
    // The same session and incident ids from another source are another episode, never closed by this source.
    const other = checked([loss, { ...restoration, eventId: 'other-source', sourceId: 'other-link' }]);
    expect(other).toMatchObject({ outcome: 'attention', details: { openEpisodeCount: 1, episodeCount: 1 } });
    expect(checked([loss, report('other-loss', { sourceId: 'other-link' })]).issues).toHaveLength(2);
  });

  it('reads only command-link transitions of a reported aircraft with a session, event and episode', () => {
    const loss = observation(report('loss'));
    const values = loss.observation.values as Record<string, unknown>;
    const variants: CheckObservation[] = [
      { ...loss, id: 'sample', observation: { ...loss.observation, values: { ...values, report: 'sample' } } },
      { ...loss, id: 'video', observation: { ...loss.observation, values: { ...values, link: 'video' } } },
      { ...loss, id: 'unknown', observation: { ...loss.observation, values: { ...values, state: 'unknown' } } },
      {
        ...loss,
        id: 'no-episode',
        observation: { ...loss.observation, values: { ...values, sourceEpisodeId: undefined } },
      },
    ];
    expect(narrowRead(commandLinkLossLeafV2.reads[0]!, variants, {})).toEqual([]);
  });
});
