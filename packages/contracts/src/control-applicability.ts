import { Type, type Static } from '@sinclair/typebox';
import { MissionAvoidanceMissionReferenceSchema } from './mission-reference.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const VersionNumber = Type.Integer({ minimum: 1, maximum: 100000 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Name = Type.String({ pattern: '^[a-z][A-Za-z0-9]{0,63}$' });
const Reason = Type.String({ pattern: '^[a-z][a-z0-9_]{0,99}$' });
const Summary = Type.String({ minLength: 1, maxLength: 500, pattern: '\\S' });
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/** One named quantity an applicability rule measured, or one its control's parameters declare. */
export const ControlApplicabilityMeasureSchema = strict({
  name: Name,
  value: Type.Union([Type.Number(), Type.String({ maxLength: 200 })]),
  unit: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
});
export type ControlApplicabilityMeasure = Static<typeof ControlApplicabilityMeasureSchema>;
const Measures = Type.Array(ControlApplicabilityMeasureSchema, { maxItems: 16 });
const Reasons = Type.Array(Reason, { maxItems: 32, uniqueItems: true });

/**
 * What an applicability rule returns: whether the control applies, with what it measured and one sentence of that
 * measurement, or that it could not settle it. An undetermined result applies.
 */
export const ControlApplicabilityOutcomeSchema = Type.Union([
  strict({ applies: Type.Boolean(), measured: Measures, declared: Measures, summary: Summary }),
  strict({
    applies: Type.Literal('undetermined'),
    reasons: Type.Array(Reason, { minItems: 1, maxItems: 32, uniqueItems: true }),
    summary: Type.Optional(Summary),
  }),
]);
export type ControlApplicabilityOutcome = Static<typeof ControlApplicabilityOutcomeSchema>;

export const controlApplicabilityBasisValues = [
  'rule',
  'no_rule',
  'inputs_incomplete',
  'undetermined',
  'error',
  'under_review',
] as const;
export type ControlApplicabilityBasis = (typeof controlApplicabilityBasisValues)[number];

const Pinned = strict({ id: Id, version: VersionNumber, digest: Digest });

/**
 * What one evaluation recorded for one control and one mission revision: whether the control applies, on what basis,
 * the rule that decided it and the inputs by digest. A control applies unless its rule ran on complete inputs and
 * found it does not. Its digest is the canonical digest of the record.
 */
export const ControlApplicabilityRecordSchema = strict({
  version: Type.Literal('control.applicability.1'),
  outcome: Type.Union([Type.Literal('applies'), Type.Literal('does_not_apply')]),
  basis: Type.Union(controlApplicabilityBasisValues.map((value) => Type.Literal(value))),
  rule: Type.Union([Pinned, Type.Null()]),
  inputs: strict({
    mission: Type.Union([MissionAvoidanceMissionReferenceSchema, Type.Null()]),
    control: strict({ controlId: Id, versionNumber: VersionNumber, controlEventId: Id, bodyDigest: Digest }),
    controlType: Pinned,
  }),
  measured: Measures,
  declared: Measures,
  summary: Summary,
  reasons: Reasons,
});
export type ControlApplicabilityRecord = Static<typeof ControlApplicabilityRecordSchema>;
