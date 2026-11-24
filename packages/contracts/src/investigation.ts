import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { EvaluationRecord, FindingRecord, FindingTreatment, TreatmentRecord } from './findings.js';
import { InputCutSchema } from './input-cut.js';
import { investigationDigest } from './investigation-digest.js';

export const INVESTIGATION_ROUTE = '/v1/flights/{id}/findings/{findingId}/investigation';

export const INVESTIGATION_LIMITS = Object.freeze({
  maxReports: 16,
  maxCitations: 16,
  maxMissingEvidence: 8,
  maxTreatments: 8,
  maxOriginalBytes: 65536,
  maxOriginalTotalBytes: 1048576,
  maxJsonReadBytes: 524288,
  maxTotalReadBytes: 2097152,
  maxContextBytes: 262144,
  maxAdviceBytes: 32768,
  maxReads: 80,
  totalTimeoutMs: 20000,
} as const);

const Closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]+$' });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);
const Action = Type.Union([Type.Literal('acknowledge'), Type.Literal('respond'), Type.Literal('resolve')]);
const Prose = Type.String({
  minLength: 1,
  maxLength: 4000,
  pattern: '^(?=[\\s\\S]*\\S)[\\t\\n\\r\\u0020-\\u007e\\u00a0-\\uffff]+$',
});
const maximumReferences = INVESTIGATION_LIMITS.maxCitations + INVESTIGATION_LIMITS.maxTreatments + 2;
const CitationIds = Type.Array(Id, { maxItems: maximumReferences, uniqueItems: true });

export const InvestigationPinSchema = Type.Object(
  {
    apiUrl: Type.String({ minLength: 1, maxLength: 2048 }),
    tenantId: Id,
    principalId: Id,
    principalRevision: Revision,
    flightId: Id,
    findingId: Id,
    evaluation: Reference,
    basis: Type.Object(
      {
        revision: Revision,
        basisRevision: Revision,
        inputCut: Type.Object(
          {
            ...InputCutSchema.properties,
            principalRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          },
          Closed,
        ),
        dependencyBasis: Digest,
        view: Type.Literal('record'),
      },
      Closed,
    ),
  },
  Closed,
);
export type InvestigationPin = Static<typeof InvestigationPinSchema>;

export const InvestigationRequestSchema = Type.Object(
  { evaluation: Reference, basis: InvestigationPinSchema.properties.basis },
  {
    ...Closed,
    description:
      'Opt-in host request for an ephemeral advisory draft. It creates no accepted record or idempotent finding write. Authentication and the Ledger API origin are fixed by the host, never supplied in this body.',
  },
);
export type InvestigationRequest = Static<typeof InvestigationRequestSchema>;

export interface InvestigationCitation {
  id: string;
  eventId: string;
  receiptId: string;
  sourceId: string;
  sourceSessionId: string;
  sourceEventId: string;
  incidentId: string;
  aircraftId: string;
  status: 'lost' | 'restored';
  occurredAt: string;
  receivedAt: string;
  artifact: { id: string; sha256: string; byteLength: number; contentType: string };
  publicTimelineItemDigest: string;
}
export interface InvestigationMissingEvidence {
  id: string;
  code:
    | 'qualifying_restoration_not_in_selected_evaluation'
    | 'selected_evaluation_insufficient'
    | 'earlier_treatments_not_collected';
  evaluationId: string;
  citationIds: string[];
}
export interface InvestigationContext {
  version: 'ledger.investigation-context.1';
  pin: InvestigationPin;
  digest: string;
  finding: Pick<FindingRecord, 'status' | 'owner' | 'openedAt'>;
  initialEvaluation: { record: EvaluationRecord; digest: string };
  selectedEvaluation: { record: EvaluationRecord; digest: string };
  history: {
    scope: 'initial_and_selected_evaluations';
    treatments: TreatmentRecord[];
    omittedTreatments: boolean;
  };
  citations: InvestigationCitation[];
  comparison: {
    initial: { id: string; digest: string };
    selected: { id: string; digest: string };
    addedCitationIds: string[];
    removedCitationIds: string[];
  };
  missingEvidence: InvestigationMissingEvidence[];
  allowedActions: FindingTreatment['action'][];
}

export const InvestigationExecutionSchema = Type.Object(
  { provider: Id, model: Id },
  {
    ...Closed,
    description:
      'Provider and model observed by the trusted host runner. These values come from its actual execution and are not supplied by model advice.',
  },
);
export type InvestigationExecution = Static<typeof InvestigationExecutionSchema>;
export const InvestigationRunnerResultSchema = Type.Object(
  { advice: Type.Unknown(), execution: InvestigationExecutionSchema },
  Closed,
);
export type InvestigationRunnerResult = Static<typeof InvestigationRunnerResultSchema>;
export type InvestigationRunner = (
  context: InvestigationContext,
  signal: AbortSignal,
) => Promise<InvestigationRunnerResult>;

export const InvestigationAdviceSchema = Type.Object(
  {
    summary: Prose,
    citations: CitationIds,
    comparison: Type.Object({ summary: Prose, citations: CitationIds }, Closed),
    missingEvidence: Type.Array(Type.Object({ id: Id, note: Prose }, Closed), {
      maxItems: INVESTIGATION_LIMITS.maxMissingEvidence,
    }),
    suggestedTreatment: Type.Union([
      Type.Null(),
      Type.Object({ action: Action, note: Prose, rationale: Prose, citations: CitationIds }, Closed),
    ]),
  },
  {
    ...Closed,
    description:
      'Untrusted advisory text and references to collected evidence. Text is not an established fact or an accepted treatment. Authority, API, basis and request identity are assigned outside model output.',
  },
);
export type InvestigationAdvice = Static<typeof InvestigationAdviceSchema>;

export const InvestigationProposalSchema = Type.Object(
  {
    version: Type.Literal('ledger.investigation-proposal.1'),
    context: InvestigationPinSchema,
    contextDigest: Digest,
    advice: InvestigationAdviceSchema,
  },
  Closed,
);
export type InvestigationProposal = Static<typeof InvestigationProposalSchema>;

export const InvestigationResponseSchema = Type.Object(
  { proposal: InvestigationProposalSchema, execution: InvestigationExecutionSchema },
  Closed,
);
export type InvestigationResponse = Static<typeof InvestigationResponseSchema>;

function boundedJson(value: unknown, maximum: number): void {
  let bytes: number;
  try {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError();
    bytes = new TextEncoder().encode(text).byteLength;
  } catch {
    throw new TypeError('Investigation data must be bounded JSON.');
  }
  if (bytes > maximum) throw new TypeError('Investigation data exceeds its JSON byte limit.');
}

function uniqueIds(values: string[], maximum: number): Set<string> {
  if (
    values.length > maximum ||
    values.some((value) => !Value.Check(Id, value) || !value.trim()) ||
    new Set(values).size !== values.length
  )
    throw new TypeError('Investigation references must be bounded, unique existing IDs.');
  return new Set(values);
}

function references(context: InvestigationContext) {
  boundedJson(context, INVESTIGATION_LIMITS.maxContextBytes);
  if (
    context.version !== 'ledger.investigation-context.1' ||
    !Value.Check(InvestigationPinSchema, context.pin) ||
    !Value.Check(Digest, context.digest) ||
    !Value.Check(Digest, context.initialEvaluation.digest) ||
    !Value.Check(Digest, context.selectedEvaluation.digest) ||
    context.pin.basis.inputCut.principalRevision !== context.pin.principalRevision ||
    context.pin.evaluation.id !== context.selectedEvaluation.record.id ||
    context.pin.evaluation.digest !== context.selectedEvaluation.digest ||
    context.initialEvaluation.record.flightId !== context.pin.flightId ||
    context.selectedEvaluation.record.flightId !== context.pin.flightId ||
    context.comparison.initial.id !== context.initialEvaluation.record.id ||
    context.comparison.initial.digest !== context.initialEvaluation.digest ||
    context.comparison.selected.id !== context.selectedEvaluation.record.id ||
    context.comparison.selected.digest !== context.selectedEvaluation.digest
  )
    throw new TypeError('Investigation context does not match its exact evaluation and flight pins.');
  const reports = uniqueIds(
    context.citations.map((citation) => citation.id),
    INVESTIGATION_LIMITS.maxCitations,
  );
  if (context.citations.some((citation) => citation.id !== citation.receiptId))
    throw new TypeError('Investigation report citations must use their exact receipt IDs.');
  const treatments = uniqueIds(
    context.history.treatments.map((treatment) => treatment.id),
    INVESTIGATION_LIMITS.maxTreatments,
  );
  if (context.history.scope !== 'initial_and_selected_evaluations')
    throw new TypeError('Investigation history must name its bounded comparison scope.');
  const evaluations = new Set([context.initialEvaluation.record.id, context.selectedEvaluation.record.id]);
  const citations = new Set([...evaluations, ...reports, ...treatments]);
  if (citations.size !== reports.size + evaluations.size + treatments.size)
    throw new TypeError('Investigation evaluation and report citation IDs must be distinct.');
  for (const ids of [context.comparison.addedCitationIds, context.comparison.removedCitationIds]) {
    uniqueIds(ids, INVESTIGATION_LIMITS.maxCitations);
    if (ids.some((id) => !reports.has(id))) throw new TypeError('Investigation comparison contains an unknown report.');
  }
  const missing = uniqueIds(
    context.missingEvidence.map((fact) => fact.id),
    INVESTIGATION_LIMITS.maxMissingEvidence,
  );
  for (const fact of context.missingEvidence) {
    if (
      ![
        'qualifying_restoration_not_in_selected_evaluation',
        'selected_evaluation_insufficient',
        'earlier_treatments_not_collected',
      ].includes(fact.code) ||
      ![context.initialEvaluation.record.id, context.selectedEvaluation.record.id].includes(fact.evaluationId)
    )
      throw new TypeError('Investigation missing evidence must refer to a collected evaluation.');
    uniqueIds(fact.citationIds, maximumReferences);
    if (fact.citationIds.some((id) => !citations.has(id)))
      throw new TypeError('Investigation missing evidence contains an unknown citation.');
  }
  uniqueIds(context.allowedActions, 3);
  if (context.allowedActions.some((action) => !Value.Check(Action, action)))
    throw new TypeError('Investigation context contains an unknown treatment action.');
  return { citations, missing };
}

export async function validateInvestigationContext(context: InvestigationContext): Promise<void> {
  references(context);
  const { digest, ...content } = context;
  const [initialDigest, selectedDigest, contextDigest] = await Promise.all([
    investigationDigest(context.initialEvaluation.record),
    investigationDigest(context.selectedEvaluation.record),
    investigationDigest(content),
  ]);
  if (initialDigest !== context.initialEvaluation.digest || selectedDigest !== context.selectedEvaluation.digest)
    throw new TypeError('Investigation evaluation digest does not match its complete retained record.');
  if (contextDigest !== digest)
    throw new TypeError('Investigation context digest does not match its collected contents.');
}

/** The host must await validateInvestigationContext before parsing advice for this context. */
export function parseInvestigationAdvice(context: InvestigationContext, value: unknown): InvestigationAdvice {
  const known = references(context);
  if (!Value.Check(InvestigationAdviceSchema, value))
    throw new TypeError('Investigation advice must match the closed advisory schema.');
  boundedJson(value, INVESTIGATION_LIMITS.maxAdviceBytes);
  for (const ids of [value.citations, value.comparison.citations, value.suggestedTreatment?.citations ?? []])
    if (ids.some((id) => !known.citations.has(id)))
      throw new TypeError('Investigation advice cites evidence outside its collected context.');
  uniqueIds(
    value.missingEvidence.map((fact) => fact.id),
    INVESTIGATION_LIMITS.maxMissingEvidence,
  );
  if (value.missingEvidence.some((fact) => !known.missing.has(fact.id)))
    throw new TypeError('Investigation advice names an unknown missing-evidence fact.');
  if (value.suggestedTreatment && !context.allowedActions.includes(value.suggestedTreatment.action))
    throw new TypeError('The proposed treatment is not allowed by this investigation context.');
  return structuredClone(value);
}

/** Binds advice to a host context already verified by validateInvestigationContext. */
export function bindInvestigationProposal(context: InvestigationContext, value: unknown): InvestigationProposal {
  return {
    version: 'ledger.investigation-proposal.1',
    context: structuredClone(context.pin),
    contextDigest: context.digest,
    advice: parseInvestigationAdvice(context, value),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

/** Checks a proposal against a host context already verified by validateInvestigationContext. */
export function validateInvestigationProposal(
  context: InvestigationContext,
  value: unknown,
): value is InvestigationProposal {
  try {
    if (!Value.Check(InvestigationProposalSchema, value)) return false;
    boundedJson(value, INVESTIGATION_LIMITS.maxContextBytes + INVESTIGATION_LIMITS.maxAdviceBytes);
    if (value.contextDigest !== context.digest || !sameJson(value.context, context.pin)) return false;
    parseInvestigationAdvice(context, value.advice);
    return true;
  } catch {
    return false;
  }
}
