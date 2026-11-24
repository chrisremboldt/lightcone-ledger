import { Type, type Static } from '@sinclair/typebox';
import type { ResponseMeta } from './index.js';
import { AdoptionEffectiveIntervalSchema } from './adoptions.js';
import { InputCutSchema } from './input-cut.js';
import { SubjectBasisManifestSchema } from './subject-decisions.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const UtcTime = Type.String({ format: 'date-time', pattern: 'Z$' });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const ContentReference = Type.Object(
  { id: Id, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), digest: Digest },
  { additionalProperties: false },
);

export const FlightRuleSelectionParamsSchema = Type.Object({ id: Id }, { additionalProperties: false });
export type FlightRuleSelectionParams = Static<typeof FlightRuleSelectionParamsSchema>;
export const FlightRuleSelectionRecordParamsSchema = Type.Object(
  { id: Id, selectionId: Id },
  { additionalProperties: false },
);
export type FlightRuleSelectionRecordParams = Static<typeof FlightRuleSelectionRecordParamsSchema>;

export const FlightRuleSelectionAdoptionSchema = Type.Object(
  {
    id: Id,
    acceptedRevision: Revision,
    pack: ContentReference,
    leaf: ContentReference,
    binding: ContentReference,
    effectiveInterval: AdoptionEffectiveIntervalSchema,
  },
  { additionalProperties: false },
);
export type FlightRuleSelectionAdoption = Static<typeof FlightRuleSelectionAdoptionSchema>;

export const EvaluatorReferenceSchema = Type.Object(
  { id: Type.Literal('ledger.command-link-evidence'), version: Type.Literal(1), digest: Digest },
  { additionalProperties: false },
);
export type EvaluatorReference = Static<typeof EvaluatorReferenceSchema>;

export const FlightRuleSelectionRecordV1Schema = Type.Object(
  {
    version: Type.Literal('flight.rule-selection.1'),
    id: Id,
    flightId: Id,
    organizationId: Id,
    clock: Type.Object({ mode: Type.Literal('wall'), evaluatedAt: UtcTime }, { additionalProperties: false }),
    adoptionRevision: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: 'Maximum accepted revision across this organization’s immutable pack adoptions, or zero.',
    }),
    projectedAdoptionRevision: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      description: 'Maximum accepted revision across this organization’s projected pack adoptions, or zero.',
    }),
    selection: Type.Object(
      {
        state: Type.Union([
          Type.Literal('not_adopted'),
          Type.Literal('pending'),
          Type.Literal('scheduled'),
          Type.Literal('eligible'),
          Type.Literal('expired'),
        ]),
        adoption: Type.Union([FlightRuleSelectionAdoptionSchema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    execution: Type.Object(
      { status: Type.Literal('inactive'), baseline: Type.Literal('builtin_draft') },
      { additionalProperties: false },
    ),
    nextBoundary: Type.Union([
      Type.Object(
        { at: UtcTime, adoptionId: Id, kind: Type.Union([Type.Literal('start'), Type.Literal('end')]) },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    renderedInputCut: InputCutSchema,
    acceptedInputCut: InputCutSchema,
    dependencyBasis: Digest,
    basisManifest: SubjectBasisManifestSchema,
    selectionDigest: Digest,
  },
  {
    additionalProperties: false,
    description:
      'Retained selection of the exact company procedure-pack version 3 C2 leaf and binding. Selection does not activate execution; existing built-in draft checks remain unchanged.',
  },
);
export type FlightRuleSelectionRecordV1 = Static<typeof FlightRuleSelectionRecordV1Schema>;
export const FlightRuleSelectionRecordV2Schema = Type.Object(
  {
    ...FlightRuleSelectionRecordV1Schema.properties,
    version: Type.Literal('flight.rule-selection.2'),
    execution: Type.Object(
      {
        status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
        baseline: Type.Literal('builtin_draft'),
        policyVersion: Type.Literal('ledger.company-c2-execution.1'),
        evaluator: EvaluatorReferenceSchema,
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    description:
      'Prospective C2 execution selection under the versioned company policy. Exact eligible adoption enables adopted execution; other selection states retain the built-in draft baseline.',
  },
);
export type FlightRuleSelectionRecordV2 = Static<typeof FlightRuleSelectionRecordV2Schema>;

export const FlightRuleSelectionAdoptionV3Schema = Type.Object(
  {
    id: Id,
    acceptedRevision: Revision,
    pack: ContentReference,
    rules: Type.Array(ContentReference, {
      maxItems: 500,
      description: 'The checked rules of the adopted pack version that are about flights.',
    }),
    effectiveInterval: AdoptionEffectiveIntervalSchema,
  },
  { additionalProperties: false },
);
export type FlightRuleSelectionAdoptionV3 = Static<typeof FlightRuleSelectionAdoptionV3Schema>;

export const RuleEvaluatorReferenceSchema = Type.Object(
  { id: Type.Literal('ledger.rule-evaluator'), version: Type.Literal(1), digest: Digest },
  { additionalProperties: false },
);
export type RuleEvaluatorReference = Static<typeof RuleEvaluatorReferenceSchema>;

export const FlightRuleSelectionRecordV3Schema = Type.Object(
  {
    ...FlightRuleSelectionRecordV1Schema.properties,
    version: Type.Literal('flight.rule-selection.3'),
    selection: Type.Object(
      {
        state: FlightRuleSelectionRecordV1Schema.properties.selection.properties.state,
        adoption: Type.Union([FlightRuleSelectionAdoptionV3Schema, Type.Null()]),
      },
      { additionalProperties: false },
    ),
    execution: Type.Object(
      {
        status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
        evaluator: RuleEvaluatorReferenceSchema,
      },
      { additionalProperties: false },
    ),
  },
  {
    additionalProperties: false,
    description:
      'Selection of the adopted pack version whose checked rules about flights the generic evaluator runs for this flight. An eligible adoption is active; other states run nothing.',
  },
);
export type FlightRuleSelectionRecordV3 = Static<typeof FlightRuleSelectionRecordV3Schema>;
export const FlightRuleSelectionRecordSchema = Type.Union([
  FlightRuleSelectionRecordV1Schema,
  FlightRuleSelectionRecordV2Schema,
  FlightRuleSelectionRecordV3Schema,
]);
export type FlightRuleSelectionRecord =
  FlightRuleSelectionRecordV1 | FlightRuleSelectionRecordV2 | FlightRuleSelectionRecordV3;
export const FlightRuleSelectionRecordResponseSchema = Type.Object(
  { selection: FlightRuleSelectionRecordSchema },
  { additionalProperties: false },
);
export type FlightRuleSelectionRecordResponse = Static<typeof FlightRuleSelectionRecordResponseSchema>;

export const FlightRuleSelectionConvergenceSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('pending'), Type.Literal('current')]),
    reason: Type.Union([
      Type.Literal('bootstrap'),
      Type.Literal('organization_changed'),
      Type.Literal('boundary_due'),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export type FlightRuleSelectionConvergence = Static<typeof FlightRuleSelectionConvergenceSchema>;

export interface FlightRuleSelectionResponse {
  selection: FlightRuleSelectionRecord | null;
  asOf: string;
  convergence: FlightRuleSelectionConvergence;
  meta: ResponseMeta;
}
