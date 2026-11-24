import {
  assuranceBodyProblems,
  assuranceTypes,
  type AssuranceBody,
  type AssuranceType,
  type AssuranceTypeField,
} from '@ledger/contracts';

// The safety assurance record form: what a person typed, turned into the body Ledger records, with every problem in
// plain words before anything is sent. The type selects which of its own fields the form asks for.

export interface AssuranceFindingRow {
  id: string;
  text: string;
}
export interface AssuranceActionRow {
  id: string;
  what: string;
  ownerId: string;
  dueOn: string;
  findingId: string;
}
export interface AssuranceFormState {
  assuranceType: AssuranceType;
  title: string;
  performedOn: string;
  completedOn: string;
  scope: string;
  examined: string;
  occurredOn: string;
  fromReport: string;
  system: string;
  counterpart: string;
  findings: AssuranceFindingRow[];
  actions: AssuranceActionRow[];
}

export function emptyAssuranceForm(assuranceType: AssuranceType = 'audit'): AssuranceFormState {
  return {
    assuranceType,
    title: '',
    performedOn: '',
    completedOn: '',
    scope: '',
    examined: '',
    occurredOn: '',
    fromReport: '',
    system: '',
    counterpart: '',
    findings: [],
    actions: [],
  };
}

/** The form holding a recorded version, to revise it. */
export function assuranceFormFrom(title: string, body: AssuranceBody): AssuranceFormState {
  return {
    assuranceType: body.assuranceType,
    title,
    performedOn: body.performedOn,
    completedOn: body.completedOn ?? '',
    scope: body.scope,
    examined: body.examined,
    occurredOn: body.occurredOn ?? '',
    fromReport: body.fromReport ?? '',
    system: body.system ?? '',
    counterpart: body.counterpart ?? '',
    findings: body.findings.map((finding) => ({ ...finding })),
    actions: body.actions.map((action) => ({ ...action, findingId: action.findingId ?? '' })),
  };
}

/** The type's own fields the form asks for, in the order it shows them. */
export function assuranceFieldsAsked(type: AssuranceType): { field: AssuranceTypeField; required: boolean }[] {
  const fields = assuranceTypes[type].fields;
  return (Object.keys(fields) as AssuranceTypeField[]).map((field) => ({
    field,
    required: fields[field] === 'required',
  }));
}

/** The next free id for a new finding (F) or action (A): one more than the highest number used. */
export function nextItemId(prefix: 'F' | 'A', items: { id: string }[]): string {
  const used = items.flatMap((item) => {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(item.id);
    return match ? [Number(match[1])] : [];
  });
  return `${prefix}${Math.max(0, ...used) + 1}`;
}

const blank = (value: string) => !value.trim();

/**
 * The title and body to record, and what is wrong with them. A finding or action left blank is dropped; a field the chosen
 * type does not ask for is left out, so changing the type never sends one. `today` is the organization's day.
 */
export function assuranceDraft(
  state: AssuranceFormState,
  today: string,
): { title: string; body: AssuranceBody; problems: string[] } {
  const problems: string[] = [];
  const title = state.title.trim();
  if (!title) problems.push('Give the record a title.');
  if (!state.performedOn) problems.push('Give the date it was performed.');
  if (blank(state.scope)) problems.push('Say what it covered.');
  if (blank(state.examined)) problems.push('Say what it looked at.');
  const findings = state.findings
    .filter((finding) => !blank(finding.text))
    .map((finding) => ({ id: finding.id.trim(), text: finding.text.trim() }));
  const actions = state.actions
    .filter((action) => !blank(action.what) || action.dueOn)
    .map((action) => ({
      id: action.id.trim(),
      what: action.what.trim(),
      ownerId: action.ownerId,
      dueOn: action.dueOn,
      ...(action.findingId ? { findingId: action.findingId } : {}),
    }));
  for (const action of actions) {
    if (!action.what) problems.push(`Say what action ${action.id} is to do.`);
    if (!action.ownerId) problems.push(`Choose who owns action ${action.id}.`);
    if (!action.dueOn) problems.push(`Give action ${action.id} a due date.`);
  }
  const asked = new Map(assuranceFieldsAsked(state.assuranceType).map((entry) => [entry.field, entry.required]));
  const own = (field: AssuranceTypeField): string | undefined => {
    const value = state[field].trim();
    return asked.has(field) && value ? value : undefined;
  };
  const optional = <K extends AssuranceTypeField>(field: K) => {
    const value = own(field);
    return value === undefined ? {} : { [field]: value };
  };
  const body: AssuranceBody = {
    assuranceType: state.assuranceType,
    performedOn: state.performedOn,
    ...(state.completedOn ? { completedOn: state.completedOn } : {}),
    scope: state.scope.trim(),
    examined: state.examined.trim(),
    findings,
    actions,
    ...optional('occurredOn'),
    ...optional('fromReport'),
    ...optional('system'),
    ...optional('counterpart'),
  };
  // Shape problems above are said first; the shared check adds what only the whole body shows.
  const shared = state.performedOn && actions.every((action) => action.dueOn) ? assuranceBodyProblems(body, today) : [];
  return { title, body, problems: [...new Set([...problems, ...shared])] };
}
