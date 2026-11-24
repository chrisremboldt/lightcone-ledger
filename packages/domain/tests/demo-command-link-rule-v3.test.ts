import { describe, expect, it } from 'vitest';
import type { CheckObservation } from '../src/check-kinds.js';
import { checkKindDigest, findCheckKind } from '../src/check-kinds.js';
import { episodeOpenV1, episodeOpenV2 } from '../src/check-kind-episodes.js';
import { checkedRuleProblem, narrowRead, runCheckedRule } from '../src/checked-rules.js';
import { getRulePackVersion } from '../src/rule-pack-registry.js';
import { sessionReadProblem } from '../src/session-reads.js';
import '../src/rules/demo-procedures-pack.js';
import { COMMAND_LINK_LOSS_LEAF_ID } from '../src/rules/command-link-evidence-v1.js';
import { commandLinkLossLeafV2 } from '../src/rules/demo-command-link-v2.js';
import { commandLinkLossLeafV3 } from '../src/rules/demo-command-link-v3.js';

// Version 3 of the lost-link review binds a capture session across flights: a report in a session whose earliest
// report is about another flight or aircraft is left out and named, whatever order the reports arrive in.

const clock = { mode: 'wall' as const, evaluatedAt: '2026-10-15T11:00:00.000Z' };

interface Report {
  id: string;
  flightId?: string;
  sourceId?: string;
  session?: string;
  incident?: string;
  aircraft?: string;
  at?: string;
  state?: 'down' | 'up';
}

function observation(report: Report): CheckObservation {
  const occurredAt = report.at ?? '2026-10-15T10:00:00.000Z';
  return {
    id: report.id,
    sourceId: report.sourceId ?? 'command-link',
    type: 'link.status',
    version: 1,
    occurredAt,
    observation: {
      type: 'link.status',
      version: 1,
      subject: { kind: 'flight', id: report.flightId ?? 'flight-one', scope: 'ledger' },
      secondarySubject: { kind: 'aircraft', id: report.aircraft ?? 'aircraft-one', scope: 'source' },
      occurredAt,
      sourceEventId: `source:${report.id}`,
      sourceSessionId: report.session ?? 'session-one',
      values: {
        link: 'command_control',
        state: report.state ?? 'down',
        report: 'transition',
        sourceEpisodeId: report.incident ?? 'incident-one',
      },
    },
  };
}

/** The review of one flight: its own reports, and every report of their sessions about any flight. */
function review(flightId: string, reports: Report[]) {
  const [own, session] = commandLinkLossLeafV3.reads;
  const all = reports.map(observation);
  const transitions = narrowRead(
    own!,
    all.filter((item) => (item.observation.subject as { id: string }).id === flightId),
    {},
  );
  const sessions = new Set(transitions.map((item) => `${item.sourceId}\n${String(item.observation.sourceSessionId)}`));
  const sessionTransitions = narrowRead(
    session!,
    all.filter((item) => sessions.has(`${item.sourceId}\n${String(item.observation.sourceSessionId)}`)),
    {},
  );
  return runCheckedRule(
    commandLinkLossLeafV3,
    commandLinkLossLeafV3.check.params,
    { transitions, sessionTransitions },
    clock,
  );
}

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
      );

describe('lost-link review version 3', () => {
  it('is a checked rule of pack version 6 on episode.open version 2; version 5 keeps version 2', () => {
    expect(checkedRuleProblem(commandLinkLossLeafV3)).toBeUndefined();
    expect(commandLinkLossLeafV3.id).toBe(COMMAND_LINK_LOSS_LEAF_ID);
    expect(checkKindDigest(findCheckKind('episode.open', 2)!)).toBe(checkKindDigest(episodeOpenV2));
    expect(checkKindDigest(findCheckKind('episode.open', 1)!)).toBe(checkKindDigest(episodeOpenV1));
    const leafOf = (version: number) =>
      getRulePackVersion('ledger.demo-procedures', version)!.leaves.find(
        (leaf) => leaf.id === COMMAND_LINK_LOSS_LEAF_ID,
      );
    expect(leafOf(6)?.digest).toBe(commandLinkLossLeafV3.digest);
    expect(leafOf(5)?.digest).toBe(commandLinkLossLeafV2.digest);
  });

  it('reads the same as version 2 when every session stays on its flight', () => {
    const reports: Report[] = [
      { id: 'loss' },
      { id: 'restored', state: 'up', at: '2026-10-15T10:01:00.000Z' },
      { id: 'second', incident: 'incident-two', at: '2026-10-15T10:02:00.000Z' },
    ];
    const before = runCheckedRule(
      commandLinkLossLeafV2,
      commandLinkLossLeafV2.check.params,
      { transitions: narrowRead(commandLinkLossLeafV2.reads[0]!, reports.map(observation), {}) },
      clock,
    );
    const after = review('flight-one', reports);
    expect({ ...after, summary: undefined, details: { ...after.details, leftOutObservations: undefined } }).toEqual({
      ...before,
      summary: undefined,
      details: { ...before.details, leftOutObservations: undefined },
    });
    expect(after.details).toMatchObject({ leftOutCount: 0, leftOutObservations: null });
  });

  it('leaves out a report in a session first used for another flight, in any arrival order', () => {
    const reports: Report[] = [
      { id: 'first-flight-loss', flightId: 'flight-one', at: '2026-10-15T10:00:00.000Z' },
      { id: 'reused-loss', flightId: 'flight-two', at: '2026-10-15T10:05:00.000Z' },
      { id: 'own-loss', flightId: 'flight-two', session: 'session-two', at: '2026-10-15T10:06:00.000Z' },
    ];
    const results = permutations(reports).map((order) => [review('flight-one', order), review('flight-two', order)]);
    for (const [one, two] of results) {
      expect(one).toEqual(results[0]![0]);
      expect(two).toEqual(results[0]![1]);
    }
    const [one, two] = results[0]!;
    expect(one!.details).toMatchObject({ episodeCount: 1, leftOutCount: 0, leftOutObservations: null });
    expect(two!.details).toMatchObject({ episodeCount: 1, leftOutCount: 1, leftOutObservations: 'reused-loss' });
    expect(two!.issues?.some((issue) => issue.includes('reused-loss'))).toBe(false);
    expect(two!.evidence).toEqual(['own-loss']);
    expect(two!.summary).toContain('1 reports in a session first used for another flight or aircraft are left out');
  });

  it('binds the session to the flight of its earliest report, not of its first arrival', () => {
    const early: Report = { id: 'early', flightId: 'flight-two', at: '2026-10-15T09:00:00.000Z' };
    const late: Report = { id: 'late', flightId: 'flight-one', at: '2026-10-15T10:00:00.000Z' };
    for (const order of [
      [late, early],
      [early, late],
    ]) {
      expect(review('flight-one', order).details).toMatchObject({ leftOutCount: 1, episodeCount: 0 });
      expect(review('flight-two', order).details).toMatchObject({ leftOutCount: 0, episodeCount: 1 });
    }
  });

  it('breaks a tie at one instant by the flight and aircraft, not by arrival', () => {
    const one: Report = { id: 'z-on-one', flightId: 'flight-one' };
    const two: Report = { id: 'a-on-two', flightId: 'flight-two' };
    for (const order of [
      [one, two],
      [two, one],
    ]) {
      expect(review('flight-one', order).details).toMatchObject({ leftOutCount: 0 });
      expect(review('flight-two', order).details).toMatchObject({ leftOutCount: 1, leftOutObservations: 'a-on-two' });
    }
  });

  it('leaves out another aircraft in the session on the same flight, and keeps sources apart', () => {
    const result = review('flight-one', [
      { id: 'loss' },
      { id: 'other-aircraft', aircraft: 'aircraft-two', at: '2026-10-15T10:01:00.000Z' },
      { id: 'other-source', sourceId: 'second-source', flightId: 'flight-two', at: '2026-10-15T09:00:00.000Z' },
    ]);
    expect(result.details).toMatchObject({ leftOutCount: 1, leftOutObservations: 'other-aircraft', episodeCount: 1 });
  });

  it('refuses a read by session that does not follow a read about the target', () => {
    const [own, session] = commandLinkLossLeafV3.reads;
    expect(sessionReadProblem({ ...commandLinkLossLeafV3, reads: [session!, own!] })).toContain(
      'not an earlier read about the target',
    );
    expect(
      sessionReadProblem({ ...commandLinkLossLeafV3, reads: [own!, { ...session!, select: 'latest' }] }),
    ).toContain('without selecting all');
  });
});
