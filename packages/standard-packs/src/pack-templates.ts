import {
  entryUnitNames,
  isOperatorRecordDefinition,
  listObservationTypes,
  recordRuleRead,
  type OperatorRecordUnit,
} from '@ledger/contracts';
import { listCheckKinds, observationRegistry } from '@ledger/domain';
import { obligationTypes } from '@ledger/pack-example-waiver';

export type PackTemplateKind = 'waiver' | 'procedure';
export const packTemplateKinds: readonly PackTemplateKind[] = ['waiver', 'procedure'];

const comment = (lines: readonly string[]) => lines.map((line) => (line ? `# ${line}` : '#')).join('\n');

const header = [
  'A rule pack description. Build the pack file with:',
  '  pnpm pack:build <this folder>',
  'It writes <id>-v<version>.pack.json beside this file. Copy that file into the folder LEDGER_PACKS_DIR names and',
  'restart the API and the workers; the pack is then offered for adoption.',
  '',
  'Every quote is the exact words of the provision as source.txt has them. Line breaks and runs of spaces may differ;',
  'every other character must match. A quote that appears more than once needs occurrence: N (1 for the first).',
  '',
  'To change a pack that has been adopted, raise pack.version and build again: an adoption keeps the version it chose.',
];

const packBlock = (id: string, title: string, reference: string, kind: PackTemplateKind) => `pack:
  # Your own prefix, such as your organization's short name. Never ledger., which only built-in packs use.
  id: ${id}
  version: 1
  title: ${title}

source:
  # The file in this folder that holds the text, kept exactly as issued.
  file: source.txt
  # waiver: a waiver or exemption you hold. procedure: your own procedure. Only a waiver's provision may relieve a rule.
  kind: ${kind}
  reference: ${reference}`;

/** A quantity written with a unit, for the template. */
function unitExample(quantity: OperatorRecordUnit): string {
  return { Meters: '400 ft', MetersPerSecond: '22 kt', Hours: '24 h', Percent: '25 %', Count: '3 count' }[quantity];
}

function obligationCatalogue(): string {
  return comment([
    'Obligation types this Ledger has. A provision names one and gives its parameters. A date is written',
    'year-month-day, such as 2026-09-28. Every check about a flight reads the records as of that flight: the record',
    "in effect at its takeoff, the days before it, the flights that overlap it, never today's state.",
    ...obligationTypes.flatMap((type) => [
      '',
      `${type.id}: ${type.title}`,
      `  about ${type.about}; ${type.check ? 'checked automatically' : type.evidence === 'unsupported' ? 'not supported yet' : 'checked by a person'}`,
      ...type.parameters.flatMap((parameter) => [
        `  ${parameter.name}: ${parameter.valueType.replace('_', ' ')}, ${parameter.title}${parameter.options ? ` (one of ${parameter.options.join(', ')})` : ''}`,
        ...(parameter.example ? [`    written as ${parameter.example}`] : []),
        ...(parameter.unit
          ? [
              `    a number in ${parameter.unit.in}, or written with any unit of ${entryUnitNames(parameter.unit.quantity).join(', ')}, such as "${unitExample(parameter.unit.quantity)}"`,
            ]
          : []),
      ]),
    ]),
  ]);
}

function checkKindCatalogue(): string {
  return comment([
    'Check kinds this Ledger has, by kind and version. pnpm pack:kinds <kind> prints what each one asks, the inputs',
    'a rule names its reads after, and every parameter with whether it is required and its unit:',
    ...listCheckKinds()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version))
      .map((kind) => `  ${kind.id} version ${kind.version}: ${kind.title}`),
    '',
    'Observation types a rule can read:',
    ...listObservationTypes(observationRegistry()).map((type) => `  ${type.type} version ${type.version}`),
    '',
    'Operator record types, each with the read a rule takes for it (pnpm ledger records columns <type> gives the',
    'path of each field):',
    ...Object.values(observationRegistry().recordTypes)
      .filter(isOperatorRecordDefinition)
      .sort((a, b) => a.recordType.localeCompare(b.recordType) || a.recordVersion - b.recordVersion)
      .map((type) => {
        const read = recordRuleRead(type);
        return `  ${type.recordType} version ${type.recordVersion}: ${read.where.length ? `type ${read.type} with where values.recordType oneOf [${type.recordType}]; fields values.record.<field>` : `type ${read.type}, no where on values.recordType; fields values.<field>, its times interval.start and interval.end or occurredAt`}`;
      }),
  ]);
}

const waiverSource = `INVENTED PLACEHOLDER. Replace this whole file with the exact text of your waiver, unchanged.

Certificate of Waiver EX-0000 (placeholder)
Effective: January 1, 2026 through December 31, 2027

Special provisions

1. Listed aircraft. Operations under this waiver use only the aircraft registered as EX-AIRCRAFT-1.

2. Maximum height. The aircraft is not operated higher than 200 feet above ground level.

3. Certificate at hand. A copy of this certificate is available at the control station during operations.
`;

const waiverDescription = `${comment(header)}

${packBlock('my-organization.waiver-ex-0000', 'Waiver EX-0000 (placeholder)', 'Certificate of Waiver EX-0000', 'waiver')}

# What the certificate states about itself.
waiver:
  # The certificate number exactly as your flight plans write it under operating authority reference.
  certificateNumber: EX-0000
  # The dates the certificate states it is effective, first and last, written year-month-day. The adopt form starts
  # from them, and the Rules screen says when they end. Ledger does not decide whether the waiver is in effect.
  effective:
    from: 2026-01-01
    through: 2027-12-31
  # Which flights the conditions below cover. There is no default: write one of these two.
  #
  #   conditionsCover: flights whose plan cites the certificate
  #     For a waiver you fly under on some flights only, such as one for flights beyond visual line of sight.
  #     A flight whose latest plan cites EX-0000 under operating authority reference is checked against every
  #     condition. For any other flight each condition records "does not apply" and says the plan does not cite
  #     the certificate; it opens no finding. A flight with no plan on file is reported as "No flight plan on file".
  #     Example: an ordinary flight within visual line of sight, planned at 300 feet without citing EX-0000, gets
  #     "does not apply" under the 200-foot limit below, and its pilot and aircraft are not checked against the
  #     waiver's lists.
  #
  #   conditionsCover: every flight
  #     For a waiver whose conditions hold for every flight you make, whatever its plan cites.
  #     Example: with every flight, that same ordinary flight is checked against the 200-foot limit and needs
  #     attention.
  #
  # Either way, a condition about people covers the remote pilots in command of the flights it covers, a condition
  # about aircraft covers the aircraft those flights' plans name, and a condition about the organization, such as a
  # procedure on file, is checked once for the organization. pnpm pack:build prints what each rule covers.
  conditionsCover: flights whose plan cites the certificate

# The Rules screen lists the provisions in number order. To read them under headings instead, list sections here and
# give each provision section: with one of their ids; then every provision names one.
# sections:
#   - id: operations
#     title: Operating conditions
#   - id: people
#     title: People and training

# One entry per provision; every provision becomes a rule that quotes it. The obligation names what the provision
# asks for. When a check covers the obligation, the rule is checked automatically. When none does, the rule is
# checked by a person (waitingFor says what they confirm) or, when Ledger cannot check it yet, carried as not
# supported. A provision no obligation type fits can give coverage: manual and waitingFor instead of an obligation.
provisions:
  - number: 1
    title: Listed aircraft
    quote: Operations under this waiver use only the aircraft registered as EX-AIRCRAFT-1.
    obligation: eligibility.listed-aircraft
    parameters:
      registrationNumbers: [EX-AIRCRAFT-1]

  - number: 2
    title: Maximum height
    quote: The aircraft is not operated higher than 200 feet above ground level.
    obligation: condition.max-height
    parameters:
      maxFeetAboveGround: 200

  - number: 3
    title: Certificate at hand
    quote: A copy of this certificate is available at the control station during operations.
    obligation: authority.certificate-at-hand
    # No record shows this, so it becomes a rule a person checks. Say what that person confirms; left out, the
    # obligation type's own sentence is used.
    waitingFor: Confirm that a copy of this certificate was at the control station during the operation.

# A provision that grants relief from a rule of another pack names that rule under relieves. While your organization
# has this waiver adopted in active mode, that rule's result for a subject is recorded as relieved, with this provision,
# instead of opening a finding. pnpm pack:list ledger.part107 prints the rule ids of the Part 107 pack.
#
#  - number: 4
#    title: Relief from visual line of sight
#    quote: (the exact words of the provision)
#    obligation: authority.flight-cites-certificate
#    parameters:
#      certificateNumber: EX-0000
#      effectiveFrom: 2026-01-01
#      effectiveThrough: 2027-12-31
#    relieves:
#      - packId: ledger.part107
#        ruleIds: [ledger.part107.107.31.a]

# The relief provision lists every flight whose plan cites the certificate, on any date. A flight that cites it
# outside the dates the certificate states needs attention, with those dates and the flight's own, and is not relieved.
#
# A provision that asks for two things carries two obligations: give it two entries, each quoting the words of its
# part, with numbers that keep them apart, such as 5 and 5b. Each becomes its own rule.
#
#  - number: 5
#    title: Listed pilots
#    quote: Only pilots EX-PILOT-1 and EX-PILOT-2 may act as remote pilot in command
#    obligation: eligibility.listed-pilot
#    parameters:
#      personIds: [EX-PILOT-1, EX-PILOT-2]
#
#  - number: 5b
#    title: Listed pilots, recurrent training
#    quote: each must have completed the operator's BVLOS recurrent training within the preceding 12 calendar months
#    obligation: qualification.named-training-current
#    parameters:
#      courseTitle: BVLOS recurrent training
#      months: 12

# A provision no obligation type fits can be written as a rule by check kind instead, under rules:, as in
# pnpm pack:new --kind procedure. A rule about each flight there covers every flight unless it has this line:
#    covers: flights whose plan cites the certificate

# Records the waiver says you keep or produce on request go under records:. Each quotes the words that list it and,
# when the waiver states one, the words saying how long. Ledger lists them with what is on file and drafts a
# recordkeeping plan from them; it never computes a period from the words or removes a record. heldBy names the
# record types that hold it (pnpm ledger records types lists them), or safety:<kind> for a safety record.
#
# records:
#  - id: flight-log
#    title: Log of each flight
#    quote: (the exact words that say the log is kept)
#    keptBy: The certificate holder
#    heldBy: [flight.record]
#    retention:
#      quote: (the exact words that say for how long)

${obligationCatalogue()}
`;

const procedureSource = `INVENTED PLACEHOLDER. Replace this whole file with the exact text of your procedure, unchanged.

Flight operations manual (placeholder), revision 1

4.2 Pilot training. Each pilot completes the company recurrent course within the previous 12 calendar months.

5.1 Aircraft inspection. An aircraft is flown only while its latest recorded inspection has not passed its next due time or its next due hours in service.

6.3 Height. No flight is planned above the height limit the operations manager sets.

6.4 Wind. No flight takes off in a wind above 11 meters per second, as measured at the site or, where the site measures none, as the crew logs it.

6.5 Battery reserve. Every flight lands with at least the battery reserve the operations manager sets remaining.

6.7 Crew briefing. The pilot briefs every crew member on the site hazards before the first flight of the day.
`;

const procedureDescription = `${comment(header)}

${packBlock('my-organization.operations-manual', 'Flight operations manual, revision 1 (placeholder)', 'Flight operations manual, revision 1', 'procedure')}

# The Rules screen lists the rules in the order of their paragraphs. To read them under headings, such as the
# chapters of your manual, list sections and give each rule section: with one of their ids; then every rule names
# one. A rule may also give paragraph: the paragraph it reads as a reader cites it, such as 4.2.
# sections:
#   - id: training
#     title: 4 Training
#   - id: aircraft
#     title: 5 Aircraft

# One entry per rule. A rule says five things:
#   quote       the exact words of your procedure it serves
#   target      what it gives a result about: person, aircraft, flight, site, component or organization
#   population  who it covers, so a subject with nothing on file is reported instead of passed over:
#                 on_record          every subject of that kind your records name
#                 in_adoption_dates  the subjects with records inside the adoption's dates (use it for flights)
#   reads       the records it reads. Most records you import are read as operator.record, narrowed with where
#               on values.recordType, and a record's own fields are values.record.<field name>. A few record types
#               are stored as an observation type of their own and read without that condition (listed at the end
#               of this file). pnpm ledger records columns <type> prints the read to write for each record type and
#               the path of each of its fields.
#               onFile is what a person calls the record: a covered subject without it is reported as
#               "No <onFile> on file". plans: true also reads a record about a time still to come, such as the
#               plan of a flight next week.
#   check       a check kind this Ledger has (listed at the end of this file) and its parameters. pnpm pack:kinds
#               <kind> prints what the kind asks, the inputs a rule's reads are named after, and every parameter
#               with whether it is required and its unit.
# docs/guides/write-a-rule-pack.md explains each field of a rule, with worked rules.
rules:
  # A date in a person's record is recent enough.
  - id: pilot-training
    title: Recurrent course completed within the previous 12 calendar months
    quote: Each pilot completes the company recurrent course within the previous 12 calendar months.
    target:
      subjectKind: person
    population:
      of: on_record
    reads:
      - name: subject
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: recurrent training record
        select: latest
        where:
          - field: values.recordType
            oneOf: [person.training]
          - field: values.record.trainingKind
            oneOf: [recurrent]
    check:
      kind: date.within-months
      version: 2
      params:
        field: values.record.completedOn
        months: 12

  # Something is next due at a time, at hours in service, or both: the latest inspection, against now and the
  # aircraft's time in service, from its latest complete total (aircraft.time-in-service) and the flights since
  # (flight.report, else flight.record). An inspection that states neither is reported as incomplete. To ask the
  # same at each flight's takeoff, the waiver obligation maintenance.inspection-due shows the reads to add.
  - id: aircraft-inspection
    title: The latest inspection is not past its next due time or hours in service
    quote: An aircraft is flown only while its latest recorded inspection has not passed its next due time or its next due hours in service.
    target:
      subjectKind: aircraft
    population:
      of: on_record
    reads:
      - name: due
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: inspection record
        select: all
        where:
          - field: values.recordType
            oneOf: [aircraft.inspection]
      - name: opening
        type: operator.record
        versions: [1]
        about: target
        required: false
        select: all
        where:
          - field: values.recordType
            oneOf: [aircraft.time-in-service]
          - field: values.record.coverage
            oneOf: [complete]
      - name: additions
        type: flight.report
        versions: [1]
        about: target
        required: false
        select: all
        where:
          - field: values.activity
            oneOf: [landed]
          - field: values.landingAt
            filled: true
      - name: recordedAdditions
        type: operator.record
        versions: [1]
        about: target
        required: false
        select: all
        where:
          - field: values.recordType
            oneOf: [flight.record]
    check:
      kind: due.time-or-total
      version: 1
      params:
        dueDescribes: inspection
        dueTimeField: values.record.nextDueAt
        dueTotalField: values.record.nextDueTimeInServiceHours
        openingField: values.record.totalTimeHours
        openingAtField: values.record.coveredThroughAt
        additionsStartField: values.takeoffAt
        additionsEndField: values.landingAt
        recordedStartField: values.record.takeoffAt
        recordedEndField: values.record.landingAt
        totalDescribes: in service
        unit: h

  # A number in a record is within a limit your organization sets when it adopts the pack.
  - id: planned-height
    title: Planned height within the limit the operations manager sets
    quote: No flight is planned above the height limit the operations manager sets.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    reads:
      - name: quantity
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: flight plan
        plans: true
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.plan]
    check:
      kind: value.within-limit
      version: 2
      params:
        field: values.record.plannedMaxHeightAboveGroundMeters
        comparison: at_most
        # The unit the field is stored in, so the sentence states it. Add textUnit: ft to state it in feet as well.
        unit: m
    # Values the organization sets when it adopts the pack, passed to the check under these names. A fixed limit
    # goes under params instead (limit: 120) and needs no adoptionParameters.
    adoptionParameters:
      - name: limit
        title: Height limit above ground (metres)
        valueType: number
        minimum: 1
        maximum: 500

  # A value of each flight within a limit: what a source reported (wind measured at the flight's site), or else what
  # the operator's own flight record states (windAtTakeoffMetersPerSecond). The sentence says which was read. Limits
  # are in the stored unit, here meters per second (11 m/s is about 21 knots).
  - id: wind-at-takeoff
    title: Wind at takeoff within 11 m/s, measured at the site or else in the flight record
    quote: No flight takes off in a wind above 11 meters per second, as measured at the site or, where the site measures none, as the crew logs it.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    related:
      - name: site
        subjectKind: site
        fanOut: false
        whenNone: empty
        from:
          read: plan
          field: values.record.siteId
    reads:
      - name: plan
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: flight plan
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.plan]
      - name: window
        type: flight.report
        versions: [1]
        about: target
        required: false
        select: latest
        where:
          - field: values.takeoffAt
            filled: true
      - name: values
        type: weather.wind
        versions: [1]
        about:
          related: site
        required: false
        select:
          latestAtOrBefore:
            read: window
            field: values.takeoffAt
        where:
          - field: values.method
            oneOf: [measured]
      - name: recorded
        type: operator.record
        versions: [1]
        about: target
        required: false
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.record]
    # With no flight report on record, the rule applies and reads the flight record.
    applicability:
      - input: window
        field: values.activity
        oneOf: [active, landed]
        whenAbsent: applies
    check:
      kind: window.values-within-limit
      version: 1
      params:
        field: values.speedMetersPerSecond
        comparison: at_most
        limit: 11
        coverage: required
        windowStartField: values.takeoffAt
        windowEndField: values.takeoffAt
        includeValueAtStart: true
        unit: m/s
        recordedField: values.record.windAtTakeoffMetersPerSecond
        recordedAtField: values.record.takeoffAt
        recordedStartField: values.record.takeoffAt
        recordedEndField: values.record.takeoffAt
        recordedDescribes: wind at takeoff in the operator's flight record
        reportedDescribes: measured wind at the site

  # The battery the aircraft reported last at or before landing, or else the battery remaining at landing in the
  # operator's flight record, at least a reserve your organization sets when it adopts the pack.
  - id: battery-at-landing
    title: Battery remaining at landing at least the adopted reserve
    quote: Every flight lands with at least the battery reserve the operations manager sets remaining.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    related:
      - name: aircraft
        subjectKind: aircraft
        fanOut: false
        whenNone: empty
        from:
          read: window
          field: secondarySubject
    reads:
      # The flight's plan, so a flight with nothing on file is reported as such.
      - name: plan
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: flight plan
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.plan]
      - name: window
        type: flight.report
        versions: [1]
        about: target
        required: false
        select: latest
        where:
          - field: values.landingAt
            filled: true
      - name: values
        type: battery.state
        versions: [1]
        about:
          related: aircraft
        required: false
        select:
          latestAtOrBefore:
            read: window
            field: values.landingAt
      - name: recorded
        type: operator.record
        versions: [1]
        about: target
        required: false
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.record]
    applicability:
      - input: window
        field: values.activity
        oneOf: [landed]
        whenAbsent: applies
    check:
      kind: window.values-within-limit
      version: 1
      params:
        field: values.totalRemainingPercent
        comparison: at_least
        coverage: required
        windowStartField: values.landingAt
        windowEndField: values.landingAt
        includeValueAtStart: true
        unit: '%'
        recordedField: values.record.batteryAtLandingPercent
        recordedAtField: values.record.landingAt
        recordedStartField: values.record.landingAt
        recordedEndField: values.record.landingAt
        recordedDescribes: battery remaining at landing in the operator's flight record
        reportedDescribes: battery remaining
    adoptionParameters:
      - name: limit
        title: Battery reserve at landing (percent remaining)
        valueType: number
        minimum: 1
        maximum: 100

  # What no record can show is still a rule: a person checks it. It is listed in every adoption and never evaluated.
  - id: crew-briefing
    title: Crew briefed on site hazards
    quote: The pilot briefs every crew member on the site hazards before the first flight of the day.
    coverage: manual
    waitingFor: Confirm that the pilot briefed every crew member on the site hazards before the first flight of the day.

# A paragraph one of the waiver obligation types fits may be written as a provision instead, exactly as a waiver
# writes one: under provisions, with number, title, quote, obligation and its parameters (and section, when the
# description lists sections). Its rule id is <pack id>.provision-<number>. An obligation named under rules is
# refused. pnpm pack:new <folder> --kind waiver writes a template that lists every obligation type and its parameters.
# provisions:
#   - number: 6.4
#     title: Each dock inspected within 30 days before each flight from it
#     quote: Each dock is inspected at intervals of not more than 30 days.
#     obligation: maintenance.dock-inspected-within-days
#     parameters:
#       days: 30
#       inspectionKinds: [scheduled]

${checkKindCatalogue()}
`;

/** The files a new pack folder starts with, by name. */
export function packTemplate(kind: PackTemplateKind): Record<string, string> {
  return kind === 'waiver'
    ? { 'source.txt': waiverSource, 'pack.yaml': waiverDescription }
    : { 'source.txt': procedureSource, 'pack.yaml': procedureDescription };
}
