import { describe, expect, it } from 'vitest';
import type { LedgerClient } from '../../packages/contracts/src/client.js';
import type {
  AcceptedObservation,
  NamedSubject,
  ObservationQuery,
  RuleEvaluationExplanation,
} from '../../packages/contracts/src/index.js';
import {
  citedBySubject,
  readCitedObservations,
  readSubjectText,
  withReadContext,
  type WithExplanation,
} from '../../apps/web/src/evaluation-reads.js';

const flight = { kind: 'flight' as const, id: 'flight-fictional' };
const flightNamed: NamedSubject = { scope: 'ledger', kind: 'flight', id: flight.id, name: 'Roof survey 1 · Dock 1' };
const site: NamedSubject = {
  scope: 'source',
  kind: 'site',
  id: 'north-roof-fictional',
  sourceId: 'roof-dock-fictional',
  name: 'north-roof-fictional',
};

function observation(id: string, occurredAt: string): AcceptedObservation {
  return { id, sourceId: 'roof-dock-fictional', occurredAt } as AcceptedObservation;
}

type Input = RuleEvaluationExplanation['inputs'][number] & { subject?: NamedSubject };

/** An evaluation as a screen holds it, with the subjects its inputs were about beside it, as reads return them. */
function evaluation(inputs: Input[]): WithExplanation {
  const subjects = inputs.map((input) => input.subject);
  return {
    id: 'evaluation-1',
    explanation: explanation(inputs.map(({ subject: _subject, ...input }) => input)),
    ...(subjects.every(Boolean) ? { inputSubjects: subjects as NamedSubject[] } : {}),
  };
}

function explanation(inputs: RuleEvaluationExplanation['inputs']): RuleEvaluationExplanation {
  const evidence = inputs.flatMap((input) =>
    input.observationIds.map((observationId, index) => ({
      eventId: `event-${observationId}`,
      receiptId: `receipt-${observationId}`,
      sourceId: 'roof-dock-fictional',
      occurredAt: `2026-11-19T10:0${index}:00.000Z`,
      observationId,
      type: input.type,
      version: 1,
    })),
  );
  return {
    kind: 'rule',
    code: 'value_outside_limit',
    summary: 'A fictional reading above the limit.',
    evidence,
    details: {},
    parameters: {},
    inputs,
    ruleEvaluation: {
      pack: { id: 'test.pack', version: 1, digest: 'a'.repeat(64) },
      ruleDigest: 'b'.repeat(64),
      check: { kind: 'value.within-limit', version: 1 },
      mode: 'active',
      subjectKey: `ledger/flight/${flight.id}`,
    },
    evaluatedAt: '2026-11-19T10:10:00.000Z',
  };
}

describe('the subject each input of an evaluation read', () => {
  const windOnFlight = evaluation([
    { name: 'plan', type: 'operator.record', observationIds: ['plan-1'], subject: flightNamed },
    { name: 'values', type: 'weather.wind', observationIds: ['wind-1', 'wind-2'], subject: site },
  ]);

  it('lists the readings a flight’s rule read about a site under the site', () => {
    const shown = [observation('plan-1', 'x'), observation('wind-1', 'y'), observation('wind-2', 'z')];
    const { labelled, groups } = citedBySubject(shown, windOnFlight, flight);
    expect(labelled).toBe(true);
    expect(
      groups.map((group) => [readSubjectText(group.subject, flight), group.observations.map((item) => item.id)]),
    ).toEqual([
      ['Flight Roof survey 1 · Dock 1', ['plan-1']],
      ['Site north-roof-fictional', ['wind-1', 'wind-2']],
    ]);
  });

  it('labels a single subject only when it is not the one the finding is on', () => {
    const own = evaluation([
      { name: 'plan', type: 'operator.record', observationIds: ['plan-1'], subject: flightNamed },
    ]);
    expect(citedBySubject([observation('plan-1', 'x')], own, flight).labelled).toBe(false);
    const unnamed = evaluation([{ name: 'plan', type: 'operator.record', observationIds: ['plan-1'] }]);
    expect(citedBySubject([observation('plan-1', 'x')], unnamed, flight).labelled).toBe(false);
    const elsewhere = evaluation([{ name: 'values', type: 'weather.wind', observationIds: ['wind-1'], subject: site }]);
    const { labelled, groups } = citedBySubject([observation('wind-1', 'y')], elsewhere, flight);
    expect(labelled).toBe(true);
    expect(groups[0]!.subject).toEqual(site);
  });

  it('takes the subjects from beside the evaluation by its id, leaving the evaluation as it was', () => {
    const plain = { id: 'evaluation-1', explanation: windOnFlight.explanation };
    expect(withReadContext(plain, { inputSubjects: { 'evaluation-1': [flightNamed, site] } }).inputSubjects).toEqual([
      flightNamed,
      site,
    ]);
    expect(withReadContext(plain, { inputSubjects: { other: [site] } })).toBe(plain);
    expect(plain).not.toHaveProperty('inputSubjects');
  });

  it('reads each cited observation under the subject its input was about', async () => {
    const queries: ObservationQuery[] = [];
    const client = {
      observations: async (query: ObservationQuery) => {
        queries.push(query);
        const ids = query.type === 'weather.wind' ? ['wind-1', 'wind-2'] : ['plan-1'];
        return { observations: ids.map((id) => observation(id, '2026-11-19T10:00:00.000Z')) };
      },
    } as unknown as LedgerClient;
    const read = await readCitedObservations(client, flight, windOnFlight);
    expect(read.map((item) => item.id)).toEqual(['plan-1', 'wind-1', 'wind-2']);
    expect(queries.map((query) => [query.subjectKind, query.subjectId, query.subjectScope, query.sourceId])).toEqual([
      ['flight', flight.id, undefined, undefined],
      ['site', site.id, 'source', site.sourceId],
    ]);
  });

  it('finds a record entered after the span it is about, as the observations route selects by that span', async () => {
    // Recorded a week after the flight it describes: the evidence names when it was recorded, the route the span.
    const record = {
      ...observation('plan-1', '2026-11-19T10:00:00.000Z'),
      interval: { start: '2026-11-12T20:10:00.000Z', end: '2026-11-12T20:35:00.000Z' },
    } as AcceptedObservation;
    const client = {
      observations: async (query: ObservationQuery) => {
        const [from, to] = [Date.parse(query.from), Date.parse(query.to)];
        const start = Date.parse(record.interval!.start);
        const selected = start < to && Date.parse(record.interval!.end) > from;
        return { observations: selected ? [record] : [], page: { nextCursor: null } };
      },
    } as unknown as LedgerClient;
    const own = evaluation([{ name: 'recorded', type: 'operator.record', observationIds: ['plan-1'] }]);
    expect((await readCitedObservations(client, flight, own)).map((item) => item.id)).toEqual(['plan-1']);
  });
});
