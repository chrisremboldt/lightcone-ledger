import { Type, type Static } from '@sinclair/typebox';
import { FlightPredepartureSummarySchema } from './flight-predeparture.js';

const Time = Type.String({ format: 'date-time', pattern: 'Z$' });
const Interval = Type.Object({ start: Time, end: Time }, { additionalProperties: false });
const MissionHead = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    sourceRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    operatingInterval: Interval,
  },
  { additionalProperties: false },
);

export const FlightOperationSummarySchema = Type.Object(
  {
    scope: Type.Union(
      (['current', 'overdue', 'historical-issues', 'history'] as const).map((value) => Type.Literal(value)),
    ),
    asOf: Time,
    reason: Type.Union(
      (
        [
          'reported-active',
          'plan-window',
          'needs-planning',
          'window-elapsed',
          'status-unconfirmed',
          'plan-unconfirmed',
          'terminal-issues',
          'terminal',
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
    window: Type.Union([
      Type.Null(),
      Type.Object(
        {
          basis: Type.Union([Type.Literal('requested'), Type.Literal('mission')]),
          start: Type.Optional(Time),
          end: Type.Optional(Time),
        },
        { additionalProperties: false },
      ),
    ]),
    mission: Type.Object(
      {
        state: Type.Union(
          (['none', 'current', 'pending', 'processing', 'failed'] as const).map((value) => Type.Literal(value)),
        ),
        accepted: Type.Optional(MissionHead),
        projected: Type.Optional(MissionHead),
      },
      { additionalProperties: false },
    ),
    activityReport: Type.Optional(
      Type.Object(
        {
          activity: Type.Union(
            (['planned', 'active', 'landed', 'cancelled'] as const).map((value) => Type.Literal(value)),
          ),
          occurredAt: Time,
          receivedAt: Time,
        },
        { additionalProperties: false },
      ),
    ),
    positionOccurredAt: Type.Optional(Time),
    predeparture: Type.Optional(FlightPredepartureSummarySchema),
  },
  {
    additionalProperties: false,
    description:
      'Read-time context on scoped flight lists and exact flight reads, not a change to recorded activity or a decision basis. A current mission window requires the highest accepted revision to be completed and equal the projected head. Pending or failed newer plans leave window null, retaining both heads explicitly. Requested schedule fields remain separate. Reported-active flights stay current when actual activity or position occurrence is no more than 90 seconds old and not future-dated, even after the window. Generic receipt, decision and evaluation clocks never refresh physical activity. Elapsed time never establishes landing, cancellation, completion or resolution.',
  },
);
export type FlightOperationSummary = Static<typeof FlightOperationSummarySchema>;
