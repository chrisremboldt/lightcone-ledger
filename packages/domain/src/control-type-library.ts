import {
  findObservationType,
  ObservationFieldPathPattern,
  observationSubjectKindValues,
  ObservationTypeIdPattern,
  type ObservationSubjectKind,
} from '@ledger/contracts';
import { registerControlType, type ControlRuleDeclaration, type ControlType } from './control-types.js';
import { observationRegistry, observationTypeChoice } from './observation-registry.js';
import { areaReachApplicability, areaReachDefinition, meters } from './area-reach-rule.js';

/**
 * A generic control type shipped with Ledger, so a hazard page has a control to propose before any pack or
 * adapter registers its own: a measure written in words, such as a procedure, a briefing or a limitation. Nothing can
 * check it automatically; a person reads it.
 */
export const describedMeasureControlType: ControlType<{ measure: string; operationKind?: string }> = {
  id: 'control.described-measure',
  version: 1,
  title: 'Described measure',
  description: 'A measure written in words, such as a procedure, a briefing, training or an operating limitation.',
  appliesTo: ['operation_kind'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['measure'],
    properties: {
      measure: {
        type: 'string',
        title: 'Measure',
        description: 'What the control requires, in words a crew can follow.',
        minLength: 1,
        maxLength: 1000,
        pattern: '\\S',
      },
      operationKind: {
        type: 'string',
        title: 'Kind of operation',
        description: 'The kind of operation it applies to, if not every operation.',
        minLength: 1,
        maxLength: 200,
        pattern: '\\S',
      },
    },
  },
  checkedAutomatically: false,
  describe: ({ measure, operationKind }) => (operationKind ? `${measure} (for ${operationKind})` : measure),
};

registerControlType(describedMeasureControlType);

// The same comparison vocabulary as the value.within-limit check kind, so an accepted limit maps onto that check.
const limitComparisons = {
  at_most: 'at most',
  at_least: 'at least',
  below: 'below',
  above: 'above',
} as const;

const limitScopes = ['organization', 'subject_kind', 'listed_subjects'] as const;

export interface OperatingLimitParameters {
  observationType: string;
  observationVersion: number;
  field: string;
  comparison: keyof typeof limitComparisons;
  limit: number;
  unit: string;
  scope: (typeof limitScopes)[number];
  subjectKind?: ObservationSubjectKind;
  subjectIds?: string;
}

/** The listed subject ids, in the order written. */
export function operatingLimitSubjectIds(parameters: Pick<OperatingLimitParameters, 'subjectIds'>): string[] {
  return (parameters.subjectIds ?? '').split(',').flatMap((id) => (id.trim() ? [id.trim()] : []));
}

function scopeProblem({ scope, subjectKind, subjectIds }: OperatingLimitParameters): string | undefined {
  if (scope === 'organization' && (subjectKind !== undefined || subjectIds !== undefined))
    return 'A limit for the whole organization names no kind of subject and no subjects';
  if (scope !== 'organization' && subjectKind === undefined)
    return 'A limit for a kind of subject or for listed subjects needs the kind of subject';
  if (scope === 'subject_kind' && subjectIds !== undefined)
    return 'A limit for a kind of subject lists no subjects; choose listed_subjects to name them';
  if (scope === 'listed_subjects' && subjectIds === undefined) return 'A limit for listed subjects needs their ids';
  return undefined;
}

function scopeWords({ scope, subjectKind, subjectIds }: OperatingLimitParameters): string {
  if (scope === 'organization') return 'across the organization';
  if (scope === 'subject_kind') return `for every ${subjectKind}`;
  return `for ${subjectKind} ${operatingLimitSubjectIds({ subjectIds }).join(', ')}`;
}

/**
 * A limit on an observed numeric value, such as a minimum reserve or a maximum reading. The observation type, field,
 * comparison and limit are parameters, so a deterministic check can follow an accepted limit with no further input.
 */
export const operatingLimitControlType: ControlType<OperatingLimitParameters> = {
  id: 'control.operating-limit',
  version: 1,
  title: 'Operating limit',
  description:
    'A limit on a value that observations report, such as a minimum reserve or a maximum reading, for the whole organization, a kind of subject or listed subjects.',
  appliesTo: ['aircraft', 'person_or_role', 'operation_kind'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['observationType', 'observationVersion', 'field', 'comparison', 'limit', 'unit', 'scope'],
    properties: {
      observationType: {
        type: 'string',
        title: 'Observation type',
        description: 'The registered observation type that reports the value, as domain.noun.',
        pattern: ObservationTypeIdPattern,
        maxLength: 100,
      },
      observationVersion: {
        type: 'integer',
        title: 'Observation type version',
        description: 'The registered version of that observation type.',
        minimum: 1,
        maximum: 1_000_000,
      },
      field: {
        type: 'string',
        title: 'Field',
        description: 'Path to the numeric value in the observation, such as values.remainingMinutes.',
        pattern: ObservationFieldPathPattern,
        maxLength: 200,
      },
      comparison: {
        enum: Object.keys(limitComparisons),
        title: 'Comparison',
        description:
          'How each reported value must stand against the limit: at_least, at_most, above or below the limit.',
      },
      limit: { type: 'number', title: 'Limit', description: 'The limit, in the unit below.' },
      unit: {
        type: 'string',
        title: 'Unit',
        description: 'The unit of the limit as people read it, such as percent or minutes. Shown only in wording.',
        minLength: 1,
        maxLength: 40,
        pattern: '\\S',
      },
      scope: {
        enum: [...limitScopes],
        title: 'Applies to',
        description:
          'organization: every subject the observations report on. subject_kind: every subject of the kind below. listed_subjects: only the subjects listed below.',
      },
      subjectKind: {
        enum: [...observationSubjectKindValues],
        title: 'Kind of subject',
        description: 'Needed for subject_kind and listed_subjects: what the observations are about.',
      },
      subjectIds: {
        type: 'string',
        title: 'Subjects',
        description: 'Needed for listed_subjects: the subject ids, separated by commas.',
        maxLength: 2000,
        pattern: '^\\s*[^,\\s][^,]*(,\\s*[^,\\s][^,]*)*$',
      },
    },
  },
  checkedAutomatically: true,
  describe: (parameters) =>
    `Keep the reported ${parameters.field} of ${parameters.observationType} version ${parameters.observationVersion} ` +
    `${limitComparisons[parameters.comparison]} ${parameters.limit} ${parameters.unit}, ${scopeWords(parameters)}.`,
  validate(parameters) {
    const { observationType, observationVersion, subjectKind } = parameters;
    const definition = findObservationType(observationRegistry(), observationType, observationVersion);
    if (!definition) return `Observation type ${observationType} version ${observationVersion} is not registered`;
    if (subjectKind !== undefined && !definition.subjectKinds.includes(subjectKind))
      return `Observation type ${observationType} version ${observationVersion} does not report on a ${subjectKind}`;
    return scopeProblem(parameters);
  },
  rules: (parameters) => operatingLimitRules(parameters),
  parameterChoices: {
    observationType: { from: 'observation_type', versionParameter: 'observationVersion' },
    field: {
      from: 'observation_numeric_field',
      typeParameter: 'observationType',
      versionParameter: 'observationVersion',
    },
  },
  wording: (parameters) => {
    const definition = findObservationType(
      observationRegistry(),
      parameters.observationType,
      parameters.observationVersion,
    );
    const choice = definition ? observationTypeChoice(definition) : undefined;
    const field = choice?.numericFields.find((entry) => entry.field === parameters.field)?.title ?? parameters.field;
    return (
      `Keep the ${field} of each ${choice?.title ?? parameters.observationType} ` +
      `${limitComparisons[parameters.comparison]} ${parameters.limit} ${parameters.unit}, ${scopeWords(parameters)}.`
    );
  },
};

/**
 * The checks an accepted limit becomes: the stated field of the latest observation of the stated type about the
 * target, against the limit. One rule per kind of subject in scope; for listed subjects, only where the latest
 * observation's own subject is listed.
 */
function operatingLimitRules(parameters: OperatingLimitParameters): ControlRuleDeclaration[] {
  const { observationType, observationVersion, field, comparison, limit, subjectKind } = parameters;
  const kinds = subjectKind
    ? [subjectKind]
    : (findObservationType(observationRegistry(), observationType, observationVersion)?.subjectKinds ?? []);
  const listed = parameters.scope === 'listed_subjects' ? operatingLimitSubjectIds(parameters) : undefined;
  return kinds.map((kind) => ({
    target: { subjectKind: kind },
    ...(listed ? { subjectIds: listed } : {}),
    reads: [
      {
        name: 'subject',
        type: observationType,
        versions: [observationVersion],
        about: 'target',
        required: true,
        select: 'latest',
        ...(listed ? { where: [{ field: 'subject.kind', oneOf: [kind] }] } : {}),
      },
    ],
    check: { kind: 'value.within-limit', version: 1, params: { field, comparison, limit } },
    ...(listed
      ? { applicability: [{ input: 'subject', field: 'subject.id', oneOf: listed, whenAbsent: 'insufficient' }] }
      : {}),
  }));
}

registerControlType(operatingLimitControlType);

export interface AvoidanceAreaParameters {
  center: { latitude: number; longitude: number };
  radiusMeters: number;
  site?: string;
  appliesWithinMeters?: number;
}

/**
 * A circle that planned routes keep clear of while the control is in effect, such as around a site. The circle is
 * closed and horizontal, its radius measured by shortest geodesic distance, at all altitudes. Route review checks
 * each planned route against every accepted one, so it is checked automatically. A declared reach limits the control
 * to flights whose planned corridor comes within it of the area's edge; without one it applies to every flight.
 */
export const avoidanceAreaControlType: ControlType<AvoidanceAreaParameters> = {
  id: 'control.avoidance-area',
  version: 1,
  title: 'Route avoidance area',
  description:
    'A circle that planned routes keep clear of while the control is in effect, at all altitudes, such as around a site.',
  appliesTo: ['area'],
  parameterSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['center', 'radiusMeters'],
    properties: {
      center: {
        type: 'object',
        title: 'Centre',
        description: 'The centre of the circle in WGS84 degrees.',
        additionalProperties: false,
        required: ['latitude', 'longitude'],
        properties: {
          latitude: { type: 'number', title: 'Latitude', minimum: -90, maximum: 90 },
          longitude: { type: 'number', title: 'Longitude', minimum: -180, maximum: 180 },
        },
      },
      radiusMeters: {
        type: 'number',
        title: 'Radius (metres)',
        description: 'How far the area extends from its centre, by shortest geodesic distance.',
        exclusiveMinimum: 0,
        maximum: 10000,
      },
      site: {
        type: 'string',
        title: 'Site',
        description: 'The site the area refers to, if any, as people name it.',
        minLength: 1,
        maxLength: 200,
        pattern: '\\S',
      },
      appliesWithinMeters: {
        type: 'number',
        title: 'Applies to flights whose planned route comes within (metres)',
        description:
          "Measured from the edge of the area. Leave empty to apply to every flight in the control's interval.",
        minimum: 0,
        maximum: areaReachDefinition.maxReachMeters,
      },
    },
  },
  checkedAutomatically: true,
  describe: ({ center, radiusMeters, site, appliesWithinMeters }) =>
    `Keep planned routes clear of the circle of ${radiusMeters} m around ${center.latitude}, ${center.longitude}` +
    `${site ? ` (${site})` : ''}, at all altitudes.` +
    (appliesWithinMeters === undefined
      ? ''
      : ` Applies to flights whose planned route comes within ${meters(appliesWithinMeters)} m of the area.`),
  area: ({ center, radiusMeters, site }) => ({
    center: { latitude: center.latitude, longitude: center.longitude },
    radiusMeters,
    ...(site ? { site } : {}),
  }),
  applicability: areaReachApplicability,
};

registerControlType(avoidanceAreaControlType);
