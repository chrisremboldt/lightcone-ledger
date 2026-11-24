import { Type, type Static } from '@sinclair/typebox';
import type { InputCut, ResponseMeta } from './index.js';
import { InputCutSchema } from './input-cut.js';
import {
  CheckDetailsSchema,
  ReadAsPlansSchema,
  findingClosingReasons,
  findingTreatmentActions,
  type CheckDetails,
  type FindingAction,
  type FindingClosingReason,
  type FindingClosure,
  type EvaluationInputSubjects,
  type EvaluationSummaryWording,
  type ReadAsPlans,
} from './rule-evaluations.js';
import { EvaluatorReferenceSchema, FlightRuleSelectionAdoptionSchema } from './rule-selection.js';

const S = Type.String();
const N = Type.Integer({ minimum: 0 });
const Time = Type.String({ format: 'date-time' });
const stringEnum = (...values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const Id = Type.String({ minLength: 1, maxLength: 200 });
export const C2EvaluationExecutionSchema = Type.Object(
  {
    version: Type.Literal('flight.c2-execution.1'),
    mode: Type.Union([Type.Literal('adopted'), Type.Literal('builtin_draft')]),
    policyVersion: Type.Literal('ledger.company-c2-execution.1'),
    evaluator: EvaluatorReferenceSchema,
    selection: Type.Object(
      {
        id: Id,
        version: Type.Literal('flight.rule-selection.2'),
        digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      },
      { additionalProperties: false },
    ),
    adoption: Type.Union([FlightRuleSelectionAdoptionSchema, Type.Null()]),
    trigger: Type.Object(
      {
        kind: Type.Union([
          Type.Literal('source_report'),
          Type.Literal('selection_change'),
          Type.Literal('retained_bootstrap'),
        ]),
        eventId: Id,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type C2EvaluationExecution = Static<typeof C2EvaluationExecutionSchema>;

const EvaluationEvidenceSchema = Type.Object({ eventId: S, receiptId: S, sourceId: S, occurredAt: Time });
export const EvaluationRecordSchema = Type.Object(
  {
    profile: Type.Optional(Type.Literal('ledger.c2-evaluation.2')),
    execution: Type.Optional(C2EvaluationExecutionSchema),
    id: S,
    flightId: S,
    leafId: S,
    leafVersion: N,
    bindingId: S,
    bindingVersion: N,
    applicability: stringEnum('applicable', 'not_applicable'),
    evidenceState: stringEnum('supported', 'insufficient', 'conflicting', 'not_applicable'),
    outcome: stringEnum('pass', 'attention', 'pending', 'not_applicable', 'relieved'),
    title: S,
    rule: Type.Optional(
      Type.Object({ reference: S, text: S, review: Type.Literal('ai_drafted'), adopted: Type.Literal(false) }),
    ),
    explanation: Type.Union([
      Type.Object({
        code: S,
        summary: S,
        evidence: Type.Array(EvaluationEvidenceSchema),
        landingTimes: Type.Array(
          Type.Object({
            ...EvaluationEvidenceSchema.properties,
            field: stringEnum('landingTime', 'landedAt'),
            value: S,
            valid: Type.Boolean(),
            normalizedTime: Type.Optional(Time),
          }),
        ),
        evaluatedAt: Time,
        scheduledEnd: Type.Optional(Time),
        dueAt: Type.Optional(Time),
      }),
      Type.Object(
        {
          kind: Type.Literal('command_link'),
          code: S,
          summary: S,
          evidence: Type.Array(
            Type.Object(
              {
                ...EvaluationEvidenceSchema.properties,
                flightId: S,
                sourceSessionId: S,
                sourceEventId: S,
                incidentId: S,
                aircraftId: S,
                status: S,
              },
              { additionalProperties: false },
            ),
          ),
          groups: Type.Array(
            Type.Object(
              {
                sourceId: S,
                sourceSessionId: S,
                incidentId: S,
                aircraftId: S,
                state: stringEnum('unresolved', 'restored', 'conflicting', 'insufficient'),
                lossEventIds: Type.Array(S),
                restorationEventIds: Type.Array(S),
              },
              { additionalProperties: false },
            ),
          ),
          evaluatedAt: Time,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('rule'),
          code: S,
          summary: S,
          evidence: Type.Array(
            Type.Object(
              { ...EvaluationEvidenceSchema.properties, observationId: S, type: S, version: N },
              { additionalProperties: false },
            ),
          ),
          details: CheckDetailsSchema,
          parameters: Type.Record(Type.String(), Type.Unknown()),
          inputs: Type.Array(
            Type.Object({ name: S, type: S, observationIds: Type.Array(S) }, { additionalProperties: false }),
          ),
          ruleEvaluation: Type.Object(
            {
              pack: Type.Object({ id: S, version: N, digest: S }, { additionalProperties: false }),
              ruleDigest: S,
              check: Type.Object({ kind: S, version: N }, { additionalProperties: false }),
              mode: stringEnum('shadow', 'active'),
              subjectKey: S,
            },
            { additionalProperties: false },
          ),
          evaluatedAt: Time,
          nextBoundary: Type.Optional(Time),
          readAsPlans: Type.Optional(ReadAsPlansSchema),
        },
        {
          additionalProperties: false,
          description:
            'An evaluation of an adopted rule by the generic evaluator, shown on the subject it is about. bindingId and bindingVersion name the rule pack; code is the check’s reason code; evidence lists the observations the result cites.',
        },
      ),
    ]),
    clock: Type.Object({ mode: Type.Literal('wall'), evaluatedAt: Time }),
    inputCut: InputCutSchema,
    acceptedInputCut: InputCutSchema,
    dependencyBasis: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    recordedAt: Time,
    dueAt: Type.Optional(Time),
  },
  {
    allOf: [
      {
        if: { anyOf: [{ required: ['profile'] }, { required: ['execution'] }] },
        then: { required: ['profile', 'execution'] },
      },
    ],
  },
);
/**
 * What a person records on a finding. acknowledge takes it; assign gives it to the person named by assigneeId; plan
 * records an action and its due date (dueOn, a calendar date in the organization's time zone); respond records what
 * was done; close ends it with a reason. resolve ends a finding whose check cleared, as recorded before closing with a
 * reason existed.
 */
export const FindingTreatmentSchema = Type.Object(
  {
    findingId: Type.String({ minLength: 1, maxLength: 200 }),
    evaluationId: Type.String({ minLength: 1, maxLength: 200 }),
    action: Type.Union(findingTreatmentActions.map((value) => Type.Literal(value))),
    assigneeId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'The person a finding is assigned to; assign only.' }),
    ),
    dueOn: Type.Optional(
      Type.String({
        pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
        description: 'The day the action is due, in the organization’s time zone; plan only.',
      }),
    ),
    reason: Type.Optional(
      Type.Union(
        findingClosingReasons.map((value) => Type.Literal(value)),
        {
          description:
            'Why a person closes the finding: a new record corrects it, it is accepted with the reason stated in the note, the condition it reported has ended (what it reported still happened), or it was recorded in error; close only.',
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export type FindingTreatment = Static<typeof FindingTreatmentSchema>;

/** A finding command for a finding about any subject; the finding's latest evaluation is the basis it pins. */
export const FindingTreatmentCommandSchema = Type.Object(
  {
    kind: Type.Literal('finding.treat'),
    treatment: FindingTreatmentSchema,
    note: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);
export type FindingTreatmentCommand = Static<typeof FindingTreatmentCommandSchema>;

/** What one decision may record on every finding of a set: take, assign, an action, or close. */
export const findingSetActions = ['acknowledge', 'assign', 'plan', 'close'] as const;

/**
 * One decision of one person about every counted open finding of one rule, optionally narrowed by subject kind and by
 * the days the findings are about. It names every finding it was shown, each with the evaluation it was shown with;
 * if the set is not exactly that at acceptance, it is refused. Documented in docs/design/finding-work.md.
 */
export const FindingSetTreatmentCommandSchema = Type.Object(
  {
    kind: Type.Literal('finding.treat-many'),
    selection: Type.Object(
      {
        packId: Id,
        ruleId: Id,
        subjectKind: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        aboutFrom: Type.Optional(
          Type.String({
            pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
            description: 'The first day the findings are about, in the organization’s time zone.',
          }),
        ),
        aboutUntil: Type.Optional(
          Type.String({
            pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
            description: 'The last day the findings are about, in the organization’s time zone, included.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    action: Type.Union(findingSetActions.map((value) => Type.Literal(value))),
    assigneeId: FindingTreatmentSchema.properties.assigneeId,
    dueOn: FindingTreatmentSchema.properties.dueOn,
    reason: FindingTreatmentSchema.properties.reason,
    findings: Type.Array(
      Type.Object(
        { findingId: Id, evaluationId: Id },
        { additionalProperties: false, description: 'A finding as it was shown: its id and its latest evaluation.' },
      ),
      { minItems: 1, maxItems: 500 },
    ),
    shownCount: Type.Integer({
      minimum: 1,
      maximum: 500,
      description: 'How many findings the person was shown; the number named.',
    }),
    note: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);
export type FindingSetTreatmentCommand = Static<typeof FindingSetTreatmentCommandSchema>;

export interface EvaluationEvidence {
  eventId: string;
  receiptId: string;
  sourceId: string;
  occurredAt: string;
}
export interface LandingEvaluationExplanation {
  code: string;
  summary: string;
  evidence: EvaluationEvidence[];
  landingTimes: (EvaluationEvidence & {
    field: 'landingTime' | 'landedAt';
    value: string;
    valid: boolean;
    normalizedTime?: string;
  })[];
  evaluatedAt: string;
  scheduledEnd?: string;
  dueAt?: string;
}
export interface CommandLinkEvaluationEvidence extends EvaluationEvidence {
  flightId: string;
  sourceSessionId: string;
  sourceEventId: string;
  incidentId: string;
  aircraftId: string;
  status: string;
}
export interface CommandLinkEvaluationExplanation {
  kind: 'command_link';
  code: string;
  summary: string;
  evidence: CommandLinkEvaluationEvidence[];
  groups: {
    sourceId: string;
    sourceSessionId: string;
    incidentId: string;
    aircraftId: string;
    state: 'unresolved' | 'restored' | 'conflicting' | 'insufficient';
    lossEventIds: string[];
    restorationEventIds: string[];
  }[];
  evaluatedAt: string;
}
export interface RuleEvaluationEvidence extends EvaluationEvidence {
  observationId: string;
  type: string;
  version: number;
}
/** An evaluation of an adopted rule by the generic evaluator, as the subject it is about shows it. */
export interface RuleEvaluationExplanation {
  kind: 'rule';
  code: string;
  summary: string;
  evidence: RuleEvaluationEvidence[];
  details: CheckDetails;
  parameters: Record<string, unknown>;
  inputs: { name: string; type: string; observationIds: string[] }[];
  ruleEvaluation: {
    pack: { id: string; version: number; digest: string };
    ruleDigest: string;
    check: { kind: string; version: number };
    mode: 'shadow' | 'active';
    subjectKey: string;
  };
  evaluatedAt: string;
  nextBoundary?: string;
  readAsPlans?: ReadAsPlans;
}
export interface EvaluationRecord {
  profile?: 'ledger.c2-evaluation.2';
  execution?: C2EvaluationExecution;
  id: string;
  flightId: string;
  leafId: string;
  leafVersion: number;
  bindingId: string;
  bindingVersion: number;
  applicability: 'applicable' | 'not_applicable';
  evidenceState: 'supported' | 'insufficient' | 'conflicting' | 'not_applicable';
  outcome: 'pass' | 'attention' | 'pending' | 'not_applicable' | 'relieved';
  title: string;
  rule?: { reference: string; text: string; review: 'ai_drafted'; adopted: false };
  explanation: LandingEvaluationExplanation | CommandLinkEvaluationExplanation | RuleEvaluationExplanation;
  clock: { mode: 'wall'; evaluatedAt: string };
  inputCut: InputCut;
  acceptedInputCut: InputCut;
  dependencyBasis: string;
  recordedAt: string;
  dueAt?: string;
}
export interface TreatmentRecord {
  id: string;
  evaluationId: string;
  action: FindingTreatment['action'];
  actorId: string;
  actorName: string;
  note: string;
  recordedAt: string;
  assignee?: { id: string; name: string };
  dueOn?: string;
  reason?: FindingClosingReason;
  /** Present when the treatment came from one decision about many findings of one rule. */
  decision?: { id: string; findingCount: number };
}
export interface FindingRecord {
  id: string;
  flightId: string;
  status: 'open' | 'acknowledged' | 'responding' | 'resolved';
  owner: { id: string; name: string } | null;
  openedAt: string;
  initialEvaluation: EvaluationRecord;
  latestEvaluation: EvaluationRecord;
  treatments: TreatmentRecord[];
  hasOlderTreatments: boolean;
  action?: FindingAction;
  closure?: FindingClosure;
}
export interface FindingsResponse {
  findings: FindingRecord[];
  /** The subject each input of the generic evaluations shown was about, by evaluation id; beside, never inside. */
  inputSubjects?: EvaluationInputSubjects;
  /** The rule wording the shown generic evaluations' summaries came from, by evaluation id; beside, never inside. */
  summaryWording?: EvaluationSummaryWording;
  meta: ResponseMeta;
}
