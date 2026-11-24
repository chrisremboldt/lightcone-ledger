import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  REAUTHENTICATION_HEADER,
  type Command,
  type CommandResponse,
  type CurrentPrincipalResponse,
  type LocalReauthenticationResponse,
  type RiskAcceptance,
  type RiskMatrixBody,
  type SigningMeaning,
  type SignInConfiguration,
  type SmsControlTypeListResponse,
  type SmsDecisionInput,
  type SmsHomeResponse,
  type SmsRecordDetailResponse,
  type SmsRecordDraft,
  type SmsRecordKind,
  type SmsRecordSummary,
  type SmsRegisterResponse,
  type SmsSigningPreviewResponse,
  zonedInstantText,
} from '@ledger/contracts';
import { ApiError } from '@ledger/contracts/client';
import { RefusalError, UsageError, type Context, type Output } from './commands.js';
import { dayIn, wrappedTable } from './format.js';
import { isPerson, personSendsIt, refuseUnlessPerson } from './persons-decision.js';
import {
  FileProblem,
  matrixPosition,
  PLAIN_CONTROL_TYPE,
  readSafetyFile,
  safetyFileKinds,
  safetyTemplates,
  type DraftItem,
  type FileContext,
  type SafetyFileKind,
} from './safety-files.js';

export interface SafetyRequest {
  verb: string | undefined;
  args: string[];
  reason?: string;
  /** --hazard: only these hazards of the file. */
  hazards: string[];
  /** --recipient: who an issued document goes to, by name or id, or everyone. */
  recipients: string[];
  from?: string;
  out?: string;
  /** The credential the client sends: a local re-authentication is asked with it and kept nowhere. */
  credential: string;
  /** A path as the person typed it, resolved where the command was typed. */
  path: (relative: string) => string;
}

const acceptanceWords: Record<RiskAcceptance, string> = {
  low: 'a person who may accept low risk may accept it',
  medium: 'a person who may accept medium risk may accept it',
  high: 'a person who may accept high risk may accept it',
  not_acceptable: 'nobody may accept it',
};

const kindWords: Record<SmsRecordKind, string> = {
  hazard: 'Hazard',
  risk_matrix: 'Risk matrix',
  document: 'Document',
  report: 'Safety report',
  control: 'Control',
  assurance: 'Safety assurance record',
};

/** How the client names a record: its kind and the organization's own id, else its Ledger id. Never a report's title. */
export function recordName(record: Pick<SmsRecordSummary, 'kind' | 'reference' | 'id' | 'title' | 'confidentiality'>) {
  const id = record.reference ? `${record.reference} (${record.id})` : record.id;
  return record.confidentiality === 'ordinary'
    ? `${kindWords[record.kind]} ${id}, “${record.title}”`
    : `${kindWords[record.kind]} ${id}`;
}

function kindOf(name: string | undefined): SafetyFileKind {
  if (name && name in safetyFileKinds) return name as SafetyFileKind;
  throw new UsageError(`Give the kind of file: ${Object.keys(safetyFileKinds).join(', ')}.`);
}

function today(zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

interface Orientation {
  who: CurrentPrincipalResponse;
  home: SmsHomeResponse;
  files: FileContext;
}

async function orient(context: Context): Promise<Orientation> {
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  const home = await context.client.request<SmsHomeResponse>('/v1/sms/home');
  const zone = who.organization?.timeZone ?? 'UTC';
  return { who, home, files: { people: home.people, zone, today: today(zone) } };
}

async function findByReference(context: Context, kind: SmsRecordKind, reference: string) {
  const query = new URLSearchParams({ kind, reference, limit: '1' });
  return (await context.client.request<SmsRegisterResponse>(`/v1/sms/records?${query}`)).records[0];
}

async function detail(context: Context, id: string): Promise<SmsRecordDetailResponse> {
  return context.client.request<SmsRecordDetailResponse>(`/v1/sms/records/${encodeURIComponent(id)}`);
}

/** A record by the organization's own id, or by its Ledger id. */
async function recordOf(
  context: Context,
  kind: SmsRecordKind,
  named: string | undefined,
): Promise<SmsRecordDetailResponse> {
  if (!named)
    throw new UsageError(`Give the ${kindWords[kind].toLowerCase()}: its id in your files, or its Ledger id.`);
  const found = await findByReference(context, kind, named);
  if (found) return detail(context, found.id);
  try {
    const shown = await detail(context, named);
    if (shown.record.kind === kind) return shown;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  throw new RefusalError(
    `No ${kindWords[kind].toLowerCase()} here has the id ${named}. pnpm ledger safety home lists what is on file.`,
  );
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(
      `Could not read ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
}

function readItems(kind: SafetyFileKind, path: string, files: FileContext) {
  try {
    return readSafetyFile(kind, readFile(path), path, files);
  } catch (error) {
    if (error instanceof FileProblem) throw new RefusalError(`${path}: ${error.message} Nothing was recorded.`);
    throw error;
  }
}

/** JSON with its keys in order, so two bodies compare by content. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sameAsOnFile(draft: SmsRecordDraft, shown: SmsRecordDetailResponse): boolean | undefined {
  if (shown.current.body === null) return undefined;
  return shown.current.title === draft.title && stable(shown.current.body) === stable(draft.body);
}

// ---- reads

export async function safetyHome(context: Context): Promise<Output> {
  const { client } = context;
  const who = await client.request<CurrentPrincipalResponse>('/v1/me');
  const home = await client.request<SmsHomeResponse>('/v1/sms/home');
  const documents = await client.request<SmsRegisterResponse>('/v1/sms/records?kind=document');
  const zone = who.organization?.timeZone ?? 'UTC';
  const lines = [
    `Safety records of ${who.organization?.name ?? 'your organization'}, as of ${zonedInstantText(home.computedAt, zone) ?? home.computedAt}.`,
    '',
    'On file:',
  ];
  const matrix = home.program.matrix;
  if (matrix) {
    const body = matrix.version.body;
    lines.push(
      `  Risk matrix in force: “${body.name}”, version ${matrix.version.versionNumber}${matrix.record.reference ? ` (${matrix.record.reference})` : ''}. Its levels, least to most serious:`,
      ...body.levels.map((level) => `    ${level.label}: ${acceptanceWords[level.acceptance]}.`),
    );
  } else lines.push('  No risk matrix is in force.');
  const inForce = documents.records.filter((record) => record.document?.inForce);
  for (const record of inForce)
    lines.push(
      `  In force: ${recordName(record)}${record.document?.inForce?.revisionLabel ? `, revision ${record.document.inForce.revisionLabel}` : ''}, since ${dayIn(record.document!.inForce!.effectiveFrom, zone)}.`,
    );
  if (!inForce.some((record) => record.document?.documentType === 'safety_policy'))
    lines.push('  Not on file: no safety policy is in force.');
  const holders = (authority: string) =>
    home.people.filter((person) => person.authority === authority).map((person) => person.name);
  for (const authority of ['low', 'medium', 'high'] as const) {
    const names = holders(authority);
    lines.push(
      `  May accept ${authority} risk${authority === 'high' ? '' : ' (and no higher)'}: ${names.length ? names.join(', ') : 'nobody yet'}.`,
    );
  }
  const adopters = home.people.filter((person) => person.adopts).map((person) => person.name);
  lines.push(
    `  May adopt a matrix and sign documents and assurance records: ${adopters.length ? adopters.join(', ') : 'nobody yet'}.`,
  );
  const section = (
    title: string,
    records: SmsRecordSummary[],
    describe: (record: SmsRecordSummary) => string = recordName,
  ) => {
    lines.push('', `${title}: ${records.length ? '' : 'none.'}`.trimEnd());
    for (const record of records) lines.push(`  ${describe(record)}${record.overdue ? ', overdue' : ''}`);
  };
  const { attention } = home;
  section('Drafts waiting for a person to adopt or sign', attention.documentsAwaitingAdoption);
  section('Documents to review', attention.documentsToReview);
  section('Documents to issue', attention.documentsToIssue);
  section('Hazards to assess', attention.needsAssessment);
  section('Risks awaiting acceptance', attention.awaitingAcceptance, (record) => {
    const residual = record.residual;
    if (!residual) return recordName(record);
    const label = matrix?.version.body.levels.find((level) => level.id === residual.level)?.label ?? residual.level;
    return `${recordName(record)}: residual ${label}; ${acceptanceWords[residual.acceptance]}${residual.acceptance === 'not_acceptable' ? '. A person reassesses it with further controls' : ''}`;
  });
  section('Overdue', attention.overdue);
  lines.push('', `Actions due within 30 days or overdue: ${home.assuranceActions.length ? '' : 'none.'}`.trimEnd());
  for (const group of home.assuranceActions)
    for (const action of group.actions)
      lines.push(
        `  ${action.actionId} of “${action.recordTitle}”: ${action.what} Owner ${group.owner.name}, due ${action.dueOn}${action.overdue ? ', overdue' : ''}.`,
      );
  return { data: { home, documents: documents.records }, lines };
}

export async function safetyControlTypes(context: Context): Promise<Output> {
  const read = await context.client.request<SmsControlTypeListResponse>('/v1/sms/control-types');
  const needs = (schema: Record<string, unknown>) => {
    const properties = (schema.properties ?? {}) as Record<string, { title?: string }>;
    const required = new Set((schema.required ?? []) as string[]);
    return Object.entries(properties)
      .map(
        ([name, property]) =>
          `${name}${required.has(name) ? '' : ' (optional)'}${property.title ? `: ${property.title}` : ''}`,
      )
      .join('; ');
  };
  return {
    data: read,
    lines: [
      ...wrappedTable(
        ['Control type', 'Version', 'What it is', 'Checked against flights', 'A control of it needs'],
        read.controlTypes.map((type) => [
          type.id,
          String(type.version),
          `${type.title}. ${type.description}`,
          type.checkedAutomatically ? 'yes' : 'no, a person reads it',
          needs(type.parameterSchema),
        ]),
        140,
        { 2: 2, 4: 2 },
      ),
      `A register's mitigations are ${PLAIN_CONTROL_TYPE.id} controls: what is done, owned by the control's owner, from its date.`,
    ],
  };
}

export function safetyTemplate(kindName: string | undefined, out: string | undefined): Output {
  const template = safetyTemplates[kindOf(kindName)];
  if (!out) return { data: template, lines: [template.text.trimEnd()] };
  writeFileSync(out, template.text);
  return { data: { ...template, out }, lines: [`Wrote ${out}.`] };
}

// ---- drafts

interface Drafted {
  reference: string;
  kind: SmsRecordKind;
  outcome: 'would_open' | 'opened' | 'on_file' | 'on_file_differs' | 'refused';
  recordId?: string;
}

/** Fills in what a control needs from what is on file: its hazard's id and the plain control type's digest. */
function controlDraft(item: DraftItem, hazardId: string, digest: string): SmsRecordDraft {
  const draft = structuredClone(item.draft!) as Extract<SmsRecordDraft, { kind: 'control' }>;
  draft.body.hazardId = hazardId;
  draft.body.controlType = { ...PLAIN_CONTROL_TYPE, digest };
  return draft;
}

/**
 * Says what a file would open, and with `open` opens it: each item under the organization's own id, nothing that is
 * on file already. A safety report is named by its id only, and only a person cleared to read reports enters one.
 */
export async function safetyDraft(
  context: Context,
  kindName: string | undefined,
  path: string,
  open: boolean,
): Promise<Output> {
  const kind = kindOf(kindName);
  const { who, files } = await orient(context);
  const read = readItems(kind, path, files);
  const lines: string[] = [];
  const results: Drafted[] = [];
  if (kind === 'report' && open) {
    if (!isPerson(who))
      throw new RefusalError(
        `Not opened. A safety report received before Ledger is entered by a person cleared to handle reports, with their own credential; this credential belongs to ${who.principal.name}, which is not a person.`,
      );
    if (!who.principal.capabilities.includes('sms:report:read'))
      throw new RefusalError(
        `Not opened. Entering a safety report needs permission to read safety reports (sms:report:read), which ${who.principal.name} does not hold.`,
      );
  }
  for (const problem of read.problems) lines.push(`${path}: ${problem}`);
  const controlTypes = read.items.some((item) => item.kind === 'control')
    ? (await context.client.request<SmsControlTypeListResponse>('/v1/sms/control-types')).controlTypes
    : [];
  const plain = controlTypes.find(
    (type) => type.id === PLAIN_CONTROL_TYPE.id && type.version === PLAIN_CONTROL_TYPE.version,
  );
  const hazardIds = new Map<string, string>();
  for (const item of read.items) {
    const result: Drafted = { reference: item.reference, kind: item.kind, outcome: 'refused' };
    results.push(result);
    if (item.problems.length || !item.draft) {
      lines.push(`${item.name}: refused. ${item.problems.join(' ')}`);
      continue;
    }
    const onFile = await findByReference(context, item.kind, item.reference);
    if (item.kind === 'hazard' && onFile) hazardIds.set(item.reference, onFile.id);
    let draft = item.draft;
    if (item.kind === 'control') {
      const hazardId = hazardIds.get(item.hazardReference!);
      if (!plain) {
        lines.push(`${item.name}: refused. This Ledger has no ${PLAIN_CONTROL_TYPE.id} control type.`);
        continue;
      }
      if (hazardId) draft = controlDraft(item, hazardId, plain.digest);
      else if (open) {
        lines.push(`${item.name}: not opened, since its hazard ${item.hazardReference} is not on file.`);
        continue;
      }
    }
    if (onFile) {
      result.recordId = onFile.id;
      const same =
        draft.kind === 'control' && !hazardIds.has(item.hazardReference!)
          ? true
          : sameAsOnFile(draft, await detail(context, onFile.id));
      result.outcome = same === false ? 'on_file_differs' : 'on_file';
      lines.push(
        same === false
          ? `${item.name}: on file as ${onFile.id}, and the file differs from the version on file. Nothing opened; a person revises it on its page.`
          : `${item.name}: on file as ${onFile.id}. Nothing opened.`,
      );
      continue;
    }
    if (!open) {
      result.outcome = 'would_open';
      lines.push(`${item.name}: would open ${draftWords(item)}.`);
      continue;
    }
    try {
      const sent = await context.client.command(
        {
          kind: 'sms.record.open',
          record: draft,
          reference: item.reference,
          ...(item.confidentiality ? { confidentiality: item.confidentiality } : {}),
        } as Command,
        randomUUID(),
      );
      const id = sent.command.subject?.id ?? String(sent.command.payload.recordId ?? '');
      result.outcome = 'opened';
      result.recordId = id;
      if (item.kind === 'hazard') hazardIds.set(item.reference, id);
      lines.push(`${item.name}: opened as ${id}, ${draftWords(item)}.`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      lines.push(`${item.name}: refused. ${refusalSentence(error)}`);
    }
  }
  const refused = results.filter((result) => result.outcome === 'refused').length + read.problems.length;
  const counted = (outcome: Drafted['outcome']) => results.filter((result) => result.outcome === outcome).length;
  lines.push(
    open
      ? `${results.length} in the file: ${counted('opened')} opened, ${counted('on_file') + counted('on_file_differs')} already on file, ${refused} refused.`
      : `${results.length} in the file: ${counted('would_open')} would open, ${counted('on_file') + counted('on_file_differs')} already on file, ${refused} refused. Nothing was recorded.`,
  );
  if (open && counted('opened'))
    lines.push(`Each is a draft until a person decides on it; pnpm ledger safety home lists what waits for a person.`);
  return {
    data: { file: path, kind, results, recordedAs: { id: who.principal.id, name: who.principal.name } },
    lines,
    refused: refused > 0,
  };
}

function draftWords(item: DraftItem): string {
  const draft = item.draft!;
  if (draft.kind === 'risk_matrix') return `a draft risk matrix with ${draft.body.levels.length} levels`;
  if (draft.kind === 'hazard') return 'an identified hazard, to be assessed by a person';
  if (draft.kind === 'control') return `a proposed control on hazard ${item.hazardReference}`;
  if (draft.kind === 'document') return 'a draft document revision, to be reviewed, adopted and issued by a person';
  if (draft.kind === 'assurance')
    return `a draft safety assurance record with ${draft.body.findings.length} findings and ${draft.body.actions.length} actions, to be signed by a person`;
  return 'a received safety report';
}

/** The API's refusal, its code and sentence. */
function refusalSentence(error: ApiError): string {
  const body = error.body as { error?: { code?: string; message?: string } } | undefined;
  return `Ledger refused it (${error.status}${body?.error?.code ? ` ${body.error.code}` : ''}): ${body?.error?.message ?? error.message}.`;
}

// ---- a person's decisions

/** A person's decision printed under a credential that is not a person's: refused with a reason, printed without. */
function personsDecision(who: CurrentPrincipalResponse, reason: string | undefined, lines: string[], what: string) {
  const decision = `${what} is a person's decision`;
  refuseUnlessPerson(who, reason, lines, decision, 'The person who decides');
  return personSendsIt(who, decision, 'The person who decides');
}

async function sendDecision(
  context: Context,
  shown: SmsRecordDetailResponse,
  basis: SmsRecordDetailResponse['basis'],
  decision: SmsDecisionInput,
  grant?: string,
): Promise<CommandResponse> {
  const body: Command = {
    kind: 'decision.record',
    subject: { kind: 'sms', id: shown.record.id },
    expectedRevision: basis.revision,
    expectedDependencyBasis: basis.dependencyBasis,
    decision,
  } as Command;
  return context.client.request<CommandResponse>(
    '/v1/commands',
    { method: 'POST', body: JSON.stringify(body), ...(grant ? { headers: { [REAUTHENTICATION_HEADER]: grant } } : {}) },
    randomUUID(),
  );
}

/** An unsigned decision of a person: printed, and sent only with their reason and their own credential. */
async function decide(
  context: Context,
  request: SafetyRequest,
  shown: SmsRecordDetailResponse,
  what: string,
  lines: string[],
  decision: (note: string) => SmsDecisionInput,
): Promise<Output> {
  const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
  lines.push(
    `Reason: ${request.reason?.trim() || 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  );
  const plan = {
    record: shown.record.id,
    reference: shown.record.reference,
    decision: decision(request.reason?.trim() || ''),
  };
  if (!isPerson(who))
    return { data: { sent: false, ...plan }, lines: [...lines, personsDecision(who, request.reason, lines, what)] };
  if (!request.reason?.trim())
    return {
      data: { sent: false, ...plan },
      lines: [
        ...lines,
        'Not sent. The person runs this again with --reason "<their reason>"; the reason is kept with the decision.',
      ],
    };
  const sent = await sendDecision(context, shown, shown.basis, plan.decision);
  return {
    data: { sent: true, ...plan, command: sent.command },
    lines: [...lines, `Recorded. Decision ${sent.command.id}.`],
  };
}

/**
 * A signed decision of a person: Ledger's own intent statement and content digest are printed, and it is sent only
 * with their reason. On a local Ledger the client confirms it is them with their own development token, and keeps the
 * grant nowhere; on a deployment the person signs in the browser.
 */
async function sign(
  context: Context,
  request: SafetyRequest,
  shown: SmsRecordDetailResponse,
  meaning: SigningMeaning,
  what: string,
  decision: (note: string, signature: { intent: string; contentDigest: string; reviewed: true }) => SmsDecisionInput,
): Promise<Output> {
  const { client } = context;
  const who = await client.request<CurrentPrincipalResponse>('/v1/me');
  const preview = await client.request<SmsSigningPreviewResponse>(
    `/v1/sms/records/${encodeURIComponent(shown.record.id)}/signing?meaning=${encodeURIComponent(meaning)}`,
  );
  const lines = [
    `${capital(what)}: ${recordName(shown.record)}, version ${shown.record.versionNumber}.`,
    ...(preview.intent ? [`What you sign: ${preview.intent}`, `Content digest: ${preview.contentDigest}`] : []),
    `Reason: ${request.reason?.trim() || 'none given'}`,
    `Recorded as ${who.principal.name} (${who.principal.id}).`,
  ];
  if (!isPerson(who))
    return {
      data: { sent: false, record: shown.record.id, preview },
      lines: [...lines, personsDecision(who, request.reason, lines, capital(what))],
    };
  if (!preview.available || !preview.intent || !preview.contentDigest)
    return {
      data: { sent: false, record: shown.record.id, preview },
      lines: [...lines, `Not sent. ${(preview.reason ?? 'It cannot be signed now').replace(/\.?$/, '.')}`],
      refused: Boolean(request.reason?.trim()),
    };
  const signature = { intent: preview.intent, contentDigest: preview.contentDigest, reviewed: true as const };
  const plan = {
    record: shown.record.id,
    reference: shown.record.reference,
    meaning,
    decision: decision(request.reason?.trim() || '', signature),
  };
  if (!request.reason?.trim())
    return {
      data: { sent: false, ...plan },
      lines: [
        ...lines,
        'Not sent. The person signs by running this again with --reason "<their reason>"; the reason is kept with the signature.',
      ],
    };
  const signIn = await client.request<SignInConfiguration>('/v1/sign-in');
  if (preview.reauthentication !== 'local_fixture' || !signIn.developmentTokens)
    return {
      data: { sent: false, ...plan, signIn: 'browser' },
      lines: [
        ...lines,
        `Not sent. On this Ledger a signature needs a fresh sign-in at your identity provider, which only the browser does: ${who.principal.name} opens Safety, finds ${recordName(shown.record)} and signs it there. The Safety home lists it as waiting for a person.`,
      ],
    };
  const grant = await client.request<LocalReauthenticationResponse>('/v1/local/reauthentications', {
    method: 'POST',
    body: JSON.stringify({ credential: request.credential }),
  });
  const sent = await sendDecision(context, shown, preview.basis, plan.decision, grant.grant);
  return {
    data: { sent: true, ...plan, command: sent.command },
    lines: [
      ...lines,
      `Signed, after confirming it is ${who.principal.name} with their own development token. Decision ${sent.command.id}.`,
    ],
  };
}

const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

function latestDecision(shown: SmsRecordDetailResponse, kind: string) {
  return [...shown.decisions]
    .filter((decision) => decision.kind === kind)
    .sort((a, b) => b.acceptedRevision - a.acceptedRevision)[0];
}

function levelWords(matrix: RiskMatrixBody, position: { severity: string; likelihood: string }): string {
  const severity = matrix.severities.find((entry) => entry.id === position.severity)!;
  const likelihood = matrix.likelihoods.find((entry) => entry.id === position.likelihood)!;
  const cell = matrix.cells.find(
    (entry) => entry.severity === position.severity && entry.likelihood === position.likelihood,
  );
  const level = matrix.levels.find((entry) => entry.id === cell?.level);
  return `${severity.label} × ${likelihood.label} = ${level?.label ?? cell?.level}, ${level ? acceptanceWords[level.acceptance] : 'not a level of the matrix'}`;
}

/** Assesses each hazard of a register file on the matrix in force, with the controls proposed on it. */
export async function safetyAssess(context: Context, path: string, request: SafetyRequest): Promise<Output> {
  const { who, home, files } = await orient(context);
  const matrix = home.program.matrix;
  if (!matrix)
    throw new RefusalError(
      'No risk matrix is in force. A person adopts one first: pnpm ledger safety adopt matrix <id>.',
    );
  const read = readItems('hazards', path, files);
  if (read.problems.length) throw new RefusalError(read.problems.map((problem) => `${path}: ${problem}`).join('\n'));
  const chosen = request.hazards.length
    ? read.assessments.filter((row) => request.hazards.includes(row.reference))
    : read.assessments;
  for (const named of request.hazards)
    if (!read.assessments.some((row) => row.reference === named))
      throw new UsageError(`${path} has no hazard ${named}.`);
  const lines = [`Matrix: “${matrix.version.body.name}”, version ${matrix.version.versionNumber}.`];
  const results: { reference: string; outcome: string; decisionId?: string }[] = [];
  const reason = request.reason?.trim();
  for (const row of chosen) {
    const problems: string[] = [];
    const initial = row.initial
      ? matrixPosition(matrix.version.body, row.initial)
      : { problem: 'Give severityBefore and likelihoodBefore.' };
    const residual = row.residual
      ? matrixPosition(matrix.version.body, row.residual)
      : { problem: 'Give severityAfter and likelihoodAfter.' };
    if (initial.problem) problems.push(initial.problem);
    if (residual.problem) problems.push(residual.problem);
    if (!row.newHazards)
      problems.push('Say in newHazards whether the controls introduce new hazards: "none", or what they are.');
    const found = await findByReference(context, 'hazard', row.reference);
    if (!found) problems.push('It is not on file; draft the register first: pnpm ledger safety draft hazards <file>.');
    if (problems.length || !found) {
      results.push({ reference: row.reference, outcome: 'refused' });
      lines.push(`Hazard ${row.reference}: not assessed. ${problems.join(' ')}`);
      continue;
    }
    const shown = await detail(context, found.id);
    const controls = (shown.controls ?? []).filter((control) => control.status !== 'closed');
    const none = /^none$/i.test(row.newHazards);
    const decision: SmsDecisionInput = {
      kind: 'risk.assess',
      note: reason ?? '',
      matrix: { recordId: matrix.record.id, versionNumber: matrix.version.versionNumber },
      initial: initial.position!,
      controls: controls.map((control) => ({ recordId: control.id, versionNumber: control.versionNumber })),
      residual: residual.position!,
      newHazardCheck: none ? { answer: 'none_identified' } : { answer: 'new_hazards_identified', note: row.newHazards },
    };
    const words = `before ${levelWords(matrix.version.body, initial.position!)}; with ${controls.length} ${controls.length === 1 ? 'control' : 'controls'}, ${levelWords(matrix.version.body, residual.position!)}.`;
    const last = latestDecision(shown, 'risk.assess');
    const lastOutcome = last?.outcome as
      | {
          initial?: { severity: string; likelihood: string };
          residual?: { severity: string; likelihood: string };
          matrix?: { recordId: string; versionNumber: number };
        }
      | undefined;
    const unchanged =
      last &&
      shown.record.status !== 'needs_reassessment' &&
      lastOutcome?.matrix?.recordId === matrix.record.id &&
      lastOutcome.matrix.versionNumber === matrix.version.versionNumber &&
      lastOutcome.initial?.severity === initial.position!.severity &&
      lastOutcome.initial.likelihood === initial.position!.likelihood &&
      lastOutcome.residual?.severity === residual.position!.severity &&
      lastOutcome.residual.likelihood === residual.position!.likelihood;
    if (unchanged) {
      results.push({ reference: row.reference, outcome: 'assessed_already', decisionId: last.id });
      lines.push(`Hazard ${row.reference}: assessed so already (${last.id}); nothing sent.`);
      continue;
    }
    if (!reason || !isPerson(who)) {
      results.push({ reference: row.reference, outcome: 'not_sent' });
      lines.push(`Hazard ${row.reference}: would record ${words}`);
      continue;
    }
    try {
      const sent = await sendDecision(context, shown, shown.basis, decision);
      results.push({ reference: row.reference, outcome: 'assessed', decisionId: sent.command.id });
      lines.push(`Hazard ${row.reference}: assessed, ${words}`);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      results.push({ reference: row.reference, outcome: 'refused' });
      lines.push(`Hazard ${row.reference}: not assessed. ${refusalSentence(error)}`);
    }
  }
  lines.push(`Reason: ${reason || 'none given'}`, `Recorded as ${who.principal.name} (${who.principal.id}).`);
  if (!isPerson(who)) lines.push(personsDecision(who, reason, lines, 'Assessing a risk'));
  else if (!reason)
    lines.push(
      'Not sent. The person who assesses runs this again with --reason "<their reason>"; it is kept with each assessment.',
    );
  return {
    data: { matrix: matrix.record.id, results },
    lines,
    refused: results.some((result) => result.outcome === 'refused'),
  };
}

async function recipientIds(context: Context, named: string[]): Promise<{ ids: string[]; names: string[] }> {
  const home = await context.client.request<SmsHomeResponse>('/v1/sms/home');
  if (!named.length)
    throw new UsageError(
      'Give who it is issued to: --recipient "<full name or id>" for each person, or --recipient everyone.',
    );
  if (named.includes('everyone'))
    return { ids: home.people.map((person) => person.id), names: home.people.map((person) => person.name) };
  const people = named.map((name) => {
    const person = home.people.find(
      (candidate) => candidate.id === name || candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!person)
      throw new UsageError(
        `${name} is nobody who may read safety records here. pnpm ledger people list shows each person.`,
      );
    return person;
  });
  return { ids: people.map((person) => person.id), names: people.map((person) => person.name) };
}

/** pnpm ledger safety <verb> ...: what each verb reads, and the command it runs. */
export async function runSafety(context: Context, request: SafetyRequest): Promise<Output> {
  const [first, second, third] = request.args;
  const only = (count: number, what: string) => {
    if (request.args.length !== count) throw new UsageError(`Give ${what}.`);
  };
  switch (request.verb) {
    case 'home':
      only(0, 'no arguments to safety home');
      return safetyHome(context);
    case 'control-types':
      only(0, 'no arguments to safety control-types');
      return safetyControlTypes(context);
    case 'template':
      only(1, `the kind of file: ${Object.keys(safetyFileKinds).join(', ')}`);
      return safetyTemplate(first, request.out === undefined ? undefined : request.path(request.out));
    case 'check':
    case 'draft':
      only(2, 'the kind of file and the file');
      return safetyDraft(context, first, request.path(second!), request.verb === 'draft');
    case 'assess':
      only(1, 'the hazard register file');
      return safetyAssess(context, request.path(first!), request);
    case 'accept': {
      only(1, 'the hazard');
      const shown = await recordOf(context, 'hazard', first);
      const assessment = latestDecision(shown, 'risk.assess');
      if (!assessment)
        throw new RefusalError(
          `${recordName(shown.record)} has no risk assessment yet. A person assesses it first: pnpm ledger safety assess <file>.`,
        );
      return sign(
        context,
        request,
        shown,
        'risk.accept',
        'accepting the predicted residual risk of',
        (note, signature) => ({
          kind: 'risk.accept',
          note,
          assessmentId: assessment.id,
          signature,
        }),
      );
    }
    case 'adopt': {
      only(2, 'what to adopt, matrix or document, and its id');
      if (first !== 'matrix' && first !== 'document') throw new UsageError('safety adopt takes matrix or document.');
      const shown = await recordOf(context, first === 'matrix' ? 'risk_matrix' : 'document', second);
      const meaning = first === 'matrix' ? 'matrix.adopt' : 'document.adopt';
      return sign(context, request, shown, meaning, `adopting the ${first}`, (note, signature) => ({
        kind: meaning,
        note,
        versionNumber: shown.record.versionNumber,
        signature,
      }));
    }
    case 'sign': {
      only(1, 'the safety assurance record');
      const shown = await recordOf(context, 'assurance', first);
      return sign(
        context,
        request,
        shown,
        'assurance.sign',
        'signing the safety assurance record',
        (note, signature) => ({
          kind: 'assurance.sign',
          note,
          versionNumber: shown.record.versionNumber,
          signature,
        }),
      );
    }
    case 'review': {
      only(1, 'the document');
      const shown = await recordOf(context, 'document', first);
      return decide(
        context,
        request,
        shown,
        'Reviewing a document revision',
        [`Review: ${recordName(shown.record)}, version ${shown.record.versionNumber}.`],
        (note) => ({
          kind: 'document.review',
          note,
          versionNumber: shown.record.versionNumber,
          attachmentIds: [],
        }),
      );
    }
    case 'issue': {
      only(1, 'the document');
      const shown = await recordOf(context, 'document', first);
      const adoption = latestDecision(shown, 'document.adopt');
      if (!adoption)
        throw new RefusalError(
          `${recordName(shown.record)} is not adopted yet. A person adopts it first: pnpm ledger safety adopt document ${first}.`,
        );
      const recipients = await recipientIds(context, request.recipients);
      const who = await context.client.request<CurrentPrincipalResponse>('/v1/me');
      const zone = who.organization?.timeZone ?? 'UTC';
      const effectiveFrom = request.from ? instantFrom(request.from, zone) : undefined;
      return decide(
        context,
        request,
        shown,
        'Issuing a document revision',
        [
          `Issue: ${recordName(shown.record)}, version ${shown.record.versionNumber}.`,
          `In force from: ${effectiveFrom ? (zonedInstantText(effectiveFrom, zone) ?? effectiveFrom) : 'when it is issued'}.`,
          `Readers: ${recipients.names.join(', ') || 'nobody'}.`,
        ],
        (note) => ({
          kind: 'document.issue',
          note,
          versionNumber: shown.record.versionNumber,
          adoptionId: adoption.id,
          recipientIds: recipients.ids,
          ...(effectiveFrom ? { effectiveFrom } : {}),
        }),
      );
    }
    case 'close-action': {
      only(2, 'the safety assurance record and the action');
      const shown = await recordOf(context, 'assurance', first);
      const action = shown.assurance?.actions.find((candidate) => candidate.id === second);
      if (!action) throw new RefusalError(`${recordName(shown.record)} sets no action ${second}.`);
      return decide(
        context,
        request,
        shown,
        'Closing an action',
        [`Close: action ${action.id} of ${recordName(shown.record)}: ${action.what}`, `Owner: ${action.owner.name}.`],
        (note) => ({ kind: 'action.close', note, actionId: action.id }),
      );
    }
    default:
      void third;
      throw new UsageError(
        `Unknown command: safety ${request.verb ?? '(none)'}. pnpm ledger --help lists the safety commands.`,
      );
  }
}

function instantFrom(text: string, zone: string): string {
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(text) ? undefined : Date.parse(text);
  if (instant !== undefined) {
    if (!Number.isFinite(instant))
      throw new UsageError(`--from is a date such as 2026-06-01 or a time with its offset: ${text}`);
    return new Date(instant).toISOString();
  }
  const [year, month, day] = text.split('-').map(Number);
  return new Date(
    Date.UTC(year!, month! - 1, day!) - zoneOffsetAt(Date.UTC(year!, month! - 1, day!), zone),
  ).toISOString();
}

function zoneOffsetAt(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - instant;
}
