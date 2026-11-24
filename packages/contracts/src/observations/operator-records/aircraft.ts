import { defineOperatorRecordType, recordField } from './define.js';

const required = { required: true } as const;
const replay = { replayOnly: true } as const;
const availability = [
  ['available', 'Available'],
  ['unavailable', 'Unavailable'],
  ['unknown', 'Unknown'],
] as const;

export const aircraftIdentityV1 = defineOperatorRecordType({
  recordType: 'aircraft.identity',
  recordVersion: 1,
  title: 'Aircraft identity and registration',
  subjectKinds: ['aircraft'],
  secondarySubjectKinds: ['organization'],
  time: { meaning: 'as_of' },
  nameFields: ['aircraftMakeModel', 'registrationNumber'],
  description:
    'The aircraft’s make and model, serial number, registration and remote identification method, as the operator recorded them.',
  mayInfer: ['The operator recorded this make, model, serial number, registration and identification method.'],
  mayNotInfer: [
    'A registration number is the operator’s entry, not a check with the registry.',
    'The remote identification method is what the operator recorded, not a broadcast Ledger observed.',
  ],
  fields: [
    recordField.text('aircraftMakeModel', 'Make and model', required),
    recordField.text('serialNumber', 'Manufacturer serial number', required),
    recordField.text('registrationNumber', 'Registration number', required),
    recordField.date('registrationExpiresOn', 'Registration expires on'),
    recordField.select('remoteIdentificationMethod', 'Remote identification', [
      ['standard_broadcast', 'Built-in broadcast'],
      ['broadcast_module', 'Add-on broadcast module'],
      ['recognized_area', 'Flown only in a recognized identification area'],
      ['exception', 'Exception granted by the authority'],
      ['none', 'None'],
    ]),
    recordField.text('remoteIdentificationSerialNumber', 'Broadcast serial or module identity', replay),
  ],
});

export const aircraftTimeInServiceV1 = defineOperatorRecordType({
  recordType: 'aircraft.time-in-service',
  recordVersion: 1,
  title: 'Aircraft time in service',
  subjectKinds: ['aircraft'],
  time: { meaning: 'as_of', atField: 'coveredThroughAt' },
  description:
    'Total time in service the operator recorded for the aircraft through a cutoff, from a logbook or register. An opening balance is the starting point for time a rule adds from later flights.',
  mayInfer: [
    'The operator recorded this total time in service through coveredThroughAt, from the named source.',
    'With entryKind opening_balance, a rule may add flight time recorded after coveredThroughAt to this total.',
  ],
  mayNotInfer: [
    'With coverage partial, the total understates time in service.',
    'Flights before coveredThroughAt are already in the total; adding them again double counts.',
  ],
  fields: [
    recordField.select(
      'entryKind',
      'Kind of entry',
      [
        ['opening_balance', 'Opening balance'],
        ['running_total', 'Running total from the operator’s log'],
      ],
      required,
    ),
    recordField.number('totalTimeHours', 'Total time in service through the cutoff', 'Hours', required),
    recordField.dateTime('coveredThroughAt', 'Covers time through', required),
    recordField.text('sourceReference', 'Source logbook or register', required),
    recordField.select(
      'coverage',
      'Coverage',
      [
        ['complete', 'Complete lifetime use through the cutoff'],
        ['partial', 'Partial'],
      ],
      required,
    ),
    recordField.longText('coverageNotes', 'Basis for the stated coverage', required),
    recordField.number('flightCount', 'Flights in the total', 'Count', replay),
  ],
});

export const aircraftInspectionV1 = defineOperatorRecordType({
  recordType: 'aircraft.inspection',
  recordVersion: 1,
  title: 'Aircraft inspection',
  subjectKinds: ['aircraft'],
  secondarySubjectKinds: ['component', 'flight'],
  time: { meaning: 'interval', startField: 'inspectedAt', endField: 'nextDueAt' },
  description:
    'A scheduled or condition inspection the operator recorded for the aircraft, with its recorded result and when the next one is due under the operator’s program: at a time, at a total time in service, or both.',
  mayInfer: [
    'The operator recorded this inspection at inspectedAt with this result and next due time or hours in service.',
    'A rule may compare the aircraft’s time in service, from aircraft.time-in-service and later flights, with nextDueTimeInServiceHours.',
    'A record that names a flight as its related subject is an inspection the operator recorded as made for that flight.',
  ],
  mayNotInfer: [
    'A recorded result is the inspector’s entry, not an airworthiness finding by Ledger.',
    'nextDueAt and nextDueTimeInServiceHours are the operator’s schedule, not limits Ledger sets.',
    'An absent nextDueAt means no due time was recorded, not that none applies.',
  ],
  fields: [
    recordField.select(
      'inspectionKind',
      'Kind of inspection',
      [
        ['scheduled', 'Scheduled'],
        ['manufacturer_interval', 'Manufacturer interval'],
        ['condition', 'Condition or unscheduled'],
        ['post_maintenance', 'After maintenance'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.dateTime('inspectedAt', 'Inspected at', required),
    recordField.dateTime('nextDueAt', 'Next inspection due', {
      requiredUnless: 'nextDueTimeInServiceHours',
      help: 'When the next inspection is due as a time. Leave it empty when it is due only at hours in service; one of the two is needed.',
    }),
    recordField.number('nextDueTimeInServiceHours', 'Next inspection due at hours in service', 'Hours', {
      help: 'The aircraft’s total time in service at which the next inspection is due, such as 315.0.',
    }),
    recordField.select(
      'recordedResult',
      'Result as recorded',
      [
        ['serviceable', 'Serviceable'],
        ['unserviceable', 'Unserviceable'],
        ['serviceable_with_deferred_items', 'Serviceable with deferred items'],
      ],
      required,
    ),
    recordField.text('inspectorName', 'Inspected by', required),
    recordField.text('procedureReference', 'Procedure or checklist reference', replay),
  ],
});

export const aircraftConditionV1 = defineOperatorRecordType({
  recordType: 'aircraft.condition',
  recordVersion: 1,
  title: 'Known condition of aircraft and associated elements',
  subjectKinds: ['aircraft'],
  secondarySubjectKinds: ['flight', 'component'],
  time: { meaning: 'event', atField: 'determinedAt' },
  description:
    'Whether the operator recorded a known unsafe condition of the aircraft or its associated elements at a point in time, usually before flight.',
  mayInfer: ['At determinedAt the operator recorded this condition statement.'],
  mayNotInfer: [
    'no_unsafe_condition_known is the operator’s statement, not an inspection result.',
    'not_determined is neither safe nor unsafe.',
    'A statement covers determinedAt; it says nothing about later conditions.',
  ],
  fields: [
    recordField.dateTime('determinedAt', 'Determined at', required),
    recordField.select(
      'recordedCondition',
      'Condition as recorded',
      [
        ['no_unsafe_condition_known', 'No unsafe condition known'],
        ['unsafe_condition_known', 'Unsafe condition known'],
        ['not_determined', 'Not determined'],
      ],
      required,
    ),
    recordField.text('affectedElement', 'Affected element', {
      help: 'The part of the aircraft, control station, link or other associated element concerned.',
    }),
    recordField.longText('conditionDescription', 'Description'),
    recordField.text('determinedByName', 'Determined by', replay),
  ],
});

export const aircraftSystemAvailabilityV1 = defineOperatorRecordType({
  recordType: 'aircraft.system-availability',
  recordVersion: 1,
  title: 'Aircraft and associated elements availability',
  subjectKinds: ['aircraft'],
  time: { meaning: 'as_of', atField: 'assessedAt' },
  description:
    'The availability the operator recorded for an aircraft and the elements it depends on (dock, battery, sensors, control link) and its configuration. Outstanding maintenance and return to service are in maintenance.action and the inspection and occurrence records.',
  mayInfer: ['At assessedAt the operator recorded these availability states.'],
  mayNotInfer: [
    'unknown is neither available nor unavailable.',
    'A delayed log export is not a loss of the control link.',
    'Available elements say nothing about maintenance; read maintenance.action for returns to service.',
  ],
  fields: [
    recordField.dateTime('assessedAt', 'Assessed at', required),
    recordField.reference('installedSiteId', 'Installed at site', 'site', {
      help: 'Leave empty for a spare aircraft.',
    }),
    recordField.reference('dockId', 'Dock or spare location', 'component', required),
    recordField.select('dockStatus', 'Dock', availability, required),
    recordField.select('controlLinkStatus', 'Control link', availability, required),
    recordField.reference('batteryId', 'Installed battery', 'component', required),
    recordField.select('batteryStatus', 'Battery', availability, required),
    recordField.select('sensorStatus', 'Supporting sensors', availability, required),
    recordField.text('firmwareVersion', 'Firmware version', required),
    recordField.text('configurationReference', 'Controlled configuration reference', required),
    recordField.select('logExportStatus', 'Historical log export', [...availability, ['delayed', 'Delayed']], replay),
    recordField.text('followUpOwnerName', 'Follow-up owner', replay),
    recordField.dateTime('followUpAt', 'Next review', replay),
  ],
});

export const aircraftDetectAndAvoidV1 = defineOperatorRecordType({
  recordType: 'aircraft.detect-and-avoid',
  recordVersion: 1,
  title: 'Detect-and-avoid equipment',
  subjectKinds: ['aircraft'],
  secondarySubjectKinds: ['flight'],
  time: { meaning: 'as_of', atField: 'checkedAt' },
  description:
    'The equipment the operator recorded as installed on an aircraft to detect other traffic and avoid it, and its state when last checked. A check made before a flight may name that flight as its related subject.',
  mayInfer: [
    'At checkedAt the operator recorded this equipment on the aircraft in this state.',
    'A record that names a flight as its related subject is the check the operator recorded as made for that flight.',
  ],
  mayNotInfer: [
    'A recorded state is the operator’s; it is not a test of the equipment in flight.',
    'The equipment reference is what the operator recorded; whether it suits an operation is for a person to review.',
  ],
  fields: [
    recordField.dateTime('checkedAt', 'Checked at', required),
    recordField.text('equipmentReference', 'Equipment make, model or configuration', required),
    recordField.select(
      'equipmentState',
      'State',
      [
        ['serviceable', 'Installed and serviceable'],
        ['inoperative', 'Installed and inoperative'],
        ['not_installed', 'Not installed'],
      ],
      required,
    ),
    recordField.text('checkedByName', 'Checked by', replay),
    recordField.text('hazardDeterminedByName', 'Determined not to be a hazard by', {
      help: 'For inoperative equipment: the person the operator authorizes to perform maintenance who determined that it does not constitute a hazard to the aircraft.',
    }),
    recordField.dateTime('hazardDeterminedAt', 'Determined not to be a hazard at'),
  ],
});

export const aircraftPayloadV1 = defineOperatorRecordType({
  recordType: 'aircraft.payload',
  recordVersion: 1,
  title: 'Payload declaration',
  subjectKinds: ['aircraft', 'flight'],
  secondarySubjectKinds: ['aircraft', 'flight'],
  time: { meaning: 'as_of' },
  description: 'What the operator recorded the aircraft carries, and whether it is classed as hazardous material.',
  mayInfer: ['The operator recorded this payload and hazardous-material classification.'],
  mayNotInfer: ['The classification is the operator’s, not a shipping or dangerous-goods determination.'],
  fields: [
    recordField.select(
      'hazardousMaterial',
      'Hazardous material',
      [
        ['not_hazardous', 'Not hazardous material'],
        ['hazardous', 'Hazardous material'],
      ],
      required,
    ),
    recordField.text('payloadDescription', 'Payload', replay),
  ],
});

export const maintenanceActionV1 = defineOperatorRecordType({
  recordType: 'maintenance.action',
  recordVersion: 1,
  title: 'Maintenance action',
  subjectKinds: ['aircraft', 'component'],
  secondarySubjectKinds: ['aircraft', 'component', 'flight'],
  time: { meaning: 'event', atField: 'performedAt' },
  description:
    'One maintenance action (repair, replacement, software or firmware change, preventive work) performed on an aircraft or component, and any return to service recorded with it.',
  mayInfer: [
    'The operator recorded that this work was performed at performedAt by the named person.',
    'returnedToService true means the operator recorded a return to service by the named person on the stated basis.',
  ],
  mayNotInfer: [
    'A recorded action is not evidence that the work was done correctly.',
    'An absent returnedToService is not a return to service.',
  ],
  fields: [
    recordField.longText('actionDescription', 'Work performed', {
      ...required,
      help: 'Firmware and system software changes are maintenance actions.',
    }),
    recordField.dateTime('performedAt', 'Performed at', required),
    recordField.text('performedByName', 'Performed by', required),
    recordField.boolean('returnedToService', 'Returned to service'),
    recordField.text('returnToServiceByName', 'Returned to service by'),
    recordField.text('returnToServiceBasis', 'Basis for return to service', {
      help: 'The approver’s authority and the completed inspection or checks it relied on.',
    }),
    recordField.text('relatedOccurrenceReference', 'Irregularity or occurrence this action addresses'),
    recordField.text('workReference', 'Work order or manual reference', replay),
  ],
});

export const componentLifeLimitV1 = defineOperatorRecordType({
  recordType: 'component.life-limit',
  recordVersion: 1,
  title: 'Life-limited part',
  subjectKinds: ['component'],
  time: { meaning: 'interval', startField: 'installedAt', endField: 'removedAt' },
  description:
    'A life-limited part installed on an aircraft: its life limit and the time already on the part, as the operator recorded them. The interval is the installation; aircraft time comes from aircraft.time-in-service.',
  mayInfer: [
    'The operator recorded this life limit, the installation period and the time already on the part.',
    'A rule may compute time used as partTimeAtInstallHours plus aircraft time in service accrued after installedAt.',
  ],
  mayNotInfer: [
    'The limit is the operator’s entry of the manufacturer’s limit, not a limit Ledger sets.',
    'An absent removedAt means no removal was recorded.',
  ],
  fields: [
    recordField.text('partName', 'Part', required),
    recordField.text('partNumber', 'Part number'),
    recordField.text('serialNumber', 'Serial number'),
    recordField.reference('aircraftId', 'Installed on aircraft', 'aircraft', required),
    recordField.dateTime('installedAt', 'Installed at', required),
    recordField.dateTime('removedAt', 'Removed at'),
    recordField.number('lifeLimitHours', 'Life limit', 'Hours', required),
    recordField.number('partTimeAtInstallHours', 'Time already on the part at installation', 'Hours', {
      help: 'Leave empty for a new part.',
    }),
    recordField.text('limitSourceReference', 'Source of the limit', {
      ...replay,
      help: 'Manufacturer document or manual section the limit comes from.',
    }),
  ],
});

export const componentInspectionV1 = defineOperatorRecordType({
  recordType: 'component.inspection',
  recordVersion: 1,
  title: 'Dock, ground station or component inspection',
  subjectKinds: ['component'],
  secondarySubjectKinds: ['flight'],
  time: { meaning: 'interval', startField: 'inspectedAt', endField: 'nextDueAt' },
  description:
    'An inspection the operator recorded for a dock, a ground station, a sensor or another component it keeps apart from an aircraft, under the component’s own id, with its recorded result and when the next one is due.',
  mayInfer: [
    'The operator recorded this inspection of the component at inspectedAt with this result.',
    'A record that names a flight as its related subject is an inspection the operator recorded as made for that flight.',
  ],
  mayNotInfer: [
    'A recorded result is the inspector’s entry, not a finding by Ledger.',
    'nextDueAt is the operator’s schedule, not a limit Ledger sets; an absent nextDueAt means none was recorded.',
  ],
  fields: [
    recordField.select(
      'inspectionKind',
      'Kind of inspection',
      [
        ['scheduled', 'Scheduled'],
        ['manufacturer_interval', 'Manufacturer interval'],
        ['condition', 'Condition or unscheduled'],
        ['post_maintenance', 'After maintenance'],
        ['other', 'Other'],
      ],
      required,
    ),
    recordField.dateTime('inspectedAt', 'Inspected at', required),
    recordField.dateTime('nextDueAt', 'Next inspection due'),
    recordField.select(
      'recordedResult',
      'Result as recorded',
      [
        ['serviceable', 'Serviceable'],
        ['unserviceable', 'Unserviceable'],
        ['serviceable_with_deferred_items', 'Serviceable with deferred items'],
      ],
      required,
    ),
    recordField.text('inspectorName', 'Inspected by', required),
    recordField.text('procedureReference', 'Procedure or checklist reference', replay),
  ],
});

export const aircraftRecordTypesV1 = [
  aircraftIdentityV1,
  aircraftTimeInServiceV1,
  aircraftInspectionV1,
  aircraftConditionV1,
  aircraftSystemAvailabilityV1,
  aircraftDetectAndAvoidV1,
  aircraftPayloadV1,
  maintenanceActionV1,
  componentLifeLimitV1,
  componentInspectionV1,
] as const;
