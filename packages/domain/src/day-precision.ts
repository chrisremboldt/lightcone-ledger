import { dayStartInstant, findOperatorRecordDefinition } from '@ledger/contracts';
import { observationRegistry } from './observation-registry.js';
import { observationField, spanStart, utcMillis, type CheckObservation } from './check-kinds.js';

// A record placed by a date alone keeps the day beside its body (values.dayOnly): the field holds the day's first
// instant, or its end (the first instant of the next day) in the field that ends the record's interval, and nextDayAt
// the first instant of the next day. A check that compares such a time with a deadline reads the instant least
// favourable to the operator (docs/design/date-only-records.md).

/** A time an observation states, and the day it is, when only a date is on record for it. */
export interface PlacedTime {
  at: number;
  day?: string;
  /** The time zone the day is a day in, when only a date is on record. */
  timeZone?: string;
}

interface DayOnly {
  day: string;
  timeZone?: string;
  nextDayAt: string;
}

/** The record field a path or the span start reads, for an operator record. */
function recordFieldOf(observation: CheckObservation, path: string | undefined): string | undefined {
  if (path?.startsWith('values.record.')) return path.slice('values.record.'.length);
  const values = observation.observation.values as { recordType?: unknown; recordVersion?: unknown } | undefined;
  if (typeof values?.recordType !== 'string' || typeof values.recordVersion !== 'number') return undefined;
  const time = findOperatorRecordDefinition(observationRegistry(), values.recordType, values.recordVersion)?.time;
  if (!time) return undefined;
  if (time.meaning === 'interval') {
    if (path === 'interval.end') return time.endField;
    return path === undefined || path === 'interval.start' ? time.startField : undefined;
  }
  return path === undefined || path === 'occurredAt' ? time.atField : undefined;
}

function dayOnlyOf(observation: CheckObservation, field: string | undefined): DayOnly | undefined {
  if (field === undefined) return undefined;
  const entry = observationField(observation, `values.dayOnly.${field}`) as Partial<DayOnly> | undefined;
  return typeof entry?.day === 'string' && typeof entry.nextDayAt === 'string' ? (entry as DayOnly) : undefined;
}

/**
 * The instant in a field of an observation (its span start when no field is given). When only a date is on record
 * for it, `earliest` reads the first instant of that day and `latest` the last, and the day is returned to say so.
 */
export function placedTime(
  observation: CheckObservation,
  path: string | undefined,
  reading: 'earliest' | 'latest',
): PlacedTime | undefined {
  const at = utcMillis(path === undefined ? spanStart(observation) : observationField(observation, path));
  if (at === undefined) return undefined;
  const day = dayOnlyOf(observation, recordFieldOf(observation, path));
  const nextDay = utcMillis(day?.nextDayAt);
  // The day's first instant: the stored one, or, for a field that holds the end of the day, from the day in its zone.
  const dayStart =
    nextDay !== undefined && at === nextDay && day?.timeZone ? dayStartInstant(day.day, day.timeZone) : at;
  if (!day || nextDay === undefined || dayStart === undefined || nextDay <= dayStart || at > nextDay) return { at };
  return {
    at: reading === 'earliest' ? dayStart : nextDay - 1,
    day: day.day,
    ...(typeof day.timeZone === 'string' ? { timeZone: day.timeZone } : {}),
  };
}
