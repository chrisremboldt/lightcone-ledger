import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import {
  IndicatorFieldConditionSchema,
  ObservationTypeIdPattern,
  subjectReferenceKey,
  type IndicatorFieldCondition,
  type SubjectReference,
} from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import { observationField, spanStart, utcMillis } from './check-kinds.js';
import { add, decimalOfNumber, rational, subtract, ZERO, type Rational } from './indicator-arithmetic.js';

/** One accepted observation as an exposure kind or an event selection sees it. */
export interface IndicatorObservation {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  interval?: { start: string; end?: string };
  /** The observation's subject and secondary subject, as Ledger subjects where intake resolved them. */
  subjects: SubjectReference[];
  observation: Readonly<Record<string, unknown>>;
}

/** Half-open [start, end) in UTC milliseconds. */
export interface ExposureWindow {
  start: number;
  end: number;
}

export interface ExposureNote {
  code: string;
  subjectKey?: string;
  observationIds: string[];
}

export interface ExposureMeasure {
  quantity: Rational;
  /** Ids of the observations the quantity was computed from. */
  counted: string[];
  /** Places where exposure is unknown: the observations show that something happened but not how much. */
  gaps: ExposureNote[];
  /** Places where the observations disagree about the exposure. */
  conflicts: ExposureNote[];
}

export interface ExposureRead {
  type: string;
  versions: number[];
  /**
   * Read where it is on file, as an alternative to the other reads: the operator's own records of what a source may
   * also report. A control window need not expect it.
   */
  alternative?: true;
}

/** Words for one and for several; {count} in either is replaced by the number. */
export interface PluralWords {
  one: string;
  other: string;
}

/** Plain words for people: the unit, and a sentence for each gap or conflict code the kind reports. */
export interface ExposureKindWording {
  unit: PluralWords;
  notes: Readonly<Record<string, PluralWords>>;
}

/**
 * An exposure kind measures what an indicator's count is divided by, from accepted observations it declares as its
 * source of truth. It is pure and versioned, performs no I/O and names no rule, vendor or problem. A published id and
 * version is never changed; a changed definition is a new version.
 */
export interface ExposureKind<Params = any> {
  id: string;
  version: number;
  title: string;
  description: string;
  /** The unit of the measured quantity, such as flight_hour. */
  unit: string;
  sourceOfTruth: string;
  /** checked: the kind reports gaps it can see. not_determinable: the observations cannot show missing exposure. */
  coverage: 'checked' | 'not_determinable';
  /** Kept out of the digest, so wording can be improved without a new version; an older result reads it too. */
  wording?: ExposureKindWording;
  /** How far outside the window gathering reads, for observations placed outside the span they describe. */
  readMarginMilliseconds: { before: number; after: number };
  parameterSchema: Readonly<Record<string, unknown>>;
  reads(params: Params): ExposureRead[];
  measure(
    params: Params,
    observations: readonly IndicatorObservation[],
    window: ExposureWindow,
    population: readonly SubjectReference[],
  ): ExposureMeasure;
}

export type ExposureKindDefinition = Omit<ExposureKind, 'reads' | 'measure' | 'wording'>;

const registryKey = Symbol.for('ledger.exposure-kind-registry.1');
const registry = ((globalThis as Record<symbol, Map<string, ExposureEntry> | undefined>)[registryKey] ??= new Map());
interface ExposureEntry {
  kind: ExposureKind;
  digest: string;
  validate: ValidateFunction;
}
const ajv = new Ajv({ strict: false, strictNumbers: true, allErrors: false });
(addFormats as unknown as (instance: Ajv) => void)(ajv);
const idPattern = new RegExp(ObservationTypeIdPattern);
const MAX_MARGIN = 7 * 24 * 60 * 60 * 1000;

export function exposureKindDefinition(kind: ExposureKind): ExposureKindDefinition {
  return structuredClone({
    id: kind.id,
    version: kind.version,
    title: kind.title,
    description: kind.description,
    unit: kind.unit,
    sourceOfTruth: kind.sourceOfTruth,
    coverage: kind.coverage,
    readMarginMilliseconds: { ...kind.readMarginMilliseconds },
    parameterSchema: kind.parameterSchema as Record<string, unknown>,
  });
}

export function exposureKindDigest(kind: ExposureKind): string {
  return canonicalDigest({ format: 'ledger.exposure-kind.1', ...exposureKindDefinition(kind) });
}

/**
 * Registers an exposure kind. Registering the same id and version again is accepted only with an identical declared
 * definition, and keeps the first registration.
 */
export function registerExposureKind(kind: ExposureKind): void {
  if (!idPattern.test(kind.id)) throw new Error(`Exposure kind id ${kind.id} must be a lowercase domain.noun id`);
  if (!Number.isSafeInteger(kind.version) || kind.version < 1)
    throw new Error(`Exposure kind ${kind.id} needs a positive integer version`);
  const { before, after } = kind.readMarginMilliseconds;
  if (![before, after].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MARGIN))
    throw new Error(`Exposure kind ${kind.id} read margins must be whole milliseconds up to seven days`);
  const digest = exposureKindDigest(kind);
  const key = `${kind.id}@${kind.version}`;
  const existing = registry.get(key);
  if (existing) {
    if (existing.digest !== digest)
      throw new Error(`Exposure kind ${kind.id} version ${kind.version} is already registered with another definition`);
    return;
  }
  registry.set(key, { kind, digest, validate: ajv.compile(structuredClone(kind.parameterSchema)) });
}

export function findExposureKind(id: string, version: number): ExposureKind | undefined {
  return registry.get(`${id}@${version}`)?.kind;
}

export function registeredExposureKindDigest(id: string, version: number): string | undefined {
  return registry.get(`${id}@${version}`)?.digest;
}

export function listExposureKinds(): ExposureKindDefinition[] {
  return [...registry.values()].map(({ kind }) => exposureKindDefinition(kind));
}

/** Returns a description of the first problem, or undefined when the parameters match the kind's schema. */
export function exposureParameterProblem(id: string, version: number, params: unknown): string | undefined {
  const entry = registry.get(`${id}@${version}`);
  if (!entry) return `Exposure kind ${id} version ${version} is not registered`;
  if (entry.validate(params)) return undefined;
  const first = entry.validate.errors?.[0];
  return `Exposure ${id} parameters ${first?.instancePath || '/'} ${first?.message ?? 'are invalid'}`;
}

// Shared reading helpers ------------------------------------------------------------------------------------------

const conditionValidator = ajv.compile(structuredClone(IndicatorFieldConditionSchema));

export function conditionProblem(condition: unknown): string | undefined {
  return conditionValidator(condition) ? undefined : 'The field condition is invalid';
}

/** Whether an observation meets a field condition. An absent field never matches, except that present asks for it. */
export function matchesCondition(observation: IndicatorObservation, condition: IndicatorFieldCondition): boolean {
  const value = observationField(observation, condition.field);
  if (value === undefined || value === null) return false;
  switch (condition.operator) {
    case 'present':
      return true;
    case 'equals':
      return value === condition.value;
    case 'one_of':
      return condition.values.some((candidate) => candidate === value);
    default: {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (condition.operator === 'at_least') return value >= condition.value;
      if (condition.operator === 'at_most') return value <= condition.value;
      return condition.operator === 'above' ? value > condition.value : value < condition.value;
    }
  }
}

export function spanStartMillis(observation: IndicatorObservation): number {
  return Date.parse(spanStart(observation));
}

function ids(observations: readonly IndicatorObservation[]): string[] {
  return observations.map((observation) => observation.id).sort();
}

function ofTypes(observations: readonly IndicatorObservation[], reads: readonly ExposureRead[]) {
  return observations.filter((observation) =>
    reads.some((read) => read.type === observation.type && read.versions.includes(observation.version)),
  );
}

function subjectOfKind(observation: IndicatorObservation, kind: SubjectReference['kind']): string | undefined {
  const subject = observation.subjects.find((candidate) => candidate.kind === kind);
  return subject ? subjectReferenceKey(subject) : undefined;
}

function groupBy(
  observations: readonly IndicatorObservation[],
  key: (observation: IndicatorObservation) => string | undefined,
): Map<string, IndicatorObservation[]> {
  const groups = new Map<string, IndicatorObservation[]>();
  for (const observation of observations) {
    const value = key(observation);
    if (value !== undefined) groups.set(value, [...(groups.get(value) ?? []), observation]);
  }
  return new Map([...groups].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

type Interval = [number, number];

function unionDuration(intervals: Interval[]): number {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let current: Interval | undefined;
  for (const [start, end] of sorted) {
    if (current && start <= current[1]) current[1] = Math.max(current[1], end);
    else {
      if (current) total += current[1] - current[0];
      current = [start, end];
    }
  }
  return total + (current ? current[1] - current[0] : 0);
}

function clip([start, end]: Interval, window: ExposureWindow): Interval | undefined {
  const from = Math.max(start, window.start),
    to = Math.min(end, window.end);
  return from < to ? [from, to] : undefined;
}

const HOUR = 3_600_000n;

/** Words for a note counted per flight: one flight, or {count} flights. */
function perFlight(one: string, other: string): PluralWords {
  return { one: `One flight ${one}`, other: `{count} flights ${other}` };
}

const flightReportNotes = {
  takeoff_reports_disagree: perFlight(
    'has reports that disagree on its takeoff time.',
    'have reports that disagree on their takeoff times.',
  ),
  landing_reports_disagree: perFlight(
    'has reports that disagree on its landing time.',
    'have reports that disagree on their landing times.',
  ),
  takeoff_records_disagree: perFlight(
    'has flight records that disagree on its takeoff time.',
    'have flight records that disagree on their takeoff times.',
  ),
  landing_records_disagree: perFlight(
    'has flight records that disagree on its landing time.',
    'have flight records that disagree on their landing times.',
  ),
  landing_not_after_takeoff: perFlight(
    'has a landing time at or before its takeoff time.',
    'have a landing time at or before their takeoff time.',
  ),
  landing_unreported: perFlight(
    'has a takeoff time and no landing time on record, so its airborne time is unknown.',
    'have a takeoff time and no landing time on record, so their airborne time is unknown.',
  ),
  takeoff_unreported: perFlight(
    'has a landing time and no takeoff time on record, so its airborne time is unknown.',
    'have a landing time and no takeoff time on record, so their airborne time is unknown.',
  ),
  flight_times_unreported: perFlight(
    'was reported as flown with no takeoff or landing time.',
    'were reported as flown with no takeoff or landing time.',
  ),
} as const;
const flightHourUnit = { one: 'flight hour', other: 'flight hours' };
const noParams = { type: 'object', additionalProperties: false, properties: {} } as const;

// Flights from flight reports and the operator's flight records ---------------------------------------------------

const flightReports: ExposureRead[] = [{ type: 'flight.report', versions: [1] }];
const operatorRecords: ExposureRead[] = [{ type: 'operator.record', versions: [1] }];
const flightTimes: ExposureRead[] = [...flightReports, { ...operatorRecords[0]!, alternative: true }];
const DAY = 24 * 60 * 60 * 1000;

function recordsOfType(observations: readonly IndicatorObservation[], recordType: string) {
  return ofTypes(observations, operatorRecords).filter(
    (observation) =>
      observationField(observation, 'values.recordType') === recordType &&
      observationField(observation, 'values.recordVersion') === 1,
  );
}

interface FlightOnRecord {
  key: string;
  /** The flight's reports and flight records: the observations its times are read from. */
  observations: IndicatorObservation[];
  takeoffAt?: number;
  landingAt?: number;
  /** Every instant the reports and records state for the flight, and when each was reported or begins. */
  instants: number[];
  flown: boolean;
  conflicts: string[];
}

/**
 * One flight: its takeoff and landing as every report of it agrees, or, for a time no report states, as its flight
 * records state it; or the disagreement. A flight record is the operator's own log of the flight as flown.
 */
function flightsOnRecord(observations: readonly IndicatorObservation[]): FlightOnRecord[] {
  const flightKey = (observation: IndicatorObservation) => subjectOfKind(observation, 'flight');
  const reportsOf = groupBy(ofTypes(observations, flightReports), flightKey);
  const recordsOf = groupBy(recordsOfType(observations, 'flight.record'), flightKey);
  const keys = [...new Set([...reportsOf.keys(), ...recordsOf.keys()])].sort();
  return keys.map((key) => {
    const reports = reportsOf.get(key) ?? [];
    const records = recordsOf.get(key) ?? [];
    const times = (items: readonly IndicatorObservation[], field: string) =>
      new Set(items.flatMap((item) => utcMillis(observationField(item, field)) ?? []));
    const conflicts: string[] = [];
    /** The reported time where a report states one, else the recorded time; undefined when they disagree. */
    const timeOf = (reportField: string, recordField: string, which: 'takeoff' | 'landing') => {
      const reported = times(reports, reportField);
      const chosen = reported.size ? reported : times(records, recordField);
      if (chosen.size > 1) conflicts.push(`${which}_${reported.size ? 'reports' : 'records'}_disagree`);
      return chosen.size === 1 ? [...chosen][0] : undefined;
    };
    const takeoffAt = timeOf('values.takeoffAt', 'values.record.takeoffAt', 'takeoff');
    const landingAt = timeOf('values.landingAt', 'values.record.landingAt', 'landing');
    if (takeoffAt !== undefined && landingAt !== undefined && landingAt <= takeoffAt)
      conflicts.push('landing_not_after_takeoff');
    const instants = [
      ...reports.map((report) => Date.parse(report.occurredAt)),
      ...records.map(spanStartMillis),
      ...times(reports, 'values.takeoffAt'),
      ...times(reports, 'values.landingAt'),
      ...times(records, 'values.record.takeoffAt'),
      ...times(records, 'values.record.landingAt'),
    ];
    const flown =
      records.length > 0 ||
      takeoffAt !== undefined ||
      landingAt !== undefined ||
      reports.some((report) => ['active', 'landed'].includes(observationField(report, 'values.activity') as string));
    return { key, observations: [...reports, ...records], takeoffAt, landingAt, instants, flown, conflicts };
  });
}

function note(code: string, flight: FlightOnRecord): ExposureNote {
  return { code, subjectKey: flight.key, observationIds: ids(flight.observations) };
}

/** Whether a report of the flight was made, or a flight record of it begins, inside the window. */
function reportedInWindow(flight: FlightOnRecord, window: ExposureWindow): boolean {
  return flight.observations.some((observation) => {
    const at = observation.type === 'flight.report' ? Date.parse(observation.occurredAt) : spanStartMillis(observation);
    return at >= window.start && at < window.end;
  });
}

/** Whether any instant the flight's reports and records state places the flight in or across the window. */
function touchesWindow(flight: FlightOnRecord, window: ExposureWindow): boolean {
  return (
    flight.instants.some((at) => at >= window.start && at < window.end) ||
    (flight.instants.some((at) => at < window.start) && flight.instants.some((at) => at >= window.end))
  );
}

export const flightHoursV1: ExposureKind<Record<string, never>> = {
  id: 'exposure.flight-hours',
  version: 1,
  title: 'Flight hours',
  description:
    'Sum over flights of the part of [takeoffAt, landingAt) inside the window, in hours. Each time is the one the flight’s reports state, or, where no report states it, the one its flight records state. Reports of one flight must agree on takeoff and landing, and so must its flight records. A flight on record as flown with no takeoff or no landing time is a gap: its exposure is unknown, not zero.',
  unit: 'flight_hour',
  sourceOfTruth:
    'flight.report@1 takeoffAt and landingAt, else operator.record@1 carrying flight.record@1 takeoffAt and landingAt, grouped by the flight subject',
  coverage: 'checked',
  wording: { unit: flightHourUnit, notes: flightReportNotes },
  readMarginMilliseconds: { before: DAY, after: DAY },
  parameterSchema: noParams,
  reads: () => flightTimes,
  measure(_params, observations, window) {
    let milliseconds = 0;
    const counted: string[] = [];
    const gaps: ExposureNote[] = [];
    const conflicts: ExposureNote[] = [];
    for (const flight of flightsOnRecord(observations)) {
      if (flight.conflicts.length) {
        if (touchesWindow(flight, window)) conflicts.push(...flight.conflicts.map((code) => note(code, flight)));
        continue;
      }
      const { takeoffAt, landingAt } = flight;
      if (takeoffAt !== undefined && landingAt !== undefined) {
        const inside = clip([takeoffAt, landingAt], window);
        if (inside) {
          milliseconds += inside[1] - inside[0];
          counted.push(...ids(flight.observations));
        }
      } else if (takeoffAt !== undefined) {
        if (takeoffAt < window.end) gaps.push(note('landing_unreported', flight));
      } else if (landingAt !== undefined) {
        if (landingAt > window.start) gaps.push(note('takeoff_unreported', flight));
      } else if (flight.flown && reportedInWindow(flight, window)) gaps.push(note('flight_times_unreported', flight));
    }
    return { quantity: rational(BigInt(milliseconds), HOUR), counted: counted.sort(), gaps, conflicts };
  },
};

export const flightsV1: ExposureKind<Record<string, never>> = {
  id: 'exposure.flights',
  version: 1,
  title: 'Flights',
  description:
    'Count of flights whose takeoff falls inside the window. The takeoff is the one the flight’s reports state, or, where no report states it, the one its flight records state. Reports of one flight must agree on the takeoff time, and so must its flight records. A flight on record as flown in the window with no takeoff time is a gap.',
  unit: 'flight',
  sourceOfTruth:
    'flight.report@1 takeoffAt, else operator.record@1 carrying flight.record@1 takeoffAt, grouped by the flight subject',
  coverage: 'checked',
  wording: {
    unit: { one: 'flight', other: 'flights' },
    notes: {
      takeoff_reports_disagree: flightReportNotes.takeoff_reports_disagree,
      takeoff_records_disagree: flightReportNotes.takeoff_records_disagree,
      takeoff_unreported: perFlight(
        'is on record as flown with no takeoff time, so it cannot be counted.',
        'are on record as flown with no takeoff time, so they cannot be counted.',
      ),
    },
  },
  readMarginMilliseconds: { before: DAY, after: DAY },
  parameterSchema: noParams,
  reads: () => flightTimes,
  measure(_params, observations, window) {
    let count = 0n;
    const counted: string[] = [];
    const gaps: ExposureNote[] = [];
    const conflicts: ExposureNote[] = [];
    for (const flight of flightsOnRecord(observations)) {
      const codes = flight.conflicts.filter((code) => code.startsWith('takeoff_'));
      if (codes.length) {
        if (touchesWindow(flight, window)) conflicts.push(...codes.map((code) => note(code, flight)));
        continue;
      }
      if (flight.takeoffAt === undefined) {
        const landedInside = flight.landingAt !== undefined && flight.landingAt >= window.start;
        if (flight.flown && (landedInside || reportedInWindow(flight, window)))
          gaps.push(note('takeoff_unreported', flight));
      } else if (flight.takeoffAt >= window.start && flight.takeoffAt < window.end) {
        count++;
        counted.push(...ids(flight.observations));
      }
    }
    return { quantity: rational(count), counted: counted.sort(), gaps, conflicts };
  },
};

// Flight hours while a declared observation type was being received -----------------------------------------------

export interface CoveredFlightHoursParams {
  type: string;
  versions: number[];
  condition?: IndicatorFieldCondition;
  maxSilenceMilliseconds: number;
  /**
   * When set, a flight airborne at the window start needs its latest received observation at or before that instant
   * to meet one of these sets of conditions (every condition in a set); otherwise the state at the start is not
   * established and the flight is a gap.
   */
  stateAtWindowStart?: IndicatorFieldCondition[][];
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Time between consecutive received observations no further apart than the silence allowed, and their own spans. */
function receivedIntervals(observations: readonly IndicatorObservation[], maxSilence: number): Interval[] {
  const instants = [...new Set(observations.map(spanStartMillis))].sort((left, right) => left - right);
  const between = instants.flatMap((at, index): Interval[] => {
    const next = instants[index + 1];
    return next !== undefined && next - at <= maxSilence ? [[at, next]] : [];
  });
  const spans = observations.flatMap((observation): Interval[] => {
    const start = utcMillis(observation.interval?.start),
      end = utcMillis(observation.interval?.end);
    return start !== undefined && end !== undefined && start < end ? [[start, end]] : [];
  });
  return mergeIntervals([...between, ...spans]);
}

function coveredPart(airborne: Interval, received: readonly Interval[]): number {
  return received.reduce((total, interval) => {
    const inside = clip(interval, { start: airborne[0], end: airborne[1] });
    return total + (inside ? inside[1] - inside[0] : 0);
  }, 0);
}

/** Whether the latest observation at or before the instant meets every condition of one of the sets. */
function stateEstablished(
  sets: IndicatorFieldCondition[][],
  observations: readonly IndicatorObservation[],
  at: number,
) {
  const before = observations.filter((observation) => spanStartMillis(observation) <= at);
  const latestAt = Math.max(...before.map(spanStartMillis));
  const latest = before.filter((observation) => spanStartMillis(observation) === latestAt);
  return (
    latest.length > 0 &&
    latest.every((observation) =>
      sets.some((set) => set.every((condition) => matchesCondition(observation, condition))),
    )
  );
}

export const coveredFlightHoursV1: ExposureKind<CoveredFlightHoursParams> = {
  id: 'exposure.covered-flight-hours',
  version: 1,
  title: 'Flight hours with coverage',
  description:
    'Sum over flights of the part of [takeoffAt, landingAt) inside the window during which observations of the declared type and condition were being received for the flight, in hours. Each time is the one the flight’s reports state, or, where no report states it, the one its flight records state. Two received observations of the flight no further apart than maxSilenceMilliseconds cover the time between them, and an observation with an interval covers its interval. Airborne time with no such coverage is a gap, so is a flight on record as flown with no takeoff or no landing time; reports of one flight must agree on takeoff and landing, and so must its flight records. With stateAtWindowStart, a flight airborne at the window start whose latest received observation at or before it meets none of the declared condition sets (all of them, where several share that instant) is a gap: its state at the start is not established.',
  unit: 'flight_hour',
  sourceOfTruth:
    'flight.report@1 takeoffAt and landingAt, else operator.record@1 carrying flight.record@1 takeoffAt and landingAt, and the times of the declared observations, all grouped by the flight subject',
  coverage: 'checked',
  wording: {
    unit: flightHourUnit,
    notes: {
      ...flightReportNotes,
      state_not_established_at_window_start: perFlight(
        'was airborne when the window started with no received report that establishes its state then.',
        'were airborne when the window started with no received report that establishes their state then.',
      ),
      coverage_not_received: perFlight(
        'has airborne time during which none of the declared reports were being received.',
        'have airborne time during which none of the declared reports were being received.',
      ),
    },
  },
  readMarginMilliseconds: { before: DAY, after: DAY },
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'versions', 'maxSilenceMilliseconds'],
    properties: {
      type: { type: 'string', pattern: ObservationTypeIdPattern, maxLength: 100 },
      versions: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      condition: IndicatorFieldConditionSchema,
      maxSilenceMilliseconds: { type: 'integer', minimum: 1, maximum: DAY },
      stateAtWindowStart: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'array', minItems: 1, maxItems: 10, items: IndicatorFieldConditionSchema },
      },
    },
  },
  reads: (params) => [...flightTimes, { type: params.type, versions: [...params.versions] }],
  measure(params, observations, window) {
    let milliseconds = 0;
    const counted: string[] = [];
    const gaps: ExposureNote[] = [];
    const conflicts: ExposureNote[] = [];
    const received = groupBy(
      ofTypes(observations, [{ type: params.type, versions: params.versions }]).filter(
        (observation) => !params.condition || matchesCondition(observation, params.condition),
      ),
      (observation) => subjectOfKind(observation, 'flight'),
    );
    for (const flight of flightsOnRecord(observations)) {
      if (flight.conflicts.length) {
        if (touchesWindow(flight, window)) conflicts.push(...flight.conflicts.map((code) => note(code, flight)));
        continue;
      }
      const { takeoffAt, landingAt } = flight;
      if (takeoffAt === undefined || landingAt === undefined) {
        if (takeoffAt !== undefined && takeoffAt < window.end) gaps.push(note('landing_unreported', flight));
        else if (landingAt !== undefined && landingAt > window.start) gaps.push(note('takeoff_unreported', flight));
        else if (takeoffAt === undefined && landingAt === undefined && flight.flown && reportedInWindow(flight, window))
          gaps.push(note('flight_times_unreported', flight));
        continue;
      }
      const airborne = clip([takeoffAt, landingAt], window);
      if (!airborne) continue;
      const coverage = received.get(flight.key) ?? [];
      if (
        params.stateAtWindowStart &&
        takeoffAt <= window.start &&
        !stateEstablished(params.stateAtWindowStart, coverage, window.start)
      )
        gaps.push(note('state_not_established_at_window_start', flight));
      const covered = coveredPart(airborne, receivedIntervals(coverage, params.maxSilenceMilliseconds));
      milliseconds += covered;
      if (covered > 0)
        counted.push(
          ...ids(flight.observations),
          ...ids(
            coverage.filter((observation) => {
              const at = spanStartMillis(observation);
              return (
                at >= airborne[0] - params.maxSilenceMilliseconds && at <= airborne[1] + params.maxSilenceMilliseconds
              );
            }),
          ),
        );
      if (covered < airborne[1] - airborne[0]) gaps.push(note('coverage_not_received', flight));
    }
    return { quantity: rational(BigInt(milliseconds), HOUR), counted: [...new Set(counted)].sort(), gaps, conflicts };
  },
};

// Observations of a declared type ----------------------------------------------------------------------------------

export interface ObservationCountParams {
  type: string;
  versions: number[];
  condition?: IndicatorFieldCondition;
}

export const observationCountV1: ExposureKind<ObservationCountParams> = {
  id: 'exposure.observation-count',
  version: 1,
  title: 'Recorded operations',
  description:
    'Count of accepted observations of the declared type whose span starts inside the window and that meet the optional condition, such as deliveries or operations. Each observation counts once. Observations cannot show operations that were never reported, so coverage cannot be checked.',
  unit: 'observation',
  sourceOfTruth: 'the observation type and versions the definition declares',
  coverage: 'not_determinable',
  wording: { unit: { one: 'recorded operation', other: 'recorded operations' }, notes: {} },
  readMarginMilliseconds: { before: 0, after: 0 },
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'versions'],
    properties: {
      type: { type: 'string', pattern: ObservationTypeIdPattern, maxLength: 100 },
      versions: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      condition: IndicatorFieldConditionSchema,
    },
  },
  reads: (params) => [{ type: params.type, versions: [...params.versions] }],
  measure(params, observations, window) {
    const matching = ofTypes(observations, observationCountV1.reads(params)).filter((observation) => {
      const at = spanStartMillis(observation);
      return (
        at >= window.start && at < window.end && (!params.condition || matchesCondition(observation, params.condition))
      );
    });
    return { quantity: rational(BigInt(matching.length)), counted: ids(matching), gaps: [], conflicts: [] };
  },
};

// Duty periods ------------------------------------------------------------------------------------------------------

export interface DutyPeriodParams {
  periods: ('duty' | 'flight_duty' | 'rest')[];
}
const dutyPeriods: ExposureRead[] = [{ type: 'crew.duty-period', versions: [1] }];
const dutyPeriodParams = {
  type: 'object',
  additionalProperties: false,
  required: ['periods'],
  properties: {
    periods: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { enum: ['duty', 'flight_duty', 'rest'] },
    },
  },
} as const;

function selectedPeriods(params: DutyPeriodParams, observations: readonly IndicatorObservation[]) {
  return ofTypes(observations, dutyPeriods).filter((observation) =>
    params.periods.includes(observationField(observation, 'values.period') as DutyPeriodParams['periods'][number]),
  );
}

export const dutyPeriodCountV1: ExposureKind<DutyPeriodParams> = {
  id: 'exposure.duty-period-count',
  version: 1,
  title: 'Duty periods',
  description:
    'Count of recorded duty periods of the declared kinds whose interval starts inside the window. Recorded periods cannot show periods that were never recorded, so coverage cannot be checked.',
  unit: 'duty_period',
  sourceOfTruth: 'crew.duty-period@1 interval.start and values.period',
  coverage: 'not_determinable',
  wording: { unit: { one: 'duty period', other: 'duty periods' }, notes: {} },
  readMarginMilliseconds: { before: 0, after: 0 },
  parameterSchema: dutyPeriodParams,
  reads: () => dutyPeriods,
  measure(params, observations, window) {
    const matching = selectedPeriods(params, observations).filter((observation) => {
      const at = spanStartMillis(observation);
      return at >= window.start && at < window.end;
    });
    return { quantity: rational(BigInt(matching.length)), counted: ids(matching), gaps: [], conflicts: [] };
  },
};

export const dutyHoursV1: ExposureKind<DutyPeriodParams> = {
  id: 'exposure.duty-hours',
  version: 1,
  title: 'Duty hours',
  description:
    'Hours of recorded duty periods of the declared kinds inside the window, with overlapping periods of one person counted once. A period with no recorded end is a gap: its length is unknown, and it is not read as still on duty.',
  unit: 'duty_hour',
  sourceOfTruth: 'crew.duty-period@1 interval and values.period, grouped by the person subject',
  coverage: 'checked',
  wording: {
    unit: { one: 'duty hour', other: 'duty hours' },
    notes: {
      duty_period_end_unrecorded: {
        one: 'One recorded duty period has no recorded end, so its length is unknown.',
        other: '{count} recorded duty periods have no recorded end, so their length is unknown.',
      },
    },
  },
  readMarginMilliseconds: { before: 0, after: 0 },
  parameterSchema: dutyPeriodParams,
  reads: () => dutyPeriods,
  measure(params, observations, window) {
    let milliseconds = 0;
    const counted: string[] = [];
    const gaps: ExposureNote[] = [];
    const groups = groupBy(selectedPeriods(params, observations), (observation) =>
      subjectOfKind(observation, 'person'),
    );
    for (const [subjectKey, periods] of groups) {
      const intervals: Interval[] = [];
      for (const period of periods) {
        const start = utcMillis(period.interval?.start);
        const end = utcMillis(period.interval?.end);
        if (start === undefined) continue;
        if (end === undefined) {
          if (start < window.end)
            gaps.push({ code: 'duty_period_end_unrecorded', subjectKey, observationIds: [period.id] });
          continue;
        }
        const inside = clip([start, end], window);
        if (inside) {
          intervals.push(inside);
          counted.push(period.id);
        }
      }
      milliseconds += unionDuration(intervals);
    }
    return { quantity: rational(BigInt(milliseconds), HOUR), counted: counted.sort(), gaps, conflicts: [] };
  },
};

// Time in service --------------------------------------------------------------------------------------------------

function timeInServiceRecords(observations: readonly IndicatorObservation[]) {
  return recordsOfType(observations, 'aircraft.time-in-service');
}

export const timeInServiceHoursV1: ExposureKind<Record<string, never>> = {
  id: 'exposure.time-in-service-hours',
  version: 1,
  title: 'Time in service',
  description:
    'For each subject in the population, total time in service recorded through the window end minus the total recorded through the window start, in hours, exactly as the operator wrote them. Both totals must be recorded with coverage complete at exactly the window bounds; a missing or partial total is a gap, disagreeing totals or a decreasing total a conflict.',
  unit: 'time_in_service_hour',
  sourceOfTruth:
    'operator.record@1 carrying aircraft.time-in-service@1: totalTimeHours, coveredThroughAt and coverage, by the record subject',
  coverage: 'checked',
  wording: {
    unit: { one: 'hour in service', other: 'hours in service' },
    notes: {
      time_in_service_totals_disagree: {
        one: 'Recorded time-in-service totals disagree at a window bound for one aircraft or component.',
        other: 'Recorded time-in-service totals disagree at a window bound for {count} aircraft or components.',
      },
      time_in_service_coverage_partial: {
        one: 'A time-in-service total at a window bound is recorded with partial coverage for one aircraft or component.',
        other:
          'A time-in-service total at a window bound is recorded with partial coverage for {count} aircraft or components.',
      },
      time_in_service_unrecorded_at_start: {
        one: 'No time-in-service total is recorded at the window start for one aircraft or component.',
        other: 'No time-in-service total is recorded at the window start for {count} aircraft or components.',
      },
      time_in_service_unrecorded_at_end: {
        one: 'No time-in-service total is recorded at the window end for one aircraft or component.',
        other: 'No time-in-service total is recorded at the window end for {count} aircraft or components.',
      },
      time_in_service_decreased: {
        one: 'The recorded time-in-service total decreases across the window for one aircraft or component.',
        other: 'The recorded time-in-service total decreases across the window for {count} aircraft or components.',
      },
    },
  },
  readMarginMilliseconds: { before: 0, after: 1 },
  parameterSchema: noParams,
  reads: () => operatorRecords,
  measure(_params, observations, window, population) {
    let quantity = ZERO;
    const counted: string[] = [];
    const gaps: ExposureNote[] = [];
    const conflicts: ExposureNote[] = [];
    const records = timeInServiceRecords(observations);
    for (const subject of population) {
      const subjectKey = subjectReferenceKey(subject);
      const own = records.filter((record) => record.subjects.some((item) => subjectReferenceKey(item) === subjectKey));
      const totalAt = (at: number, code: string): { total: Rational; ids: string[] } | undefined => {
        const atBound = own.filter(
          (record) => utcMillis(observationField(record, 'values.record.coveredThroughAt')) === at,
        );
        const totals = new Map<string, Rational>();
        for (const record of atBound) {
          const total = decimalOfNumber(observationField(record, 'values.record.totalTimeHours') as number);
          if (total) totals.set(`${total.numerator}/${total.denominator}`, total);
        }
        const incomplete = atBound.some((record) => observationField(record, 'values.record.coverage') !== 'complete');
        if (totals.size > 1)
          conflicts.push({ code: 'time_in_service_totals_disagree', subjectKey, observationIds: ids(atBound) });
        else if (totals.size === 0 || incomplete)
          gaps.push({
            code: totals.size ? 'time_in_service_coverage_partial' : code,
            subjectKey,
            observationIds: ids(atBound),
          });
        else return { total: [...totals.values()][0]!, ids: ids(atBound) };
        return undefined;
      };
      const opening = totalAt(window.start, 'time_in_service_unrecorded_at_start');
      const closing = totalAt(window.end, 'time_in_service_unrecorded_at_end');
      if (!opening || !closing) continue;
      const accrued = subtract(closing.total, opening.total);
      if (!accrued) {
        conflicts.push({
          code: 'time_in_service_decreased',
          subjectKey,
          observationIds: [...opening.ids, ...closing.ids].sort(),
        });
        continue;
      }
      quantity = add(quantity, accrued);
      counted.push(...opening.ids, ...closing.ids);
    }
    return { quantity, counted: [...new Set(counted)].sort(), gaps, conflicts };
  },
};

export const libraryExposureKinds: readonly ExposureKind[] = [
  flightHoursV1,
  flightsV1,
  coveredFlightHoursV1,
  observationCountV1,
  dutyPeriodCountV1,
  dutyHoursV1,
  timeInServiceHoursV1,
];
for (const kind of libraryExposureKinds) registerExposureKind(kind);
