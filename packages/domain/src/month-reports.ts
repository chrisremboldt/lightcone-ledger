import {
  findOperatorRecordDefinition,
  OPERATOR_RECORD_SOURCE_ID,
  recordFieldFilled,
  REPORT_LIMITS,
  storedUnit,
  zonedMinute,
  zonedWallTime,
  type AircraftFlightTime,
  type FlightTimeByAircraft,
  type MonthOccurrence,
  type OccurrencesByMonth,
  type OperatorRecordDefinition,
  type OperatorRecordField,
  type ReportMonthPeriod,
  type ReportMonthQuery,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { observationRegistry } from './observation-registry.js';
import {
  operatorRecordObservationTypes,
  RECORD_TYPE_SQL,
  RECORD_VERSION_SQL,
  storedRecord,
} from './operator-record-reads.js';
import { organizationRecordTypes } from './organization-record-types.js';
import { currentFlightRecords, FLIGHT_RECORD, has, notReadable } from './reports.js';

/**
 * Two reports of one calendar month, in the organization's time zone, to prepare what an operator sends: flight time
 * by aircraft, and the occurrences recorded (docs/design/reports.md). Both count what is on file and name no rule.
 * They read operator records only, under the reader's own scope, and take no row locks; a reader who may not read
 * records is told so, never shown a zero.
 */

/** Where an aircraft's registration and serial number are on file. */
const AIRCRAFT_IDENTITY = 'aircraft.identity';
const REGISTRATION_FIELD = 'registrationNumber';
const SERIAL_FIELD = 'serialNumber';
/** Every record type whose id begins so is an occurrence, whoever defines it. */
const OCCURRENCE_PREFIX = 'occurrence.';

const CURRENT = `NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=o.tenant_id AND r.replaces_observation_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM observation_withdrawals w WHERE w.tenant_id=o.tenant_id AND w.observation_id=o.id)`;

function requireReportRead(principal: AuthContext): void {
  if (!has(principal, 'evidence:read') && !has(principal, 'sms:read'))
    throw new DomainError(403, 'capability_required', 'Reading this report requires evidence:read or sms:read');
}

interface MonthBounds {
  period: ReportMonthPeriod;
  start: Date;
  end: Date;
  now: Date;
}

/** One calendar month in the organization's time zone; the last whole month when none is asked for. */
async function monthBounds(client: PoolClient, tenantId: string, month: string | undefined): Promise<MonthBounds> {
  if (month !== undefined && month < '1900-01')
    throw new DomainError(400, 'invalid_month', `${month} is not a month Ledger counts; give one such as 2026-10`);
  const row = (
    await client.query<{ zone: string; month: string; last_day: string; start: Date; stop: Date; now: Date }>(
      `SELECT z.zone,m.month,clock_timestamp() AS now,
         to_char((m.month||'-01')::date+interval '1 month'-interval '1 day','YYYY-MM-DD') AS last_day,
         ((m.month||'-01')::date::timestamp AT TIME ZONE z.zone) AS start,
         (((m.month||'-01')::date+interval '1 month') AT TIME ZONE z.zone) AS stop
       FROM (SELECT COALESCE(time_zone,'UTC') AS zone FROM tenants WHERE id=$1) z,
         LATERAL (SELECT COALESCE($2::text,to_char(
           date_trunc('month',clock_timestamp() AT TIME ZONE z.zone)-interval '1 month','YYYY-MM')) AS month) m`,
      [tenantId, month ?? null],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, 'organization_not_found', 'The organization was not found');
  return {
    period: {
      month: row.month,
      from: `${row.month}-01`,
      until: row.last_day,
      timeZone: row.zone,
      start: row.start.toISOString(),
      end: row.stop.toISOString(),
      ended: row.stop.getTime() <= row.now.getTime(),
    },
    start: row.start,
    end: row.stop,
    now: row.now,
  };
}

/** By the organization's own id, code unit by code unit; what names none comes last. */
function byOwnId(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

const textOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Each aircraft's registration and serial number from its identity record: the latest current one that held by the
 * end of the month, else the first recorded after it, which the report says. An identity record names no time of its
 * own, so its time is when it was recorded, and a month prepared from records imported later has only such records.
 */
async function aircraftIdentities(
  client: PoolClient,
  tenantId: string,
  aircraftIds: readonly string[],
  end: Date,
): Promise<Map<string, NonNullable<AircraftFlightTime['identity']>>> {
  const identities = new Map<string, NonNullable<AircraftFlightTime['identity']>>();
  if (!aircraftIds.length) return identities;
  const rows = await client.query<{
    subject_id: string;
    after: boolean;
    observation: Record<string, any>;
    observation_type: string;
    observation_version: number;
  }>(
    `SELECT DISTINCT ON(o.subject_id) o.subject_id,(o.span_start>=$6) AS after,o.observation,o.observation_type,
       o.observation_version
     FROM observations o
     WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=ANY($3::text[]) AND o.subject_kind='aircraft'
       AND o.subject_id=ANY($5::text[]) AND ${RECORD_TYPE_SQL}=$4 AND ${CURRENT}
     ORDER BY o.subject_id,(o.span_start>=$6),CASE WHEN o.span_start<$6 THEN o.span_start END DESC NULLS LAST,
       o.span_start,o.received_at DESC,o.id DESC`,
    [tenantId, OPERATOR_RECORD_SOURCE_ID, operatorRecordObservationTypes(), AIRCRAFT_IDENTITY, [...aircraftIds], end],
  );
  for (const row of rows.rows) {
    const { record } = storedRecord(row);
    identities.set(row.subject_id, {
      registrationNumber: textOf(record[REGISTRATION_FIELD]),
      serialNumber: textOf(record[SERIAL_FIELD]),
      recordedAfterMonth: row.after,
    });
  }
  return identities;
}

/** What one aircraft's flight records of the month add up to, as the database counted them. */
export interface AircraftFlightRow {
  aircraft_id: string | null;
  flights: string | number;
  seconds: string | number;
  without: string | number;
}

/**
 * The aircraft of a month in the order of their ids, each with whole seconds, and their total. The total's seconds are
 * the whole seconds of every flight's time added up, as the summary of a period counts them, so with times recorded to
 * a fraction of a second it may exceed the sum of the rows by less than one second each.
 */
export function flightTimeByAircraft(
  rows: readonly AircraftFlightRow[],
  identities: ReadonlyMap<string, NonNullable<AircraftFlightTime['identity']>>,
): {
  aircraft: AircraftFlightTime[];
  total: { aircraft: number; flights: number; flightSeconds: number; withoutTime: number };
} {
  const aircraft = [...rows]
    .sort((left, right) => byOwnId(left.aircraft_id, right.aircraft_id))
    .map((row) => ({
      aircraftId: row.aircraft_id,
      identity: row.aircraft_id === null ? null : (identities.get(row.aircraft_id) ?? null),
      flights: Number(row.flights),
      flightSeconds: Math.floor(Number(row.seconds)),
      withoutTime: Number(row.without),
    }));
  return {
    aircraft,
    total: {
      aircraft: aircraft.filter((entry) => entry.aircraftId !== null).length,
      flights: aircraft.reduce((sum, entry) => sum + entry.flights, 0),
      flightSeconds: Math.floor(rows.reduce((sum, row) => sum + Number(row.seconds), 0)),
      withoutTime: aircraft.reduce((sum, entry) => sum + entry.withoutTime, 0),
    },
  };
}

/** The aircraft a flight record names as its related subject. */
const AIRCRAFT_OF_FLIGHT = `,CASE WHEN o.secondary_subject_kind='aircraft' THEN o.secondary_subject_id END AS aircraft_id`;

async function aircraftFlightTime(client: PoolClient, tenantId: string, bounds: MonthBounds) {
  const flown = `WITH flown AS (${currentFlightRecords('$4', AIRCRAFT_OF_FLIGHT)}),
    month AS (SELECT * FROM flown WHERE interval_start>=$5 AND interval_start<$6)`;
  const params = [
    tenantId,
    OPERATOR_RECORD_SOURCE_ID,
    operatorRecordObservationTypes(),
    FLIGHT_RECORD,
    bounds.start,
    bounds.end,
  ];
  const counted = await client.query<AircraftFlightRow>(
    `${flown} SELECT aircraft_id,count(*) AS flights,
       COALESCE(sum(EXTRACT(EPOCH FROM interval_end-interval_start)) FILTER (WHERE interval_end>interval_start),0)
         AS seconds,
       count(*) FILTER (WHERE interval_end IS NULL OR interval_end<=interval_start) AS without
     FROM month GROUP BY aircraft_id`,
    params,
  );
  const limit = REPORT_LIMITS.flightsWithoutTime;
  const without = await client.query<{
    subject_id: string;
    aircraft_id: string | null;
    interval_start: Date;
    interval_end: Date | null;
  }>(
    `${flown} SELECT subject_id,aircraft_id,interval_start,interval_end FROM month
     WHERE interval_end IS NULL OR interval_end<=interval_start ORDER BY interval_start,subject_id LIMIT $7`,
    [...params, limit + 1],
  );
  const named = counted.rows.flatMap((row) => (row.aircraft_id === null ? [] : [row.aircraft_id]));
  return {
    readable: true as const,
    ...flightTimeByAircraft(counted.rows, await aircraftIdentities(client, tenantId, named, bounds.end)),
    withoutTime: without.rows.slice(0, limit).map((row) => ({
      aircraftId: row.aircraft_id,
      flightId: row.subject_id,
      takeoffAt: row.interval_start.toISOString(),
      reason: row.interval_end ? ('landing_not_after_takeoff' as const) : ('no_landing_time' as const),
    })),
    withoutTimeTruncated: without.rows.length > limit,
  };
}

/** GET /v1/reports/flight-time: one month's flights and flight time by aircraft. */
export async function getFlightTimeByAircraft(
  client: PoolClient,
  principal: AuthContext,
  query: ReportMonthQuery,
): Promise<FlightTimeByAircraft> {
  requireReportRead(principal);
  const bounds = await monthBounds(client, principal.tenantId, query.month);
  return {
    period: bounds.period,
    flights: has(principal, 'evidence:read')
      ? await aircraftFlightTime(client, principal.tenantId, bounds)
      : notReadable('evidence:read'),
    computedAt: bounds.now.toISOString(),
  };
}

/**
 * A field's value as a person reads it: a choice by its label, a time as the organization's clocks read it, a time
 * given as a date alone as that date. Null for a field with no value.
 */
export function recordFieldText(
  field: OperatorRecordField,
  value: unknown,
  timeZone: string,
  day?: string,
): string | null {
  if (!recordFieldFilled(value)) return null;
  switch (field.kind) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'select':
      return field.options.find((option) => option.value === value)?.label ?? String(value);
    case 'reference':
      return String((value as { id?: unknown }).id ?? '');
    case 'date_time':
      return day ?? zonedMinute(String(value), timeZone);
    case 'number':
      return field.unit === 'Count' ? String(value) : `${value} ${storedUnit(field.unit).unit}`;
    default:
      return String(value);
  }
}

/** The field that places a record in time, as its type says. */
const placingField = (definition: OperatorRecordDefinition) =>
  definition.time.meaning === 'interval' ? definition.time.startField : definition.time.atField;

interface OccurrenceRow {
  id: string;
  subject_kind: string;
  subject_id: string;
  secondary_subject_kind: string | null;
  secondary_subject_id: string | null;
  span_start: Date;
  observation: Record<string, any>;
  observation_type: string;
  observation_version: number;
}

/**
 * One occurrence as the report lists it: its day, the flight and aircraft it names, and its own fields. The fields are
 * read from the record type's definition, whatever the type; a record of a type no longer defined keeps its fields
 * under their names. No definition marks one of its fields as the occurrence's kind, so none is singled out.
 */
export function monthOccurrence(
  row: OccurrenceRow,
  definition: OperatorRecordDefinition | undefined,
  timeZone: string,
): MonthOccurrence {
  const stored = storedRecord(row);
  const subjects = [
    { kind: row.subject_kind, id: row.subject_id },
    ...(row.secondary_subject_kind && row.secondary_subject_id
      ? [{ kind: row.secondary_subject_kind, id: row.secondary_subject_id }]
      : []),
  ];
  const at = row.span_start.toISOString();
  const placing = definition && placingField(definition);
  const day = placing ? stored.dayOnly?.[placing]?.day : undefined;
  // The field that places the record is the row's own day and time, so it is not listed again among its fields.
  const fields = definition
    ? definition.fields.flatMap((field) => {
        if (field.name === placing) return [];
        const value = recordFieldText(field, stored.record[field.name], timeZone, stored.dayOnly?.[field.name]?.day);
        return value === null ? [] : [{ name: field.name, label: field.label, value }];
      })
    : Object.entries(stored.record).map(([name, value]) => ({
        name,
        label: name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      }));
  return {
    recordId: row.id,
    occurredAt: at,
    occurredOn: day ?? (zonedWallTime(at, timeZone) ?? at).slice(0, 10),
    dateOnly: Boolean(day),
    flightId: subjects.find((subject) => subject.kind === 'flight')?.id ?? null,
    aircraftId: subjects.find((subject) => subject.kind === 'aircraft')?.id ?? null,
    about: subjects.filter((subject) => !['flight', 'aircraft', 'organization'].includes(subject.kind)),
    fields,
  };
}

type OccurrenceTypes = Extract<OccurrencesByMonth['occurrences'], { readable: true }>['types'];

/**
 * The record types the report lists: the latest version of each occurrence type the organization has, with a count of
 * zero when none is on file for the month, and every other version or type that has records in it. By title.
 */
export function occurrenceTypes(
  definitions: readonly OperatorRecordDefinition[],
  counts: readonly { record_type: string; record_version: number; count: string | number }[],
  titleOf: (recordType: string, recordVersion: number) => string,
): OccurrenceTypes {
  const latest = new Map<string, number>();
  for (const definition of definitions)
    if (definition.recordType.startsWith(OCCURRENCE_PREFIX))
      latest.set(definition.recordType, Math.max(latest.get(definition.recordType) ?? 0, definition.recordVersion));
  const listed = new Map<string, OccurrenceTypes[number]>();
  const list = (recordType: string, recordVersion: number, count: number) =>
    listed.set(`${recordType}@${recordVersion}`, {
      recordType,
      recordVersion,
      title: titleOf(recordType, recordVersion),
      count,
      occurrences: [],
    });
  for (const [recordType, recordVersion] of latest) list(recordType, recordVersion, 0);
  for (const row of counts) list(row.record_type, Number(row.record_version), Number(row.count));
  return [...listed.values()].sort(
    (left, right) =>
      left.title.localeCompare(right.title) ||
      left.recordType.localeCompare(right.recordType) ||
      left.recordVersion - right.recordVersion,
  );
}

async function monthOccurrences(client: PoolClient, tenantId: string, bounds: MonthBounds) {
  const own = await organizationRecordTypes(client, tenantId, bounds.now.toISOString());
  const definitionOf = (recordType: string, recordVersion: number) =>
    own.find(recordType, recordVersion) ??
    findOperatorRecordDefinition(observationRegistry(), recordType, recordVersion);
  const inMonth = `FROM observations o
    WHERE o.tenant_id=$1 AND o.source_id=$2 AND o.observation_type=ANY($3::text[])
      AND ${RECORD_TYPE_SQL} LIKE $4 AND o.span_start>=$5 AND o.span_start<$6 AND ${CURRENT}`;
  const params = [
    tenantId,
    OPERATOR_RECORD_SOURCE_ID,
    operatorRecordObservationTypes(),
    `${OCCURRENCE_PREFIX}%`,
    bounds.start,
    bounds.end,
  ];
  const counts = await client.query<{ record_type: string; record_version: number; count: string }>(
    `SELECT ${RECORD_TYPE_SQL} AS record_type,${RECORD_VERSION_SQL} AS record_version,count(*) AS count ${inMonth}
     GROUP BY 1,2`,
    params,
  );
  const limit = REPORT_LIMITS.monthOccurrences;
  const rows = await client.query<OccurrenceRow>(
    `SELECT o.id,o.subject_kind,o.subject_id,o.secondary_subject_kind,o.secondary_subject_id,o.span_start,
       o.observation,o.observation_type,o.observation_version ${inMonth} ORDER BY o.span_start,o.id LIMIT $7`,
    [...params, limit],
  );
  const types = occurrenceTypes(
    own.definitions,
    counts.rows,
    (recordType, recordVersion) => definitionOf(recordType, recordVersion)?.title ?? recordType,
  );
  const byType = new Map(types.map((type) => [`${type.recordType}@${type.recordVersion}`, type]));
  for (const row of rows.rows) {
    const { recordType, recordVersion } = storedRecord(row);
    byType
      .get(`${recordType}@${recordVersion}`)
      ?.occurrences.push(monthOccurrence(row, definitionOf(recordType, recordVersion), bounds.period.timeZone));
  }
  const total = types.reduce((sum, type) => sum + type.count, 0);
  return { readable: true as const, types, total, truncated: total > rows.rows.length };
}

/** GET /v1/reports/occurrences: one month's occurrence records, by record type. */
export async function getOccurrencesByMonth(
  client: PoolClient,
  principal: AuthContext,
  query: ReportMonthQuery,
): Promise<OccurrencesByMonth> {
  requireReportRead(principal);
  const bounds = await monthBounds(client, principal.tenantId, query.month);
  return {
    period: bounds.period,
    occurrences: has(principal, 'evidence:read')
      ? await monthOccurrences(client, principal.tenantId, bounds)
      : notReadable('evidence:read'),
    computedAt: bounds.now.toISOString(),
  };
}
