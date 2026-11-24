import { Type, type Static } from '@sinclair/typebox';
import { FidelitySchema } from '../fidelity.js';

export const Closed = { additionalProperties: false } as const;
export const ObservationId = Type.String({ minLength: 1, maxLength: 200 });
export const ObservationText = Type.String({ minLength: 1, maxLength: 1000 });
export const UtcTime = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
  description: 'UTC instant, RFC 3339 with a Z suffix and at most millisecond precision.',
});
export const Percent = Type.Number({ minimum: 0, maximum: 100 });
export const ObservationTypeIdPattern = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
export const ObservationTypeIdSchema = Type.String({
  pattern: ObservationTypeIdPattern,
  maxLength: 100,
  description: 'Lowercase dotted domain.noun identifier, for example battery.state.',
});
/** A document purpose a rule pack declares, such as `part108-nprm.safety-policy`. */
export const DocumentPurposeIdPattern = '^[a-z0-9]+(?:[._-][a-z0-9]+)*$';
export const DocumentPurposeIdSchema = Type.String({ pattern: DocumentPurposeIdPattern, minLength: 1, maxLength: 120 });
/** A controlled document's type, such as `safety_policy`, as the safety records name it. */
export const DocumentTypeIdSchema = Type.String({ pattern: '^[a-z][a-z0-9_]*$', minLength: 1, maxLength: 80 });
/** The document types that serve a purpose by being what they are, without a person ticking it. */
export const DocumentTypesSchema = Type.Array(DocumentTypeIdSchema, {
  minItems: 1,
  maxItems: 20,
  uniqueItems: true,
  description:
    'The controlled-document types that serve this purpose by being what they are; a document of another type serves it when a person ticks it.',
});
export const ObservationVersionSchema = Type.Integer({ minimum: 1, maximum: 1_000_000 });

/** component: a physical part with its own identity, such as a battery pack or a life-limited part. */
export const observationSubjectKindValues = [
  'flight',
  'aircraft',
  'person',
  'site',
  'organization',
  'component',
] as const;
export type ObservationSubjectKind = (typeof observationSubjectKindValues)[number];
export const observationSubjectScopeValues = ['ledger', 'source'] as const;

export function subjectOf<const Kinds extends readonly ObservationSubjectKind[]>(kinds: Kinds) {
  return Type.Object(
    {
      kind: Type.Union(kinds.map((kind: Kinds[number]) => Type.Literal(kind))),
      id: ObservationId,
      scope: Type.Union(
        observationSubjectScopeValues.map((scope) => Type.Literal(scope)),
        {
          description:
            'ledger: id is a Ledger identifier the adapter is bound to. source: id is the source system’s own identifier, to be resolved by intake.',
        },
      ),
    },
    Closed,
  );
}
export const ObservationSubjectSchema = subjectOf(observationSubjectKindValues);
export type ObservationSubject = Static<typeof ObservationSubjectSchema>;

export const altitudeDatumValues = [
  'wgs84_ellipsoid',
  'mean_sea_level',
  'takeoff_point',
  'ground_level',
  'unknown',
] as const;
export const AltitudeSchema = Type.Object(
  {
    meters: Type.Number({ minimum: -10_000, maximum: 100_000 }),
    datum: Type.Union(
      altitudeDatumValues.map((datum) => Type.Literal(datum)),
      {
        description: 'Vertical reference. unknown is an explicit statement that the source does not say.',
      },
    ),
  },
  Closed,
);
export const ObservationPositionSchema = Type.Object(
  {
    latitudeDegrees: Type.Number({ minimum: -90, maximum: 90 }),
    longitudeDegrees: Type.Number({ minimum: -180, maximum: 180 }),
    altitude: Type.Optional(AltitudeSchema),
  },
  { ...Closed, description: 'WGS84 decimal degrees. Altitude, when present, always states its datum.' },
);
export type ObservationPosition = Static<typeof ObservationPositionSchema>;

export const ObservationIntervalSchema = Type.Object(
  { start: UtcTime, end: Type.Optional(UtcTime) },
  {
    ...Closed,
    description:
      'Half-open [start, end). An absent end means the source has not reported one; it does not mean the interval is still open.',
  },
);
export type ObservationInterval = Static<typeof ObservationIntervalSchema>;

/** Fields every observation carries besides type, version, subject, time and values. */
export const observationProvenance = {
  sourceEventId: Type.Optional(ObservationId),
  sourceSessionId: Type.Optional(ObservationId),
  fidelity: FidelitySchema,
  limitations: Type.Array(ObservationText, { maxItems: 20 }),
  originalArtifactId: ObservationId,
  originalLocator: Type.Optional(
    Type.Union(
      [
        Type.Object(
          {
            kind: Type.Literal('json_pointer'),
            value: Type.String({ pattern: '^(?:/(?:[^~/]|~[01])*)*$', maxLength: 1000 }),
          },
          Closed,
        ),
        Type.Object(
          {
            kind: Type.Literal('byte_range'),
            value: Type.Object(
              {
                offsetBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
                lengthBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              },
              Closed,
            ),
          },
          Closed,
        ),
      ],
      {
        description:
          'Where in the retained original this observation came from, when one original yields many observations: an RFC 6901 JSON pointer, or a byte range.',
      },
    ),
  ),
};

export const ObservationHeaderSchema = Type.Object(
  { type: ObservationTypeIdSchema, version: ObservationVersionSchema },
  { description: 'The two fields used to find an observation type before validating the whole observation.' },
);
export type ObservationHeader = Static<typeof ObservationHeaderSchema>;

export function observationHeader<const T extends string, const V extends number>(type: T, version: V) {
  return { type: Type.Literal(type), version: Type.Literal(version) };
}
