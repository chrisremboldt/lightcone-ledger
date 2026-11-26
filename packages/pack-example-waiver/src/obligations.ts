import {
  OPERATING_AREA_SIZE_LIMIT_METERS,
  occurrenceNotReportable,
  parsePoint,
  parsePoints,
  type OperatorRecordUnit,
  type RuleApplicabilityCondition,
  type RulePopulation,
  type RuleRead,
} from '@ledger/contracts';
import { findCheckKind, withPopulation, type CheckedRuleSpec } from '@ledger/domain';

/**
 * A check with no source framing: what it reads and asks. A waiver gives it a source by quoting the provision that
 * cites the obligation type.
 */
export type SourceNeutralCheck = Omit<CheckedRuleSpec, 'id' | 'version' | 'source'>;
type SubjectKind = SourceNeutralCheck['target']['subjectKind'];
type Condition = NonNullable<RuleRead['where']>[number];

/** How Ledger establishes an obligation. It describes coverage, never whether the obligation is met. */
export const evidenceModes = {
  computed: 'A check compares recorded values with the provision’s parameters.',
  record_complete: 'A check confirms a retained record holds the content the provision names.',
  attested: 'A named person with the authority reviews the provision against retained evidence.',
  field_check: 'The crew checks it at the aircraft; no operator record holds it.',
  unsupported: 'No operator record type or check kind covers it yet.',
} as const;
export type EvidenceMode = keyof typeof evidenceModes;

export type ParameterValue = number | string | string[];
export type ObligationParameters = Readonly<Record<string, ParameterValue>>;

export interface ParameterSpec {
  name: string;
  title: string;
  /** date: a calendar date written year-month-day, such as 2026-09-28. */
  valueType: 'number' | 'text' | 'text_list' | 'date';
  /** For text and text_list: the values allowed, when the record field is a closed list. */
  options?: readonly string[];
  /** For number: the parameter must be greater than zero. */
  positive?: boolean;
  /** For number: the parameter must be a whole number. */
  whole?: boolean;
  /**
   * For number: the quantity it measures and the unit it is kept in, so a pack description may write it with any unit
   * of that quantity, such as "122 m" for a height kept in feet. A bare number is in this unit.
   */
  unit?: { quantity: OperatorRecordUnit; in: string };
  /** How a value is written, for the template, when the title alone does not say. */
  example?: string;
  /** For text and text_list: why one value cannot be read, or undefined when it can. */
  readProblem?: (value: string) => string | undefined;
}

/** One kind of duty a waiver provision can carry, with its typed parameters and how it is evidenced. */
export interface ObligationType {
  id: string;
  title: string;
  subjectKind: SubjectKind;
  /** Who or what the obligation is checked for, in the words a pack description and pnpm pack:build use. */
  about: string;
  evidence: EvidenceMode;
  parameters: readonly ParameterSpec[];
  /**
   * The document purpose the obligation looks for, when a controlled document can stand for its record: the pack
   * declares it, so a person can tick it on a document (docs/design/on-file-checks.md).
   */
  purpose?: (parameters: ObligationParameters) => { id: string; title: string };
  /** The library check kind the obligation runs on; only for computed and record_complete obligations. */
  checkKind?: { id: string; version: number };
  /** The rule a provision's parameters make of the check kind. */
  check?: (parameters: ObligationParameters) => SourceNeutralCheck;
  /** For an obligation no check serves: who or what establishes it. */
  waitingFor?: string;
  /**
   * Who the rule is meant for, and what a person calls the record each named read takes, so a member without it is
   * reported as not on file (docs/design/rule-coverage.md).
   */
  covers?: { population: RulePopulation; onFile?: Record<string, string> };
}

const flights: RulePopulation = { of: 'in_adoption_dates' };
const organization: RulePopulation = { of: 'on_record' };

/** Who an obligation about each flight, the aircraft a flight's plan names, or a flight's pilots covers. */
const aboutFlight = 'each flight';
const aboutPlannedAircraft = 'the aircraft each flight’s plan names';
const aboutPlannedDock = 'the dock or ground station each flight’s plan names';
const aboutPilots = 'each remote pilot in command assigned to a flight';
const aboutOrganization = 'the organization, once';

const FOOT_METERS = 0.3048;
const STATUTE_MILE_METERS = 1609.344;
/** A distance in statute miles as a title or sentence states it: "1 statute mile", "3 statute miles". */
const statuteMiles = (miles: number): string => `${miles} statute mile${miles === 1 ? '' : 's'}`;

function kind(id: string, version: number) {
  const found = findCheckKind(id, version);
  if (!found) throw new Error(`Check kind ${id} version ${version} is not registered`);
  return found;
}

/** Operator records of one type about the target, narrowed (and optionally filtered) before the check sees them. */
function records(
  name: string,
  recordType: string | readonly string[],
  select: RuleRead['select'],
  where: Condition[] = [],
  about: RuleRead['about'] = 'target',
): RuleRead {
  return {
    name,
    type: 'operator.record',
    versions: [1],
    about,
    required: false,
    select,
    where: [
      { field: 'values.recordType', oneOf: typeof recordType === 'string' ? [recordType] : [...recordType] },
      { field: 'values.recordVersion', oneOf: [1] },
      ...where,
    ],
  };
}

/**
 * A read of records made for the flight's planned window (its plan, assignments, notices, preflight items): read as
 * soon as recorded, so a planned flight is checked before its window starts.
 */
const planned = (...args: Parameters<typeof records>): RuleRead => ({ ...records(...args), plans: true });

const text = (parameters: ObligationParameters, name: string) => parameters[name] as string;
const number = (parameters: ObligationParameters, name: string) => parameters[name] as number;
const texts = (parameters: ObligationParameters, name: string) => parameters[name] as string[];

/**
 * The aircraft a flight's plan names, read as empty when it names none so the rule rests on the plan. A position about
 * the aircraft re-evaluates the flights whose planned window has not ended, or ended within a week.
 */
const plannedAircraft = (read: string) => [
  {
    name: 'aircraft',
    subjectKind: 'aircraft' as const,
    fanOut: false,
    whenNone: 'empty' as const,
    from: { read, field: 'secondarySubject' },
    requeue: { windowEnd: { read, field: 'values.record.windowEndsAt' }, endedWithinDays: 7 },
  },
];

/** The positions the planned aircraft reported in the planned window: the flight's flown values. */
const flownPositions = (name: string, plan: string): RuleRead => ({
  name,
  type: 'position.fix',
  versions: [1],
  about: { related: 'aircraft' },
  required: false,
  select: {
    within: { read: plan, startField: 'values.record.windowStartsAt', endField: 'values.record.windowEndsAt' },
  },
});

const unusableFix = [{ field: 'values.fix', oneOf: ['none'] }];
const datum = (datums: string[]) => [{ field: 'position.altitude.datum', oneOf: datums }];
/** What a reported height measures. Only heights above ground level or the takeoff point meet a limit above ground. */
const heightMeasures = [
  { where: datum(['ground_level']), describes: 'flown height above ground level', compared: true },
  { where: datum(['takeoff_point']), describes: 'flown height above the takeoff point', compared: true },
  { where: datum(['wgs84_ellipsoid']), describes: 'height above the WGS84 ellipsoid', compared: false },
  { where: datum(['mean_sea_level']), describes: 'height above mean sea level', compared: false },
  { where: datum(['unknown']), describes: 'height against an unstated reference', compared: false },
];

/**
 * A height the operator recorded for the flight is read after heights above ground level the aircraft reported, and
 * before a height above the takeoff point: the operator's figure is above ground (docs/design/observed-values.md).
 */
const heightMeasuresBesideRecord = heightMeasures.map((measure) =>
  measure.where[0]!.oneOf.includes('takeoff_point') ? { ...measure, afterRecorded: true } : measure,
);

const metersText = (meters: number) => String(Math.round(meters * 100) / 100);

/** The aircraft a flight's latest plan, gathered by the named read, names as its other subject. */
const aircraftOfPlan = (read: string) => [
  {
    name: 'aircraft',
    subjectKind: 'aircraft' as const,
    fanOut: false,
    whenNone: 'insufficient' as const,
    from: { read, field: 'secondarySubject' },
  },
];

/** The dock or ground station a flight's latest plan names, by the component id it gives. */
const dockOfPlan = (read: string) => [
  {
    name: 'dock',
    subjectKind: 'component' as const,
    fanOut: false,
    whenNone: 'insufficient' as const,
    whenNoneSummary: 'No dock or ground station is named on the flight plan, so its inspection is not checked.',
    from: { read, field: 'values.record.dockId' },
  },
];

/** The operating site a flight's latest plan names. */
const siteOfPlan = [
  {
    name: 'site',
    subjectKind: 'site' as const,
    fanOut: false,
    whenNone: 'insufficient' as const,
    from: { read: 'plan', field: 'values.record.siteId' },
  },
];

/** The operating site a flight's latest plan names, read as empty when it names none so the flight record is read. */
const siteOfPlanOrNone = [{ ...siteOfPlan[0]!, whenNone: 'empty' as const }];

/** The latest flight report that states a takeoff: the reported window of the flight. */
const reportedWindow: RuleRead = {
  name: 'window',
  type: 'flight.report',
  versions: [1],
  about: 'target',
  required: false,
  select: 'latest',
  where: [{ field: 'values.takeoffAt', filled: true }],
};

/**
 * A flight reported as flown, or known only from the operator's record of it: with no report on record the rule
 * applies and reads the record (docs/design/observed-values.md, section 7).
 */
const flownOrRecorded = [
  { input: 'window', field: 'values.activity', oneOf: ['active', 'landed'], whenAbsent: 'applies' as const },
];

/**
 * The parameters that read the operator's own flight record when no source reported the value: the value in the named
 * field, at the record's takeoff or landing, which is also the window when no report states one.
 */
const fromFlightRecord = (
  field: string,
  atField: 'takeoffAt' | 'landingAt',
  recordedDescribes: string,
  reportedDescribes: string,
) => ({
  recordedField: `values.record.${field}`,
  recordedAtField: `values.record.${atField}`,
  recordedStartField: `values.record.${atField}`,
  recordedEndField: `values.record.${atField}`,
  recordedDescribes,
  reportedDescribes,
});

const procedureKinds = ['lost_link', 'emergency', 'flight_termination'] as const;
const procedureNames: Record<(typeof procedureKinds)[number], { title: string; label: string }> = {
  lost_link: { title: 'Lost link procedure', label: 'lost link procedure' },
  emergency: { title: 'Emergency procedure', label: 'emergency procedure' },
  flight_termination: { title: 'Flight termination procedure', label: 'flight termination procedure' },
};
/** The document purpose of a procedure of one kind, shared by every waiver that names that kind. */
function procedurePurpose(procedureKind: string) {
  const names = procedureNames[procedureKind as (typeof procedureKinds)[number]];
  return { id: `procedure.${procedureKind.replace(/_/g, '-')}`, ...names };
}

const remoteIdentificationMethods = [
  'standard_broadcast',
  'broadcast_module',
  'recognized_area',
  'exception',
  'none',
] as const;
/** The occurrence records that carry when the occurrence was reported to the authority. */
const reportedOccurrences = [
  'occurrence.accident',
  'occurrence.emergency-deviation',
  'occurrence.mechanical-irregularity',
  'occurrence.operation-anomaly',
  'occurrence.property-or-area',
  'occurrence.security',
] as const;
const inspectionKinds = ['scheduled', 'manufacturer_interval', 'condition', 'post_maintenance', 'other'] as const;
const preflightFields = [
  'weatherDetermination',
  'airspaceDetermination',
  'groundHazardsDetermination',
  'participantsBriefing',
  'linkEnergyLoadDetermination',
] as const;

/** The flight's time as the per-flight kinds read it: a reported takeoff, else the operator's record, else the plan. */
const flightTimeParams = {
  reportedStartField: 'values.takeoffAt',
  reportedEndField: 'values.landingAt',
  recordedStartField: 'values.record.takeoffAt',
  recordedEndField: 'values.record.landingAt',
  plannedStartField: 'values.record.windowStartsAt',
  plannedEndField: 'values.record.windowEndsAt',
};

/** The flights whose plan cites a certificate, on any date. */
const citingPlans = (certificate: string): RulePopulation => ({
  of: 'designated',
  by: {
    type: 'operator.record',
    versions: [1],
    where: [
      { field: 'values.recordType', oneOf: ['flight.plan'] },
      { field: 'values.record.operatingAuthorityReference', oneOf: [certificate] },
    ],
    field: 'subject',
  },
});

/** An area a provision lists: a circle by its centre and radius, or a corridor by its points and half-width. */
type ListedArea =
  | { id: string; center: { latitude: number; longitude: number }; radiusMeters: number }
  | { id: string; points: { latitude: number; longitude: number }[]; halfWidthMeters: number };

const circlePattern = /^(.+?):\s*circle\s+(.+?)\s+radius\s+(\d+(?:\.\d+)?)\s*(?:m)?$/i;
const corridorPattern = /^(.+?):\s*corridor\s+(.+?)\s+half-width\s+(\d+(?:\.\d+)?)\s*(?:m)?$/i;

/** An area as a provision's parameter writes it, or why it cannot be read. */
function listedArea(value: string): ListedArea | string {
  const written = value.trim();
  const circle = circlePattern.exec(written);
  const corridor = corridorPattern.exec(written);
  const size = Number((circle ?? corridor)?.[3]);
  const id = (circle ?? corridor)?.[1]?.trim();
  if (!id || !(size > 0) || size > OPERATING_AREA_SIZE_LIMIT_METERS)
    return `“${written}” is not an area written as "ID: circle LATITUDE, LONGITUDE radius METERS" or "ID: corridor LATITUDE, LONGITUDE; LATITUDE, LONGITUDE half-width METERS", with a size above 0 and at most ${OPERATING_AREA_SIZE_LIMIT_METERS} m`;
  if (circle) {
    const center = parsePoint(circle[2]!);
    return typeof center === 'string' ? `${id}: ${center}` : { id, center, radiusMeters: size };
  }
  const points = parsePoints(corridor![2]!);
  return typeof points === 'string' ? `${id}: ${points}` : { id, points, halfWidthMeters: size };
}

/** Each remote pilot in command a flight's assignments name, one result each. */
const pilotsOfFlight = [
  {
    name: 'pilot',
    subjectKind: 'person' as const,
    fanOut: true,
    whenNone: 'insufficient' as const,
    from: { read: 'assignments', field: 'values.record.personId' },
  },
];

/**
 * The reads of a check about a flight's pilot and the other flights they command: the flight's own assignments, every
 * assignment as remote pilot in command naming the pilot (about any flight), and the flight's own time.
 */
const pilotFlightReads = (): RuleRead[] => [
  planned('assignments', 'operation.role-assignment', 'all', [
    { field: 'values.record.role', oneOf: ['pilot_in_command'] },
  ]),
  planned(
    'intervals',
    'operation.role-assignment',
    'all',
    [{ field: 'values.record.role', oneOf: ['pilot_in_command'] }],
    {
      related: 'pilot',
      referencing: 'values.record.personId',
    },
  ),
  { ...reportedWindow, name: 'reported' },
  records('recorded', 'flight.record', 'latest'),
  planned('planned', 'flight.plan', 'latest'),
];

export const obligationTypes: readonly ObligationType[] = [
  {
    id: 'eligibility.listed-pilot',
    title: 'Remote pilot in command is a listed pilot',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [{ name: 'personIds', title: 'Source identifiers of the listed pilots', valueType: 'text_list' }],
    covers: { population: flights, onFile: { subject: 'remote pilot in command assignment' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: (parameters) => ({
      title: 'Remote pilot in command recorded is a listed pilot',
      target: { subjectKind: 'flight' },
      reads: [
        planned('subject', 'operation.role-assignment', 'latest', [
          { field: 'values.record.role', oneOf: ['pilot_in_command'] },
        ]),
      ],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.personId.id', expected: texts(parameters, 'personIds') },
      },
      wording: {
        pass: 'The latest person assigned as remote pilot in command for this flight is one of the pilots the provision lists. Whether that person flew is for a person to review.',
      },
    }),
  },
  {
    id: 'eligibility.listed-aircraft',
    title: 'Aircraft is a listed aircraft',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'computed',
    parameters: [
      { name: 'registrationNumbers', title: 'Registration numbers of the listed aircraft', valueType: 'text_list' },
    ],
    covers: { population: flights, onFile: { plan: 'flight plan', subject: 'aircraft identity record' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: (parameters) => ({
      title: 'Registration recorded for the planned aircraft is a listed one',
      target: { subjectKind: 'flight' },
      related: aircraftOfPlan('plan'),
      reads: [
        planned('plan', 'flight.plan', 'latest'),
        records('subject', 'aircraft.identity', 'latest', [], { related: 'aircraft' }),
      ],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.registrationNumber', expected: texts(parameters, 'registrationNumbers') },
      },
      wording: {
        pass: 'The registration number recorded for the aircraft the flight plan names is one the provision lists. Whether this aircraft is the one flown is for a person to review.',
      },
    }),
  },
  {
    id: 'equipment.anti-collision-lighting',
    title: 'Anti-collision lighting visible for a stated distance',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'field_check',
    parameters: [
      {
        name: 'visibleStatuteMiles',
        title: 'Distance the lighting is visible',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Meters', in: 'mi' },
      },
    ],
    waitingFor: 'The crew at the aircraft: no operator record holds the lighting or its visible distance.',
  },
  {
    id: 'condition.max-height',
    title: 'Height within a stated maximum, flown or else planned',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'maxFeetAboveGround',
        title: 'Maximum height above ground (feet)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Meters', in: 'ft' },
      },
    ],
    covers: { population: flights, onFile: { plan: 'flight plan' } },
    checkKind: { id: 'value.flown-or-planned', version: 1 },
    check: (parameters) => {
      const feet = number(parameters, 'maxFeetAboveGround');
      return {
        title: `Height of at most ${feet} feet above ground, flown or else planned`,
        target: { subjectKind: 'flight' },
        related: plannedAircraft('plan'),
        reads: [
          planned('plan', 'flight.plan', 'latest'),
          records('recorded', 'flight.record', 'latest'),
          flownPositions('flown', 'plan'),
        ],
        check: {
          kind: kind('value.flown-or-planned', 1),
          params: {
            plannedField: 'values.record.plannedMaxHeightAboveGroundMeters',
            plannedDescribes: 'planned maximum height above ground level',
            recordedField: 'values.record.maxHeightFlownAboveGroundMeters',
            recordedDescribes: 'maximum height flown above ground level in the operator’s flight record',
            flownField: 'position.altitude.meters',
            flownDescribes: 'height',
            measures: heightMeasuresBesideRecord,
            unusable: unusableFix,
            comparison: 'at_most',
            limit: feet * FOOT_METERS,
            limitDescribes: `at most ${feet} feet above ground level, ${metersText(feet * FOOT_METERS)} m`,
            unit: 'm',
            textUnit: 'ft',
          },
        },
        wording: {
          pass: '{reading} A height above the takeoff point is not a height above ground level where the ground rises or falls, and a height the operator recorded is its own figure; those, and the height between reports, are for a person to review.',
        },
      };
    },
  },
  {
    id: 'condition.max-distance',
    title: 'Planned distance from the control station within a stated maximum',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'maxStatuteMiles',
        title: 'Maximum distance (statute miles)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Meters', in: 'mi' },
      },
    ],
    covers: { population: flights, onFile: { plan: 'flight plan' } },
    checkKind: { id: 'value.flown-or-planned', version: 1 },
    check: (parameters) => {
      const miles = number(parameters, 'maxStatuteMiles');
      return {
        title: `Planned distance of at most ${statuteMiles(miles)} from the control station`,
        target: { subjectKind: 'flight' },
        reads: [planned('plan', 'flight.plan', 'latest')],
        check: {
          kind: kind('value.flown-or-planned', 1),
          params: {
            plannedField: 'values.record.plannedMaxDistanceFromControlStationMeters',
            plannedDescribes: 'planned maximum distance from the control station',
            flownDescribes: 'distance from the control station',
            comparison: 'at_most',
            limit: miles * STATUTE_MILE_METERS,
            limitDescribes: `at most ${statuteMiles(miles)}, ${metersText(miles * STATUTE_MILE_METERS)} m`,
            unit: 'm',
            textUnit: 'mi',
          },
        },
        wording: {
          pass: '{reading} No observation states where the control station was, so the distance flown is for a person to review.',
        },
      };
    },
  },
  {
    id: 'condition.pilot-in-operating-area',
    title: 'Remote pilot in command located in the operating area',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [],
    covers: { population: flights, onFile: { subject: 'flight plan' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: () => ({
      title: 'Pilot planned to be in the operating area',
      target: { subjectKind: 'flight' },
      reads: [planned('subject', 'flight.plan', 'latest')],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.pilotInOperatingArea', expected: ['yes'] },
      },
      wording: {
        pass: 'The flight plan records the pilot as located in the operating area. Where the pilot stood during the flight is for a person to review.',
      },
    }),
  },
  {
    id: 'condition.visual-observer-assigned',
    title: 'Visual observer assigned for the planned window',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [],
    covers: { population: flights, onFile: { window: 'flight plan' } },
    checkKind: { id: 'interval.covers-window', version: 2 },
    check: () => ({
      title: 'Visual observer assigned for the planned window',
      target: { subjectKind: 'flight' },
      reads: [planned('interval', 'operation.role-assignment', 'all'), planned('window', 'flight.plan', 'latest')],
      check: {
        kind: kind('interval.covers-window', 2),
        params: {
          select: {
            where: [
              { field: 'values.record.role', oneOf: ['visual_observer'] },
              { field: 'values.record.personId', filled: true },
            ],
          },
          openEnd: 'stated',
        },
      },
      wording: {
        pass: 'Recorded visual observer assignments cover the planned window. Whether the observer kept the aircraft in sight is for a person to review.',
      },
    }),
  },
  {
    id: 'notification.before-operations',
    title: 'Named party notified a stated time before operations',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      { name: 'party', title: 'Party to notify', valueType: 'text' },
      {
        name: 'leadHours',
        title: 'Notice given at least this many hours before',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Hours', in: 'h' },
      },
    ],
    checkKind: { id: 'record.made-before', version: 1 },
    check: (parameters) => {
      const party = text(parameters, 'party');
      const hours = number(parameters, 'leadHours');
      return {
        title: `${party} notified at least ${hours} hours before the planned start`,
        target: { subjectKind: 'flight' },
        reads: [
          planned('record', 'operation.notification', 'all', [{ field: 'values.record.recipient', oneOf: [party] }]),
          planned('window', 'flight.plan', 'latest'),
        ],
        check: {
          kind: kind('record.made-before', 1),
          params: { startField: 'values.record.windowStartsAt', leadHours: hours },
        },
        wording: {
          pass: `A notice to ${party} is recorded at {madeAt}, by {dueBy}. Whether it reached them and covered this flight is for a person to review.`,
        },
      };
    },
  },
  {
    id: 'notification.not-more-than-before-operations',
    title: 'Named party notified not more than a stated time before operations',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      { name: 'party', title: 'Party to notify', valueType: 'text' },
      {
        name: 'maxLeadHours',
        title: 'Notice given not more than this many hours before',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Hours', in: 'h' },
      },
    ],
    covers: { population: flights, onFile: { window: 'flight plan' } },
    checkKind: { id: 'record.made-before', version: 1 },
    check: (parameters) => {
      const party = text(parameters, 'party');
      const hours = number(parameters, 'maxLeadHours');
      return {
        title: `${party} notified not more than ${hours} hours before the planned start`,
        target: { subjectKind: 'flight' },
        reads: [
          planned('record', 'operation.notification', 'all', [{ field: 'values.record.recipient', oneOf: [party] }]),
          planned('window', 'flight.plan', 'latest'),
        ],
        check: {
          kind: kind('record.made-before', 1),
          params: { startField: 'values.record.windowStartsAt', leadHours: 0, maxLeadHours: hours },
        },
        wording: {
          pass: `A notice to ${party} is recorded at {madeAt}, from {notBefore} to the planned start at {startsAt}. Whether it reached them and covered this flight is for a person to review.`,
        },
      };
    },
  },
  {
    id: 'authority.flight-cites-certificate',
    title: 'Flight plan cites the certificate, for a flight within the dates it states',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      { name: 'certificateNumber', title: 'Certificate number as cited', valueType: 'text' },
      { name: 'effectiveFrom', title: 'First day the certificate states it is effective', valueType: 'date' },
      { name: 'effectiveThrough', title: 'Last day the certificate states it is effective', valueType: 'date' },
    ],
    checkKind: { id: 'time.within-dates', version: 1 },
    // Its population depends on the certificate number, so the check declares it: every flight whose plan cites the
    // certificate, on any date, so one flown outside the dates is listed.
    check: (parameters) => {
      const certificate = text(parameters, 'certificateNumber');
      return withPopulation(
        {
          title: 'Flight plan cites the certificate, for a flight within the dates it states',
          target: { subjectKind: 'flight' },
          reads: [
            planned('subject', 'flight.plan', 'latest'),
            { ...reportedWindow, name: 'reported' },
            records('recorded', 'flight.record', 'latest'),
            planned('planned', 'flight.plan', 'latest'),
          ],
          check: {
            kind: kind('time.within-dates', 1),
            params: {
              field: 'values.record.operatingAuthorityReference',
              expected: [certificate],
              from: text(parameters, 'effectiveFrom'),
              through: text(parameters, 'effectiveThrough'),
              datesDescribe: `the dates certificate ${certificate} states it is effective`,
              ...flightTimeParams,
            },
          },
          wording: {
            pass: `The latest flight plan cites ${certificate}, and the flight’s time, {flightDay}, is within the dates it states, ${text(parameters, 'effectiveFrom')} through ${text(parameters, 'effectiveThrough')}. Whether the flight was flown under it is for a person to review.`,
          },
        },
        citingPlans(certificate),
        { subject: 'flight plan' },
      );
    },
  },
  {
    id: 'condition.operating-area',
    title: 'Positions flown keep inside one of the stated areas and margin',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'areas',
        title: 'Areas, each a circle or a corridor with its id',
        valueType: 'text_list',
        example:
          '"NORTH-SUB: circle 41.8800, -87.6274 radius 3000" or "LINE-7: corridor 41.88, -87.63; 41.90, -87.60 half-width 150", in meters',
        readProblem: (value) => {
          const area = listedArea(value);
          return typeof area === 'string' ? area : undefined;
        },
      },
      {
        name: 'marginMeters',
        title: 'Margin beyond each area (meters)',
        valueType: 'number',
        unit: { quantity: 'Meters', in: 'm' },
      },
    ],
    checkKind: { id: 'position.in-area', version: 2 },
    check: (parameters) => ({
      title: 'Positions flown outside the operating areas during the planned window',
      target: { subjectKind: 'flight' },
      related: plannedAircraft('window'),
      reads: [planned('window', 'flight.plan', 'latest'), flownPositions('positions', 'window')],
      check: {
        kind: kind('position.in-area', 2),
        params: {
          expect: 'inside',
          scope: 'any',
          minPositions: 2,
          unusable: unusableFix,
          areas: texts(parameters, 'areas').map((value) => listedArea(value) as ListedArea),
          marginMeters: number(parameters, 'marginMeters'),
          windowSelect: { recordType: 'flight.plan', recordVersion: 1 },
          windowStartField: 'values.record.windowStartsAt',
          windowEndField: 'values.record.windowEndsAt',
          coverage: 'optional',
        },
      },
      wording: {
        pass: 'Read the flown positions: every usable position the planned aircraft reported in the planned window is inside one of the areas and margin. Whether it stayed there between reports is for a person to review.',
        not_applicable:
          'No position is reported for the planned aircraft in the planned window, and a plan states no path to place, so the check does not apply until positions are on record. Whether the flight kept inside the areas is for a person to review.',
      },
    }),
  },
  {
    id: 'condition.site-listed',
    title: 'Flight planned at one of the listed operating sites',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      { name: 'siteIds', title: 'Operating sites, by the ids flight plans give them', valueType: 'text_list' },
    ],
    covers: { population: flights, onFile: { subject: 'flight plan' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: (parameters) => ({
      title: 'Operating site the flight plan names is a listed one',
      target: { subjectKind: 'flight' },
      reads: [planned('subject', 'flight.plan', 'latest')],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.siteId.id', expected: texts(parameters, 'siteIds') },
      },
      wording: {
        pass: 'The operating site the latest flight plan names is one the provision lists. Whether the flight stayed at that site is for a person to review.',
      },
    }),
  },
  {
    id: 'equipment.detect-and-avoid',
    title: 'Detect-and-avoid equipment checked before each flight and recorded as serviceable',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'computed',
    parameters: [],
    covers: { population: flights, onFile: { planned: 'flight plan' } },
    checkKind: { id: 'record.before-flight', version: 1 },
    check: () => ({
      title: 'Detect-and-avoid check recorded before the flight, since the aircraft’s previous flight, as serviceable',
      target: { subjectKind: 'flight' },
      related: aircraftOfPlan('planned'),
      reads: [
        planned('planned', 'flight.plan', 'latest'),
        { ...reportedWindow, name: 'reported' },
        records('recorded', 'flight.record', 'latest'),
        records('records', 'aircraft.detect-and-avoid', 'all', [], { related: 'aircraft' }),
        records('previous', 'flight.record', 'all', [], { related: 'aircraft' }),
      ],
      check: {
        kind: kind('record.before-flight', 1),
        params: {
          recordDescribes: 'detect-and-avoid check',
          field: 'values.record.equipmentState',
          expected: ['serviceable'],
          previousEndField: 'values.record.landingAt',
          previousDescribes: 'the aircraft’s previous flight in the operator’s flight records',
          ...flightTimeParams,
        },
      },
      wording: {
        pass: '{reading} Whether the equipment worked during the flight is for a person to review.',
      },
    }),
  },
  {
    id: 'procedure.on-file',
    title: 'A procedure of a stated kind is on file',
    subjectKind: 'organization',
    about: aboutOrganization,
    evidence: 'record_complete',
    parameters: [{ name: 'procedureKind', title: 'Kind of procedure', valueType: 'text', options: procedureKinds }],
    purpose: (parameters) => {
      const { id, title } = procedurePurpose(text(parameters, 'procedureKind'));
      return { id, title };
    },
    covers: { population: organization },
    checkKind: { id: 'record.in-force', version: 1 },
    check: (parameters) => {
      const purpose = procedurePurpose(text(parameters, 'procedureKind'));
      return {
        title: 'Procedure on file',
        target: { subjectKind: 'organization' },
        // A controlled document in effect serving the procedure's purpose, or else the operator record.
        reads: [
          {
            name: 'records',
            type: 'organization.record-in-force',
            versions: [1],
            about: 'organization',
            required: false,
            select: 'all',
            plans: true,
            where: [{ field: 'values.recordKind', oneOf: ['document'] }],
          },
          records(
            'record',
            'organization.procedure',
            'latest',
            [{ field: 'values.record.procedureKind', oneOf: [text(parameters, 'procedureKind')] }],
            'organization',
          ),
        ],
        check: {
          kind: kind('record.in-force', 1),
          params: {
            recordLabel: purpose.label,
            serves: { purpose: purpose.id },
            alternative: { recordType: 'organization.procedure', recordVersion: 1 },
          },
        },
        wording: {
          pass: '{named} What it says, and whether it is the procedure the provision names, are for a person to review.',
        },
      };
    },
  },
  {
    id: 'weather.wind-at-takeoff',
    title: 'Wind at takeoff within a stated maximum, measured at the site or else in the flight record',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'maxMetersPerSecond',
        title: 'Maximum wind (meters per second)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'MetersPerSecond', in: 'm/s' },
      },
    ],
    checkKind: { id: 'window.values-within-limit', version: 1 },
    check: (parameters) => windAtTakeoff(parameters, 'maxMetersPerSecond', 'wind'),
  },
  {
    id: 'weather.visibility-at-takeoff',
    title: 'Recorded visibility before takeoff at least a stated minimum',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'minStatuteMiles',
        title: 'Minimum visibility (statute miles)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Meters', in: 'mi' },
      },
    ],
    checkKind: { id: 'value.flown-or-planned', version: 1 },
    check: (parameters) => {
      const miles = number(parameters, 'minStatuteMiles');
      return {
        title: `Recorded visibility of at least ${statuteMiles(miles)}`,
        target: { subjectKind: 'flight' },
        reads: [
          planned('plan', 'flight.preflight-assessment', 'latest'),
          records('recorded', 'flight.record', 'latest'),
        ],
        check: {
          kind: kind('value.flown-or-planned', 1),
          params: {
            planDescribes: 'the latest preflight assessment',
            plannedField: 'values.record.visibilityMeters',
            plannedDescribes: 'visibility recorded in the latest preflight assessment',
            recordedField: 'values.record.visibilityAtTakeoffMeters',
            recordedDescribes: 'visibility at takeoff in the operator’s flight record',
            flownDescribes: 'visibility',
            comparison: 'at_least',
            limit: miles * STATUTE_MILE_METERS,
            limitDescribes: `at least ${statuteMiles(miles)}, ${metersText(miles * STATUTE_MILE_METERS)} m`,
            unit: 'm',
            textUnit: 'mi',
          },
        },
        wording: {
          pass: '{reading} Visibility during the flight is for a person to review.',
        },
      };
    },
  },
  {
    id: 'weather.gust-at-takeoff',
    title: 'Gust at takeoff within a stated maximum, measured at the site or else in the flight record',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'maxGustMetersPerSecond',
        title: 'Maximum gust (meters per second)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'MetersPerSecond', in: 'm/s' },
      },
    ],
    checkKind: { id: 'window.values-within-limit', version: 1 },
    check: (parameters) => windAtTakeoff(parameters, 'maxGustMetersPerSecond', 'gust'),
  },
  {
    id: 'condition.battery-at-landing',
    title: 'Battery remaining at landing at least a stated reserve, reported or else in the flight record',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'minPercent',
        title: 'Battery reserve at landing (percent remaining)',
        valueType: 'number',
        positive: true,
        unit: { quantity: 'Percent', in: '%' },
      },
    ],
    checkKind: { id: 'window.values-within-limit', version: 1 },
    check: (parameters) => ({
      title: `Battery remaining at landing of at least ${number(parameters, 'minPercent')}%`,
      target: { subjectKind: 'flight' },
      related: [
        {
          name: 'aircraft',
          subjectKind: 'aircraft',
          fanOut: false,
          whenNone: 'empty',
          from: { read: 'window', field: 'secondarySubject' },
        },
      ],
      reads: [
        { ...reportedWindow, where: [{ field: 'values.landingAt', filled: true }] },
        {
          name: 'values',
          type: 'battery.state',
          versions: [1],
          about: { related: 'aircraft' },
          required: false,
          select: { latestAtOrBefore: { read: 'window', field: 'values.landingAt' } },
        },
        records('recorded', 'flight.record', 'latest'),
      ],
      applicability: [{ input: 'window', field: 'values.activity', oneOf: ['landed'], whenAbsent: 'applies' }],
      check: {
        kind: kind('window.values-within-limit', 1),
        params: {
          field: 'values.totalRemainingPercent',
          comparison: 'at_least',
          limit: number(parameters, 'minPercent'),
          coverage: 'required',
          windowStartField: 'values.landingAt',
          windowEndField: 'values.landingAt',
          includeValueAtStart: true,
          unit: '%',
          ...fromFlightRecord(
            'batteryAtLandingPercent',
            'landingAt',
            'battery remaining at landing in the operator’s flight record',
            'battery remaining',
          ),
        },
      },
    }),
  },
  {
    id: 'maintenance.inspection-due',
    title: 'Aircraft inspection not past its next due time or hours in service at takeoff',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'computed',
    parameters: [],
    covers: { population: flights, onFile: { plannedTime: 'flight plan' } },
    checkKind: { id: 'due.time-or-total', version: 1 },
    check: () => inspectionDueAtTakeoff(),
  },
  {
    id: 'maintenance.inspected-within-days',
    title: 'Aircraft inspected within a stated number of days before each flight',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'computed',
    parameters: [
      { name: 'days', title: 'Days from the inspection to takeoff, at most', valueType: 'number', positive: true },
      {
        name: 'inspectionKinds',
        title: 'Kinds of inspection that count',
        valueType: 'text_list',
        options: inspectionKinds,
      },
    ],
    covers: { population: flights, onFile: { planned: 'flight plan' } },
    checkKind: { id: 'record.before-flight', version: 1 },
    check: (parameters) => {
      const days = number(parameters, 'days');
      return {
        title: `Aircraft inspected within ${days} days before takeoff`,
        target: { subjectKind: 'flight' },
        related: aircraftOfPlan('planned'),
        reads: [
          planned('planned', 'flight.plan', 'latest'),
          { ...reportedWindow, name: 'reported' },
          records('recorded', 'flight.record', 'latest'),
          records(
            'records',
            'aircraft.inspection',
            'all',
            [{ field: 'values.record.inspectionKind', oneOf: texts(parameters, 'inspectionKinds') }],
            { related: 'aircraft' },
          ),
        ],
        check: {
          kind: kind('record.before-flight', 1),
          params: { recordDescribes: 'inspection', maxAgeDays: days, ...flightTimeParams },
        },
        wording: {
          pass: '{reading} What the inspection found is for a person to review.',
        },
      };
    },
  },
  {
    id: 'maintenance.dock-inspected-within-days',
    title: 'Dock or ground station inspected within a stated number of days before each flight',
    subjectKind: 'flight',
    about: aboutPlannedDock,
    evidence: 'computed',
    parameters: [
      { name: 'days', title: 'Days from the inspection to takeoff, at most', valueType: 'number', positive: true },
      {
        name: 'inspectionKinds',
        title: 'Kinds of inspection that count',
        valueType: 'text_list',
        options: inspectionKinds,
      },
    ],
    covers: { population: flights, onFile: { planned: 'flight plan' } },
    checkKind: { id: 'record.before-flight', version: 1 },
    check: (parameters) => {
      const days = number(parameters, 'days');
      return {
        title: `Dock or ground station inspected within ${days} days before takeoff`,
        target: { subjectKind: 'flight' },
        related: dockOfPlan('planned'),
        reads: [
          planned('planned', 'flight.plan', 'latest'),
          { ...reportedWindow, name: 'reported' },
          records('recorded', 'flight.record', 'latest'),
          records(
            'records',
            'component.inspection',
            'all',
            [{ field: 'values.record.inspectionKind', oneOf: texts(parameters, 'inspectionKinds') }],
            { related: 'dock' },
          ),
        ],
        check: {
          kind: kind('record.before-flight', 1),
          params: { recordDescribes: 'inspection', maxAgeDays: days, ...flightTimeParams },
        },
        wording: {
          pass: '{reading} What the inspection found is for a person to review.',
        },
      };
    },
  },
  {
    id: 'operation.aircraft-per-pilot',
    title: 'Aircraft one remote pilot in command flies at once, at most a stated number',
    subjectKind: 'flight',
    about: aboutPilots,
    evidence: 'computed',
    parameters: [
      {
        name: 'maxAircraft',
        title: 'Aircraft in flight at once under one pilot, at most',
        valueType: 'number',
        positive: true,
        whole: true,
      },
    ],
    covers: { population: flights, onFile: { assignments: 'remote pilot in command assignment' } },
    checkKind: { id: 'intervals.at-once', version: 1 },
    check: (parameters) => ({
      title: `At most ${number(parameters, 'maxAircraft')} aircraft at once under each remote pilot in command`,
      target: { subjectKind: 'flight' },
      related: pilotsOfFlight,
      reads: pilotFlightReads(),
      check: {
        kind: kind('intervals.at-once', 1),
        params: {
          intervalDescribes: 'flights as remote pilot in command',
          holderField: 'values.record.personId.id',
          max: number(parameters, 'maxAircraft'),
          ...flightTimeParams,
        },
      },
      wording: {
        pass: '{reading} Each other flight is placed by the pilot’s assignment to it; whether the aircraft were in the air at those times is for a person to review.',
      },
    }),
  },
  {
    id: 'qualification.recent-flights',
    title: 'Remote pilot in command flew a stated number of flights in a stated number of days before each flight',
    subjectKind: 'flight',
    about: aboutPilots,
    evidence: 'computed',
    parameters: [
      {
        name: 'flights',
        title: 'Flights as remote pilot in command, at least',
        valueType: 'number',
        positive: true,
        whole: true,
      },
      { name: 'days', title: 'In the days before takeoff', valueType: 'number', positive: true, whole: true },
    ],
    covers: { population: flights, onFile: { assignments: 'remote pilot in command assignment' } },
    checkKind: { id: 'intervals.counted-before', version: 1 },
    check: (parameters) => {
      const flightsAsked = number(parameters, 'flights');
      const days = number(parameters, 'days');
      return {
        title: `At least ${flightsAsked} flights as remote pilot in command in the ${days} days before each flight`,
        target: { subjectKind: 'flight' },
        related: pilotsOfFlight,
        reads: pilotFlightReads(),
        check: {
          kind: kind('intervals.counted-before', 1),
          params: {
            intervalDescribes: 'flights as remote pilot in command',
            holderField: 'values.record.personId.id',
            days,
            atLeast: flightsAsked,
            ...flightTimeParams,
          },
        },
        wording: {
          pass: '{reading} The flights are counted from the pilot’s assignments; whether each was the kind of flight the provision names is for a person to review.',
        },
      };
    },
  },
  {
    id: 'condition.no-hazardous-carriage',
    title: 'Payload carried is not hazardous material',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [],
    covers: { population: flights, onFile: { subject: 'payload declaration' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: () => ({
      title: 'Payload recorded as not hazardous material',
      target: { subjectKind: 'flight' },
      reads: [planned('subject', 'aircraft.payload', 'latest')],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.hazardousMaterial', expected: ['not_hazardous'] },
      },
      wording: {
        pass: 'The payload is recorded as not hazardous material. The classification is the operator’s; whether it is right is for a person to review.',
      },
    }),
  },
  {
    id: 'qualification.named-training-current',
    title: 'Named training completed within a stated number of calendar months',
    subjectKind: 'flight',
    about: aboutPilots,
    evidence: 'computed',
    parameters: [
      { name: 'courseTitle', title: 'Course title as recorded', valueType: 'text' },
      { name: 'months', title: 'Calendar months', valueType: 'number', positive: true },
    ],
    covers: {
      population: flights,
      onFile: { assignments: 'remote pilot in command assignment', subject: 'record of the named training' },
    },
    checkKind: { id: 'date.within-months', version: 2 },
    check: (parameters) => {
      const course = text(parameters, 'courseTitle');
      const months = number(parameters, 'months');
      return {
        title: `${course} completed within the previous ${months} calendar months by each remote pilot in command`,
        target: { subjectKind: 'flight' },
        related: [
          {
            name: 'pilot',
            subjectKind: 'person',
            fanOut: true,
            whenNone: 'insufficient',
            from: { read: 'assignments', field: 'values.record.personId' },
          },
        ],
        reads: [
          planned('assignments', 'operation.role-assignment', 'all', [
            { field: 'values.record.role', oneOf: ['pilot_in_command'] },
          ]),
          records('subject', 'person.training', 'latest', [{ field: 'values.record.courseTitle', oneOf: [course] }], {
            related: 'pilot',
          }),
        ],
        check: { kind: kind('date.within-months', 2), params: { field: 'values.record.completedOn', months } },
        wording: {
          pass: `The latest recorded ${course} course was completed within the previous ${months} calendar months. What the course covered is for a person to review.`,
        },
      };
    },
  },
  {
    id: 'equipment.remote-id-method',
    title: 'Aircraft remote identification by a stated method',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'computed',
    parameters: [
      {
        name: 'methods',
        title: 'Remote identification methods',
        valueType: 'text_list',
        options: remoteIdentificationMethods,
      },
    ],
    covers: { population: flights, onFile: { plan: 'flight plan', subject: 'aircraft identity record' } },
    checkKind: { id: 'value.one-of', version: 1 },
    check: (parameters) => ({
      title: 'Remote identification method recorded for the planned aircraft is a stated one',
      target: { subjectKind: 'flight' },
      related: aircraftOfPlan('plan'),
      reads: [
        planned('plan', 'flight.plan', 'latest'),
        records('subject', 'aircraft.identity', 'latest', [], { related: 'aircraft' }),
      ],
      check: {
        kind: kind('value.one-of', 1),
        params: { field: 'values.record.remoteIdentificationMethod', expected: texts(parameters, 'methods') },
      },
      wording: {
        pass: 'The remote identification method recorded for the aircraft the flight plan names is one the provision states. Whether it broadcast during the flight is for a person to review.',
      },
    }),
  },
  {
    id: 'record.preflight-content',
    title: 'Preflight assessment records stated content',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'record_complete',
    parameters: [
      { name: 'fields', title: 'Preflight assessment fields', valueType: 'text_list', options: preflightFields },
    ],
    covers: { population: flights, onFile: { record: 'preflight assessment' } },
    checkKind: { id: 'record.complete', version: 2 },
    check: (parameters) => ({
      title: 'Preflight assessment holds the content the provision names',
      target: { subjectKind: 'flight' },
      reads: [planned('record', 'flight.preflight-assessment', 'latest')],
      check: {
        kind: kind('record.complete', 2),
        params: { recordType: 'flight.preflight-assessment', recordVersion: 1, fields: texts(parameters, 'fields') },
      },
      wording: {
        pass: 'The latest preflight assessment holds the content the provision names. What it says is for a person to review.',
      },
    }),
  },
  {
    id: 'report.occurrence-within',
    title: 'Occurrence reported to a named party within a stated number of hours',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'computed',
    parameters: [
      {
        name: 'occurrences',
        title: 'Kinds of occurrence record to report',
        valueType: 'text_list',
        options: reportedOccurrences,
      },
      { name: 'party', title: 'Party the report goes to', valueType: 'text' },
      {
        name: 'hours',
        title: 'Reported within this many hours',
        valueType: 'number',
        positive: true,
        whole: true,
        unit: { quantity: 'Hours', in: 'h' },
      },
    ],
    covers: { population: flights },
    checkKind: { id: 'events.answered-within', version: 1 },
    check: (parameters) => {
      const party = text(parameters, 'party');
      const hours = number(parameters, 'hours');
      return {
        title: `Each occurrence reported to ${party} within ${hours} hours`,
        target: { subjectKind: 'flight' },
        reads: [records('events', texts(parameters, 'occurrences'), 'all')],
        check: {
          kind: kind('events.answered-within', 1),
          params: {
            answerField: 'values.record.reportedToAuthorityAt',
            answerLabel: `report to ${party}`,
            hours,
            notDue: occurrenceNotReportable(texts(parameters, 'occurrences')),
          },
        },
        wording: {
          pass: `Each occurrence recorded for this flight has a report to ${party} recorded within ${hours} hours. Whether the report went to ${party} and said what the provision asks is for a person to review.`,
          not_applicable: 'No occurrence of the kinds the provision names is recorded for this flight.',
        },
      };
    },
  },
  {
    id: 'record.maintenance-complete',
    title: 'Maintenance entries held complete',
    subjectKind: 'flight',
    about: aboutPlannedAircraft,
    evidence: 'record_complete',
    parameters: [],
    covers: { population: flights, onFile: { plan: 'flight plan' } },
    checkKind: { id: 'record.complete', version: 2 },
    check: () => ({
      title: 'Every maintenance entry for the planned aircraft holds the content its record requires',
      target: { subjectKind: 'flight' },
      related: aircraftOfPlan('plan'),
      reads: [
        planned('plan', 'flight.plan', 'latest'),
        records('record', 'maintenance.action', 'all', [], { related: 'aircraft' }),
      ],
      check: {
        kind: kind('record.complete', 2),
        params: { recordType: 'maintenance.action', recordVersion: 1, scope: 'each', whenAbsent: 'not_applicable' },
      },
      wording: {
        pass: 'Every maintenance entry recorded for the aircraft the flight plan names holds the content its record requires. Whether the work was done as the entry says is for a person to review.',
      },
    }),
  },
  {
    id: 'authority.certificate-at-hand',
    title: 'Certificate available at the control station',
    subjectKind: 'flight',
    about: aboutFlight,
    evidence: 'attested',
    parameters: [],
    waitingFor: 'A person: whether a copy was at the control station is not in a record.',
  },
];

/** Wind or gust at takeoff: measured at the flight's site, or else what the operator's flight record states. */
function windAtTakeoff(
  parameters: ObligationParameters,
  limitName: string,
  measure: 'wind' | 'gust',
): SourceNeutralCheck {
  const limit = number(parameters, limitName);
  const reported = measure === 'wind' ? 'values.speedMetersPerSecond' : 'values.gustSpeedMetersPerSecond';
  return {
    title: measure === 'wind' ? 'Wind at takeoff' : 'Gust at takeoff',
    target: { subjectKind: 'flight' },
    related: siteOfPlanOrNone,
    reads: [
      records('plan', 'flight.plan', 'latest'),
      reportedWindow,
      {
        name: 'values',
        type: 'weather.wind',
        versions: [1],
        about: { related: 'site' },
        required: false,
        select: { latestAtOrBefore: { read: 'window', field: 'values.takeoffAt' } },
        where: [{ field: 'values.method', oneOf: ['measured'] }],
      },
      records('recorded', 'flight.record', 'latest'),
    ],
    applicability: flownOrRecorded,
    check: {
      kind: kind('window.values-within-limit', 1),
      params: {
        field: reported,
        comparison: 'at_most',
        limit,
        coverage: 'required',
        windowStartField: 'values.takeoffAt',
        windowEndField: 'values.takeoffAt',
        includeValueAtStart: true,
        unit: 'm/s',
        stationField: 'values.stationId',
        ...fromFlightRecord(
          measure === 'wind' ? 'windAtTakeoffMetersPerSecond' : 'gustAtTakeoffMetersPerSecond',
          'takeoffAt',
          `${measure} at takeoff in the operator’s flight record`,
          `measured ${measure} at the site`,
        ),
      },
    },
    // Used only for a reported value: with the recorded one the worst value is null and the check's own summary,
    // which says the operator's record was read, stands.
    wording: {
      attention: `At takeoff the measured ${measure} was {worstValue} m/s, above the {limit} m/s maximum.{stationNote}{recordedNote}`,
    },
  };
}

/**
 * The aircraft the flight's plan names: its inspection in effect at takeoff and its time in service then, from its
 * latest complete total and the flights since, against the inspection's next due time and hours. The takeoff is the
 * reported one, else the operator's flight record's, else the planned start.
 */
function inspectionDueAtTakeoff(): SourceNeutralCheck {
  const aircraftFlights = (name: string, type: 'flight.report' | 'flight.record'): RuleRead =>
    type === 'flight.report'
      ? {
          name,
          type,
          versions: [1],
          about: { related: 'aircraft' },
          required: false,
          select: 'all',
          where: [
            { field: 'values.activity', oneOf: ['landed'] },
            { field: 'values.landingAt', filled: true },
          ],
        }
      : records(name, type, 'all', [], { related: 'aircraft' });
  return {
    title: 'Aircraft inspection not past its next due time or hours in service at takeoff',
    target: { subjectKind: 'flight' },
    related: aircraftOfPlan('plannedTime'),
    reads: [
      planned('plannedTime', 'flight.plan', 'latest'),
      { ...reportedWindow, name: 'reportedTime' },
      records('recordedTime', 'flight.record', 'latest'),
      records('due', 'aircraft.inspection', 'all', [], { related: 'aircraft' }),
      records(
        'opening',
        'aircraft.time-in-service',
        'all',
        [{ field: 'values.record.coverage', oneOf: ['complete'] }],
        {
          related: 'aircraft',
        },
      ),
      aircraftFlights('additions', 'flight.report'),
      aircraftFlights('recordedAdditions', 'flight.record'),
    ],
    check: {
      kind: kind('due.time-or-total', 1),
      params: inspectionDueParams({
        reportedTimeField: 'values.takeoffAt',
        recordedTimeField: 'values.record.takeoffAt',
        plannedTimeField: 'values.record.windowStartsAt',
      }),
    },
  };
}

/** The due kind's parameters for an aircraft inspection against its time in service. */
export function inspectionDueParams(times: Record<string, string> = {}) {
  return {
    dueDescribes: 'inspection',
    dueTimeField: 'values.record.nextDueAt',
    dueTotalField: 'values.record.nextDueTimeInServiceHours',
    openingField: 'values.record.totalTimeHours',
    openingAtField: 'values.record.coveredThroughAt',
    additionsStartField: 'values.takeoffAt',
    additionsEndField: 'values.landingAt',
    recordedStartField: 'values.record.takeoffAt',
    recordedEndField: 'values.record.landingAt',
    totalDescribes: 'in service',
    unit: 'h',
    ...times,
  };
}

/** The read of a flight's latest plan that decides whether a waiver's conditions cover the flight. */
export const AUTHORITY_READ = 'authority';

/** The parts of a rule that say who it covers, as a waiver library rule and a rule written by check kind both hold. */
interface CoverableRule {
  target: { subjectKind: string };
  reads: RuleRead[];
  applicability?: RuleApplicabilityCondition[];
  population?: RulePopulation;
}

/**
 * A rule about each flight, limited to the flights whose latest plan cites the certificate: for any other flight it
 * does not apply and says why, and a flight with no plan on file is reported as such. Every flight with records in the
 * adoption's dates is in its population, so none is passed over. A rule about anything else is returned unchanged.
 */
export function limitedToCitingFlights<Rule extends CoverableRule>(rule: Rule, certificateNumber: string): Rule {
  if (rule.target.subjectKind !== 'flight') return rule;
  if (rule.reads.some((read) => read.name === AUTHORITY_READ))
    throw new Error(`The rule already has a read named ${AUTHORITY_READ}, which the limit to citing flights adds`);
  return {
    ...rule,
    reads: [
      { ...planned(AUTHORITY_READ, 'flight.plan', 'latest'), required: true, onFile: 'flight plan' },
      ...rule.reads,
    ],
    applicability: [
      {
        input: AUTHORITY_READ,
        field: 'values.record.operatingAuthorityReference',
        oneOf: [certificateNumber],
        whenAbsent: 'insufficient',
        notMetSummary: `The latest flight plan does not cite ${certificateNumber} as its operating authority, so the waiver’s conditions do not cover this flight.`,
      },
      ...(rule.applicability ?? []),
    ],
    population: rule.population ?? flights,
  };
}

export function findObligationType(id: string): ObligationType | undefined {
  return obligationTypes.find((type) => type.id === id);
}

/** True for a calendar date written year-month-day that exists. */
function calendarDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

function parameterProblem(spec: ParameterSpec, value: ParameterValue | undefined): string | undefined {
  if (value === undefined) return 'is missing';
  if (spec.valueType === 'number')
    return typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (spec.positive && value <= 0) ||
      (spec.whole && !Number.isSafeInteger(value))
      ? `must be a ${spec.positive ? 'positive ' : ''}${spec.whole ? 'whole ' : ''}number`
      : undefined;
  if (spec.valueType === 'date')
    return typeof value === 'string' && calendarDate(value) ? undefined : 'must be a date written as 2026-09-28';
  const values: unknown[] = spec.valueType === 'text' ? [value] : Array.isArray(value) ? value : [];
  if (spec.valueType === 'text_list' && values.length === 0) return 'must be a non-empty list of text';
  if (values.some((item) => typeof item !== 'string' || item.trim() === '')) return 'must be text';
  const unknown = spec.options && (values as string[]).find((item) => !spec.options!.includes(item));
  if (unknown) return `holds ${unknown}, which is not one of ${spec.options!.join(', ')}`;
  const unreadable = spec.readProblem && (values as string[]).map(spec.readProblem).find(Boolean);
  return unreadable ? `cannot be read: ${unreadable}` : undefined;
}

/** Every problem with the parameters a provision gives an obligation type; empty when they fit. */
export function obligationParameterProblems(type: ObligationType, parameters: ObligationParameters = {}): string[] {
  const known = new Set(type.parameters.map((spec) => spec.name));
  return [
    ...Object.keys(parameters)
      .filter((name) => !known.has(name))
      .map((name) => `${type.id}: parameter ${name} is not one it takes`),
    ...type.parameters.flatMap((spec) => {
      const problem = parameterProblem(spec, parameters[spec.name]);
      return problem ? [`${type.id}: parameter ${spec.name} ${problem}`] : [];
    }),
  ];
}
