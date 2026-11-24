import type { Principal, RiskAuthority, SmsHomeResponse, SmsRecordSummary } from '@ledger/contracts';
import { riskAuthorityValues } from '@ledger/contracts';

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
