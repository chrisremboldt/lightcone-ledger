import {
  INDICATOR_LIMITS,
  OBSERVATION_PAGE_LIMIT,
  SUBJECT_RECORD_PAGE_LIMIT,
  type AcceptedObservation,
  type AcceptedObservationSubject,
  type IndicatorDefinition,
  type IndicatorPopulation,
  type RuleEvaluationRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { utcMillis } from './check-kinds.js';
import { findExposureKind, type IndicatorObservation } from './indicator-exposure-kinds.js';
import {
  findIndicatorDefinition,
  findingPlacement,
  issueEvents,
  issueRules,
  type IndicatorCalculationInput,
  type IndicatorEvent,
} from './indicators.js';
import { listObservations } from './observations.js';
import { listRuleEvaluations, listSubjectFindings } from './rule-evaluation-reads.js';
import { getRulePackVersion, listRulePackVersions } from './rule-pack-registry.js';
import { dueRuleEvaluationWork } from './rule-evaluations.js';
import { RECORDS_ON_FILE_SOURCE } from './records-on-file.js';

export interface IndicatorGatherRequest {
  definition: { id: string; version: number };
  /** Half-open [start, end) in UTC, no longer than the definition allows. */
  window: { start: string; end: string };
  /** The evidence cut: observations received and findings opened after this instant are not read. */
  recordedThrough: string;
  /** Optionally also restrict observations to an accepted input cut (stream id to highest included sequence). */
  evidenceCut?: Record<string, number>;
  control?: { id: string; version: number } | null;
  /** The subjects in scope. Required unless the definition lists its subjects. */
  population?: IndicatorPopulation;
  /** Lower read bounds than the defaults, never higher. */
  limits?: { maxEvents?: number; maxExposureObservations?: number; maxEvaluations?: number };
}

export interface IndicatorGathering {
  definition: IndicatorDefinition;
  /** incomplete_selection: a bound was reached, so the input holds only part of what is recorded. */
  outcome: 'complete' | 'incomplete_selection';
  input: IndicatorCalculationInput;
}

interface Budget {
  remaining: number;
  exceeded: boolean;
}

function refsOf(subject: AcceptedObservationSubject, sourceId: string): SubjectReference[] {
  const kind = subject.kind as SubjectReference['kind'];
  const source: SubjectReference = { scope: 'source', kind, id: subject.id, sourceId };
  if (subject.scope === 'ledger') return [{ scope: 'ledger', kind, id: subject.id }];
  return subject.ledgerId ? [{ scope: 'ledger', kind, id: subject.ledgerId }, source] : [source];
}

function indicatorObservation(observation: AcceptedObservation): IndicatorObservation {
  return {
    id: observation.id,
    type: observation.type,
    version: observation.version,
    occurredAt: observation.occurredAt,
    ...(observation.interval ? { interval: { ...observation.interval } } : {}),
    subjects: [observation.subject, ...(observation.secondarySubject ? [observation.secondarySubject] : [])].flatMap(
      (subject) => refsOf(subject, observation.sourceId),
    ),
    observation: observation.observation,
  };
}

function subjectQuery(subject: SubjectReference) {
  return {
    subjectKind: subject.kind,
    subjectId: subject.id,
    subjectScope: subject.scope,
    ...(subject.scope === 'source' ? { sourceId: subject.sourceId } : {}),
  };
}

/** Reads every page of observations of one type and version about one subject, within the budget. */
async function readObservations(
  client: PoolClient,
  principal: AuthContext,
  subject: SubjectReference,
  read: { type: string; version: number; from: string; to: string },
  cut: { recordedThrough: number; streams?: Record<string, number> },
  into: Map<string, IndicatorObservation>,
  budget: Budget,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await listObservations(
      client,
      principal,
      {
        ...subjectQuery(subject),
        ...read,
        order: 'oldest_first',
        limit: OBSERVATION_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      },
      cut.streams ? { evidenceCut: cut.streams } : {},
    );
    for (const observation of page.observations)
      if (Date.parse(observation.receivedAt) <= cut.recordedThrough && !into.has(observation.id)) {
        if (budget.remaining === 0) {
          budget.exceeded = true;
          return;
        }
        into.set(observation.id, indicatorObservation(observation));
        budget.remaining--;
      }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
}

function leafReadsPlans(leaves: readonly { id: string; reads?: readonly { plans?: true }[] }[], ruleId: string) {
  return leaves.some((leaf) => leaf.id === ruleId && (leaf.reads ?? []).some((read) => read.plans));
}

/**
 * Whether the named rule can open a finding on a plan: some registered version of its leaf, or for a rule the registry
 * does not hold (an organization's accepted controls), some adoption of it by this tenant, has a read of plans.
 */
async function ruleReadsPlans(
  client: PoolClient,
  principal: AuthContext,
  rule: { packId: string; ruleId: string },
): Promise<boolean> {
  const registered = listRulePackVersions()
    .filter((summary) => summary.packId === rule.packId)
    .map((summary) => getRulePackVersion(summary.packId, summary.version)!.leaves);
  if (registered.some((leaves) => leaves.some((leaf) => leaf.id === rule.ruleId)))
    return registered.some((leaves) => leafReadsPlans(leaves, rule.ruleId));
  const adopted = await client.query<{ leaves: { id: string; reads?: { plans?: true }[] }[] }>(
    `SELECT record->'pack'->'leaves' AS leaves FROM organization_pack_adoptions WHERE tenant_id=$1 AND pack_id=$2`,
    [principal.tenantId, rule.packId],
  );
  return adopted.rows.some((row) => leafReadsPlans(row.leaves, rule.ruleId));
}

/**
 * Reads the findings the named rule opened for one subject inside the window, newest first, within the budget. Unless
 * the rule can open a finding on a plan, the read stops at the first finding opened before the window.
 */
async function readFindings(
  client: PoolClient,
  principal: AuthContext,
  subject: SubjectReference,
  rule: { packId: string; ruleId: string },
  window: { start: number; end: number; recordedThrough: number },
  into: Map<string, IndicatorEvent>,
  budget: Budget,
  readsPlans: boolean,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await listSubjectFindings(client, principal, {
      ...subjectQuery(subject),
      limit: SUBJECT_RECORD_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const finding of page.findings) {
      const openedAt = Date.parse(finding.openedAt);
      if (!readsPlans && openedAt < window.start) return;
      const plannedFrom = (finding.latestEvaluation.readAsPlans ?? finding.initialEvaluation.readAsPlans)?.from;
      const placed = findingPlacement({ openedAt: finding.openedAt, ...(plannedFrom ? { plannedFrom } : {}) })!;
      // Newest opened first: an older finding counts here only if it was opened on a plan about a later time.
      if (
        finding.packId !== rule.packId ||
        finding.ruleId !== rule.ruleId ||
        placed < window.start ||
        placed >= window.end ||
        openedAt > window.recordedThrough ||
        into.has(finding.id)
      )
        continue;
      if (budget.remaining === 0) {
        budget.exceeded = true;
        return;
      }
      into.set(finding.id, {
        kind: 'finding',
        id: finding.id,
        subject: { ...finding.subject },
        packId: finding.packId,
        ruleId: finding.ruleId,
        openedAt: finding.openedAt,
        ...(plannedFrom ? { plannedFrom } : {}),
        ...(finding.related ? { related: { ...finding.related.subject } } : {}),
      });
      budget.remaining--;
    }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
}

/**
 * Reads the named rules' active evaluations of one subject recorded through the cut and keeps each issue they name
 * once per rule. Shadow evaluations are left out, as their findings are never counted in what a person attests to.
 */
async function readIssues(
  client: PoolClient,
  principal: AuthContext,
  subject: SubjectReference,
  rules: readonly { packId: string; ruleId: string }[],
  recordedThrough: number,
  into: Map<string, IndicatorEvent>,
  budgets: { issues: Budget; evaluations: Budget },
  later: { found: boolean },
): Promise<void> {
  const evaluations: RuleEvaluationRecord[] = [];
  const named = (evaluation: RuleEvaluationRecord, rule: { packId: string; ruleId: string }) =>
    evaluation.pack.id === rule.packId && evaluation.rule.id === rule.ruleId;
  let cursor: string | undefined;
  read: do {
    const page = await listRuleEvaluations(client, principal, {
      ...subjectQuery(subject),
      limit: SUBJECT_RECORD_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const evaluation of page.evaluations) {
      if (!rules.some((rule) => named(evaluation, rule)) || evaluation.adoption.mode === 'shadow') continue;
      // Not read, but said: a calculation at a later cut may count what this evaluation names.
      if (Date.parse(evaluation.recordedAt) > recordedThrough) {
        later.found = true;
        continue;
      }
      if (budgets.evaluations.remaining === 0) {
        budgets.evaluations.exceeded = true;
        break read;
      }
      budgets.evaluations.remaining--;
      evaluations.push(evaluation);
    }
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
  const issues = rules.flatMap((rule) =>
    issueEvents(
      rule,
      subject,
      evaluations.filter((evaluation) => named(evaluation, rule)),
    ),
  );
  for (const issue of issues) {
    if (into.has(issue.id)) continue;
    if (budgets.issues.remaining === 0) {
      budgets.issues.exceeded = true;
      return;
    }
    into.set(issue.id, issue);
    budgets.issues.remaining--;
  }
}

/**
 * Whether anything that could change the evidence for the population is still outstanding: evaluations due for one of
 * its subjects, or inputs a source recorded at or before the cut that are not yet projected. Ledger's records of what
 * the organization keeps on file are not evidence about the population, so they are not waited for.
 */
async function pendingFor(client: PoolClient, subjects: readonly SubjectReference[], recordedThrough: number) {
  for (const subject of subjects) if ((await dueRuleEvaluationWork(client, subject)) > 0) return true;
  const unprojected = await client.query(
    `SELECT 1 FROM work_items w JOIN journal_events e ON e.tenant_id=w.tenant_id AND e.id=w.event_id
     WHERE w.tenant_id=current_setting('ledger.tenant_id',true) AND w.state<>'completed' AND e.source_id IS NOT NULL
      AND e.source_id<>$2 AND e.received_at<=$1 LIMIT 1`,
    [new Date(recordedThrough), RECORDS_ON_FILE_SOURCE],
  );
  return Boolean(unprojected.rowCount);
}

function bound(requested: number | undefined, maximum: number): number {
  if (requested === undefined) return maximum;
  if (!Number.isSafeInteger(requested) || requested < 0)
    throw new DomainError(400, 'invalid_indicator_limit', 'Read bounds must be whole numbers');
  return Math.min(requested, maximum);
}

function populationFor(definition: IndicatorDefinition, request: IndicatorGatherRequest): IndicatorPopulation {
  if (request.population) {
    if (request.population.subjects.length > INDICATOR_LIMITS.maxSubjects)
      throw new DomainError(400, 'indicator_population_too_large', `At most ${INDICATOR_LIMITS.maxSubjects} subjects`);
    return structuredClone(request.population);
  }
  if (definition.scope.kind !== 'subjects')
    throw new DomainError(
      400,
      'indicator_population_required',
      'This indicator counts subjects by organization or kind, so the population for the window must be declared',
    );
  return {
    subjects: structuredClone(definition.scope.subjects),
    complete: true,
    declaredBy: { kind: 'definition', id: `${definition.id}@${definition.version}` },
  };
}

/**
 * Gathers the events and exposure observations a registered indicator needs for one window, at an evidence cut,
 * through the ordinary evidence reads. It reads only the caller's tenant and requires evidence:read. Reads stop at
 * fixed bounds; reaching one gives outcome incomplete_selection, which the calculation reports as insufficient.
 */
export async function gatherIndicatorInputs(
  client: PoolClient,
  principal: AuthContext,
  request: IndicatorGatherRequest,
): Promise<IndicatorGathering> {
  const definition = findIndicatorDefinition(request.definition.id, request.definition.version);
  if (!definition)
    throw new DomainError(
      404,
      'indicator_not_registered',
      'No indicator definition is registered with this id and version',
    );
  const start = utcMillis(request.window.start),
    end = utcMillis(request.window.end),
    recordedThrough = utcMillis(request.recordedThrough);
  if (start === undefined || end === undefined || recordedThrough === undefined || start >= end)
    throw new DomainError(400, 'invalid_indicator_window', 'The window and evidence cut must be ordered UTC instants');
  if (end - start > definition.window.maxMilliseconds)
    throw new DomainError(400, 'invalid_indicator_window', 'The window is longer than this indicator allows');
  const population = populationFor(definition, request);
  const cut = { recordedThrough, ...(request.evidenceCut ? { streams: request.evidenceCut } : {}) };

  const events = new Map<string, IndicatorEvent>();
  const eventBudget: Budget = {
    remaining: bound(request.limits?.maxEvents, INDICATOR_LIMITS.maxEvents),
    exceeded: false,
  };
  const evaluationBudget: Budget = {
    remaining: bound(request.limits?.maxEvaluations, INDICATOR_LIMITS.maxEvaluations),
    exceeded: false,
  };
  const selection = definition.events;
  const later = { found: false };
  let readsPlans: boolean | undefined;
  for (const subject of population.subjects) {
    if (eventBudget.exceeded || evaluationBudget.exceeded) break;
    if (selection.kind === 'issues') {
      await readIssues(
        client,
        principal,
        subject,
        issueRules(selection),
        recordedThrough,
        events,
        { issues: eventBudget, evaluations: evaluationBudget },
        later,
      );
      continue;
    }
    if (selection.kind === 'findings') {
      readsPlans ??= await ruleReadsPlans(client, principal, selection);
      await readFindings(
        client,
        principal,
        subject,
        selection,
        { start, end, recordedThrough },
        events,
        eventBudget,
        readsPlans,
      );
      continue;
    }
    const observations = new Map<string, IndicatorObservation>();
    for (const version of selection.versions)
      await readObservations(
        client,
        principal,
        subject,
        { type: selection.type, version, from: request.window.start, to: request.window.end },
        cut,
        observations,
        eventBudget,
      );
    for (const [id, observation] of observations)
      if (!events.has(id)) events.set(id, { kind: 'observation', ...observation });
  }

  const kind = findExposureKind(definition.exposure.kind, definition.exposure.version)!;
  const exposure = new Map<string, IndicatorObservation>();
  const exposureBudget: Budget = {
    remaining: bound(request.limits?.maxExposureObservations, INDICATOR_LIMITS.maxExposureObservations),
    exceeded: false,
  };
  const from = new Date(start - kind.readMarginMilliseconds.before).toISOString();
  const to = new Date(end + kind.readMarginMilliseconds.after).toISOString();
  for (const subject of population.subjects)
    for (const read of kind.reads(definition.exposure.params))
      for (const version of read.versions)
        if (!exposureBudget.exceeded)
          await readObservations(
            client,
            principal,
            subject,
            { type: read.type, version, from, to },
            cut,
            exposure,
            exposureBudget,
          );

  const exceeded = [
    ...(eventBudget.exceeded ? ['events'] : []),
    ...(evaluationBudget.exceeded ? ['evaluations'] : []),
    ...(exposureBudget.exceeded ? ['exposure'] : []),
  ];
  return {
    definition,
    outcome: exceeded.length ? 'incomplete_selection' : 'complete',
    input: {
      window: { start: request.window.start, end: request.window.end },
      recordedThrough: request.recordedThrough,
      control: request.control ? { ...request.control } : null,
      population,
      selection: {
        complete: exceeded.length === 0,
        exceeded,
        pending: await pendingFor(client, population.subjects, recordedThrough),
        ...(later.found ? { evaluatedAfterCut: true } : {}),
      },
      events: [...events.values()],
      exposure: [...exposure.values()],
    },
  };
}
