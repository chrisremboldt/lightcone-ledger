import { Type, type Static } from '@sinclair/typebox';
import {
  IndicatorPopulationSchema,
  IndicatorResultSchema,
  IndicatorResultWordingSchema,
  INDICATOR_LIMITS,
} from './indicators.js';
import {
  ObservationTypeIdSchema,
  ObservationVersionSchema,
  observationSubjectKindValues,
} from './observations/envelope.js';
import { SubjectReferenceSchema } from './rule-evaluations.js';

/** Hard bounds on one control window. */
export const CONTROL_WINDOW_LIMITS = {
  maxSubjects: INDICATOR_LIMITS.maxSubjects,
  maxObservationTypes: 20,
  maxIndicators: 20,
  maxListed: 100,
  maxNoteLength: 2000,
} as const;

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({
  format: 'date-time',
  pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:[0-5]\\d(?:\\.\\d{1,3})?Z$',
});
const Closed = { additionalProperties: false } as const;
const SubjectKind = Type.Union(observationSubjectKindValues.map((value) => Type.Literal(value)));
const Note = Type.String({ minLength: 1, maxLength: CONTROL_WINDOW_LIMITS.maxNoteLength });

export const ControlWindowControlSchema = Type.Object(
  {
    kind: Type.Literal('control_record'),
    hazardId: Id,
    recordId: Id,
    versionNumber: Version,
    bodyDigest: Digest,
    acceptanceId: Id,
  },
  {
    ...Closed,
    description: 'The accepted control the window monitors: a control record version that a risk acceptance binds.',
  },
);
export type ControlWindowControl = Static<typeof ControlWindowControlSchema>;

export const ControlWindowPeriodSchema = Type.Object(
  { start: Time, end: Time },
  { ...Closed, description: 'Half-open [start, end) in UTC.' },
);

export const ControlWindowObservationSchema = Type.Object(
  {
    type: ObservationTypeIdSchema,
    versions: Type.Array(ObservationVersionSchema, { minItems: 1, maxItems: 20, uniqueItems: true }),
  },
  Closed,
);
export type ControlWindowObservation = Static<typeof ControlWindowObservationSchema>;

export const ControlWindowIndicatorSchema = Type.Object({ id: Id, version: Version, digest: Digest }, Closed);

const Subjects = Type.Array(SubjectReferenceSchema, { maxItems: CONTROL_WINDOW_LIMITS.maxSubjects });

export const ControlWindowOpenSchema = Type.Object(
  {
    control: ControlWindowControlSchema,
    period: ControlWindowPeriodSchema,
    subjectKind: SubjectKind,
    subjects: Subjects,
    complete: Type.Boolean({
      description: 'Whether the person opening the window declares the subject list complete.',
    }),
    expectedObservations: Type.Array(ControlWindowObservationSchema, {
      minItems: 1,
      maxItems: CONTROL_WINDOW_LIMITS.maxObservationTypes,
    }),
    indicators: Type.Array(ControlWindowIndicatorSchema, {
      minItems: 1,
      maxItems: CONTROL_WINDOW_LIMITS.maxIndicators,
    }),
    note: Note,
  },
  {
    ...Closed,
    description:
      'Opens a window over which an accepted control is monitored. The control, period, subject kind, expected observation types and indicator definitions are fixed for the life of the window.',
  },
);
export type ControlWindowOpen = Static<typeof ControlWindowOpenSchema>;

export const ControlWindowReviseSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    subjects: Subjects,
    complete: Type.Boolean(),
    note: Note,
  },
  {
    ...Closed,
    description:
      'Declares the population again: the listed subjects and whether they are complete. Each revision is kept; the latest one is current.',
  },
);
export type ControlWindowRevise = Static<typeof ControlWindowReviseSchema>;

export const ControlWindowParamsSchema = Type.Object({ windowId: Id }, Closed);
export type ControlWindowParams = Static<typeof ControlWindowParamsSchema>;

export const ControlWindowIndicatorParamsSchema = Type.Object(
  { windowId: Id, indicatorId: Id, version: Type.String({ pattern: '^[1-9][0-9]{0,8}$' }) },
  Closed,
);
export type ControlWindowIndicatorParams = Static<typeof ControlWindowIndicatorParamsSchema>;

export const ControlWindowQuerySchema = Type.Object(
  {
    controlKind: Type.Literal('control_record'),
    hazardId: Id,
    controlId: Id,
    controlVersion: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,8}$' })),
  },
  Closed,
);
export type ControlWindowQuery = Static<typeof ControlWindowQuerySchema>;

export const ControlWindowSchema = Type.Object(
  {
    id: Id,
    variant: Type.Union([Type.Literal('generic'), Type.Literal('retained')], {
      description:
        'generic is a window declared through this interface. retained is an older source-reported window, shown in the same shape; its full record stays readable where it was recorded.',
    }),
    organizationId: Id,
    control: ControlWindowControlSchema,
    period: ControlWindowPeriodSchema,
    population: Type.Object(
      {
        subjectKind: SubjectKind,
        subjects: Subjects,
        complete: Type.Boolean(),
        declaredBy: IndicatorPopulationSchema.properties.declaredBy,
      },
      Closed,
    ),
    expectedObservations: Type.Array(ControlWindowObservationSchema, {
      maxItems: CONTROL_WINDOW_LIMITS.maxObservationTypes,
    }),
    indicators: Type.Array(ControlWindowIndicatorSchema, { maxItems: CONTROL_WINDOW_LIMITS.maxIndicators }),
    openedAt: Time,
    revision: Type.Object(
      {
        number: Type.Integer({ minimum: 1 }),
        id: Id,
        recordedAt: Time,
        digest: Digest,
        note: Type.Union([Note, Type.Null()]),
      },
      { ...Closed, description: 'The current revision. Its recordedAt is the evidence cut an indicator reads at.' },
    ),
    wording: Type.Optional(
      Type.Object(
        {
          population: Type.String({ minLength: 1, maxLength: 1000 }),
          indicators: Type.Array(
            Type.Object({ id: Id, version: Version, title: Type.Union([Type.String(), Type.Null()]) }, Closed),
            { maxItems: CONTROL_WINDOW_LIMITS.maxIndicators },
          ),
        },
        {
          ...Closed,
          description:
            'The window in plain words for people, supplied when windows are listed: how many subjects it covers and who declared them, by name, and the title of each indicator registered now.',
        },
      ),
    ),
  },
  {
    ...Closed,
    description:
      'A monitored period for one accepted control: the subjects it covers, who declared them and whether they are complete, the observation types it expects and the indicator definitions it is for.',
  },
);
export type ControlWindow = Static<typeof ControlWindowSchema>;

export const ControlWindowResponseSchema = Type.Object({ window: ControlWindowSchema }, Closed);
export type ControlWindowResponse = Static<typeof ControlWindowResponseSchema>;

export const ControlWindowListResponseSchema = Type.Object(
  {
    windows: Type.Array(ControlWindowSchema, { maxItems: CONTROL_WINDOW_LIMITS.maxListed }),
    truncated: Type.Boolean({ description: 'More windows exist than were listed; the newest are shown.' }),
  },
  Closed,
);
export type ControlWindowListResponse = Static<typeof ControlWindowListResponseSchema>;

export const ControlWindowIndicatorResponseSchema = Type.Object(
  {
    windowId: Id,
    revision: Type.Integer({ minimum: 1 }),
    selection: Type.Union([Type.Literal('complete'), Type.Literal('incomplete_selection')]),
    result: IndicatorResultSchema,
    wording: IndicatorResultWordingSchema,
  },
  {
    ...Closed,
    description:
      'One indicator calculated for the window from its current population declaration, at the evidence cut of its current revision. Evidence for a person to review, never a verdict on the control.',
  },
);
export type ControlWindowIndicatorResponse = Static<typeof ControlWindowIndicatorResponseSchema>;
