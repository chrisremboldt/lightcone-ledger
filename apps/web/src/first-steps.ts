import type {
  AdoptionRuleCoverageResponse,
  NamedSubject,
  OrganizationPerson,
  PackAdoptionRecord,
  Principal,
  RecordProduction,
  RiskAuthority,
  RulePackSummary,
  SmsHomeResponse,
  SmsRecordSummary,
} from '@ledger/contracts';
import { ACCEPTED_CONTROL_PACK_ID, OPERATOR_RECORD_SOURCE_ID, readsOnly, riskAuthorityValues } from '@ledger/contracts';
import { time, timeZoneLabel } from './format.js';
import { canKeepRecords } from './operator-records.js';
import type { Place } from './place.js';
import { subjectLabel } from './subject-label.js';

type Person = SmsHomeResponse['people'][number];

/** Where an item's action leads: a screen of the safety area, a record, or the People screen. */
export type FirstStepTarget =
  | { kind: 'people' }
  | { kind: 'new_matrix' }
  | { kind: 'new_policy' }
  | { kind: 'new_report' }
  | { kind: 'record'; id: string; recordKind: SmsRecordSummary['kind'] };

export interface FirstStep {
  key: string;
  title: string;
  onFile: boolean;
  /** What is on file, naming the record or the people; or what is missing. */
  detail: string;
  /** The one action that starts it, and who may take it; absent once it is on file. */
  action?: { label: string; who: string; target: FirstStepTarget; mine: boolean };
}

/** What the list reads: the safety home, the documents and matrices register, and the safety reports register. */
export interface FirstStepsInput {
  home: Pick<SmsHomeResponse, 'people' | 'program'> & Partial<Pick<SmsHomeResponse, 'reportLinks'>>;
  /** Documents and risk matrices, as the documents register lists them. */
  documents: readonly SmsRecordSummary[];
  reports: readonly SmsRecordSummary[];
  principal: Pick<Principal, 'id' | 'capabilities'>;
}

const levelWords: Record<RiskAuthority, string> = { low: 'low', medium: 'medium', high: 'high' };
const ADMINISTRATOR = 'An administrator';

function names(people: readonly Person[]): string {
  const listed = people.map((person) => person.name);
  if (listed.length <= 1) return listed.join('');
  return `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
}

/** Who may take an action: the people named, or what the action needs when no one holds it yet. */
function who(people: readonly Person[], needs: string): string {
  return people.length ? names(people) : `A person who may ${needs}; no one may yet`;
}

function grant(principal: FirstStepsInput['principal']): NonNullable<FirstStep['action']> {
  return {
    label: 'Grant it on the People screen',
    who: ADMINISTRATOR,
    target: { kind: 'people' },
    mine: principal.capabilities.includes('authority:write'),
  };
}

function covers(person: Person, level: RiskAuthority): boolean {
  return (
    person.authority !== null && riskAuthorityValues.indexOf(person.authority) >= riskAuthorityValues.indexOf(level)
  );
}

function adoptionStep({ home, principal }: FirstStepsInput): FirstStep {
  const adopters = home.people.filter((person) => person.adopts);
  return {
    key: 'adopt',
    title: 'A person who may sign to adopt a risk matrix and documents',
    onFile: adopters.length > 0,
    detail: adopters.length ? names(adopters) : 'No one may adopt a risk matrix or sign a document yet.',
    ...(adopters.length ? {} : { action: grant(principal) }),
  };
}

function acceptanceStep({ home, principal }: FirstStepsInput, level: RiskAuthority): FirstStep {
  const accepting = home.people.filter((person) => covers(person, level));
  return {
    key: `accept-${level}`,
    title: `A person who may accept ${levelWords[level]} risk`,
    onFile: accepting.length > 0,
    detail: accepting.length ? names(accepting) : `No one may accept ${levelWords[level]} risk yet.`,
    ...(accepting.length ? {} : { action: grant(principal) }),
  };
}

function matrixStep({ home, documents, principal }: FirstStepsInput): FirstStep {
  const inForce = home.program.matrix;
  if (inForce)
    return {
      key: 'matrix',
      title: 'A risk matrix in force',
      onFile: true,
      detail: `${inForce.version.body.name}, version ${inForce.version.versionNumber}, adopted`,
    };
  const draft = documents.find((record) => record.kind === 'risk_matrix' && record.status !== 'closed');
  if (draft) {
    const adopters = home.people.filter((person) => person.adopts);
    return {
      key: 'matrix',
      title: 'A risk matrix in force',
      onFile: false,
      detail: `“${draft.title}” version ${draft.versionNumber} is a draft until it is signed.`,
      action: {
        label: 'Review and sign the draft',
        who: who(adopters, 'adopt a risk matrix'),
        target: { kind: 'record', id: draft.id, recordKind: draft.kind },
        mine: principal.capabilities.includes('sms:adopt'),
      },
    };
  }
  const configurers = home.people.filter((person) => person.configures);
  return {
    key: 'matrix',
    title: 'A risk matrix in force',
    onFile: false,
    detail: 'No risk matrix is adopted. Hazards can be recorded but not assessed.',
    action: {
      label: 'Start a risk matrix',
      who: who(configurers, 'configure safety records'),
      target: { kind: 'new_matrix' },
      mine: principal.capabilities.includes('sms:configure'),
    },
  };
}

function policyStep({ home, documents, principal }: FirstStepsInput): FirstStep {
  const policies = documents.filter(
    (record) => record.kind === 'document' && record.document?.documentType === 'safety_policy',
  );
  const inForce = policies.find((record) => record.document?.inForce);
  if (inForce) {
    const issue = inForce.document!.inForce!;
    return {
      key: 'policy',
      title: 'A safety policy in force',
      onFile: true,
      detail: `${inForce.title}, ${issue.revisionLabel ?? `version ${issue.versionNumber}`}, in force`,
    };
  }
  const writers = home.people.filter((person) => person.writes);
  const draft = policies.find((record) => record.status !== 'closed');
  if (draft)
    return {
      key: 'policy',
      title: 'A safety policy in force',
      onFile: false,
      detail: `“${draft.title}” is not in force yet: it is reviewed, signed and issued to its readers first.`,
      action: {
        label: 'Open the draft policy',
        who: who(writers, 'write safety records'),
        target: { kind: 'record', id: draft.id, recordKind: draft.kind },
        mine: principal.capabilities.includes('sms:write'),
      },
    };
  return {
    key: 'policy',
    title: 'A safety policy in force',
    onFile: false,
    detail: 'No safety policy is recorded.',
    action: {
      label: 'Draft a safety policy',
      who: who(writers, 'write safety records'),
      target: { kind: 'new_policy' },
      mine: principal.capabilities.includes('sms:write'),
    },
  };
}

/** How people can send a report themselves: signed in, and through each reporting link in force, by its label. */
function submission(home: FirstStepsInput['home']): string {
  const links = (home.reportLinks ?? []).map((link) => `“${link.label}”`);
  if (!links.length) return ' Anyone signed in can submit a report; no reporting link is in force.';
  const listed = links.length === 1 ? links[0] : `${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}`;
  return ` Anyone signed in can submit a report, and anyone without signing in through the reporting ${links.length === 1 ? 'link' : 'links'} ${listed}.`;
}

function reportsStep({ home, reports, principal }: FirstStepsInput): FirstStep {
  const cleared = home.people.filter((person) => person.readsReports);
  const receivers = cleared.filter((person) => person.writes);
  const recorded = reports.length
    ? ` ${reports.length} safety ${reports.length === 1 ? 'report' : 'reports'} on file.`
    : ' No safety report on file yet.';
  if (receivers.length)
    return {
      key: 'reports',
      title: 'Who receives safety reports and who is cleared to read them',
      onFile: true,
      detail: `Recorded as received by ${names(receivers)}.${submission(home)} Cleared to read them, including who reported: ${names(cleared)}.${recorded}`,
    };
  return {
    key: 'reports',
    title: 'Who receives safety reports and who is cleared to read them',
    onFile: false,
    detail: cleared.length
      ? `${names(cleared)} may read safety reports but not record them.${submission(home)}`
      : `No one is cleared to read safety reports, so none can be read or recorded as received.${submission(home)}`,
    action: grant(principal),
  };
}

/**
 * The organization's first steps as what is on file and what is not, each missing one with the action that starts it
 * and who may take it. It lists what is on file; it never says the whole is complete.
 */
export function firstSteps(input: FirstStepsInput): FirstStep[] {
  return [
    adoptionStep(input),
    ...riskAuthorityValues.map((level) => acceptanceStep(input, level)),
    matrixStep(input),
    policyStep(input),
    reportsStep(input),
  ];
}

/** Whether the safety home carries what the list needs; recordings made before it was added do not. */
export function firstStepsReadable(home: Pick<SmsHomeResponse, 'people'>): boolean {
  return home.people.every((person) => 'writes' in person && 'readsReports' in person && 'configures' in person);
}

/** Where an item's action leads, and what the move there keeps: a draft policy opens its form, a draft matrix its signing. */
export function firstStepPlace(target: FirstStepTarget): { place: Place; extras: Record<string, unknown> } {
  switch (target.kind) {
    case 'people':
      return { place: { section: 'people' }, extras: {} };
    case 'new_matrix':
      return { place: { section: 'safety', view: 'new-risk-matrix' }, extras: {} };
    case 'new_policy':
      return { place: { section: 'safety', view: 'documents' }, extras: { drafting: true } };
    case 'new_report':
      return { place: { section: 'safety', view: 'reports' }, extras: {} };
    case 'record':
      return {
        place: { section: 'safety', view: 'record', kind: target.recordKind, id: target.id },
        extras: target.recordKind === 'document' ? {} : { sign: true },
      };
  }
}

// The whole first day, in the order of the setup guide.

/** A step's state: on file or not, read (coverage, which says something rather than being ticked), or unreadable. */
export type FirstDayState = 'on_file' | 'not_on_file' | 'read' | 'unreadable';

export interface FirstDayAction {
  label: string;
  who: string;
  /** The exact place in Ledger where it starts; absent for a step done on a command line. */
  place?: Place;
  extras?: Record<string, unknown>;
  /** For a step done on a command line: the command that starts it and the guide section that walks it. */
  command?: string;
  guide?: string;
  /** Whether the signed-in person may take it here. */
  mine: boolean;
}

export interface FirstDayStep {
  key: 'people' | 'records' | 'pack-file' | 'adoption' | 'coverage' | 'safety' | 'production';
  number: number;
  title: string;
  state: FirstDayState;
  optional?: true;
  /** What is on file, in the organization's own words and ids; or what is not. */
  detail: string;
  action?: FirstDayAction;
  /** The safety items of the safety step, each as the safety home lists it. */
  items?: FirstStep[];
}

/** What the list reads. A read the person may not make, or that failed, is null. */
export interface FirstDayInput {
  principal: Pick<Principal, 'id' | 'name' | 'capabilities' | 'observationGrants'>;
  /** People who may sign in, the first page of them, and whether more exist. */
  people: { people: readonly Pick<OrganizationPerson, 'id' | 'name'>[]; more: boolean } | null;
  /** The first few subjects of each kind on record. */
  subjects: Record<'aircraft' | 'person' | 'flight', readonly NamedSubject[]> | null;
  packs: readonly RulePackSummary[] | null;
  adoptions: readonly PackAdoptionRecord[] | null;
  /** The coverage of each adoption in effect. */
  coverage: readonly AdoptionRuleCoverageResponse[] | null;
  safety: Omit<FirstStepsInput, 'principal'> | null;
  /** The latest production of records, if any. */
  productions: { latest: Pick<RecordProduction, 'producedAt' | 'producedBy' | 'requestedBy'> | null } | null;
}

const ANYONE_READING_RECORDS = 'Anyone who may read records';

function list(values: readonly string[], more = false): string {
  if (more) return `${values.join(', ')} and more`;
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function may(principal: FirstDayInput['principal'], capability: string): boolean {
  return (principal.capabilities as readonly string[]).includes(capability);
}

function unreadable(step: Omit<FirstDayStep, 'state' | 'detail'>, what: string): FirstDayStep {
  return { ...step, state: 'unreadable', detail: `Your role does not let you read ${what}, or it could not be read.` };
}

function peopleStep({ principal, people }: FirstDayInput): FirstDayStep {
  const action: FirstDayAction = {
    label: 'Add a person on the People screen',
    who: ADMINISTRATOR,
    place: { section: 'people' },
    mine: may(principal, 'authority:write'),
  };
  const step = { key: 'people' as const, number: 1, title: 'The people who sign in' };
  if (!people) return unreadable({ ...step, action }, 'who may sign in');
  const named = people.people.map((person) => person.name);
  if (named.length >= 2) return { ...step, state: 'on_file', detail: `${list(named, people.more)} may sign in.` };
  // One person is a whole organization for a sole operator: it is on file, and the way to add another stays.
  if (named.length === 1)
    return {
      ...step,
      state: 'on_file',
      detail: `Only ${named[0]} may sign in. Add anyone else who will use Ledger.`,
      action,
    };
  return { ...step, state: 'not_on_file', detail: 'No one may sign in.', action };
}

const subjectKinds = [
  ['aircraft', 'Aircraft'],
  ['person', 'Pilots'],
  ['flight', 'Flights'],
] as const;

function recordsStep({ principal, subjects }: FirstDayInput): FirstDayStep {
  const action: FirstDayAction = {
    label: 'Import or enter records under Records',
    who: 'A person who keeps your records',
    place: { section: 'records', pane: 'import' },
    mine: canKeepRecords(principal, OPERATOR_RECORD_SOURCE_ID),
  };
  const step = { key: 'records' as const, number: 2, title: 'An aircraft, a pilot and a flight on record' };
  if (!subjects) return unreadable({ ...step, action }, 'the records on file');
  const shown = subjectKinds.map(([kind, label]) => {
    const found = subjects[kind];
    return `${label}: ${found.length ? list(found.slice(0, 2).map(subjectLabel), found.length > 2) : 'none on record'}.`;
  });
  const onFile = subjectKinds.every(([kind]) => subjects[kind].length > 0);
  return { ...step, state: onFile ? 'on_file' : 'not_on_file', detail: shown.join(' '), ...(onFile ? {} : { action }) };
}

function packFileStep({ packs }: FirstDayInput): FirstDayStep {
  const action: FirstDayAction = {
    label: 'Write your waiver or procedure as a pack, build it and load the file',
    who: 'Someone who can edit a text file writes and builds it; whoever runs the Ledger server loads it',
    command: 'pnpm pack:new <name> --kind waiver',
    guide: 'Set up Ledger for your organization, section 6, “Bring your own waiver and procedures”',
    mine: false,
  };
  const step = { key: 'pack-file' as const, number: 3, title: 'Your own waiver or procedure, offered as a rule pack' };
  if (!packs) return unreadable({ ...step, action }, 'the rule packs offered');
  const own = packs.flatMap((pack) =>
    pack.origin.kind === 'organization_file'
      ? [`${pack.title} version ${pack.version}, from the file ${pack.origin.file}`]
      : [],
  );
  if (own.length) return { ...step, state: 'on_file', detail: `${list(own)}.` };
  return {
    ...step,
    state: 'not_on_file',
    detail: 'No pack file of your own is loaded; only the packs built into Ledger are offered.',
    action,
  };
}

/** The adoptions a person made that are in effect or will be: not the rules Ledger assembles from accepted controls. */
export function adoptionsInForce(adoptions: readonly PackAdoptionRecord[]): PackAdoptionRecord[] {
  return adoptions.filter(
    (adoption) =>
      adoption.pack.packId !== ACCEPTED_CONTROL_PACK_ID &&
      ['pending', 'scheduled', 'effective'].includes(adoption.state),
  );
}

function rulePackStep({ principal, adoptions }: FirstDayInput): FirstDayStep {
  const action: FirstDayAction = {
    label: 'Adopt a rule pack on the Rules screen',
    who: 'A person who may adopt rule packs',
    place: { section: 'rules', pane: 'coverage' },
    mine: may(principal, 'pack:adopt'),
  };
  const step = { key: 'adoption' as const, number: 4, title: 'A rule pack adopted' };
  if (!adoptions) return unreadable({ ...step, action }, 'the adopted rule packs');
  const inForce = adoptionsInForce(adoptions).map(
    (adoption) =>
      `${adoption.pack.title} version ${adoption.pack.version}, ${adoption.mode === 'shadow' ? 'in shadow' : 'active'}`,
  );
  if (inForce.length) return { ...step, state: 'on_file', detail: `${list(inForce)}.` };
  return { ...step, state: 'not_on_file', detail: 'No rule pack is adopted.', action };
}

/** One line of what an adoption's coverage says: how many rules have a subject needing attention or a record missing. */
export function coverageLine(coverage: AdoptionRuleCoverageResponse): string {
  const attention = coverage.sections.reduce((sum, section) => sum + section.needingAttention, 0);
  const missing = coverage.sections.reduce((sum, section) => sum + section.withNoRecord, 0);
  const rules = (count: number) => `${count} ${count === 1 ? 'rule' : 'rules'}`;
  const said =
    attention || missing
      ? [
          attention ? `${rules(attention)} with a subject needing attention` : '',
          missing ? `${attention ? missing : rules(missing)} with a record not on file` : '',
        ]
          .filter(Boolean)
          .join(', ')
      : 'no rule with a subject needing attention or a record not on file';
  return `${coverage.title}${coverage.mode === 'shadow' ? ' (in shadow)' : ''}: ${said}.`;
}

function coverageStep({ principal, adoptions, coverage }: FirstDayInput): FirstDayStep {
  const first = adoptions ? adoptionsInForce(adoptions)[0] : undefined;
  const action: FirstDayAction = {
    label: 'Read coverage on the Rules screen',
    who: ANYONE_READING_RECORDS,
    place: { section: 'rules', pane: 'coverage', ...(first ? { packId: first.pack.packId } : {}) },
    mine: may(principal, 'evidence:read'),
  };
  const step = { key: 'coverage' as const, number: 5, title: 'What coverage says' };
  if (!coverage) return unreadable({ ...step, action }, 'coverage');
  if (!coverage.length)
    return { ...step, state: 'not_on_file', detail: 'Coverage is read once a rule pack is adopted and in effect.' };
  return { ...step, state: 'read', detail: coverage.map(coverageLine).join(' '), action };
}

function safetyStep({ principal, safety }: FirstDayInput): FirstDayStep {
  const step = {
    key: 'safety' as const,
    number: 6,
    title: 'Who may adopt and accept risk, a risk matrix, a safety policy and who receives safety reports',
  };
  if (!safety || !firstStepsReadable(safety.home)) return unreadable(step, 'the safety records');
  const items = firstSteps({ ...safety, principal });
  const onFile = items.filter((item) => item.onFile).length;
  return {
    ...step,
    state: onFile === items.length ? 'on_file' : 'not_on_file',
    detail: `${onFile} of ${items.length} on file.`,
    items,
  };
}

function productionStep({ principal, productions }: FirstDayInput): FirstDayStep {
  const action: FirstDayAction = {
    label: 'Produce records under Records',
    who: ANYONE_READING_RECORDS,
    place: { section: 'records', pane: 'produce' },
    mine: may(principal, 'evidence:read') && !readsOnly(principal.capabilities),
  };
  const step = {
    key: 'production' as const,
    number: 7,
    title: 'Records produced for someone who asks for them',
    optional: true as const,
  };
  if (!productions) return unreadable({ ...step, action }, 'the records produced');
  const latest = productions.latest;
  if (latest)
    return {
      ...step,
      state: 'on_file',
      detail: `Latest produced ${time(latest.producedAt, true)} ${timeZoneLabel()}${latest.producedBy.name ? ` by ${latest.producedBy.name}` : ''}, asked for by ${latest.requestedBy}.`,
    };
  return {
    ...step,
    state: 'not_on_file',
    detail: 'No records have been produced. This step is for when an inspector or a customer asks for records.',
    action,
  };
}

/**
 * The whole first day, in the order of the setup guide: each step with what is on file and what is not, and the one
 * action that starts it with who may take it. Every state comes from what is on record; it never says the whole is
 * complete.
 */
export function firstDaySteps(input: FirstDayInput): FirstDayStep[] {
  return [
    peopleStep(input),
    recordsStep(input),
    packFileStep(input),
    rulePackStep(input),
    coverageStep(input),
    safetyStep(input),
    productionStep(input),
  ];
}

/** Whether a person may take one of the steps that open the list: add people, keep records or adopt rule packs. */
export function mayStartFirstDay(principal: FirstDayInput['principal']): boolean {
  return (
    may(principal, 'authority:write') ||
    may(principal, 'pack:adopt') ||
    canKeepRecords(principal, OPERATOR_RECORD_SOURCE_ID)
  );
}

/** Whether a person can read what steps 1 to 4 need: who signs in, the records on file, the packs and adoptions. */
function readsFirstDay(principal: FirstDayInput['principal']): boolean {
  return may(principal, 'flight:read') && may(principal, 'evidence:read');
}

/**
 * Whether the workspace opens on the list rather than where it opened before: for a person who reads flights and may
 * add people, keep records or adopt rule packs, while the organization has adopted no rule pack. Null adoptions (not
 * read) never open it.
 */
export function opensOnFirstDay(
  principal: FirstDayInput['principal'],
  adoptions: readonly PackAdoptionRecord[] | null,
): boolean {
  return (
    readsFirstDay(principal) &&
    mayStartFirstDay(principal) &&
    adoptions !== null &&
    adoptionsInForce(adoptions).length === 0
  );
}

/**
 * Whether the bar offers "Setup": to the same people, while one of steps 1 to 4 or 6 is not on file. Coverage is read,
 * not ticked, and producing records is optional. A step that could not be read hides the entry rather than show it on
 * a guess.
 */
export function offersSetup(principal: FirstDayInput['principal'], steps: readonly FirstDayStep[]): boolean {
  if (!readsFirstDay(principal) || !mayStartFirstDay(principal)) return false;
  const counted = steps.filter((step) => step.key !== 'coverage' && step.key !== 'production');
  if (counted.some((step) => step.state === 'unreadable')) return false;
  return counted.some((step) => step.state !== 'on_file');
}
