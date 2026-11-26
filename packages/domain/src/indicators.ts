import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import {
  INDICATOR_LIMITS,
  IndicatorDefinitionContentSchema,
  subjectReferenceKey,
  type IndicatorDefinition,
  type IndicatorDefinitionContent,
  type IndicatorEvents,
  type IndicatorPopulation,
  type IndicatorResult,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest, canonicalize } from '@ledger/integrity';
import { utcMillis } from './check-kinds.js';
import {
  compare,
  divide,
  formatDecimal,
  multiply,
  parseDecimal,
  rational,
  rationalView,
  type Rational,
} from './indicator-arithmetic.js';
import {
  exposureParameterProblem,
  findExposureKind,
  matchesCondition,
  registeredExposureKindDigest,
  spanStartMillis,
  type IndicatorObservation,
} from './indicator-exposure-kinds.js';

/** A finding the generic evaluator opened, as an indicator counts it. */
export interface IndicatorFinding {
  kind: 'finding';
  id: string;
  subject: SubjectReference;
  packId: string;
  ruleId: string;
  openedAt: string;
  /** For a finding opened on a plan: the start of the time the plan is about. It is placed no earlier. */
  plannedFrom?: string;
  /** The related subject of a finding from a rule that fans out; the finding counts for it too. */
  related?: SubjectReference;
}

/** One distinct issue a rule's evaluations of one subject named, as an indicator counts it. */
export interface IndicatorIssue {
  kind: 'issue';
  /** Stable for the rule, subject and issue name. */
  id: string;
  subject: SubjectReference;
  packId: string;
  ruleId: string;
  issue: string;
  /**
   * When the issue happened. issue: as the latest evaluation naming it said, by its check kind. evaluation: the kind
   * gives no time, so the issue is placed at the time of the first evaluation that named it.
   */
  time: { placedBy: 'issue' | 'evaluation'; start: string; end?: string; endUnknown?: true };
  /** Whether the latest evaluation naming the issue found the evidence conflicting. */
  conflicting: boolean;
}

export type IndicatorEvent = IndicatorFinding | IndicatorIssue | ({ kind: 'observation' } & IndicatorObservation);

/** Everything one calculation reads, already gathered. The calculation itself performs no I/O. */
export interface IndicatorCalculationInput {
  /** Half-open [start, end) in UTC. */
  window: { start: string; end: string };
  /** The evidence cut: nothing recorded after this instant was read. */
  recordedThrough: string;
  /** The control the indicator is calculated for, when there is one. */
  control: { id: string; version: number } | null;
  population: IndicatorPopulation;
  /** Whether gathering read everything in scope within its bounds, and which bound it reached otherwise. */
  /**
   * Whether gathering read everything in scope within its bounds, which bound it reached otherwise, and whether
   * evaluations or projections about the population were still outstanding at the time of reading.
   */
  selection: { complete: boolean; exceeded: string[]; pending?: boolean; evaluatedAfterCut?: boolean };
  events: readonly IndicatorEvent[];
  exposure: readonly IndicatorObservation[];
}

export type IndicatorDefinitionSpec = Omit<IndicatorDefinitionContent, 'format' | 'exposure'> & {
  exposure: { kind: string; version: number; params: Record<string, unknown> };
};

const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const validContent = ajv.compile(structuredClone(IndicatorDefinitionContentSchema));

/** Builds a definition from its declared content, pinning the registered exposure kind and the content by digest. */
export function defineIndicator(spec: IndicatorDefinitionSpec): IndicatorDefinition {
  const definitionDigest = registeredExposureKindDigest(spec.exposure.kind, spec.exposure.version);
  if (!definitionDigest)
    throw new Error(`Exposure kind ${spec.exposure.kind} version ${spec.exposure.version} is not registered`);
  const content: IndicatorDefinitionContent = structuredClone({
    format: 'ledger.indicator-definition.1',
    ...spec,
    exposure: { ...spec.exposure, definitionDigest },
  });
  const definition = { ...content, digest: canonicalDigest(content) };
  const problem = indicatorDefinitionProblem(definition);
  if (problem) throw new Error(problem);
  return definition;
}

function contentOf(definition: IndicatorDefinition): IndicatorDefinitionContent {
  const { digest: _digest, ...content } = definition;
  return content;
}

/** Returns a description of the first problem with a definition, or undefined. */
export function indicatorDefinitionProblem(definition: IndicatorDefinition): string | undefined {
  const content = contentOf(definition);
  const label = `Indicator ${String(definition.id)} version ${String(definition.version)}`;
  if (!validContent(content)) {
    const first = validContent.errors?.[0];
    return `${label}: ${first?.instancePath || '/'} ${first?.message ?? 'is invalid'}`;
  }
  if (canonicalDigest(content) !== definition.digest) return `${label} does not match its digest`;
  const { exposure, scope } = content;
  if (registeredExposureKindDigest(exposure.kind, exposure.version) !== exposure.definitionDigest)
    return `${label} pins exposure kind ${exposure.kind} version ${exposure.version}, which is not registered with that digest`;
  const parameters = exposureParameterProblem(exposure.kind, exposure.version, exposure.params);
  if (parameters) return `${label}: ${parameters}`;
  if (parseDecimal(content.completeness.exposureMustExceed) === undefined)
    return `${label}: exposureMustExceed is not a decimal`;
  if (content.limit && parseDecimal(content.limit.rate) === undefined) return `${label}: the limit is not a decimal`;
  if (scope.kind === 'subjects') {
    const keys = scope.subjects.map(subjectKeyOf);
    if (keys.some((key) => key === undefined)) return `${label} lists a source subject without its sourceId`;
    if (new Set(keys).size !== keys.length) return `${label} lists a subject twice`;
  }
  return undefined;
}

function subjectKeyOf(subject: SubjectReference): string | undefined {
  try {
    return subjectReferenceKey(subject);
  } catch {
    return undefined;
  }
}

// Registry --------------------------------------------------------------------------------------------------------

// One process can load this module both from source and from its build (tests do), so the registrations live on a
// process-wide key that both copies share.
const registryKey = Symbol.for('ledger.indicator-definition-registry.1');
const registry = ((globalThis as Record<symbol, Map<string, IndicatorDefinition> | undefined>)[registryKey] ??=
  new Map());

/**
 * Registers an indicator definition. Definitions belong with packs and example packages, never with core code.
 * Registering the same id and version again is accepted only with the same digest.
 */
export function registerIndicatorDefinition(definition: IndicatorDefinition): void {
  const problem = indicatorDefinitionProblem(definition);
  if (problem) throw new Error(problem);
  const key = `${definition.id}@${definition.version}`;
  const existing = registry.get(key);
  if (existing) {
    if (existing.digest !== definition.digest)
      throw new Error(
        `Indicator ${definition.id} version ${definition.version} is already registered with another definition`,
      );
    return;
  }
  registry.set(key, Object.freeze(structuredClone(definition)));
}

export function findIndicatorDefinition(id: string, version: number): IndicatorDefinition | undefined {
  const definition = registry.get(`${id}@${version}`);
  return definition ? structuredClone(definition) : undefined;
}

export function listIndicatorDefinitions(): IndicatorDefinition[] {
  return [...registry.values()].map((definition) => structuredClone(definition));
}

// Calculation -----------------------------------------------------------------------------------------------------

/** The id an issue event carries: a digest of the rule, the subject and the issue name. */
export function indicatorIssueId(packId: string, ruleId: string, subject: SubjectReference, issue: string): string {
  return `issue:${canonicalDigest({ packId, ruleId, subject: subjectReferenceKey(subject), issue })}`;
}

/** The evaluation fields an issue event is built from. */
export type IssueEvaluation = Pick<
  RuleEvaluationRecord,
  'issues' | 'issueTimes' | 'evidenceState' | 'recordedAt' | 'clock' | 'readAsPlans'
>;

/** Where an evaluation places what it names when its check gives no time: when it ran, or when the plans it read begin. */
function evaluationTime(evaluation: IssueEvaluation): string {
  const planned = evaluation.readAsPlans?.from;
  return planned && Date.parse(planned) > Date.parse(evaluation.clock.evaluatedAt)
    ? planned
    : evaluation.clock.evaluatedAt;
}

/**
 * One event per distinct issue the evaluations of one subject name: when it happened, by the latest evaluation that
 * says so, else by the first evaluation that named it; and whether the latest naming evaluation found a conflict.
 */
export function issueEvents(
  rule: { packId: string; ruleId: string },
  subject: SubjectReference,
  evaluations: readonly IssueEvaluation[],
): IndicatorIssue[] {
  const oldestFirst = [...evaluations].sort(
    (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt),
  );
  const found = new Map<string, IndicatorIssue>();
  for (const evaluation of oldestFirst)
    for (const issue of new Set(evaluation.issues ?? [])) {
      const stated = evaluation.issueTimes?.find((time) => time.issue === issue);
      const previous = found.get(issue);
      const time: IndicatorIssue['time'] = stated
        ? {
            placedBy: 'issue',
            start: stated.start,
            ...(stated.end ? { end: stated.end } : {}),
            ...(stated.endUnknown ? { endUnknown: true as const } : {}),
          }
        : previous?.time.placedBy === 'issue'
          ? previous.time
          : (previous?.time ?? { placedBy: 'evaluation', start: evaluationTime(evaluation) });
      found.set(issue, {
        kind: 'issue',
        id: indicatorIssueId(rule.packId, rule.ruleId, subject, issue),
        subject: structuredClone(subject),
        packId: rule.packId,
        ruleId: rule.ruleId,
        issue,
        time,
        conflicting: evaluation.evidenceState === 'conflicting',
      });
    }
  return [...found.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** The rules an issue selection counts: the named rule, then any further rules. */
export function issueRules(events: Extract<IndicatorEvents, { kind: 'issues' }>): { packId: string; ruleId: string }[] {
  return [{ packId: events.packId, ruleId: events.ruleId }, ...(events.alsoRules ?? [])];
}

/** The event id a subject counted once carries: a digest of its key. */
function subjectEventId(event: IndicatorEvent): string {
  return `subject:${canonicalDigest({ subject: subjectKeyOf(eventSubjects(event)[0]!) })}`;
}

type Placement = 'in' | 'out' | 'undetermined';

/** Whether an issue falls in the half-open window: by its interval, as continuing, or undetermined. */
function issuePlacement(time: IndicatorIssue['time'], start: number, end: number): Placement {
  const from = utcMillis(time.start);
  if (from === undefined) return 'undetermined';
  if (from >= end) return 'out';
  if (from >= start) return 'in';
  if (time.end !== undefined) {
    const to = utcMillis(time.end);
    return to === undefined ? 'undetermined' : to > start ? 'in' : 'out';
  }
  // Begun before the window: one that continues is in it; one whose end is unknown cannot be placed.
  return time.endUnknown ? 'undetermined' : time.placedBy === 'evaluation' ? 'out' : 'in';
}

function eventMatches(events: IndicatorEvents, event: IndicatorEvent): boolean {
  if (events.kind === 'findings')
    return event.kind === 'finding' && event.packId === events.packId && event.ruleId === events.ruleId;
  if (events.kind === 'issues')
    return (
      event.kind === 'issue' &&
      issueRules(events).some((rule) => event.packId === rule.packId && event.ruleId === rule.ruleId)
    );
  return (
    event.kind === 'observation' &&
    event.type === events.type &&
    events.versions.includes(event.version) &&
    (!events.condition || matchesCondition(event, events.condition))
  );
}

/** When a finding counts: when it opened, or for one opened on a plan, no earlier than the time the plan is about. */
export function findingPlacement(finding: Pick<IndicatorFinding, 'openedAt' | 'plannedFrom'>): number | undefined {
  const opened = utcMillis(finding.openedAt);
  const planned = finding.plannedFrom === undefined ? undefined : utcMillis(finding.plannedFrom);
  return opened === undefined || planned === undefined ? opened : Math.max(opened, planned);
}

function eventPlacement(event: IndicatorEvent, start: number, end: number): Placement {
  if (event.kind === 'issue') return issuePlacement(event.time, start, end);
  const at = event.kind === 'finding' ? findingPlacement(event) : spanStartMillis(event);
  return at !== undefined && at >= start && at < end ? 'in' : 'out';
}

function eventSubjects(event: IndicatorEvent): SubjectReference[] {
  if (event.kind === 'issue') return [event.subject];
  if (event.kind !== 'finding') return event.subjects;
  return event.related ? [event.subject, event.related] : [event.subject];
}

/** Keeps one item per id; the same id with different content is an identity conflict. */
function distinct<Item extends { id: string }>(items: readonly Item[], onConflict: (id: string) => void): Item[] {
  const byId = new Map<string, { item: Item; text: string }>();
  for (const item of items) {
    const text = canonicalize(item);
    const previous = byId.get(item.id);
    if (previous && previous.text !== text) onConflict(item.id);
    if (!previous) byId.set(item.id, { item, text });
  }
  return [...byId.values()].map(({ item }) => item);
}

function boundedInput(definition: IndicatorDefinition, input: IndicatorCalculationInput): [number, number] {
  const start = utcMillis(input.window.start),
    end = utcMillis(input.window.end);
  if (start === undefined || end === undefined || start >= end || utcMillis(input.recordedThrough) === undefined)
    throw new TypeError('An indicator calculation needs an ordered UTC window and a UTC evidence cut');
  if (end - start > definition.window.maxMilliseconds)
    throw new RangeError(`The window is longer than indicator ${definition.id} allows`);
  if (
    input.population.subjects.length > INDICATOR_LIMITS.maxSubjects ||
    input.events.length > INDICATOR_LIMITS.maxEvents ||
    input.exposure.length > INDICATOR_LIMITS.maxExposureObservations
  )
    throw new RangeError('Indicator inputs exceed their bound');
  return [start, end];
}

function populationProblem(
  definition: IndicatorDefinition,
  keys: (string | undefined)[],
  subjects: SubjectReference[],
) {
  if (keys.some((key) => key === undefined) || new Set(keys).size !== keys.length) return true;
  const scope = definition.scope;
  if (scope.kind === 'subjects') {
    const declared = scope.subjects.map((subject) => subjectReferenceKey(subject)).sort();
    return canonicalize(declared) !== canonicalize([...keys].sort());
  }
  return scope.kind === 'subject_kind' && subjects.some((subject) => subject.kind !== scope.subjectKind);
}

/** Each reason and limitation code the calculation gives, in a plain sentence for people. */
export const indicatorReasonSentences: Readonly<Record<string, string>> = Object.freeze({
  population_outside_scope: 'The declared population does not match the subjects this indicator counts.',
  population_not_declared_complete:
    'This indicator needs the population declared complete by a named person or source, and it is not.',
  selection_incomplete: 'Reading reached a limit before every record in scope was read.',
  evaluations_pending: 'Rule evaluations for the population were still due when the evidence was read.',
  window_open_at_cut: 'The evidence was read before the window ended.',
  event_identity_conflict: 'Two counted events share an identity but differ in content.',
  event_time_undetermined: 'An event began before the window and its end is unknown, so it cannot be placed.',
  event_evidence_conflicting: 'The latest evaluation behind a counted event found the evidence conflicting.',
  exposure_identity_conflict: 'Two records the exposure is measured from share an identity but differ in content.',
  exposure_conflicting: 'The records the exposure is measured from disagree.',
  exposure_coverage_gaps: 'This indicator needs the exposure records to show no gaps, and they show some.',
  exposure_not_positive: 'No exposure was measured in the window, so no rate can be stated.',
  exposure_not_above_minimum: 'The exposure measured is not above the minimum this indicator needs for a rate.',
  evaluations_recorded_after_cut:
    'The rule evaluated part of the population after the evidence was read; a later reading may differ.',
});

/**
 * Calculates an indicator over gathered inputs: events in scope and window, divided by the exposure the definition's
 * exposure kind measures. Pure and deterministic. The result states a rate only when every completeness requirement
 * holds; otherwise it is insufficient or conflicting, with reasons. It is evidence for a person, not a verdict.
 */
export function calculateIndicator(definition: IndicatorDefinition, input: IndicatorCalculationInput): IndicatorResult {
  const problem = indicatorDefinitionProblem(definition);
  if (problem) throw new TypeError(problem);
  const [start, end] = boundedInput(definition, input);
  const kind = findExposureKind(definition.exposure.kind, definition.exposure.version)!;
  const reasons = new Set<string>();
  let conflicting = false;
  const conflict = (code: string) => {
    reasons.add(code);
    conflicting = true;
  };

  const subjects = input.population.subjects;
  const subjectKeys = subjects.map(subjectKeyOf);
  if (populationProblem(definition, subjectKeys, subjects)) reasons.add('population_outside_scope');
  const inPopulation = new Set(subjectKeys);
  const touches = (named: SubjectReference[]) => named.some((subject) => inPopulation.has(subjectKeyOf(subject)));
  if (
    definition.completeness.populationDeclaredComplete &&
    (!input.population.complete || input.population.declaredBy === null)
  )
    reasons.add('population_not_declared_complete');
  if (!input.selection.complete) reasons.add('selection_incomplete');
  if (input.selection.pending) reasons.add('evaluations_pending');
  if (Date.parse(input.recordedThrough) < end) reasons.add('window_open_at_cut');

  const selected = distinct(input.events, () => conflict('event_identity_conflict')).filter(
    (event) => eventMatches(definition.events, event) && touches(eventSubjects(event)),
  );
  const events = selected.filter((event) => eventPlacement(event, start, end) === 'in');
  // Counting subjects, an issue that cannot be placed matters only for a subject no other issue counts.
  const bySubject = definition.events.kind === 'issues' && definition.events.countEach === 'subject';
  const countedSubjects = new Set(bySubject ? events.map(subjectEventId) : []);
  if (
    selected.some(
      (event) =>
        eventPlacement(event, start, end) === 'undetermined' &&
        !(bySubject && countedSubjects.has(subjectEventId(event))),
    )
  )
    reasons.add('event_time_undetermined');
  if (events.some((event) => event.kind === 'issue' && event.conflicting)) conflict('event_evidence_conflicting');
  const exposureInputs = distinct(input.exposure, () => conflict('exposure_identity_conflict')).filter((observation) =>
    touches(observation.subjects),
  );
  const measure = kind.measure(definition.exposure.params, exposureInputs, { start, end }, subjects);
  if (measure.conflicts.length) conflict('exposure_conflicting');
  if (measure.gaps.length && definition.completeness.coverageWithoutGaps) reasons.add('exposure_coverage_gaps');
  const exposure = measure.quantity;
  if (exposure.numerator === 0n) reasons.add('exposure_not_positive');
  else if (compare(exposure, parseDecimal(definition.completeness.exposureMustExceed)!) <= 0)
    reasons.add('exposure_not_above_minimum');

  const status = conflicting ? 'conflicting' : reasons.size ? 'insufficient' : 'supported';
  const eventIds = (bySubject ? [...countedSubjects] : events.map((event) => event.id)).sort();
  const definitionRef = { id: definition.id, version: definition.version, digest: definition.digest };
  const exposureKindRef = { id: kind.id, version: kind.version, digest: definition.exposure.definitionDigest };
  const population = {
    subjectCount: subjects.length,
    digest: canonicalDigest({ subjects: [...subjectKeys].sort() }),
    complete: input.population.complete,
    declaredBy: input.population.declaredBy ? { ...input.population.declaredBy } : null,
  };
  const digits = definition.unit.fractionDigits;
  let rate: IndicatorResult['rate'] = null;
  if (status === 'supported') {
    const value: Rational = divide(
      multiply(rational(BigInt(eventIds.length)), rational(BigInt(definition.unit.per))),
      exposure,
    );
    rate = {
      value: rationalView(value),
      decimal: formatDecimal(value, digits),
      per: definition.unit.per,
      label: definition.unit.label,
    };
  }
  return {
    version: 'ledger.indicator-result.1',
    definition: definitionRef,
    exposureKind: exposureKindRef,
    control: input.control ? { ...input.control } : null,
    window: { start: input.window.start, end: input.window.end },
    recordedThrough: input.recordedThrough,
    status,
    eventCount: eventIds.length,
    exposure: {
      value: rationalView(exposure),
      decimal: formatDecimal(exposure, digits),
      unit: kind.unit,
      coverage: kind.coverage,
      gaps: measure.gaps.map((item) => structuredClone(item)),
      conflicts: measure.conflicts.map((item) => structuredClone(item)),
    },
    rate,
    reasons: [...reasons].sort(),
    ...(input.selection.evaluatedAfterCut ? { limitations: ['evaluations_recorded_after_cut'] } : {}),
    ...(definition.events.kind === 'issues'
      ? {
          eventsPlacedBy: [
            ...new Set(events.flatMap((event) => (event.kind === 'issue' ? [event.time.placedBy] : []))),
          ].sort(),
        }
      : {}),
    population,
    counted: { events: eventIds, exposure: [...measure.counted] },
    inputDigest: canonicalDigest({
      format: 'ledger.indicator-input.1',
      definition: definitionRef,
      exposureKind: exposureKindRef,
      control: input.control,
      window: { start: input.window.start, end: input.window.end },
      population: { digest: population.digest, complete: population.complete, declaredBy: population.declaredBy },
      events: eventIds,
      exposure: [...measure.counted],
    }),
  };
}
