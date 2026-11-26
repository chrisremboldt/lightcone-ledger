import { Type, type Static, type TObject, type TProperties } from '@sinclair/typebox';
import { indicatorStatusValues, IndicatorDecimalPattern } from './indicators.js';

/**
 * Reports a person reads, prints or saves: a summary of a period, findings opened and closed per month by rule, and
 * one indicator's recorded results over time. Every number is a count of recorded things, computed by the database
 * under the reader's own scope. Documented in docs/design/reports.md.
 */

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Time = Type.String({ format: 'date-time' });
const Count = Type.Integer({ minimum: 0 });
const Closed = { additionalProperties: false } as const;
const Day = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });
const Month = Type.String({ pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' });
const Decimal = Type.String({ pattern: IndicatorDecimalPattern });

export const REPORT_LIMITS = {
  /** The longest period one summary covers, in days. */
  summaryDays: 731,
  /** The most months one count of findings per month covers. */
  findingMonths: 36,
  /** The most recorded results one indicator's history lists. */
  indicatorResults: 500,
} as const;

export const ReportPeriodQuerySchema = Type.Object(
  {
    from: Type.String({ ...Day, description: 'The first day of the period, in the organization’s time zone.' }),
    until: Type.String({ ...Day, description: 'The last day of the period, included.' }),
  },
  Closed,
);
export type ReportPeriodQuery = Static<typeof ReportPeriodQuerySchema>;

export const FindingsByMonthQuerySchema = Type.Object(
  {
    from: Type.Optional(Type.String({ ...Month, description: 'The first month, such as 2026-01.' })),
    until: Type.Optional(
      Type.String({
        ...Month,
        description: 'The last month, included. Both left out: the twelve months that end with the current one.',
      }),
    ),
  },
  Closed,
);
export type FindingsByMonthQuery = Static<typeof FindingsByMonthQuerySchema>;

const NotReadableSchema = Type.Object(
  {
    readable: Type.Literal(false),
    capability: Type.String({ description: 'What reading this part needs, which the reader does not hold.' }),
  },
  Closed,
);
/** A part of a report: its counts, or that the reader may not read what it counts, which is never shown as zero. */
function part<Properties extends TProperties>(counts: TObject<Properties>, description: string) {
  return Type.Union([Type.Object({ readable: Type.Literal(true), ...counts.properties }, Closed), NotReadableSchema], {
    description,
  });
}

const RuleCountsSchema = Type.Object(
  {
    packId: Id,
    packTitle: Type.String(),
    ruleId: Id,
    ruleTitle: Type.String(),
    opened: Count,
    closed: Count,
    openAtEnd: Count,
  },
  Closed,
);
export type ReportRuleCounts = Static<typeof RuleCountsSchema>;

export const PeriodSummarySchema = Type.Object(
  {
    period: Type.Object(
      {
        from: Day,
        until: Day,
        timeZone: Type.String(),
        start: Time,
        end: Time,
        asOf: Type.String({
          format: 'date-time',
          description: 'What “at the end” is counted at: the end of the period, or now when it has not ended.',
        }),
        ended: Type.Boolean(),
      },
      Closed,
    ),
    flights: part(
      Type.Object(
        {
          flights: Type.Integer({
            minimum: 0,
            description: 'Flights with a current flight record whose takeoff is in the period.',
          }),
          flightSeconds: Type.Integer({
            minimum: 0,
            description: 'Their recorded takeoff to landing time, added up, in seconds.',
          }),
          withoutDuration: Type.Integer({
            minimum: 0,
            description:
              'Of those flights, the ones whose recorded landing is not after their takeoff: not in the time.',
          }),
          plannedWithoutRecord: Type.Integer({
            minimum: 0,
            description: 'Flights with a current plan starting in the period and no flight record: not counted above.',
          }),
        },
        Closed,
      ),
      'Flights and flight time from the flight records on file. Needs evidence:read.',
    ),
    findings: part(
      Type.Object(
        {
          rules: Type.Array(RuleCountsSchema),
          total: Type.Object({ opened: Count, closed: Count, openAtEnd: Count }, Closed),
          proposed: Type.Integer({
            minimum: 0,
            description: 'Findings opened in the period by rules adopted to propose only: recorded, never counted.',
          }),
          relieved: Type.Integer({
            minimum: 0,
            description: 'Findings opened in the period whose latest result a waiver relieves: not counted.',
          }),
        },
        Closed,
      ),
      'Counted findings by rule: opened and closed in the period, and open at its end. Needs evidence:read.',
    ),
    findingActions: part(
      Type.Object({ open: Count, overdue: Count }, Closed),
      'Actions planned on counted findings, open at the end of the period and of those overdue. Needs evidence:read.',
    ),
    assuranceActions: part(
      Type.Object({ open: Count, overdue: Count }, Closed),
      'Actions of signed safety assurance records, open at the end of the period and of those overdue. Needs sms:read.',
    ),
    hazards: part(
      Type.Object(
        {
          levels: Type.Array(Type.Object({ level: Id, label: Type.String(), count: Count }, Closed), {
            description: 'Hazards open at the end by the residual level of their latest assessment, least first.',
          }),
          notAssessed: Count,
          total: Count,
        },
        Closed,
      ),
      'Hazards open at the end of the period, by level. Needs sms:read.',
    ),
    computedAt: Time,
  },
  {
    ...Closed,
    description:
      'A summary of one period: counts of recorded things only, each part the reader may read. No score, no rating.',
  },
);
export type PeriodSummary = Static<typeof PeriodSummarySchema>;

export const FindingsByMonthSchema = Type.Object(
  {
    period: Type.Object({ from: Month, until: Month, timeZone: Type.String() }, Closed),
    months: Type.Array(Month),
    rules: Type.Array(
      Type.Object(
        {
          packId: Id,
          packTitle: Type.String(),
          ruleId: Id,
          ruleTitle: Type.String(),
          opened: Type.Array(Count, { description: 'One count per month, in the order of months.' }),
          closed: Type.Array(Count),
        },
        Closed,
      ),
    ),
    total: Type.Object({ opened: Type.Array(Count), closed: Type.Array(Count) }, Closed),
    computedAt: Time,
  },
  {
    ...Closed,
    description:
      'Counted findings opened and closed in each month, in the organization’s time zone, by rule. A rule with none in the period is not listed.',
  },
);
export type FindingsByMonth = Static<typeof FindingsByMonthSchema>;

export const ReportIndicatorListSchema = Type.Object(
  {
    indicators: Type.Array(
      Type.Object(
        {
          id: Id,
          version: Type.Integer({ minimum: 1 }),
          title: Type.Union([Type.String(), Type.Null()]),
          results: Count,
          firstWindowStart: Time,
          lastWindowEnd: Time,
        },
        Closed,
      ),
    ),
  },
  { ...Closed, description: 'Each indicator definition with at least one recorded result, by title.' },
);
export type ReportIndicatorList = Static<typeof ReportIndicatorListSchema>;

export const ReportIndicatorParamsSchema = Type.Object(
  { indicatorId: Id, version: Type.String({ pattern: '^[1-9][0-9]{0,8}$' }) },
  Closed,
);
export type ReportIndicatorParams = Static<typeof ReportIndicatorParamsSchema>;

export const IndicatorHistorySchema = Type.Object(
  {
    definition: Type.Object(
      {
        id: Id,
        version: Type.Integer({ minimum: 1 }),
        title: Type.Union([Type.String(), Type.Null()]),
        description: Type.Union([Type.String(), Type.Null()]),
        unitLabel: Type.Union([Type.String(), Type.Null()]),
        limit: Type.Union([Type.Object({ rate: Decimal, label: Type.String() }, Closed), Type.Null()], {
          description: 'The level the definition sets for a person to compare a rate with, or null when it sets none.',
        }),
      },
      { ...Closed, description: 'As the registered definition states it; null where no registered one does.' },
    ),
    results: Type.Array(
      Type.Object(
        {
          id: Id,
          digest: Type.String({ pattern: '^[a-f0-9]{64}$' }),
          windowId: Id,
          hazardId: Id,
          window: Type.Object({ start: Time, end: Time }, Closed),
          recordedAt: Time,
          recordedThrough: Time,
          status: Type.Union(indicatorStatusValues.map((value) => Type.Literal(value))),
          eventCount: Count,
          exposure: Type.Object({ decimal: Decimal, unit: Type.String() }, Closed),
          rate: Type.Union([Type.Object({ decimal: Type.String(), label: Type.String() }, Closed), Type.Null()], {
            description: 'The rate the result states, or null when the evidence supported none.',
          }),
        },
        Closed,
      ),
      { maxItems: REPORT_LIMITS.indicatorResults },
    ),
    truncated: Type.Boolean({ description: 'More results are recorded than are listed: the newest are listed.' }),
    computedAt: Time,
  },
  {
    ...Closed,
    description:
      'Every recorded result of one indicator definition version, across its control windows, by window then by when it was recorded.',
  },
);
export type IndicatorHistory = Static<typeof IndicatorHistorySchema>;
