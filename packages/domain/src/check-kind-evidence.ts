import { ObservationFieldPathPattern, type CheckDetails } from '@ledger/contracts';
import {
  latestObservations,
  observationField,
  registerCheckKind,
  utcMillis,
  type CheckKind,
  type CheckObservation,
  type CheckResult,
} from './check-kinds.js';
import { fieldLabel } from './field-labels.js';

// Check kinds about whether evidence agrees and whether it arrived in time. The rule names the fields, the deadline
// and the grace; nothing here knows what the evidence describes.

const fieldPath = { type: 'string', pattern: ObservationFieldPathPattern, maxLength: 400 } as const;

function result(
  evidenceState: CheckResult['evidenceState'],
  outcome: CheckResult['outcome'],
  reasonCode: string,
  summary: string,
  evidence: readonly CheckObservation[],
  details: CheckDetails,
  nextBoundary?: number,
): CheckResult {
  return {
    evidenceState,
    outcome,
    reasonCode,
    summary,
    evidence: evidence.map((observation) => observation.id),
    ...(nextBoundary === undefined ? {} : { nextBoundary: new Date(nextBoundary).toISOString() }),
    details,
  };
}

/** Distinct normalized values in a stable order, as one detail value. */
function listed(values: readonly ReportedValue[]): string | null {
  const distinct = [...new Set(values.map((item) => item.normalized))].sort();
  return distinct.length ? distinct.join(', ') : null;
}

const valueTypes = {
  utc_instant: (value: unknown) => {
    const time = utcMillis(value);
    return time === undefined ? undefined : new Date(time).toISOString();
  },
  string: (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined),
  number: (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined),
} as const;

interface ReportedValue {
  observation: CheckObservation;
  normalized: string;
}

/** Each observation's valid values of the named fields, normalized so equal values compare equal. */
function reportedValues(
  observations: readonly CheckObservation[],
  fields: readonly string[],
  valueType: keyof typeof valueTypes,
): ReportedValue[] {
  return observations.flatMap((observation) =>
    fields.flatMap((field) => {
      const normalized = valueTypes[valueType](observationField(observation, field));
      return normalized === undefined ? [] : [{ observation, normalized }];
    }),
  );
}

function distinctObservations(values: readonly ReportedValue[]): CheckObservation[] {
  return [...new Map(values.map((item) => [item.observation.id, item.observation])).values()];
}

// Reported values disagree ---------------------------------------------------------------------------------------

export interface ValuesDisagreeParams {
  fields: string[];
  valueType: keyof typeof valueTypes;
}

export const valuesDisagreeV1: CheckKind<ValuesDisagreeParams> = {
  id: 'values.disagree',
  version: 1,
  title: 'Reported values disagree',
  description:
    'Every valid value of the named fields across the observations the rule reads is compared. More than one distinct value is a disagreement that needs attention; one value is supported; no valid value is insufficient. Values are compared by type: instants after normalising to UTC, so equal instants written differently agree. Invalid values are ignored, never compared. The check never picks one of disagreeing values.',
  inputs: [{ name: 'reports', description: 'Observations that may carry the compared fields.' }],
  details: [
    {
      name: 'values',
      description: 'The distinct valid values compared, normalized, sorted and comma separated; null when none.',
    },
    { name: 'valueCount', description: 'How many distinct valid values were compared.' },
    { name: 'reportCount', description: 'How many observations the check read.' },
  ],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fields', 'valueType'],
    properties: {
      fields: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: fieldPath },
      valueType: { enum: Object.keys(valueTypes) },
    },
  },
  evaluate(params, inputs) {
    const reports = inputs.reports ?? [];
    const values = reportedValues(reports, params.fields, params.valueType);
    const distinct = new Set(values.map((item) => item.normalized));
    const label = params.fields.join(' or ');
    const details = { values: listed(values), valueCount: distinct.size, reportCount: reports.length };
    if (distinct.size > 1)
      return result(
        'conflicting',
        'attention',
        'values_disagree',
        `${distinct.size} distinct ${label} values are reported. Review the retained observations.`,
        distinctObservations(values),
        details,
      );
    if (distinct.size === 1)
      return result(
        'supported',
        'pass',
        'values_agree',
        `The valid reported ${label} values do not disagree.`,
        distinctObservations(values),
        details,
      );
    return result(
      'insufficient',
      'pending',
      'value_missing',
      `No valid ${label} value is reported to compare.`,
      [],
      details,
    );
  },
};

// Evidence due by a deadline -------------------------------------------------------------------------------------

export interface EvidenceDueParams {
  fields: string[];
  valueType: keyof typeof valueTypes;
  deadlineField: string;
  graceSeconds: number;
}

export const evidenceDueV1: CheckKind<EvidenceDueParams> = {
  id: 'evidence.due',
  version: 1,
  title: 'Evidence recorded by a deadline',
  description:
    'Evidence is an observation with a valid value in one of the named fields. When any is recorded the check is supported. Otherwise the deadline is the latest subject-state observation’s deadline field plus the grace: before it the evidence is awaited, and the answer changes at the deadline with no new input; from it on the absent evidence needs attention. Without a valid deadline the check cannot say when the evidence is due. Absence is never read as evidence of anything else.',
  inputs: [
    { name: 'evidence', description: 'Observations that may carry the awaited value.' },
    { name: 'state', description: 'The subject’s own current record, which holds the deadline.' },
  ],
  details: [
    { name: 'dueAt', description: 'The deadline plus the grace, a UTC instant; null without a single valid deadline.' },
    { name: 'graceSeconds', description: 'The grace after the deadline, in seconds.' },
    { name: 'evidenceFound', description: 'Whether a valid value of the named fields is recorded.' },
    {
      name: 'evidenceValues',
      description: 'The distinct valid values found, normalized, sorted and comma separated; null when none.',
    },
  ],
  summaryValues: ['dueAt'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['fields', 'valueType', 'deadlineField', 'graceSeconds'],
    properties: {
      fields: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: fieldPath },
      valueType: { enum: Object.keys(valueTypes) },
      deadlineField: fieldPath,
      graceSeconds: { type: 'integer', minimum: 0, maximum: 31_536_000 },
    },
  },
  evaluate(params, inputs, clock) {
    const label = params.fields.map((field) => fieldLabel(field, inputs.evidence ?? [])).join(' or ');
    const values = reportedValues(inputs.evidence ?? [], params.fields, params.valueType);
    const state = latestObservations(inputs.state ?? []);
    const deadline = fieldLabel(params.deadlineField, state);
    const deadlines = [
      ...new Set(state.flatMap((item) => utcMillis(observationField(item, params.deadlineField)) ?? [])),
    ];
    const dueAt = deadlines.length === 1 ? deadlines[0]! + params.graceSeconds * 1000 : undefined;
    const due = dueAt === undefined ? null : new Date(dueAt).toISOString();
    const details = {
      dueAt: due,
      graceSeconds: params.graceSeconds,
      evidenceFound: values.length > 0,
      evidenceValues: listed(values),
    };
    if (values.length)
      return result(
        'supported',
        'pass',
        'evidence_present',
        `A valid value is recorded for ${label}.`,
        distinctObservations(values),
        details,
      );
    if (dueAt === undefined)
      return result(
        'insufficient',
        'pending',
        'deadline_unavailable',
        `A single valid time for ${deadline} is needed to establish when the evidence is due.`,
        state,
        details,
      );
    return utcMillis(clock.evaluatedAt)! >= dueAt
      ? result(
          'insufficient',
          'attention',
          'evidence_overdue',
          `No valid value is recorded for ${label} by ${due}, ${params.graceSeconds} seconds after ${deadline}.`,
          state,
          details,
        )
      : result(
          'insufficient',
          'pending',
          'evidence_awaited',
          `A valid value for ${label} is awaited until ${due}, ${params.graceSeconds} seconds after ${deadline}.`,
          state,
          details,
          dueAt,
        );
  },
};

export const evidenceCheckKinds: readonly CheckKind[] = [valuesDisagreeV1, evidenceDueV1];
for (const kind of evidenceCheckKinds) registerCheckKind(kind);
