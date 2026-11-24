import { Type, type Static } from '@sinclair/typebox';
import { ControlWindowControlSchema } from './control-windows.js';
import { IndicatorPopulationSchema, IndicatorResultSchema, IndicatorResultWordingSchema } from './indicators.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Closed = { additionalProperties: false } as const;
const Reference = Type.Object({ id: Id, digest: Digest }, Closed);

export const CONTROL_INDICATOR_LIMITS = { maxListed: 50, maxNoteLength: 4000 } as const;

export const ControlIndicatorRecordSchema = Type.Object(
  {
    definition: Type.Object({ id: Id, version: Version, digest: Digest }, Closed),
    expectedRevision: Type.Object({ number: Version, digest: Digest }, Closed),
  },
  {
    ...Closed,
    description:
      'Records one indicator result for a control window. definition and expectedRevision are what the person was shown: the indicator by digest and the window revision whose population and evidence cut the result reads. A changed window or definition conflicts.',
  },
);
export type ControlIndicatorRecord = Static<typeof ControlIndicatorRecordSchema>;

export const ControlIndicatorResultRecordSchema = Type.Object(
  {
    format: Type.Literal('ledger.control-indicator-result.1'),
    id: Id,
    organizationId: Id,
    windowId: Id,
    windowRevision: Version,
    windowRevisionDigest: Digest,
    control: ControlWindowControlSchema,
    request: Type.Object(
      {
        definition: Type.Object({ id: Id, version: Version }, Closed),
        window: Type.Object({ start: Time, end: Time }, Closed),
        recordedThrough: Time,
        population: IndicatorPopulationSchema,
      },
      { ...Closed, description: 'The gathering request the result was calculated from.' },
    ),
    selection: Type.Union([Type.Literal('complete'), Type.Literal('incomplete_selection')]),
    result: IndicatorResultSchema,
    actorId: Id,
    recordedAt: Time,
  },
  {
    ...Closed,
    description:
      'One recorded indicator calculation for a control, with the request that produced it. The result keeps the definition and exposure-kind digests, the cut, the counted ids and the input digest. Evidence for a person to review, never a verdict.',
  },
);
export type ControlIndicatorResultRecord = Static<typeof ControlIndicatorResultRecordSchema>;

export const ControlIndicatorResultResponseSchema = Type.Object(
  {
    record: ControlIndicatorResultRecordSchema,
    digest: Digest,
    currentness: Type.Object(
      {
        status: Type.Union([Type.Literal('current'), Type.Literal('changed')]),
        checkedAt: Time,
        inputDigest: Digest,
      },
      {
        ...Closed,
        description:
          'Gathering the same request again now: current when it reads the same inputs, changed when the evidence at that cut or the window has changed since.',
      },
    ),
    wording: IndicatorResultWordingSchema,
  },
  Closed,
);
export type ControlIndicatorResultResponse = Static<typeof ControlIndicatorResultResponseSchema>;

export const ControlIndicatorResultParamsSchema = Type.Object({ resultId: Id }, Closed);
export type ControlIndicatorResultParams = Static<typeof ControlIndicatorResultParamsSchema>;
export const ControlIndicatorReviewParamsSchema = Type.Object({ reviewId: Id }, Closed);
export type ControlIndicatorReviewParams = Static<typeof ControlIndicatorReviewParamsSchema>;

export const indicatorReviewConclusionValues = ['effective', 'ineffective', 'inconclusive'] as const;

export const ControlIndicatorReviewSchema = Type.Object(
  {
    result: Reference,
    conclusion: Type.Union(indicatorReviewConclusionValues.map((value) => Type.Literal(value))),
    note: Type.String({ minLength: 1, maxLength: CONTROL_INDICATOR_LIMITS.maxNoteLength }),
  },
  {
    ...Closed,
    description:
      'A person’s review of one recorded indicator result, cited by its digest. A supported result allows effective, ineffective or inconclusive; an insufficient or conflicting one only inconclusive; a result whose inputs changed since it was recorded allows none until it is recorded again.',
  },
);
export type ControlIndicatorReview = Static<typeof ControlIndicatorReviewSchema>;

export const ControlIndicatorReviewRecordSchema = Type.Object(
  {
    format: Type.Literal('ledger.control-indicator-review.1'),
    id: Id,
    organizationId: Id,
    control: ControlWindowControlSchema,
    result: Reference,
    resultStatus: IndicatorResultSchema.properties.status,
    conclusion: ControlIndicatorReviewSchema.properties.conclusion,
    note: ControlIndicatorReviewSchema.properties.note,
    actor: Type.Object(
      {
        id: Id,
        name: Type.String(),
        kind: Type.Literal('human'),
        principalRevision: Version,
        capabilities: Type.Array(Type.String()),
        checkedCapabilities: Type.Array(Type.String()),
        policyVersion: Type.Literal('ledger.control-effectiveness-review-authority.2'),
      },
      Closed,
    ),
    recordedAt: Time,
  },
  {
    ...Closed,
    description:
      'A human review of a control’s effectiveness: the same review, by the same authority, now binding a recorded indicator result by digest. People attest; Ledger records.',
  },
);
export type ControlIndicatorReviewRecord = Static<typeof ControlIndicatorReviewRecordSchema>;

export const ControlIndicatorReviewResponseSchema = Type.Object(
  { record: ControlIndicatorReviewRecordSchema, digest: Digest },
  Closed,
);
export type ControlIndicatorReviewResponse = Static<typeof ControlIndicatorReviewResponseSchema>;

export const ControlIndicatorResultListResponseSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        { record: ControlIndicatorResultRecordSchema, digest: Digest, wording: IndicatorResultWordingSchema },
        Closed,
      ),
      {
        maxItems: CONTROL_INDICATOR_LIMITS.maxListed,
      },
    ),
    reviews: Type.Array(ControlIndicatorReviewResponseSchema, { maxItems: CONTROL_INDICATOR_LIMITS.maxListed }),
  },
  { ...Closed, description: 'Recorded results for one window, newest first, and the reviews of them, newest first.' },
);
export type ControlIndicatorResultListResponse = Static<typeof ControlIndicatorResultListResponseSchema>;
