import type {
  AdoptionParameterValues,
  CheckDetails,
  CheckedRuleLeaf,
  IssueTime,
  RuleAdoptionParameter,
  RetainedDocumentSource,
  RulePackVersion,
  RuleRead,
} from '@ledger/contracts';
import {
  isCheckedRuleLeaf,
  isRetainedDocumentSource,
  RECORD_FOR_LATER_TIME,
  RECORD_NOT_ON_FILE,
  RuleWordingPlaceholderPattern,
  localizeInstants,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  checkParameterProblem,
  findCheckKind,
  latestObservations,
  observationField,
  observationMatches,
  registeredCheckKindDigest,
  spanStart,
  utcMillis,
  type CheckClock,
  type CheckInputs,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import './check-kind-library.js';
import { fieldLabel, readTitle, valueLabel } from './field-labels.js';
import { relatedSubjectProblem } from './related-subjects.js';
import { sessionReadProblem } from './session-reads.js';

/** What a pack author writes; `defineCheckedRule` adds the pinned hashes, offsets and digests. */
export interface CheckedRuleSpec {
  id: string;
  version: number;
  title: string;
  source:
    | {
        kind: 'operator_procedure' | 'waiver_or_exemption';
        reference: string;
        text: string;
        /** UTF-16 offsets into text; stored as UTF-8 byte offsets. Defaults to the whole text. */
        span?: { start: number; end: number };
      }
    /** A paragraph already pinned into a retained document; kept as given. */
    | RetainedDocumentSource;
  target: CheckedRuleLeaf['target'];
  reads: CheckedRuleLeaf['reads'];
  check: { kind: CheckKind; params?: Record<string, unknown> };
  adoptionParameters?: CheckedRuleLeaf['adoptionParameters'];
  applicability?: CheckedRuleLeaf['applicability'];
  subjectState?: CheckedRuleLeaf['subjectState'];
  wording?: CheckedRuleLeaf['wording'];
  related?: CheckedRuleLeaf['related'];
  relieves?: CheckedRuleLeaf['relieves'];
  population?: CheckedRuleLeaf['population'];
  waitEnds?: CheckedRuleLeaf['waitEnds'];
  section?: CheckedRuleLeaf['section'];
  paragraph?: CheckedRuleLeaf['paragraph'];
}

/**
 * A rule with the population it is meant for, and each named read made required with what a person calls its record,
 * so a member without that record is reported as "No … on file" (docs/design/rule-coverage.md).
 */
export function withPopulation<Spec extends Pick<CheckedRuleSpec, 'reads'>>(
  spec: Spec,
  population: NonNullable<CheckedRuleLeaf['population']>,
  onFile: Readonly<Record<string, string>> = {},
): Spec & { population: NonNullable<CheckedRuleLeaf['population']> } {
  const unknown = Object.keys(onFile).find((name) => !spec.reads.some((read) => read.name === name));
  if (unknown) throw new Error(`No read ${unknown} to name a record for`);
  return {
    ...spec,
    reads: spec.reads.map((read) =>
      onFile[read.name] === undefined ? read : { ...read, required: true, onFile: onFile[read.name] },
    ),
    population,
  };
}

/** Builds a checked rule leaf with its source hash, byte offsets, check definition digest and leaf digest. */
export function defineCheckedRule(spec: CheckedRuleSpec): CheckedRuleLeaf {
  const content: Omit<CheckedRuleLeaf, 'digest'> = {
    id: spec.id,
    version: spec.version,
    title: spec.title,
    source: isRetainedDocumentSource(spec.source) ? structuredClone(spec.source) : procedureSource(spec.source),
    review: 'ai_drafted',
    adopted: false,
    coverage: 'automated',
    target: { ...spec.target },
    reads: structuredClone(spec.reads),
    check: {
      kind: spec.check.kind.id,
      version: spec.check.kind.version,
      definitionDigest: registeredCheckKindDigest(spec.check.kind.id, spec.check.kind.version) ?? '',
      params: structuredClone(spec.check.params ?? {}),
    },
    adoptionParameters: structuredClone(spec.adoptionParameters ?? []),
    applicability: structuredClone(spec.applicability ?? []),
    // Optional parts are left out when absent, so leaves that use none keep their digests.
    ...(spec.subjectState ? { subjectState: { ...spec.subjectState } } : {}),
    ...(spec.wording ? { wording: { ...spec.wording } } : {}),
    ...(spec.related ? { related: structuredClone(spec.related) } : {}),
    ...(spec.relieves ? { relieves: structuredClone(spec.relieves) } : {}),
    ...(spec.population ? { population: structuredClone(spec.population) } : {}),
    ...(spec.waitEnds ? { waitEnds: { ...spec.waitEnds } } : {}),
    ...(spec.section ? { section: spec.section } : {}),
    ...(spec.paragraph ? { paragraph: spec.paragraph } : {}),
  };
  const leaf = { ...content, digest: canonicalDigest(content) };
  const problem = checkedRuleProblem(leaf);
  if (problem) throw new Error(problem);
  return leaf;
}

function procedureSource(
  source: Exclude<CheckedRuleSpec['source'], RetainedDocumentSource>,
): CheckedRuleLeaf['source'] {
  const bytes = Buffer.from(source.text, 'utf8');
  const span = source.span ?? { start: 0, end: source.text.length };
  return {
    kind: source.kind,
    reference: source.reference,
    text: source.text,
    encoding: 'utf-8',
    byteLength: bytes.length,
    sha256: sha256(bytes),
    textSpan: {
      start: Buffer.byteLength(source.text.slice(0, span.start), 'utf8'),
      end: Buffer.byteLength(source.text.slice(0, span.end), 'utf8'),
      unit: 'utf8_byte',
    },
  };
}

/** Describes the first reason a checked rule leaf cannot run, or returns undefined. */
export function checkedRuleProblem(leaf: CheckedRuleLeaf): string | undefined {
  const { digest, ...content } = leaf;
  const label = `Rule ${leaf.id} version ${leaf.version}`;
  if (canonicalDigest(content) !== digest) return `${label} does not match its digest`;
  const bytes = Buffer.from(leaf.source.text, 'utf8');
  if (bytes.length !== leaf.source.byteLength || sha256(bytes) !== leaf.source.sha256)
    return `${label} does not match its pinned source text`;
  const { start, end } = leaf.source.textSpan;
  // A retained-document span locates the text in its document; the registry compares it with the document bytes.
  const outside = isRetainedDocumentSource(leaf.source)
    ? end - start !== bytes.length || leaf.source.textSpan.sourceId !== leaf.source.document.sourceId
    : start > end || end > bytes.length;
  if (outside) return `${label} has a source span outside its text`;
  const kind = findCheckKind(leaf.check.kind, leaf.check.version);
  if (!kind)
    return `${label} uses check kind ${leaf.check.kind} version ${leaf.check.version}, which is not registered`;
  if (registeredCheckKindDigest(kind.id, kind.version) !== leaf.check.definitionDigest)
    return `${label} pins a different definition of check kind ${kind.id} version ${kind.version}`;
  const names = [...leaf.reads.map((read) => read.name), ...(leaf.subjectState ? [leaf.subjectState.name] : [])];
  if (new Set(names).size !== names.length) return `${label} names an input twice`;
  const missing = kind.inputs.filter((input) => !input.optional && !names.includes(input.name));
  if (missing.length) return `${label} does not read the check's input ${missing[0]!.name}`;
  const parameterNames = leaf.adoptionParameters.map((parameter) => parameter.name);
  if (new Set(parameterNames).size !== parameterNames.length) return `${label} declares an adoption parameter twice`;
  const fixed = parameterNames.find((name) => Object.hasOwn(leaf.check.params, name));
  if (fixed) return `${label} both fixes and asks for parameter ${fixed}`;
  const condition = leaf.applicability.find((item) => !names.includes(item.input));
  if (condition) return `${label} has an applicability condition on unread input ${condition.input}`;
  if (leaf.applicability.some((item) => item.notMetSummary && verdictWords.test(item.notMetSummary)))
    return `${label} has an applicability summary that states a verdict`;
  const unrequired = leaf.reads.find((read) => read.onFile !== undefined && !read.required);
  if (unrequired) return `${label} names the record ${unrequired.name} takes, but does not require it`;
  const anchorProblem = leaf.reads.map((read, index) => readAnchorProblem(leaf, read, index)).find(Boolean);
  if (anchorProblem) return `${label} ${anchorProblem}`;
  const related = relatedSubjectProblem(leaf);
  if (related) return `${label} ${related}`;
  const session = sessionReadProblem(leaf);
  if (session) return `${label} ${session}`;
  const wording = wordingProblem(leaf, kind);
  if (wording) return `${label} ${wording}`;
  if (leaf.waitEnds && !names.includes(leaf.waitEnds.read))
    return `${label} stops waiting by unread input ${leaf.waitEnds.read}`;
  if (leaf.relieves && leaf.source.kind !== 'waiver_or_exemption')
    return `${label} declares relief but does not quote a waiver or exemption`;
  return undefined;
}

function anchorOf(read: RuleRead) {
  return typeof read.select === 'object' && 'latestAtOrBefore' in read.select
    ? read.select.latestAtOrBefore
    : undefined;
}

/** The window a read selects within, when it selects by one. */
export function readWindowOf(read: RuleRead) {
  return typeof read.select === 'object' && 'within' in read.select ? read.select.within : undefined;
}

function readAnchorProblem(leaf: CheckedRuleLeaf, read: RuleRead, index: number): string | undefined {
  const anchor = anchorOf(read) ?? readWindowOf(read);
  if (!anchor) return undefined;
  const earlier = leaf.reads.slice(0, index).some((other) => other.name === anchor.read);
  if (earlier || leaf.subjectState?.name === anchor.read) return undefined;
  return `selects ${read.name} by ${anchor.read}, which is not the subject state or an earlier read`;
}

const placeholderPattern = new RegExp(RuleWordingPlaceholderPattern, 'g');
// Wording restates what the check found; it never states a verdict on its own.
const verdictWords = /\b(non-?compliant|compliant|compliance|un-?authori[sz]ed|authori[sz]ed|no-go|go)\b/i;

function placeholders(template: string): string[] {
  return [...template.matchAll(placeholderPattern)].map((match) => match[1]!);
}

function wordingProblem(leaf: CheckedRuleLeaf, kind: CheckKind): string | undefined {
  const declared = new Set((kind.details ?? []).map((detail) => detail.name));
  for (const [outcome, template] of Object.entries(leaf.wording ?? {})) {
    if (template === undefined) continue;
    if (/[{}]/.test(template.replace(placeholderPattern, '')))
      return `has ${outcome} wording with a brace that is not a {name} placeholder`;
    const missing = placeholders(template).find((name) => !declared.has(name));
    if (missing) return `has ${outcome} wording naming ${missing}, which check kind ${kind.id} does not return`;
    if (verdictWords.test(template)) return `has ${outcome} wording that states a verdict`;
  }
  return undefined;
}

/** The valid instants in the named field of the anchor input's latest observations. */
function anchorInstants(anchor: { read: string; field: string }, inputs: CheckInputs): Set<number> {
  return new Set(
    latestObservations(inputs[anchor.read] ?? []).flatMap(
      (item) => utcMillis(observationField(item, anchor.field)) ?? [],
    ),
  );
}

/** The single valid instant in the named field of the anchor input's latest observations, or undefined. */
function anchorInstant(anchor: { read: string; field: string }, inputs: CheckInputs): number | undefined {
  const instants = anchorInstants(anchor, inputs);
  return instants.size === 1 ? [...instants][0] : undefined;
}

/**
 * The window a read selects within, from the inputs already read: undefined for a read without one, null when the
 * window has no single valid start, or states more than one end, or an end before its start (the read is then
 * empty). Without an end the window reaches to the evaluation time.
 */
export function readWindow(read: RuleRead, inputs: CheckInputs): { start: number; end?: number } | null | undefined {
  const window = readWindowOf(read);
  if (!window) return undefined;
  const start = anchorInstant({ read: window.read, field: window.startField }, inputs);
  const ends = anchorInstants({ read: window.read, field: window.endField }, inputs);
  if (start === undefined || ends.size > 1) return null;
  const end = [...ends][0];
  if (end === undefined) return { start };
  return end >= start ? { start, end } : null;
}

/**
 * The latest instant a read may select at, from the inputs already read: undefined for a read with no anchor,
 * null when its anchor holds no single valid instant (the read is then empty).
 */
export function readUpperBound(read: RuleRead, inputs: CheckInputs): number | null | undefined {
  const window = readWindow(read, inputs);
  if (window !== undefined) return window === null ? null : window.end;
  const anchor = anchorOf(read);
  if (!anchor) return undefined;
  return anchorInstant(anchor, inputs) ?? null;
}

/**
 * Narrows one read's observations, newest first, to what the rule reads: those meeting its conditions, at or
 * before its anchor or inside its window, and for a latest selection those sharing the newest span start. The engine applies this
 * before required inputs, applicability and the check.
 */
export function narrowRead(
  read: RuleRead,
  observations: readonly CheckObservation[],
  inputs: CheckInputs,
): CheckObservation[] {
  const bound = readUpperBound(read, inputs);
  if (bound === null) return [];
  const from = readWindow(read, inputs)?.start ?? -Infinity;
  const kept = observations.filter((item) => {
    const at = Date.parse(spanStart(item));
    return observationMatches(item, read.where) && at >= from && (bound === undefined || at <= bound);
  });
  return read.select === 'all' || readWindowOf(read) ? kept : latestObservations(kept);
}

/** Describes the first problem with every checked rule leaf in a pack version, or returns undefined. */
export function checkedPackProblem(pack: RulePackVersion): string | undefined {
  for (const leaf of pack.leaves) {
    if (!isCheckedRuleLeaf(leaf)) continue;
    const problem = checkedRuleProblem(leaf);
    if (problem) return problem;
  }
  return undefined;
}

function parameterValueProblem(parameter: RuleAdoptionParameter, value: unknown): string | undefined {
  const valid =
    parameter.valueType === 'boolean'
      ? typeof value === 'boolean'
      : parameter.valueType === 'string'
        ? typeof value === 'string' && (!parameter.options || parameter.options.includes(value))
        : typeof value === 'number' &&
          Number.isFinite(value) &&
          (parameter.valueType === 'number' || Number.isSafeInteger(value)) &&
          (parameter.minimum === undefined || value >= parameter.minimum) &&
          (parameter.maximum === undefined || value <= parameter.maximum);
  return valid ? undefined : `Parameter ${parameter.name} is not a valid ${parameter.valueType}`;
}

/** The check parameters for one leaf under one adoption: the rule's fixed values plus the organization's values. */
export function checkParameters(leaf: CheckedRuleLeaf, values: AdoptionParameterValues | undefined) {
  return { ...leaf.check.params, ...(values?.[leaf.id] ?? {}) };
}

/**
 * Describes the first problem with the parameter values an adoption supplies for a pack, or returns undefined.
 * Every declared parameter needs a valid value, nothing undeclared may be supplied, and the merged parameters must
 * match the check kind's schema.
 */
export function adoptionParameterProblem(
  pack: RulePackVersion,
  values: AdoptionParameterValues | undefined,
): string | undefined {
  const checked = pack.leaves.filter(isCheckedRuleLeaf);
  for (const leafId of Object.keys(values ?? {}))
    if (!checked.some((leaf) => leaf.id === leafId && leaf.adoptionParameters.length))
      return `Leaf ${leafId} takes no adoption parameters`;
  for (const leaf of checked) {
    const supplied = values?.[leaf.id] ?? {};
    for (const name of Object.keys(supplied))
      if (!leaf.adoptionParameters.some((parameter) => parameter.name === name))
        return `Leaf ${leaf.id} does not declare parameter ${name}`;
    for (const parameter of leaf.adoptionParameters) {
      if (!Object.hasOwn(supplied, parameter.name)) return `Leaf ${leaf.id} needs parameter ${parameter.name}`;
      const problem = parameterValueProblem(parameter, supplied[parameter.name]);
      if (problem) return `Leaf ${leaf.id}: ${problem}`;
    }
    const problem = checkParameterProblem(leaf.check.kind, leaf.check.version, checkParameters(leaf, values));
    if (problem) return `Leaf ${leaf.id}: ${problem}`;
  }
  return undefined;
}

export interface CheckedRuleOutcome extends CheckResult {
  applicability: 'applicable' | 'not_applicable';
}

/** Sentences joined once each: two reads of one record say it is missing once. */
const sentences = (list: readonly string[]) => [...new Set(list)].join(' ');

/** "A" or "An" before a phrase, by its first letter. */
function withArticle(phrase: string): string {
  return `${/^[aeiou]/i.test(phrase) ? 'An' : 'A'} ${phrase}`;
}

/**
 * Runs one checked rule on gathered inputs. The engine part of an evaluation that needs no database: applicability
 * and missing required inputs are decided here, and the check runs only when both allow it. `later` names, by read,
 * when the earliest record a required read would take starts, for a read that came back empty only because its
 * records are about a time that has not come.
 */
export function runCheckedRule(
  leaf: CheckedRuleLeaf,
  parameters: Record<string, unknown>,
  inputs: CheckInputs,
  clock: CheckClock,
  later: Readonly<Record<string, string>> = {},
): CheckedRuleOutcome {
  const now = wallClock(clock);
  const outcome = engineDecision(leaf, inputs, now, later) ?? checkOutcome(leaf, parameters, inputs, clock, now);
  return waitEnded(leaf, inputs, outcome, now);
}

const HOUR = 3_600_000;

/**
 * A result waiting for a record, once the rule's time to wait has passed: the record is not on file. Before then, the
 * end of the wait is a boundary at which the rule is evaluated again.
 */
function waitEnded(
  leaf: CheckedRuleLeaf,
  inputs: CheckInputs,
  outcome: CheckedRuleOutcome,
  now: number,
): CheckedRuleOutcome {
  const wait = leaf.waitEnds;
  if (!wait || outcome.outcome !== 'pending' || outcome.reasonCode === RECORD_NOT_ON_FILE) return outcome;
  const timed = (inputs[wait.read] ?? []).flatMap((observation) => {
    const at = utcMillis(observationField(observation, wait.field));
    return at === undefined ? [] : [{ observation, at }];
  });
  if (!timed.length) return outcome;
  const latest = timed.reduce((most, item) => (item.at > most.at ? item : most));
  const ends = latest.at + wait.afterHours * HOUR;
  if (now < ends) {
    const boundary = utcMillis(outcome.nextBoundary);
    return boundary !== undefined && boundary <= ends
      ? outcome
      : { ...outcome, nextBoundary: new Date(ends).toISOString() };
  }
  const allowed = wait.afterHours % 24 === 0 ? `${wait.afterHours / 24} days` : `${wait.afterHours} hours`;
  const { nextBoundary: _waitedFor, ...rest } = outcome;
  return {
    ...rest,
    evidenceState: 'insufficient',
    outcome: 'pending',
    reasonCode: RECORD_NOT_ON_FILE,
    summary: `No ${wait.onFile} on file ${allowed} after ${wait.describes} at ${new Date(latest.at).toISOString()}. ${outcome.summary}`,
    evidence: [...new Set([...outcome.evidence, latest.observation.id])],
  };
}

function wallClock(clock: CheckClock): number {
  const now = utcMillis(clock.evaluatedAt);
  if (clock.mode !== 'wall' || now === undefined)
    throw new TypeError('A rule evaluation needs an explicit valid UTC wall clock');
  return now;
}

/** True for a read about the evaluated subject or the organization that no other read selects for. */
function ownRead(read: RuleRead): boolean {
  return (read.about === 'target' || read.about === 'organization') && !anchorOf(read) && !readWindowOf(read);
}

/**
 * For a rule with related subjects: the result its applicability conditions on a record of the evaluated subject's
 * own decide before any related subject is read. Only a condition on a required read that names its record (onFile)
 * decides first. A condition not met makes the rule not apply, once for the subject; a required record of the
 * subject's own that is not on file is reported once. Undefined when the rule has no such condition, or its
 * conditions are met, and the related subjects decide.
 */
export function evaluatedSubjectDecision(
  leaf: CheckedRuleLeaf,
  inputs: CheckInputs,
  clock: CheckClock,
  later: Readonly<Record<string, string>> = {},
): CheckedRuleOutcome | undefined {
  const own = leaf.reads.filter(ownRead);
  const applicability = leaf.applicability.filter((condition) =>
    own.some((read) => read.name === condition.input && read.required && read.onFile),
  );
  if (!applicability.length) return undefined;
  const reads = own.filter((read) => read.required || applicability.some((condition) => condition.input === read.name));
  const { subjectState, ...rule } = leaf;
  void subjectState;
  return engineDecision({ ...rule, reads, applicability }, inputs, wallClock(clock), later);
}

/** What the engine decides without the check: the rule does not apply, or a record it requires is missing. */
function engineDecision(
  leaf: CheckedRuleLeaf,
  inputs: CheckInputs,
  now: number,
  later: Readonly<Record<string, string>>,
): CheckedRuleOutcome | undefined {
  const titleOf = (name: string) => {
    const read = leaf.reads.find((item) => item.name === name);
    return read ? readTitle(read) : name;
  };
  for (const condition of leaf.applicability) {
    const latest = latestObservations(inputs[condition.input] ?? []);
    const values = latest.map((observation) => observationField(observation, condition.field));
    // A required record a person names that is not on file is reported as such below, before any later condition.
    if (!latest.length && leaf.reads.some((read) => read.name === condition.input && read.required && read.onFile))
      break;
    if (!latest.length) {
      if (condition.whenAbsent === 'applies') continue;
      if (condition.whenAbsent === 'not_applicable')
        return notApplicable('applicability_input_absent', `No ${titleOf(condition.input)} is recorded.`, []);
      return {
        applicability: 'applicable',
        evidenceState: 'insufficient',
        outcome: 'pending',
        reasonCode: 'applicability_input_missing',
        summary: `Whether the rule applies depends on the ${titleOf(condition.input)}, which is not recorded.`,
        evidence: [],
      };
    }
    if (!values.some((value) => condition.oneOf.includes(value as string | number | boolean)))
      return notApplicable(
        'condition_not_met',
        condition.notMetSummary ??
          `The rule does not apply: ${fieldLabel(condition.field, latest)} is not ${condition.oneOf.map((value) => valueLabel(condition.field, value, latest)).join(' or ')}.`,
        latest.map((observation) => observation.id),
      );
  }
  const state = leaf.subjectState;
  if (state?.required && !(inputs[state.name] ?? []).length)
    return {
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
      summary: `Ledger holds no state for the subject, which required input ${state.name} reads.`,
      evidence: [],
    };
  const missing = leaf.reads.filter((read) => read.required && !(inputs[read.name] ?? []).length);
  const laterFor = (read: RuleRead) => (read.plans ? undefined : utcMillis(later[read.name]));
  const awaited = (read: RuleRead) =>
    `${withArticle(readTitle(read))} is on file for a later time; the rule reads it from ${later[read.name]}.`;
  const starts = missing.map(laterFor);
  if (missing.length && starts.every((start) => start !== undefined && start > now))
    return {
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: RECORD_FOR_LATER_TIME,
      summary: sentences(missing.map(awaited)),
      evidence: [],
      nextBoundary: new Date(Math.min(...(starts as number[]))).toISOString(),
    };
  const absent = (read: RuleRead, words: string) => (laterFor(read) === undefined ? words : awaited(read));
  if (missing.length && missing.every((read) => read.onFile !== undefined))
    return {
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: RECORD_NOT_ON_FILE,
      summary: sentences(missing.map((read) => absent(read, `No ${read.onFile} on file.`))),
      evidence: [],
    };
  if (missing.length)
    return {
      applicability: 'applicable',
      evidenceState: 'insufficient',
      outcome: 'pending',
      reasonCode: 'required_input_missing',
      summary: sentences(missing.map((read) => absent(read, `No ${readTitle(read)} is recorded.`))),
      evidence: [],
    };
  return undefined;
}

function checkOutcome(
  leaf: CheckedRuleLeaf,
  parameters: Record<string, unknown>,
  inputs: CheckInputs,
  clock: CheckClock,
  now: number,
): CheckedRuleOutcome {
  const kind = findCheckKind(leaf.check.kind, leaf.check.version);
  if (!kind || registeredCheckKindDigest(kind.id, kind.version) !== leaf.check.definitionDigest)
    throw new Error(`Check kind ${leaf.check.kind} version ${leaf.check.version} is unavailable as pinned`);
  const problem = checkParameterProblem(kind.id, kind.version, parameters);
  if (problem) throw new Error(problem);
  const outcome = kind.evaluate(structuredClone(parameters), inputs, { ...clock });
  const known = new Set(Object.values(inputs).flatMap((observations) => observations.map((item) => item.id)));
  const boundary = utcMillis(outcome.nextBoundary);
  const details = declaredDetails(kind, outcome.details);
  return {
    applicability: outcome.outcome === 'not_applicable' ? 'not_applicable' : 'applicable',
    evidenceState: outcome.evidenceState,
    outcome: outcome.outcome,
    reasonCode: outcome.reasonCode,
    summary: withNotCounted(worded(leaf.wording?.[outcome.outcome], details) ?? outcome.summary, outcome),
    evidence: [...new Set(outcome.evidence)].filter((id) => known.has(id)),
    ...(boundary !== undefined && boundary > now ? { nextBoundary: new Date(boundary).toISOString() } : {}),
    ...(details ? { details } : {}),
    ...(kind.issues ? { issues: declaredIssues(outcome.issues) } : {}),
    ...(kind.issues?.timed
      ? { issueTimes: declaredIssueTimes(outcome.issueTimes, declaredIssues(outcome.issues)) }
      : {}),
  };
}

/** The summary followed by the records the check left out; those alone when it counted nothing else. */
function withNotCounted(summary: string, outcome: CheckResult): string {
  if (!outcome.notCounted) return summary;
  return outcome.outcome === 'not_applicable' ? outcome.notCounted : `${summary} ${outcome.notCounted}`;
}

/** One time per named issue, in issue order, each with an ordered UTC start and optional end. */
function declaredIssueTimes(times: readonly IssueTime[] | undefined, issues: readonly string[]): IssueTime[] {
  const byIssue = new Map<string, IssueTime>();
  for (const time of times ?? []) {
    const start = utcMillis(time.start);
    const end = time.end === undefined ? undefined : utcMillis(time.end);
    if (!issues.includes(time.issue) || byIssue.has(time.issue) || start === undefined) continue;
    if (time.end !== undefined && (end === undefined || end < start)) continue;
    byIssue.set(time.issue, {
      issue: time.issue,
      start: new Date(start).toISOString(),
      ...(end !== undefined ? { end: new Date(end).toISOString() } : {}),
      ...(time.end === undefined && time.endUnknown ? { endUnknown: true as const } : {}),
    });
  }
  return issues.flatMap((issue) => byIssue.get(issue) ?? []);
}

/** The issues as one sorted list of distinct bounded names. */
function declaredIssues(issues: readonly string[] | undefined): string[] {
  const kept = (issues ?? []).filter((issue) => typeof issue === 'string' && issue.length > 0 && issue.length <= 1000);
  return [...new Set(kept)].sort().slice(0, 500);
}

function isDetailValue(value: unknown): value is CheckDetails[string] {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 1000)
  );
}

/** The details the kind declares, with scalar values; undefined when none remain. */
function declaredDetails(kind: CheckKind, details: CheckDetails | undefined): CheckDetails | undefined {
  const declared = new Set((kind.details ?? []).map((detail) => detail.name));
  const kept = Object.entries(details ?? {}).filter(([name, value]) => declared.has(name) && isDetailValue(value));
  return kept.length ? Object.fromEntries(kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : undefined;
}

/** The rule's wording with every placeholder filled from the details, or undefined when one is not returned. */
export function worded(template: string | undefined, details: CheckDetails | undefined): string | undefined {
  if (template === undefined) return undefined;
  let complete = true;
  const text = template.replace(placeholderPattern, (_, name: string) => {
    const value = details?.[name];
    if (value === undefined || value === null) complete = false;
    return String(value);
  });
  return complete && text.length <= 2000 ? text : undefined;
}

const utcInstantText = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/;

/** The names of the values a kind's own summary may state: its summary values and the record fields it lists. */
function summaryValueNames(
  kind: Pick<CheckKind, 'summaryValues' | 'summaryRecordValues'>,
  values: CheckDetails | undefined,
): string[] {
  const sources = kind.summaryRecordValues ?? [];
  return [
    ...(kind.summaryValues ?? []),
    ...(sources.includes('nextBoundary') ? ['nextBoundary'] : []),
    ...(sources.includes('evidenceOccurredAt')
      ? Object.keys(values ?? {}).filter((name) => /^evidence\d+OccurredAt$/.test(name))
      : []),
  ];
}

/**
 * A check kind's own summary as wording: each value the kind names (`summaryValues`, `summaryRecordValues`) replaced
 * by its placeholder. The values are the record's details and recorded fields (`summaryRecordValues` in contracts).
 * Undefined unless filling it from those values gives the summary exactly, and unless every UTC instant in the
 * summary is such a value, so a screen never shows some times as recorded and others in a person's terms.
 */
export function checkSummaryWording(
  kind: Pick<CheckKind, 'summaryValues' | 'summaryRecordValues'>,
  summary: string,
  values: CheckDetails | undefined,
  timeZone?: string,
): string | undefined {
  // The recorded summary states each instant in the organization's zone (localizeInstants); the value is UTC.
  const named = summaryValueNames(kind, values)
    .flatMap((name) => {
      const value = values?.[name];
      if (typeof value !== 'string' || !value) return [];
      const stated = localizeInstants(value, timeZone);
      return summary.includes(stated) ? [{ name, value: stated }] : [];
    })
    .sort((a, b) => b.value.length - a.value.length);
  if (!named.length) return undefined;
  let template = summary;
  for (const { name, value } of named) template = template.split(value).join(`{${name}}`);
  if (utcInstantText.test(template) || template.length > 1000) return undefined;
  return localizeInstants(worded(template, values) ?? '', timeZone) === summary ? template : undefined;
}

function notApplicable(reasonCode: string, summary: string, evidence: string[]): CheckedRuleOutcome {
  return {
    applicability: 'not_applicable',
    evidenceState: 'not_applicable',
    outcome: 'not_applicable',
    reasonCode,
    summary,
    evidence,
  };
}
