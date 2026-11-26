import { randomUUID } from 'node:crypto';
import {
  FINDING_SET_LIMIT,
  OPERATOR_RECORD_SOURCE_ID,
  isCheckedRuleLeaf,
  type AcceptedObservation,
  type AdoptionRuleCoverageResponse,
  type Command,
  type CurrentPrincipalResponse,
  type FindingClosingReason,
  type FindingSetTreatmentCommand,
  type OpenFinding,
  type OpenFindingGroup,
  type OpenFindingGroupsResponse,
  type OpenFindingsQuery,
  type OpenFindingsResponse,
  type NamedSubject,
  type RuleEvaluationRecord,
  type SubjectFindingListResponse,
  type SubjectFindingRecord,
  type SubjectReference,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import {
  RefusalError,
  standingAdoptions,
  subjectReference,
  UsageError,
  type Context,
  type Output,
} from './commands.js';
import { cell, dayIn, plural, shortRuleId, subjectWords, table, withIndefiniteArticle } from './format.js';
import { isPerson, personSendsIt, refuseUnlessPerson } from './persons-decision.js';

/** Which open findings a command reads: the tab, and the filters a person narrows them by. */
export interface FindingFilters {
  pack?: string;
  rule?: string;
  subjectKind?: string;
  /** Days in the organization's time zone the findings are about, both included. */
  from?: string;
  until?: string;
  proposed?: boolean;
}

function dayRange(from: string, until: string, zone: string): string {
  const [first, last] = [dayIn(from, zone), dayIn(until, zone)];
  return first === last ? first : `${first} to ${last}`;
}

function day(text: string | undefined, flag: string): string | undefined {
  if (text === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  const check = match ? new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!)) : undefined;
  if (!match || check!.getUTCMonth() !== +match[2]! - 1 || check!.getUTCDate() !== +match[3]!)
    throw new UsageError(`${flag} is a day in your organization's time zone, such as 2026-11-01: ${text}`);
  return text.trim();
}

function narrowing(filters: FindingFilters) {
  const aboutFrom = day(filters.from, '--from');
  const aboutUntil = day(filters.until, '--until');
  return {
    ...(filters.pack ? { packId: filters.pack } : {}),
    ...(filters.subjectKind ? { subjectKind: filters.subjectKind as OpenFindingsQuery['subjectKind'] } : {}),
    ...(aboutFrom ? { aboutFrom } : {}),
    ...(aboutUntil ? { aboutUntil } : {}),
  };
}

function narrowingWords(filters: FindingFilters): string {
  const words = [
    filters.subjectKind ? `about ${withIndefiniteArticle(filters.subjectKind)}` : '',
    filters.from ? `about ${filters.from} or later` : '',
    filters.until ? `about ${filters.until} or earlier` : '',
  ].filter(Boolean);
  return words.length ? ` ${words.join(', ')}` : '';
}

function alsoOnFile(counts: OpenFindingsResponse['counts']): string {
  return `Also on file: ${counts.proposed} from proposed rules (--proposed), ${counts.relieved} relieved by a waiver.`;
}

async function zoneOf(context: Context): Promise<{ who: CurrentPrincipalResponse; zone: string }> {
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  return { who, zone: who.organization?.timeZone ?? 'UTC' };
}

/** The one group --rule names, by its whole id or the part after its pack id; --pack decides between packs. */
function oneGroup(read: OpenFindingGroupsResponse, rule: string): OpenFindingGroup | undefined {
  const named = read.groups.filter(
    (group) => group.ruleId === rule || shortRuleId(group.packId, group.ruleId) === rule,
  );
  if (named.length > 1)
    throw new UsageError(
      `${rule} names a rule of ${named.map((group) => group.packId).join(' and ')}; give --pack to choose one.`,
    );
  return named[0];
}

/** The open findings grouped by rule, fewest first, so the rare ones lead. */
export async function findingGroups(context: Context, filters: FindingFilters): Promise<Output> {
  const { zone } = await zoneOf(context);
  const shown = filters.proposed ? 'proposed' : 'counted';
  const read = await context.client.openFindingGroups({ shown, ...narrowing(filters) });
  const heading = filters.proposed
    ? `${plural(read.total.findings, 'finding')} from proposed rules under ${plural(read.total.rules, 'rule')}: recorded and labelled, never counted.`
    : `${plural(read.total.findings, 'open finding')} under ${plural(read.total.rules, 'rule')}${narrowingWords(filters)}, the rules with the fewest first. ${read.attention.unowned} counted with no owner, ${read.attention.overdue} with an action overdue. ${alsoOnFile(read.counts)}`;
  const lines = read.groups.length
    ? [
        heading,
        ...table(
          ['Open', 'Subjects', 'Owned', 'About', 'Rule', 'Paragraph', 'Title'],
          read.groups.map((group) => [
            String(group.open),
            String(group.subjects),
            String(group.owned),
            dayRange(group.aboutFrom, group.aboutUntil, zone),
            shortRuleId(group.packId, group.ruleId),
            group.paragraph,
            `${group.ruleTitle} (${group.packTitle})`,
          ]),
        ),
        `One rule's findings: pnpm ledger findings list --rule <rule>. Every finding, oldest first: pnpm ledger findings list --all.`,
      ]
    : [
        filters.proposed
          ? 'No finding from a proposed rule is open.'
          : `No counted finding is open${narrowingWords(filters)}. ${alsoOnFile(read.counts)}`,
      ];
  if (read.truncated)
    lines.push('More findings are open than Ledger reads at once; narrow them by --pack or the days.');
  const notOnFile = await notOnFileByPack(context, filters);
  return { data: { ...read, notOnFile: notOnFile.data }, lines: [...lines, ...notOnFile.lines] };
}

/** How many results of one adopted pack say a record is not on file. */
export interface NotOnFileCount {
  packId: string;
  version: number;
  adoptionId: string;
  results: number;
  rules: number;
}

/**
 * For each adopted pack the list covers, the results that say a record is not on file, from the counts the coverage
 * read already holds. Such a result opens no finding, so the findings list alone never shows it.
 */
async function notOnFileByPack(
  context: Context,
  filters: FindingFilters,
): Promise<{ data: NotOnFileCount[]; lines: string[] }> {
  const mode = filters.proposed ? 'shadow' : 'active';
  const heading =
    'Not on file is not a finding: a rule that finds no record of what it reads says so in coverage and opens no finding.';
  let reads: AdoptionRuleCoverageResponse[];
  try {
    const adoptions = standingAdoptions(await context.client.organizationCoverage()).filter(
      (adoption) => adoption.mode === mode && (!filters.pack || adoption.pack.packId === filters.pack),
    );
    reads = await Promise.all(adoptions.map((adoption) => context.client.adoptionRuleCoverage(adoption.id)));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
    return {
      data: [],
      lines: [
        '',
        `${heading} This credential may not read coverage, so how many there are is not shown; a credential with flight:read lists them with pnpm ledger coverage --result no_record.`,
      ],
    };
  }
  const data = reads.map((read) => {
    const rules = read.rules.filter((rule) => rule.counts?.no_record);
    return {
      packId: read.packId,
      version: read.version,
      adoptionId: read.adoptionId,
      results: rules.reduce((sum, rule) => sum + rule.counts!.no_record, 0),
      rules: rules.length,
    };
  });
  if (!data.length) return { data, lines: [] };
  return {
    data,
    lines: [
      '',
      `${heading} Read these as well:`,
      ...reads.map((read, index) => {
        const count = data[index]!;
        const pack = `${read.title} (${read.packId} version ${read.version})`;
        return count.results
          ? `  ${pack}: ${plural(count.results, 'result')} under ${plural(count.rules, 'rule')} ${count.results === 1 ? 'says' : 'say'} a record is not on file. Each, with its rule, subject and sentence: pnpm ledger coverage --pack ${read.packId} --result no_record`
          : `  ${pack}: no result says a record is not on file.`;
      }),
    ],
  };
}

/** Every finding the query selects, page by page. */
async function everyFinding(
  context: Context,
  query: OpenFindingsQuery,
  bound?: number,
): Promise<{ first: OpenFindingsResponse; findings: OpenFinding[] }> {
  const findings: OpenFinding[] = [];
  let cursor: string | undefined;
  let first: OpenFindingsResponse | undefined;
  do {
    const page = await context.client.openFindings({ ...query, limit: 200, ...(cursor ? { cursor } : {}) });
    first ??= page;
    if (bound !== undefined && page.matching > bound) return { first, findings: [] };
    findings.push(...page.findings);
    cursor = page.page.hasMore ? (page.page.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return { first: first!, findings };
}

function findingTable(findings: readonly OpenFinding[], zone: string, withRule: boolean): string[] {
  return table(
    withRule ? ['Subject', 'About', 'Rule', 'Open', 'Owner', 'Why'] : ['Subject', 'About', 'Open', 'Owner', 'Why'],
    findings.map((item) => [
      subjectWords(item.related?.subject ?? item.subject),
      dayIn(item.aboutAt, zone),
      ...(withRule ? [`${item.ruleTitle} (${item.paragraph})`] : []),
      `${plural(item.ageDays, 'day')}${item.cleared ? ', supported by the record now' : ''}`,
      item.owner?.name ?? 'No owner',
      item.summary,
    ]),
  );
}

/** Every open finding across pilots, aircraft, flights and the organization, oldest first; or one rule's. */
export async function openFindings(context: Context, filters: FindingFilters): Promise<Output> {
  const { zone } = await zoneOf(context);
  const shown = filters.proposed ? 'proposed' : 'counted';
  let rule: OpenFindingGroup | undefined;
  if (filters.rule) {
    const groups = await context.client.openFindingGroups({ shown, ...narrowing(filters) });
    rule = oneGroup(groups, filters.rule);
    if (!rule)
      return {
        data: { shown, findings: [], counts: groups.counts, attention: groups.attention },
        lines: [
          `No ${shown === 'proposed' ? 'proposed' : 'counted'} finding of a rule ${filters.rule} is open${narrowingWords(filters)}. pnpm ledger findings list shows the rules with open findings.`,
        ],
      };
  }
  const { first, findings } = await everyFinding(context, {
    shown,
    ...narrowing(filters),
    ...(rule ? { packId: rule.packId, ruleId: rule.ruleId } : {}),
  });
  const heading = rule
    ? `${plural(findings.length, 'open finding')} of ${rule.ruleTitle} (${shortRuleId(rule.packId, rule.ruleId)}, ${rule.paragraph}, ${rule.packTitle})${narrowingWords(filters)}, about ${rule.subjects === 1 ? '1 subject' : `${rule.subjects} subjects`}, oldest first. ${rule.owned} owned.`
    : filters.proposed
      ? `${plural(findings.length, 'finding')} from proposed rules: recorded and labelled, never counted.`
      : `${plural(findings.length, 'open finding')} counted. ${first.attention.unowned} with no owner, ${first.attention.overdue} with an action overdue. ${alsoOnFile(first.counts)}`;
  return {
    data: { shown, findings, counts: first.counts, attention: first.attention },
    lines: findings.length
      ? [heading, ...findingTable(findings, zone, !rule)]
      : [
          filters.proposed
            ? 'No finding from a proposed rule is open.'
            : `No counted finding is open${narrowingWords(filters)}. ${alsoOnFile(first.counts)}`,
        ],
  };
}

const closingReasons: Record<string, { reason: FindingClosingReason; words: string }> = {
  'corrected-by-record': { reason: 'corrected_by_record', words: 'corrected by a new record' },
  accepted: { reason: 'accepted', words: 'accepted, with the reason stated' },
  'condition-ended': { reason: 'condition_ended', words: 'the condition ended; what it reported still happened' },
  'recorded-in-error': { reason: 'recorded_in_error', words: 'recorded in error' },
};

export interface FindingSetRequest extends FindingFilters {
  action: 'take' | 'close';
  /** For close: why, one of the closing reasons. */
  as?: string;
  /** The person's own words, kept with the decision. Without them nothing is sent. */
  reason?: string;
}

/**
 * Takes or closes every counted open finding of one rule, optionally narrowed by subject kind and the days they are
 * about, as one decision: prints the set first, and sends it only with the person's own reason and credential.
 */
export async function treatFindingSet(context: Context, request: FindingSetRequest): Promise<Output> {
  if (!request.rule) throw new UsageError(`findings ${request.action} needs --rule <rule>: the rule whose findings.`);
  if (request.proposed)
    throw new UsageError('Findings from proposed rules are never counted and are not taken or closed.');
  const closing = request.action === 'close' ? closingReasons[request.as ?? ''] : undefined;
  if (request.action === 'close' && !closing)
    throw new UsageError(
      `findings close needs --as and why they are closed: ${Object.entries(closingReasons)
        .map(([name, { words }]) => `${name} (${words})`)
        .join(', ')}.`,
    );
  if (request.action === 'take' && request.as !== undefined) throw new UsageError('--as is for findings close.');
  const { who, zone } = await zoneOf(context);
  const groups = await context.client.openFindingGroups({ shown: 'counted', ...narrowing(request) });
  const rule = oneGroup(groups, request.rule);
  if (!rule)
    return {
      data: { sent: false, findings: [] },
      lines: [`No counted finding of a rule ${request.rule} is open${narrowingWords(request)}. Nothing was sent.`],
    };
  const selection: FindingSetTreatmentCommand['selection'] = {
    packId: rule.packId,
    ruleId: rule.ruleId,
    ...(request.subjectKind ? { subjectKind: request.subjectKind } : {}),
    ...(request.from ? { aboutFrom: request.from } : {}),
    ...(request.until ? { aboutUntil: request.until } : {}),
  };
  const { first, findings } = await everyFinding(
    context,
    { shown: 'counted', ...narrowing(request), packId: rule.packId, ruleId: rule.ruleId },
    FINDING_SET_LIMIT,
  );
  const named = `${rule.ruleTitle} (${shortRuleId(rule.packId, rule.ruleId)}, ${rule.paragraph}, ${rule.packTitle})`;
  if (first.matching > FINDING_SET_LIMIT)
    throw new RefusalError(
      `${first.matching} open findings of ${named} match${narrowingWords(request)}; one decision covers at most ${FINDING_SET_LIMIT}. Narrow them by the days they are about (--from, --until) or by --subject-kind, and decide on each part. Nothing was sent.`,
    );
  const subjects = new Set(findings.map((item) => `${item.subject.kind}:${item.subject.id}`)).size;
  const doing =
    request.action === 'take'
      ? `take responsibility for all ${findings.length}; you become the owner of each, and each stays open.`
      : `close all ${findings.length} as ${closing!.words}. Each closes with your name, your reason and its latest evaluation; a later result that needs attention opens it again, and a later flight the rule finds the same about opens a new finding.`;
  const lines = [
    `Rule: ${named}`,
    `Findings: ${plural(findings.length, 'open finding')}${narrowingWords(request)}, about ${plural(subjects, 'subject')}, about ${dayRange(rule.aboutFrom, rule.aboutUntil, zone)} (${zone}).`,
    ...findingTable(findings, zone, false),
    `One decision: ${doing}`,
    `Reason: ${request.reason?.trim() ? request.reason.trim() : 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  const plan = { selection, action: request.action, findings: findings.length, subjects };
  const reason = request.reason?.trim();
  const decision = "Taking and closing findings are a person's decisions";
  const sender = 'The person who decides';
  refuseUnlessPerson(who, reason, lines, decision, sender);
  if (!isPerson(who))
    return { data: { sent: false, ...plan }, lines: [...lines, personSendsIt(who, decision, sender)] };
  if (request.action === 'close') {
    const owned = findings.filter((item) => item.owner?.id === who.principal.id).length;
    if (owned !== findings.length)
      return {
        data: { sent: false, ...plan, owned },
        lines: [
          ...lines,
          `Not sent. You own ${owned} of these ${findings.length} findings; only a finding's owner closes it. Take them all first with one decision: pnpm ledger findings take --rule ${request.rule}${request.pack ? ` --pack ${request.pack}` : ''} --reason "<your reason>"`,
        ],
        refused: Boolean(reason),
      };
  }
  if (!reason)
    return {
      data: { sent: false, ...plan },
      lines: [
        ...lines,
        'Not sent. A person records it by running this again with --reason "<their reason>"; the reason is kept with the decision and with each finding.',
      ],
    };
  const command: FindingSetTreatmentCommand = {
    kind: 'finding.treat-many',
    selection,
    action: request.action === 'take' ? 'acknowledge' : 'close',
    ...(closing ? { reason: closing.reason } : {}),
    findings: findings.map((item) => ({ findingId: item.id, evaluationId: item.evaluationId })),
    shownCount: findings.length,
    note: reason,
  };
  const sent = await context.client.command(command as Command, randomUUID());
  return {
    data: { sent: true, decisionId: sent.command.id, ...plan, command: sent.command },
    lines: [
      ...lines,
      `${request.action === 'take' ? 'Taken' : 'Closed'}: ${plural(findings.length, 'finding')} of ${named}, as one decision, ${sent.command.id}. Each finding shows it.`,
    ],
  };
}

/** Where a finding is read from: the subject it is about, by the reference its records name. */
type FindingSubject = Pick<SubjectReference, 'scope' | 'kind' | 'id' | 'sourceId'>;

/** The subject an open finding is about, found by paging the open findings, counted and proposed. */
async function openFindingSubject(context: Context, findingId: string): Promise<FindingSubject | undefined> {
  for (const shown of ['counted', 'proposed'] as const) {
    const { findings } = await everyFinding(context, { shown });
    const found = findings.find((item) => item.id === findingId);
    if (found) return found.subject;
  }
  return undefined;
}

/** The pages of findings about one subject Ledger is read for, at most, before the finding is said not found. */
const SUBJECT_FINDING_PAGES = 20;

async function findingAbout(
  context: Context,
  findingId: string,
  subject: FindingSubject,
): Promise<{ finding: SubjectFindingRecord; read: SubjectFindingListResponse } | undefined> {
  let cursor: string | undefined;
  for (let page = 0; page < SUBJECT_FINDING_PAGES; page++) {
    const read = await context.client.subjectFindings({
      subjectKind: subject.kind,
      subjectId: subject.id,
      ...(subject.scope === 'source' ? { subjectScope: 'source' as const, sourceId: subject.sourceId } : {}),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const finding = read.findings.find((item) => item.id === findingId);
    if (finding) return { finding, read };
    if (!read.page.hasMore || !read.page.nextCursor) return undefined;
    cursor = read.page.nextCursor;
  }
  return undefined;
}

/** The pages of one observation read, at most, before the records an evaluation cites stop being looked for. */
const OBSERVATION_PAGES = 20;
/** Every time a record can be about: a cited record's own time need not fall inside the span it is about. */
const ALL_TIME = { from: '1970-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z' } as const;

/**
 * The records an evaluation read, through the ordinary observation reads: one read per subject and type, replaced and
 * withdrawn ones included, each under the subject its input was about, paged until every record it cites is found.
 */
async function recordsRead(
  context: Context,
  subject: FindingSubject,
  evaluation: RuleEvaluationRecord,
  inputSubjects: readonly NamedSubject[] | undefined,
): Promise<AcceptedObservation[]> {
  const aboutOf = new Map<string, FindingSubject>();
  evaluation.inputs.forEach((input, index) => {
    for (const id of input.observationIds) aboutOf.set(id, inputSubjects?.[index] ?? input.subject ?? subject);
  });
  const groups = new Map<string, { about: FindingSubject; items: RuleEvaluationRecord['evidence'] }>();
  for (const item of evaluation.evidence) {
    const about = aboutOf.get(item.observationId) ?? subject;
    const key = `${about.scope}/${about.sourceId ?? ''}/${about.kind}/${about.id} ${item.type}@${item.version}`;
    const group = groups.get(key) ?? { about, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const found = new Map<string, AcceptedObservation>();
  for (const { about, items } of groups.values()) {
    const wanted = new Set(items.map((item) => item.observationId));
    let cursor: string | undefined;
    for (let page = 0; page < OBSERVATION_PAGES && wanted.size; page++) {
      const read = await context.client.observations({
        subjectKind: about.kind,
        subjectId: about.id,
        ...(about.scope === 'source' ? { subjectScope: 'source' as const, sourceId: about.sourceId } : {}),
        type: items[0]!.type,
        version: items[0]!.version,
        ...ALL_TIME,
        include: 'all',
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const observation of read.observations)
        if (wanted.delete(observation.id)) found.set(observation.id, observation);
      if (!read.page.hasMore || !read.page.nextCursor) break;
      cursor = read.page.nextCursor;
    }
  }
  return evaluation.evidence.flatMap((item) => found.get(item.observationId) ?? []);
}

/** What an evaluation's rule requires that it found nothing of, in the words the rule gives the record. */
export interface NotOnFile {
  input: string;
  type: string;
  record: string;
  /** A record of the input about a later time, which the rule reads from then. */
  later?: { from: string; observationId: string };
}

async function notOnFile(context: Context, evaluation: RuleEvaluationRecord): Promise<NotOnFile[]> {
  const empty = evaluation.inputs.filter((input) => input.required && !input.observationIds.length);
  if (!empty.length) return [];
  let reads: { name: string; onFile?: string }[] = [];
  try {
    const { pack } = await context.client.rulePackVersion(evaluation.pack.id, evaluation.pack.version);
    const leaf = pack.leaves.find((item) => item.id === evaluation.rule.id);
    reads = leaf && isCheckedRuleLeaf(leaf) ? leaf.reads : [];
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  return empty.map((input) => ({
    input: input.name,
    type: input.type,
    record: reads.find((read) => read.name === input.name)?.onFile ?? `a ${input.type} record`,
    ...(input.later ? { later: { from: input.later.from, observationId: input.later.observationIds[0]! } } : {}),
  }));
}

function observationLine(observation: AcceptedObservation): string {
  const when = observation.interval
    ? `${observation.interval.start} to ${observation.interval.end ?? 'open'}`
    : observation.occurredAt;
  const state = observation.replacedBy ? ' (replaced)' : observation.withdrawal ? ' (withdrawn)' : '';
  return `    ${observation.id}, ${observation.type}, ${when}${state}: ${cell(JSON.stringify(observation.observation), 160)}`;
}

async function evaluationBehind(
  context: Context,
  subject: FindingSubject,
  evaluation: RuleEvaluationRecord,
  inputSubjects: readonly NamedSubject[] | undefined,
  heading: string,
): Promise<{ data: unknown; lines: string[] }> {
  const records = await recordsRead(context, subject, evaluation, inputSubjects);
  const missing = await notOnFile(context, evaluation);
  const lines = [
    `${heading} ${evaluation.id}, recorded ${evaluation.recordedAt}: ${evaluation.summary}`,
    `  The evidence: ${evaluation.evidenceState}. Rule version ${evaluation.rule.version}, check ${evaluation.check.kind} version ${evaluation.check.version}.`,
    records.length ? `  The records it read (${records.length}):` : '  It read no record.',
    ...records.map(observationLine),
    ...(missing.length
      ? [
          '  Not on file when it was evaluated:',
          ...missing.map(
            (item) =>
              `    ${item.record} (${item.input}, ${item.type})${item.later ? `; a record about a later time is on file, ${item.later.observationId}, read from ${item.later.from}` : ''}.`,
          ),
        ]
      : []),
  ];
  return { data: { evaluation, records, notOnFile: missing }, lines };
}

/**
 * One finding: what it is about, its status and owner, the evaluation that opened it and the latest, the records each
 * read and what each found not on file, and the decisions recorded about it. It records nothing.
 */
export async function showFinding(context: Context, request: { finding: string; subject?: string }): Promise<Output> {
  const findingId = request.finding.trim();
  if (!findingId) throw new UsageError('Give the finding id: pnpm ledger findings list --all lists them.');
  const subject: FindingSubject | undefined = request.subject
    ? { scope: 'source', sourceId: OPERATOR_RECORD_SOURCE_ID, ...subjectReference(request.subject, '--subject') }
    : await openFindingSubject(context, findingId);
  if (!subject)
    throw new UsageError(
      `No open finding ${findingId}. A finding no longer open is read with --subject <kind>:<id>, the subject it is about.`,
    );
  const found = await findingAbout(context, findingId, subject);
  if (!found) throw new UsageError(`No finding ${findingId} about ${subject.kind} ${subject.id}.`);
  const { finding, read } = found;
  const latest = finding.latestEvaluation;
  const named = read.inputSubjects[latest.id]?.find((item) => item.id === finding.subject.id) ?? finding.subject;
  const behind = [await evaluationBehind(context, subject, latest, read.inputSubjects[latest.id], 'Latest evaluation')];
  if (finding.initialEvaluation.id !== latest.id)
    behind.push(
      await evaluationBehind(
        context,
        subject,
        finding.initialEvaluation,
        read.inputSubjects[finding.initialEvaluation.id],
        'It opened on evaluation',
      ),
    );
  const closure = finding.closure
    ? finding.closure.by === 'record'
      ? [`Closed by a record, ${finding.closure.closedAt}: ${finding.closure.summary}`]
      : [
          `Closed by ${finding.closure.actorName}, ${finding.closure.closedAt}, as ${finding.closure.reason}: ${finding.closure.note}`,
        ]
    : [];
  const lines = [
    `Finding ${finding.id} about ${subjectWords(named)}${finding.related ? `, for ${finding.related.subject.kind} ${finding.related.subject.id}` : ''}: ${latest.rule.title} (${shortRuleId(finding.packId, finding.ruleId)}, ${latest.rule.source.reference}, ${finding.packId} version ${latest.pack.version}).`,
    `Status: ${finding.status}; ${finding.owner ? `owner ${finding.owner.name}` : 'no owner'}; opened ${finding.openedAt}${finding.mode === 'shadow' ? '; from a rule in shadow: recorded, never counted' : ''}${finding.ruleNoLongerAdopted ? '; its rule is no longer adopted' : ''}.`,
    ...(finding.action
      ? [`Action: ${finding.action.note}, due ${finding.action.dueOn}${finding.action.overdue ? ', overdue' : ''}.`]
      : []),
    ...behind.flatMap((item) => ['', ...item.lines]),
    '',
    ...(finding.treatments.length
      ? [
          `Decisions about it${finding.hasOlderTreatments ? ', the latest' : ''}:`,
          ...finding.treatments.map(
            (treatment) =>
              `  ${treatment.recordedAt} ${treatment.actorName}: ${treatment.action}${treatment.reason ? ` as ${treatment.reason}` : ''}${treatment.note ? `, “${treatment.note}”` : ''}`,
          ),
        ]
      : ['No decision about it is recorded.']),
    ...closure,
  ];
  return {
    data: { finding, evaluations: behind.map((item) => item.data), inputSubjects: read.inputSubjects },
    lines,
  };
}
