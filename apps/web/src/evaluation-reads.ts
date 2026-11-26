import { useEffect, useState } from 'react';
import {
  subjectReferenceKey,
  summaryRecordValues,
  type AcceptedObservation,
  type EvaluationRecord,
  type NamedSubject,
  type RuleEvaluationExplanation,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import type { LedgerClient } from '@ledger/contracts/client';
import { sentence } from './format.js';
import { wordedSummary } from './wording.js';

/** Any evaluation record shape a screen holds: the flight findings' records and the hazard records' copies. */
export interface WithExplanation {
  id?: string;
  explanation: object;
  /** The subject each input was about, in input order, as a read returns it beside the evaluation. */
  inputSubjects?: readonly NamedSubject[];
  /** The wording the recorded summary was filled from (the rule's or the check kind's), as a read returns it beside the evaluation. */
  summaryWording?: string;
}

/** The subject an evaluation is about: a Ledger subject by default, or a source's own id under its source. */
export type CitedSubject = Pick<SubjectReference, 'kind' | 'id'> &
  Partial<Pick<SubjectReference, 'scope' | 'sourceId'>>;

/** A recorded rule evaluation of any subject, in the shape the evaluation reads show. */
export function explainedEvaluation(record: RuleEvaluationRecord): {
  id: string;
  explanation: RuleEvaluationExplanation;
} {
  return {
    id: record.id,
    explanation: {
      kind: 'rule',
      code: record.reasonCode,
      summary: record.summary,
      evidence: record.evidence.map((item) => ({ ...item })),
      details: { ...(record.details ?? {}) },
      parameters: structuredClone(record.parameters),
      inputs: record.inputs.map((input) => ({
        name: input.name,
        type: input.type,
        observationIds: [...input.observationIds],
      })),
      ruleEvaluation: {
        pack: { ...record.pack },
        ruleDigest: record.rule.digest,
        check: { kind: record.check.kind, version: record.check.version },
        mode: record.adoption.mode ?? 'active',
        subjectKey: record.subjectKey,
      },
      evaluatedAt: record.clock.evaluatedAt,
      ...(record.nextBoundary ? { nextBoundary: record.nextBoundary } : {}),
    },
  };
}

/**
 * An evaluation's summary as a person reads it: the rule's or the check kind's wording filled again from the recorded details
 * (and the recorded next boundary and evidence times the wording names), with
 * times in the organization's time and subjects by name; any other summary as recorded. Nothing recorded changes.
 */
export function summaryText(evaluation: WithExplanation & { explanation: { summary: string } }): string {
  const explanation = ruleExplanation(evaluation);
  if (!explanation) return evaluation.explanation.summary;
  return wordedSummary(
    explanation.summary,
    evaluation.summaryWording,
    summaryRecordValues(explanation),
    readSubjects(evaluation),
  );
}

/** Every subject the evaluation's inputs were about, once each, as the read named them. */
export function readSubjects(evaluation: WithExplanation): NamedSubject[] {
  const subjects = new Map<string, NamedSubject>();
  for (const subject of evaluation.inputSubjects ?? []) subjects.set(subjectReferenceKey(subject), subject);
  return [...subjects.values()];
}

/** One key for a cited subject, a Ledger subject by default. */
export function citedSubjectKey(subject: CitedSubject): string {
  return subjectReferenceKey(
    subject.scope === 'source' && subject.sourceId
      ? { scope: 'source', kind: subject.kind, id: subject.id, sourceId: subject.sourceId }
      : { scope: 'ledger', kind: subject.kind, id: subject.id },
  );
}

/** The subject of the input that read each cited observation, as the read named it beside the evaluation. */
export function inputSubjects(evaluation: WithExplanation): Map<string, NamedSubject> {
  const subjects = new Map<string, NamedSubject>();
  const explanation = ruleExplanation(evaluation);
  if (!explanation || !evaluation.inputSubjects) return subjects;
  explanation.inputs.forEach((input, index) => {
    const subject = evaluation.inputSubjects![index];
    if (subject) for (const id of input.observationIds) subjects.set(id, subject);
  });
  return subjects;
}

/** What a read returns beside its evaluations, by evaluation id. */
export interface EvaluationReadContext {
  inputSubjects?: Readonly<Record<string, readonly NamedSubject[]>>;
  summaryWording?: Readonly<Record<string, string>>;
}

/** An evaluation with what the read returned beside it: its inputs' subjects and its summary's wording. */
export function withReadContext<Evaluation extends WithExplanation & { id: string }>(
  evaluation: Evaluation,
  context: EvaluationReadContext,
): Evaluation {
  const subjects = context.inputSubjects?.[evaluation.id];
  const wording = context.summaryWording?.[evaluation.id];
  if (!subjects && !wording) return evaluation;
  return {
    ...evaluation,
    ...(subjects ? { inputSubjects: subjects } : {}),
    ...(wording ? { summaryWording: wording } : {}),
  };
}

/** Cited observations read about one subject. subject is null when the explanation names none: the subject shown. */
export interface CitedSubjectGroup {
  key: string;
  subject: NamedSubject | null;
  observations: AcceptedObservation[];
}

/**
 * The cited observations under the subject each was read about, in the order first cited. labelled is true when the
 * evaluation read more than one subject, or a subject other than the one shown; otherwise the observations are
 * listed as they are, without a subject.
 */
export function citedBySubject(
  observations: readonly AcceptedObservation[],
  evaluation: WithExplanation,
  shown: CitedSubject,
): { labelled: boolean; groups: CitedSubjectGroup[] } {
  const subjects = inputSubjects(evaluation);
  const groups = new Map<string, CitedSubjectGroup>();
  for (const observation of observations) {
    const subject = subjects.get(observation.id) ?? null;
    const key = citedSubjectKey(subject ?? shown);
    const group = groups.get(key) ?? { key, subject, observations: [] };
    group.observations.push(observation);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  return { labelled: list.length > 1 || (list.length === 1 && list[0]!.key !== citedSubjectKey(shown)), groups: list };
}

/** A subject an evaluation read, as a person knows it: its kind in words and its name. */
export function readSubjectText(subject: NamedSubject | null, shown: CitedSubject): string {
  const kind = sentence(subject?.kind ?? shown.kind);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${subject?.name ?? shown.id}`;
}

/** The generic evaluator's explanation, when the evaluation came from an adopted rule. */
export function ruleExplanation(evaluation: WithExplanation): RuleEvaluationExplanation | null {
  const explanation = evaluation.explanation as EvaluationRecord['explanation'];
  return 'kind' in explanation && explanation.kind === 'rule' ? explanation : null;
}

/**
 * Reports compared for disagreement: the check kind decides, never the rule. A finding keeps this presentation when
 * a later evaluation finds the reports agree, so its reports and any correction in progress stay on screen.
 */
export function isDisagreement(evaluation: WithExplanation): boolean {
  return ruleExplanation(evaluation)?.ruleEvaluation.check.kind === 'values.disagree';
}

/**
 * Reports of an episode that opens and closes, such as a lost link and its restoration: the check kind decides, never
 * the rule, so the finding keeps this presentation after a later evaluation finds every episode closed.
 */
export function isEpisodeReview(evaluation: WithExplanation): boolean {
  return ruleExplanation(evaluation)?.ruleEvaluation.check.kind === 'episode.open';
}

/** The fields the check compared, as the rule's parameters name them. */
export function comparedFields(explanation: RuleEvaluationExplanation): string[] {
  const fields = explanation.parameters.fields;
  return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === 'string') : [];
}

export function observationValue(observation: Record<string, unknown>, path: string): unknown {
  let value: unknown = observation;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !utc.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(Date.parse(value)).toISOString();
}

/** One value an evaluation read, from one observation it cites. */
export interface CitedValueRow {
  observationId: string;
  eventId: string;
  receiptId: string;
  sourceId: string;
  occurredAt: string;
  field: string;
  value: string;
  valid: boolean;
  normalizedTime?: string;
  reportedTime: string | null;
}

/** The compared values of the cited observations, in the order the evaluation cites them. */
export function citedValueRows(
  evaluation: WithExplanation,
  observations: readonly AcceptedObservation[],
): CitedValueRow[] {
  const explanation = ruleExplanation(evaluation);
  if (!explanation) return [];
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const fields = comparedFields(explanation);
  return explanation.evidence.flatMap((evidence) => {
    const observation = byId.get(evidence.observationId);
    if (!observation) return [];
    return fields.flatMap((field) => {
      const raw = observationValue(observation.observation, field);
      if (raw === undefined || raw === null) return [];
      const value = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const time = instant(raw);
      return [
        {
          observationId: observation.id,
          eventId: evidence.eventId,
          receiptId: evidence.receiptId,
          sourceId: evidence.sourceId,
          occurredAt: evidence.occurredAt,
          field,
          value,
          valid: typeof raw === 'string' ? time !== null : true,
          ...(time ? { normalizedTime: time } : {}),
          reportedTime: time,
        },
      ];
    });
  });
}

export interface CitedObservations {
  observations: AcceptedObservation[];
  loading: boolean;
  error: string | null;
}

/**
 * Reads the observations an evaluation cites as evidence, through the ordinary observation reads: one read per
 * subject and observation type, over the times the evidence spans, including any since replaced or withdrawn. Each
 * observation is read under the subject its input was about, or the evaluation's subject when the explanation does
 * not name one.
 */
export async function readCitedObservations(
  client: LedgerClient,
  subject: CitedSubject,
  evaluation: WithExplanation,
): Promise<AcceptedObservation[]> {
  const explanation = ruleExplanation(evaluation);
  if (!explanation?.evidence.length) return [];
  const cited = new Set(explanation.evidence.map((item) => item.observationId));
  const subjects = inputSubjects(evaluation);
  const groups = new Map<string, { about: CitedSubject; items: typeof explanation.evidence }>();
  for (const item of explanation.evidence) {
    const about = subjects.get(item.observationId) ?? subject;
    const key = `${citedSubjectKey(about)} ${item.type}@${item.version}`;
    const group = groups.get(key) ?? { about, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const found = new Map<string, AcceptedObservation>();
  for (const { about, items } of groups.values()) {
    // The observations route selects by the span a record is about, not by when it was recorded: a record entered
    // after the flight it describes lies outside a window around its occurredAt. So every time is read, newest
    // first, a page at a time, until each cited observation of the group is found.
    const wanted = new Set(items.map((item) => item.observationId));
    let cursor: string | undefined;
    for (let page = 0; page < CITED_READ_PAGES && wanted.size; page++) {
      const response = await client.observations({
        subjectKind: about.kind,
        subjectId: about.id,
        ...(about.scope === 'source' ? { subjectScope: 'source' as const, sourceId: about.sourceId } : {}),
        type: items[0]!.type,
        version: items[0]!.version,
        from: CITED_READ_FROM,
        to: CITED_READ_TO,
        order: 'newest_first',
        include: 'all',
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const observation of response.observations)
        if (cited.has(observation.id)) {
          found.set(observation.id, observation);
          wanted.delete(observation.id);
        }
      if (!response.page?.nextCursor) break;
      cursor = response.page.nextCursor;
    }
  }
  return [...found.values()];
}
/** The widest window the observations route reads, and how many pages of one subject's records are read at most. */
const CITED_READ_FROM = '1970-01-01T00:00:00.000Z';
const CITED_READ_TO = '9999-12-31T00:00:00.000Z';
const CITED_READ_PAGES = 10;

export function useCitedObservations(
  client: LedgerClient | null,
  subject: CitedSubject,
  evaluation: WithExplanation,
): CitedObservations {
  const [state, setState] = useState<CitedObservations>({ observations: [], loading: false, error: null });
  const applies = Boolean(client && ruleExplanation(evaluation)?.evidence.length);
  useEffect(() => {
    if (!client || !applies) {
      setState({ observations: [], loading: false, error: null });
      return;
    }
    let current = true;
    setState((prior) => ({ ...prior, loading: true, error: null }));
    readCitedObservations(client, subject, evaluation).then(
      (observations) => current && setState({ observations, loading: false, error: null }),
      (error: unknown) =>
        current &&
        setState({
          observations: [],
          loading: false,
          error: error instanceof Error ? error.message : 'The cited observations could not be read.',
        }),
    );
    return () => {
      current = false;
    };
    // The evaluation id identifies everything it cites.
  }, [client, applies, subject.kind, subject.id, subject.scope, subject.sourceId, evaluation.id]);
  return state;
}
