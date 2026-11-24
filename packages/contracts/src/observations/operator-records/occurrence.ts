import type { ObservationSubjectKind } from '../envelope.js';
import { defineOperatorRecordType, recordField, type OperatorRecordField } from './define.js';

const required = { required: true } as const;
const replay = { replayOnly: true } as const;
/** A time a report or notice was made: a log often keeps only its day (docs/design/date-only-records.md). */
const madeOn = { takesDate: true } as const;
const subjects: readonly ObservationSubjectKind[] = ['flight', 'aircraft', 'site', 'organization'];
const secondary: readonly ObservationSubjectKind[] = ['flight', 'aircraft', 'component', 'site'];
const eventTime = { meaning: 'event', atField: 'occurredAt' } as const;
const occurredAt = recordField.dateTime('occurredAt', 'Occurred at', required);
const summary = recordField.longText('summary', 'What happened', required);
const recordedOnly = 'An occurrence record is not a report to the authority unless reportedToAuthorityAt says so.';
const notReportable = [
  recordField.boolean('notReportable', 'Recorded as not reportable', {
    help: 'The operator’s determination that this occurrence needs no report to the authority. A rule that counts occurrences needing a report leaves it out, and says so and who decided.',
  }),
  recordField.reference('notReportableDecidedById', 'Determined not reportable by', 'person', {
    help: 'The person who determined that the occurrence needs no report, under the organization’s own id.',
  }),
];
const notReportableIsOperators =
  'Whether the occurrence needs a report is the operator’s determination, recorded in notReportable.';
const absenceSaysNothing = 'Absence of this record is not evidence that nothing happened.';

const determined = [
  ['yes', 'Yes'],
  ['no', 'No'],
  ['not_determined', 'Not determined'],
] as const;

function occurrence(
  recordType: string,
  title: string,
  description: string,
  fields: readonly OperatorRecordField[],
  mayNotInfer: readonly string[] = [],
  about: {
    subjectKinds: readonly ObservationSubjectKind[];
    secondarySubjectKinds: readonly ObservationSubjectKind[];
  } = {
    subjectKinds: subjects,
    secondarySubjectKinds: secondary,
  },
) {
  return defineOperatorRecordType({
    recordType,
    recordVersion: 1,
    title,
    ...about,
    time: eventTime,
    description,
    mayInfer: [`The operator recorded this ${title.toLowerCase()} at occurredAt.`],
    mayNotInfer: [...mayNotInfer, absenceSaysNothing],
    fields,
  });
}

export const mechanicalIrregularityV1 = occurrence(
  'occurrence.mechanical-irregularity',
  'Mechanical irregularity',
  'A mechanical or system irregularity the operator recorded for an aircraft or flight, and the corrective action it recorded.',
  [
    occurredAt,
    recordField.longText('irregularityDescription', 'Irregularity', required),
    recordField.longText('correctiveAction', 'Corrective action', required),
    recordField.select('lossOfControlOrCommunication', 'Caused a loss of control or communication', determined, {
      help: 'Whether the failure, malfunction or defect caused a momentary or permanent loss of control of the aircraft or of communication with it.',
    }),
    recordField.dateTime('reportedToManufacturerAt', 'Reported to the manufacturer at', madeOn),
    recordField.text('manufacturerReference', 'Manufacturer report reference', replay),
    recordField.select('dataServiceFailure', 'A failure of an approved data service', determined, {
      help: 'Whether this was a failure, malfunction or defect in a data service the operator uses that is approved under part 146 (an automated data service) and that endangered or may have endangered the operation.',
    }),
    recordField.dateTime('reportedToServiceProviderAt', 'Reported to the data service provider at', madeOn),
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.text('authorityReference', 'Authority report reference', replay),
    ...notReportable,
  ],
  [
    recordedOnly,
    notReportableIsOperators,
    'A recorded corrective action is not a maintenance action; read maintenance.action for that.',
    'An irregularity record is not a report to the manufacturer unless reportedToManufacturerAt says so, nor to a data service provider unless reportedToServiceProviderAt says so.',
    'An irregularity record is the operator’s description, not an aircraft.fault observation.',
  ],
);

export const emergencyDeviationV1 = occurrence(
  'occurrence.emergency-deviation',
  'Emergency deviation',
  'A deviation from the operating rules that the operator recorded as made in response to an emergency, and any report of it to the authority.',
  [
    occurredAt,
    summary,
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.text('authorityReference', 'Authority report reference', replay),
    ...notReportable,
  ],
  [recordedOnly, notReportableIsOperators],
);

export const securityOccurrenceV1 = occurrence(
  'occurrence.security',
  'Security occurrence',
  'A security occurrence the operator recorded about the organization, such as interference with the aircraft, control station or link, or access to its facilities or networks by someone not allowed it, and any report of it to the authority. The flight, aircraft or site concerned is its secondary subject.',
  [
    occurredAt,
    summary,
    recordField.select(
      'breachKind',
      'Kind of breach',
      [
        ['loss_of_control', 'Breach that led to loss of control of the aircraft'],
        ['physical_access', 'Unauthorized access to facilities, aircraft, loading areas or goods'],
        ['network_access', 'Unauthorized access to networks, devices or data'],
        ['other', 'Other security occurrence'],
      ],
      required,
    ),
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.longText('correctiveAction', 'Corrective action', replay),
    recordField.text('authorityReference', 'Authority report reference', replay),
    ...notReportable,
  ],
  [recordedOnly, notReportableIsOperators],
  { subjectKinds: ['organization'], secondarySubjectKinds: ['flight', 'aircraft', 'site'] },
);

export const operationAnomalyV1 = occurrence(
  'occurrence.operation-anomaly',
  'Operation anomaly',
  'Something the operator recorded as going other than planned during an operation, short of an accident.',
  [
    occurredAt,
    summary,
    recordField.select(
      'recordedSeverity',
      'Severity as recorded',
      [
        ['note', 'Note'],
        ['irregularity', 'Irregularity'],
        ['stand_down', 'Led to a stand-down'],
      ],
      replay,
    ),
    recordField.text('stopConditionReference', 'Stop condition that applied', replay),
    recordField.select('interruptionKind', 'Interruption', [
      ['none', 'Neither'],
      ['landing_away', 'Unplanned or precautionary landing away from the normal landing location'],
      [
        'route_change_for_mechanical_difficulty',
        'Change or diversion of the planned route for a known or suspected mechanical difficulty',
      ],
    ]),
    recordField.dateTime('includedInSummaryAt', 'Included in a summary of interruptions provided at', madeOn),
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.text('authorityReference', 'Authority report reference', replay),
    ...notReportable,
  ],
  [
    recordedOnly,
    notReportableIsOperators,
    'Severity is the operator’s classification.',
    'An anomaly is in a summary provided to the authority only when includedInSummaryAt says so.',
  ],
);

export const propertyOrAreaEventV1 = occurrence(
  'occurrence.property-or-area',
  'Property or unauthorized-area event',
  'Damage to property, or entry into an area the operation was not meant to enter, as the operator recorded it, and any report of it to the authority.',
  [
    occurredAt,
    summary,
    recordField.select(
      'eventKind',
      'Kind of event',
      [
        ['property_damage', 'Damage to property other than the aircraft'],
        ['unauthorized_area', 'Operation into an area the operation was not allowed to enter'],
      ],
      required,
    ),
    recordField.select('meetsReportingCriteria', 'Meets the reporting criteria the operator applies', determined, {
      ...required,
      help: 'The operator’s determination, for example damage above an amount, or entry into an unauthorized area after a system malfunction or failure.',
    }),
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.text('estimatedDamage', 'Estimated damage', replay),
    recordField.longText('areaDescription', 'Area entered', replay),
    recordField.text('authorityReference', 'Authority report reference', replay),
  ],
  [recordedOnly, 'Whether the event meets the reporting criteria is the operator’s determination.'],
);

export const accidentV1 = occurrence(
  'occurrence.accident',
  'Accident',
  'An accident the operator recorded: serious injury, loss of consciousness or property damage, and any report of it to the authority.',
  [
    occurredAt,
    recordField.select(
      'accidentKind',
      'Kind of accident',
      [
        ['serious_injury', 'Serious injury'],
        ['loss_of_consciousness', 'Loss of consciousness'],
        ['property_damage', 'Property damage'],
      ],
      required,
    ),
    summary,
    recordField.dateTime('reportedToAuthorityAt', 'Reported to the authority at', madeOn),
    recordField.text('estimatedDamage', 'Estimated damage or repair cost', {
      help: 'As recorded, with its currency.',
    }),
    recordField.text('authorityReference', 'Authority report reference', replay),
    ...notReportable,
  ],
  [
    recordedOnly,
    notReportableIsOperators,
    'The accident kind is the operator’s classification; whether a report was due is for a rule.',
  ],
);

export const occurrenceRecordTypesV1 = [
  mechanicalIrregularityV1,
  emergencyDeviationV1,
  securityOccurrenceV1,
  operationAnomalyV1,
  propertyOrAreaEventV1,
  accidentV1,
] as const;

/**
 * For a check that counts occurrences needing a report (its `notDue` parameter): an occurrence the operator recorded as
 * not reportable, or as not meeting the reporting criteria it applies, is not counted. Given the occurrence record types
 * a rule reads, only the fields those types have are named.
 */
export function occurrenceNotReportable(recordTypes?: readonly string[]) {
  const conditions = [
    { field: 'values.record.notReportable', oneOf: [true], byField: 'values.record.notReportableDecidedById' },
    { field: 'values.record.meetsReportingCriteria', oneOf: ['no'] },
  ];
  const read = occurrenceRecordTypesV1.filter((type) => !recordTypes || recordTypes.includes(type.recordType));
  return {
    anyOf: conditions.filter((condition) =>
      read.some((type) => type.fields.some((field) => `values.record.${field.name}` === condition.field)),
    ),
    words: 'not reportable',
  };
}
