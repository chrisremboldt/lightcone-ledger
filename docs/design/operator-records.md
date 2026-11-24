# Operator record types, version 1

Status: accepted, with the reviewer's rulings applied (see Decisions). Schemas: `packages/contracts/src/observations/operator-records/`. Tests: `packages/contracts/tests/operator-records.test.ts`. Builds on the observation vocabulary (`observation-vocabulary.md`).

## Purpose

Regulatory checks mostly ask whether a record exists, is complete and is current: a person's training, a duty period, an aircraft's time in service, a maintenance action. The vocabulary already carries such records in `operator.record@1`; this note defines the concrete record types that the Part 108 and Part 107 checks read, that the check kinds evaluate, and that file import and generated entry forms produce. Nothing here is wired: no intake, migration, screen or check.

A record states what the operator recorded. No field says a requirement is met, and no schema holds a rule threshold (no "24 calendar months", no "400 feet"); those belong to rules.

## Shape of a record type

Each type is an `OperatorRecordDefinition`, registered with the existing `registerOperatorRecordType`. It extends the registry's `OperatorRecordTypeDefinition` (id, version, subject kinds, description, `mayInfer`, `mayNotInfer`, schema) with:

| Part | Meaning |
| --- | --- |
| `recordType`, `recordVersion` | Lowercase `domain.noun` id and integer version. No vendor, regulation or section number in ids or field names. |
| `title` | Form and template heading. |
| `subjectKinds`, `secondarySubjectKinds` | From the vocabulary's six kinds. The carrier accepts all six; the type narrows them. |
| `time` | `as_of` (a standing record; optional `atField` gives `occurredAt`), `event` (`atField` gives `occurredAt`), or `interval` (`startField` and `endField` give `interval.start` and `end`). Time fields are always UTC `date_time` fields and the anchor field is always required. The body's time fields are the source of truth: intake derives the envelope's time from them, and refuses a record whose submitted envelope time disagrees. |
| `fields` | Ordered field metadata: `name`, `label`, `kind`, `required`, `replayOnly`, optional `help`, and per kind `unit` with bounds (number), `options` (select) or `referenceKind` (reference). |
| `schema` | Generated from `fields`, so metadata and schema cannot drift. |

**Field kinds**: `text` (≤1,000 chars), `long_text` (≤10,000), `boolean`, `date` (calendar date `YYYY-MM-DD`), `date_time` (UTC, as in the vocabulary), `number` (with unit), `select` (closed options), `reference` (an `{ id, scope }` object, the same shape as a subject: `source` is the id in the operator's file, resolved later through aliases; `ledger` is a Ledger id; it points at a person, aircraft, site, component, or a `crew.duty-period` observation).

**Naming**, enforced by a test: numeric names end in their unit (the vocabulary's list, which now includes `Hours`: decimal hours as the operator records them), `Count` fields are integers; `date_time` names end in `At` and nothing else does; `date` names end in `On`; reference names end in `Id`.

**Completeness.** Every field is optional in the schema, which rejects only wrong shape: unknown fields, wrong types, blank or whitespace-only text, non-UTC times, impossible dates, out-of-range numbers, an empty body. An incomplete record is still retained, because "recorded but incomplete, missing X" is itself what the checks report. Completeness is answered by functions beside the schema:

- `missingRequiredFields(definition, body)`: names of `required` fields with no value, in field order; empty means complete. Absent, `null` and blank text are missing; `false` is an answer.
- `missingFields(definition, body, names)`: the same for a rule that reads a different set (for example training evidence reads the provider and materials; a knowledge-test currency rule reads only the completion date). It throws if asked for a replay-only field.
- `missingReplayFields(definition, body)`: replay-only fields with no value. This is thin replay, never an incomplete record.
- A field may be `requiredUnless` another: of two fields that say the same thing in different ways, one is needed (an inspection's next due time, or its next due hours in service). With neither, `missingRequiredFields` names the first, and `missingFieldLabel` names both ("Next inspection due or Next inspection due at hours in service").

`replayOnly` fields support replay and explanation only (who assessed, a work-order number, a mission name). A field cannot be both required and replay-only; `defineOperatorRecordType` refuses it.

`standardObservationRegistry` is the default registry: the vocabulary types (`observationRegistryV1`, unchanged) plus every type here. `findOperatorRecordDefinition` returns a registered type with its field metadata, so file import can build a form or a CSV/JSON template (one column per field, label as header, help as note, options as allowed values) from the registry alone.

## Record types

R = required for completeness; replay-only fields in *italics*. Units: H hours, m meters, m/s meters per second, % percent, n count.

| Id | Subjects (secondary) | Time | Fields |
| --- | --- | --- | --- |
| `person.standing` | person (organization) | as_of | fullName R, qualificationSummary R, duties R, employeeReference, *qualificationSource* |
| `person.certificate` | person (organization) | as_of | credentialKind R (adds security_threat_assessment), credentialNumber R, recordedStatus R (held, suspended, revoked, surrendered, expired), issuedOn, expiresOn, issuingBody, *copyReference* |
| `person.training` | person (organization) | as_of | trainingKind R (initial, recurrent, knowledge_test, aircraft_specific, role_specific, other), courseTitle R, completedOn R, evidenceReference R, materialsReference, providerName, providerAddress, *programName*, *instructorName* |
| `person.employment` | person (organization) | as_of | employmentStatus R, functionStartedOn R, separatedOn, separationForCause, separationDetails |
| `person.rest-assessment` | person (organization, flight) | event assessedAt | assessedAt R, dutyPeriodId R, restPeriodId R, weeklyRestPeriodId R (each a `crew.duty-period` reference), calendarDayDutyHours R, weekStartsAt R, weekDutyHours R, timeZone R, scheduleReference R, *note* |
| `person.aircraft-experience` | person (organization, aircraft) | as_of | role R, aircraftMakeModel R, supervisedHours R, supervisorReference R, recentHours R, recentPeriodStartsOn R, recentPeriodEndsOn R, qualificationReference R |
| `person.readiness-declaration` | person (flight, organization) | event declaredAt | declaredAt R, medicalStatement R, substanceStatement R, *recordedByName* |
| `operation.role-assignment` | flight, organization (organization, site, aircraft) | interval startsAt→endsAt | personId R, role R (operations_supervisor, flight_coordinator, pilot_in_command, person_manipulating_controls, visual_observer, payload_operator, training_designee, other), startsAt R, endsAt, handoverFromPersonId, handoverProcedureReference, handoverBrief, authorityNotifiedAt |
| `organization.coordinator-requirement` | organization, flight | as_of | coordinatorRequired R, basis R, basisReference |
| `operation.multiple-aircraft` | flight, organization (organization) | as_of | supervisingPersonId, simultaneousAircraftCount R, manufacturerLimitCount R, methodLimitCount R, methodReference R |
| `aircraft.identity` | aircraft (organization) | as_of | aircraftMakeModel R, serialNumber R, registrationNumber R, registrationExpiresOn, remoteIdentificationMethod, *remoteIdentificationSerialNumber* |
| `aircraft.time-in-service` | aircraft | as_of coveredThroughAt | entryKind R (opening_balance, running_total), totalTimeHours R, coveredThroughAt R, sourceReference R, coverage R (complete, partial), coverageNotes R, *flightCount* |
| `aircraft.inspection` | aircraft (component) | interval inspectedAt→nextDueAt | inspectionKind R, inspectedAt R, nextDueAt (R unless nextDueTimeInServiceHours), nextDueTimeInServiceHours, recordedResult R, inspectorName R, *procedureReference* |
| `aircraft.condition` | aircraft (flight, component) | event determinedAt | determinedAt R, recordedCondition R (no_unsafe_condition_known, unsafe_condition_known, not_determined), affectedElement, conditionDescription, *determinedByName* |
| `aircraft.system-availability` | aircraft | as_of assessedAt | assessedAt R, installedSiteId, dockId R, dockStatus R, controlLinkStatus R, batteryId R, batteryStatus R, sensorStatus R, firmwareVersion R, configurationReference R, *logExportStatus*, *followUpOwnerName*, *followUpAt* |
| `aircraft.detect-and-avoid` | aircraft | as_of checkedAt | checkedAt R, equipmentReference R, equipmentState R (serviceable, inoperative, not_installed), *checkedByName*, hazardDeterminedByName, hazardDeterminedAt |
| `aircraft.payload` | aircraft, flight (aircraft, flight) | as_of | hazardousMaterial R, *payloadDescription* |
| `maintenance.action` | aircraft, component (aircraft, component, flight) | event performedAt | actionDescription R, performedAt R, performedByName R, returnedToService, returnToServiceByName, returnToServiceBasis, relatedOccurrenceReference, *workReference* |
| `component.life-limit` | component | interval installedAt→removedAt | partName R, partNumber, serialNumber, aircraftId R, installedAt R, removedAt, lifeLimitHours R, partTimeAtInstallHours, *limitSourceReference* |
| `component.inspection` | component | interval inspectedAt→nextDueAt | inspectionKind R, inspectedAt R, nextDueAt, recordedResult R, inspectorName R, *procedureReference* |
| `flight.plan` | flight (aircraft) | interval windowStartsAt→windowEndsAt | windowStartsAt R, windowEndsAt R, operationKind R, plannedOriginDescription R, plannedDestinationDescription R, routeSummary R, siteId, dockId, visualMode, operatingAuthorityReference, pilotInOperatingArea, plannedMaxHeightAboveGroundMeters, plannedMaxGroundSpeedMetersPerSecond, plannedMaxDistanceFromControlStationMeters, structureHeightMeters, structureMaxDistanceMeters, structureBasisReference, visualObserverCoverage |
| `flight.preflight-assessment` | flight (aircraft, site) | event assessedAt | assessedAt R, weatherDetermination R, airspaceDetermination R, groundHazardsDetermination R, participantsBriefing R, linkEnergyLoadDetermination R, visibilityMeters, cloudVerticalClearanceMeters, cloudHorizontalClearanceMeters, *assessedByName*, *sourcesRetrievedAt* |
| `flight.record` | flight (aircraft) | interval takeoffAt→landingAt | takeoffAt R, landingAt R, takeoffLocation R, landingLocations R, maxHeightFlownAboveGroundMeters R, heightNotes, flightPathReference, windAtTakeoffMetersPerSecond, gustAtTakeoffMetersPerSecond, visibilityAtTakeoffMeters, batteryAtLandingPercent, *weatherSummary*, *missionName* |
| `organization.operating-area` | organization | interval startsAt→endsAt | areaId R, shape R (circle, corridor), center (latitude, longitude), radiusMeters (at most 50,000), corridorPoints (latitude, longitude pairs separated by semicolons), corridorHalfWidthMeters (at most 50,000), startsAt R, endsAt, areaApprovalReference, alternateLandingAreas, takeoffLandingAreas, boundaryDescription, ceilingAboveGroundMeters, verifiedByName, *boundaryArtifactReference* |
| `site.status` | site | as_of recordedAt | recordedAt R, status R (available, held, deferred), condition, resumeEvidence, *responsibleName*, *followUpAt* |
| `operation.notification` | flight, organization | event notifiedAt | notifiedAt R, recipient R, means R (email, telephone, in_person, online_form, other), coveredOperations, *confirmationReference* |
| `organization.procedure` | organization | as_of effectiveAt | procedureKind R (lost_link, emergency, flight_termination, cybersecurity, training_program, physical_security, battery_monitoring, other), title R, documentReference R, revision R, effectiveAt R |
| `organization.report` | organization | event providedAt | reportKind R (flight_hours, reliability_data, aircraft_list, other), recipient R, providedAt R, periodStartsOn, periodEndsOn, *reportReference* |
| `organization.review` | organization | event reviewedAt | reviewKind R (cybersecurity_policy, training_program, other), documentReference R, reviewedAt R, reviewedByName R, recordedOutcome R (no_change, revised), revisionAfterReview, *note* |
| `occurrence.mechanical-irregularity` | flight, aircraft, site, organization (flight, aircraft, component, site) | event occurredAt | occurredAt R, irregularityDescription R, correctiveAction R, lossOfControlOrCommunication (yes, no, not_determined), reportedToManufacturerAt, *manufacturerReference*, dataServiceFailure (yes, no, not_determined), reportedToServiceProviderAt |
| `occurrence.emergency-deviation` | as above | event occurredAt | occurredAt R, summary R, reportedToAuthorityAt, *authorityReference* |
| `occurrence.security` | organization (flight, aircraft, site) | event occurredAt | occurredAt R, summary R, breachKind R (loss_of_control, physical_access, network_access, other), reportedToAuthorityAt, *correctiveAction*, *authorityReference* |
| `occurrence.operation-anomaly` | flight, aircraft, site, organization (flight, aircraft, component, site) | event occurredAt | occurredAt R, summary R, *recordedSeverity*, *stopConditionReference*, interruptionKind (none, landing_away, route_change_for_mechanical_difficulty), includedInSummaryAt |
| `occurrence.property-or-area` | flight, aircraft, site, organization (flight, aircraft, component, site) | event occurredAt | occurredAt R, summary R, eventKind R (property_damage, unauthorized_area), meetsReportingCriteria R (yes, no, not_determined), reportedToAuthorityAt, *estimatedDamage*, *areaDescription*, *authorityReference* |
| `occurrence.accident` | flight, aircraft, site, organization (flight, aircraft, component, site) | event occurredAt | occurredAt R, accidentKind R, summary R, reportedToAuthorityAt, estimatedDamage, *authorityReference* |

**Merges and splits, and why.**

- *Personnel standing* and *certificate* stay apart: the standing file is the operator's wording about a person; a certificate is a numbered credential with dates and status that current-rule checks read on their own.
- *Training* merges the earlier training record, its evidence record and the knowledge-test currency fact: they describe one completed course or test. Job start moved to `person.employment`, and the person's name lives in `person.standing`. Rules that need only the date ask `missingFields` for it.
- *Role assignment* merges the per-flight crew assignment (pilot in command, observer, manipulator), the flight's operating assignment (supervisor and coordinator in one record) and the organization's named operations supervisor. One record names one person in one role, so a flight with a supervisor and a coordinator has two records, and a handover is a new record with `handoverFromPersonId`.
- *Aircraft identity* merges identity, registration and the remote identification method: all standing facts of one airframe.
- *Flight record* merges the per-flight record and the flight path and landing record: both describe one flown flight and the source treats them as one record. It is the operator's own logbook entry, so it carries the flight's takeoff and landing times: an operator with no connected aircraft has no other way to record them. The path itself, when available, is `position.fix` observations; the record holds a reference.
- *Flight plan* absorbs the current rule's planned limits (height, distance, speed, structure allowance, visual mode and observer coverage): all are planned values for one flight. Observed visibility and cloud clearance go to the *preflight assessment*.
- *Aircraft condition* stays separate from the preflight assessment: it is an aircraft-subject statement that can be made at any time, and the "known unsafe" check reads it alone.
- *Occurrences* are six types, not one with a kind: their required fields differ, and a single type cannot express per-kind completeness.
- *Life-limit* is per component with its installation as the interval, so a part moved between aircraft keeps one history. Aircraft time at installation is not repeated here: a rule reads it from `aircraft.time-in-service` and flight time up to `installedAt`.

**One fact, one type.** No two types carry the same fact (ruling 9):

- Duty and rest periods are `crew.duty-period` observations. `person.rest-assessment` keeps only what that type does not carry (the operator's totals, week, calendar and schedule reference) and references the duty, rest and weekly rest periods it concerns.
- Flight times are the operator's statement in `flight.record` and a source's statement in `flight.report`. These are two statements of one fact by two parties, not one fact in two types: rules read the source's report first and the operator's record otherwise, and name both where they differ (`observed-values.md`, section 6). The aircraft's registration is `aircraft.identity`; the kind of operation is `flight.plan`; the people on a flight are `operation.role-assignment`. `flight.record` keeps the as-flown times, places, heights and path. Planned origin and destination are named as planned in `flight.plan`; the flown height and the site ceiling have distinct names.
- Return to service and outstanding maintenance are `maintenance.action` (with inspections and irregularities), not a state on `aircraft.system-availability`. Aircraft total time is only `aircraft.time-in-service`.
- The start of a person's function is only `person.employment`; the airspace authorization is only the `airspace.authorization` observation; a person's name is only `person.standing`.
- A reference field and a secondary subject never name the same thing: where the body holds the reference (site on a plan, aircraft on a life-limited part, dock and battery on availability), the type does not list that secondary kind; a component worked on is the subject or secondary subject of `maintenance.action`.

## Fact-key mapping

The earlier Part 108 checks read 33 keys (31 directly plus two through the duty-period selection); the Part 107 checks read 19, four of them shared. With one input of a derived key, 49 rows. "Derived" means a rule computes it from records and observations; it is not a record.

| Earlier key | Now | Notes |
| --- | --- | --- |
| `people.personnel_standing_record` | `person.standing` | identityName→fullName, qualification→qualificationSummary; assignedAt dropped as the same fact as `person.employment.functionStartedOn` |
| `people.nprm_training_record` | `person.training` | completedAt→completedOn; trainingOrganization→providerName; programName replay |
| `people.nprm_training_evidence` | `person.training` | Merged. completionCertificateReference→evidenceReference; providerNameAndAddress split; personName→`person.standing`; jobStartedAt→`person.employment.functionStartedOn` |
| `people.nprm_employment_record` | `person.employment` | releaseForCause→separationForCause + separationDetails |
| `people.duty_rest_assessment` | `person.rest-assessment` + observation `crew.duty-period` | Duty, rest and weekly rest intervals become `crew.duty-period` observations (period duty or rest) that the assessment references; calendarDayHours→calendarDayDutyHours; sourceReference→scheduleReference |
| `people.duty_rest_period_assessment` | `person.rest-assessment` | Merged; dutyPeriodFactId→dutyPeriodId reference. Its digest pins are dropped: pinning a basis is the evaluator's job |
| `people.duty_period` | observation `crew.duty-period` | Observation, not a record |
| `people.duty_coverage` | derived | Dropped: from `crew.duty-period` |
| `people.coordinator_qualification` | `person.aircraft-experience` | role flight_coordinator; makeModel→aircraftMakeModel; initialSupervisedHours→supervisedHours; period→recentPeriodStartsOn/EndsOn |
| `flight.operating_assignment` | `operation.role-assignment` | Split: one record per role. handoffProcedure→handoverProcedureReference |
| `organization.operations_supervisor` | `operation.role-assignment` | Merged: subject organization, role operations_supervisor; name→`person.standing.fullName`; assignedAt→startsAt; note dropped |
| `organization.flight_coordinator_requirement` | `organization.coordinator-requirement` | required→coordinatorRequired; namedPerson→role assignment; basis values renamed |
| `aircraft.identity` | `aircraft.identity` | makeModel→aircraftMakeModel |
| `aircraft.time_in_service` | derived | Dropped: opening balance plus later flight time from `flight.report` |
| `aircraft.time_opening_balance` | `aircraft.time-in-service` | entryKind opening_balance; cutoffAt→coveredThroughAt; coverage gains partial |
| `aircraft.life_limited_part_status` | derived | Dropped: from `component.life-limit` and time in service |
| `aircraft.life_limited_part` (input) | `component.life-limit` | limitHours→lifeLimitHours; hoursAtInstall dropped (aircraft time at installedAt comes from `aircraft.time-in-service` and flights) |
| `aircraft.maintenance_status` | derived | Dropped: from `maintenance.action` and `occurrence.mechanical-irregularity` |
| `aircraft.maintenance_record` | `maintenance.action` | affectedComponent→the record's component subject or secondary subject; timeInServiceAtAction→`aircraft.time-in-service` (running_total); reference→workReference |
| `aircraft.system_availability` | `aircraft.system-availability` | maintenanceState, maintenanceRecordSubjectId and returnToServiceBy/Basis dropped: those facts are `maintenance.action`, `aircraft.inspection` and occurrences |
| `aircraft.preflight_safe_condition` | `aircraft.condition` | recorded + condition→recordedCondition; an absent record replaces recorded false |
| `environment.flight_plan` | `flight.plan` | origin/destination→plannedOriginDescription/plannedDestinationDescription; windowStart/End→windowStartsAt/EndsAt; plannedDate dropped (the window carries it) |
| `environment.operational_volume` | `organization.operating-area` | maxAltitudeAglFt→ceilingAboveGroundMeters; feet→meters; artifactDigest→boundaryArtifactReference; the boundary as a circle or corridor (shape, center, radiusMeters, corridorPoints, corridorHalfWidthMeters) |
| `environment.preflight_assessment` | `flight.preflight-assessment` | *Conclusion→*Determination |
| `environment.site_identity` | site subject | Dropped: names belong to Ledger's site directory, not a record |
| `environment.operating_conditions` | `site.status` | district dropped |
| `flight.nprm_per_flight_record` | `flight.record` + `flight.report` + `aircraft.identity` + `flight.plan` + `operation.role-assignment` | occurredAt and duration→`flight.record` takeoffAt/landingAt (or a source's `flight.report`); registration→`aircraft.identity`; operationType→`flight.plan.operationKind`; designatedPersonnelNames→role assignments; origin→takeoffLocation; destination→landingLocations; altitudes→maxHeightFlownAboveGroundMeters + heightNotes |
| `flight.nprm_path_record` | `flight.record` | Merged: flightPathReference, landingLocations; path data is `position.fix` |
| `flight.nprm_mechanical_irregularity` | `occurrence.mechanical-irregularity` | recordedAt→occurredAt; affectedComponent→secondary subject |
| `flight.operation_anomaly` | `occurrence.operation-anomaly` | stopCondition's provision-specific list→free-text stopConditionReference |
| `flight.emergency_deviation` | `occurrence.emergency-deviation` | reportedAt→reportedToAuthorityAt (now optional); reference renamed |
| `flight.security_occurrence` | `occurrence.security` | |
| `flight.property_unauthorized_area` | `occurrence.property-or-area` | unauthorizedArea→areaDescription |
| `flight.multiple_aircraft` | `operation.multiple-aircraft` | `*Count` names |
| `people.remote_pilot_certificate` | `person.certificate` | valid (boolean)→recordedStatus |
| `people.currency` | `person.training` | trainingKind knowledge_test or recurrent; lastAeronauticalKnowledgeTestAt→completedOn |
| `people.flight_assignment` | `operation.role-assignment` | rpic, vo, manipulator→pilot_in_command, visual_observer, person_manipulating_controls |
| `people.fitness_to_serve` | `person.readiness-declaration` | conclusion→medicalStatement |
| `people.authority_to_serve` | `person.readiness-declaration` | Merged: conclusion→substanceStatement |
| `aircraft.registration` | `aircraft.identity` | Merged: registrationNumber |
| `aircraft.remote_id_path` | `aircraft.identity` | Merged: remoteIdentificationMethod |
| `aircraft.inspection` | `aircraft.inspection` | expiresAt→nextDueAt; result and inspector added |
| `aircraft.payload_class` | `aircraft.payload` | classification→hazardousMaterial |
| `environment.airspace_site` | `flight.preflight-assessment` + observation `airspace.authorization` | classSummary→airspaceDetermination; authorizationId and status are the observation |
| `flight.visual_configuration` | `flight.plan` + `operation.role-assignment` | mode→visualMode + operatingAuthorityReference; observer→role visual_observer |
| `flight.operating_limits` | `flight.plan` + `flight.preflight-assessment` | maxAglFt, maxDownrangeSm→meters; cloudClearance→cloud clearance fields |
| `flight.operating_conditions` | `flight.plan` + `flight.preflight-assessment` | Planned ground speed to the plan; visibility and cloud to the assessment; knots, miles, feet→SI |
| `flight.structure_clearance` | `flight.plan` | structure* fields |
| `flight.accident_report` | `occurrence.accident` | reportKind→accidentKind (three values); reportedAt optional |

Dropped as records: four derived keys and the site identity. Observations rather than records: duty and rest periods (`crew.duty-period`), airspace authorization (`airspace.authorization`) and flight path (`position.fix`). A flight's takeoff and landing are both: the operator's `flight.record` and, where a source reports them, `flight.report`.

## Decisions

Recorded from the review of this note.

1. **Hours.** `Hours` is a unit: decimal hours as the operator records them, for time in service, life limits, experience and duty totals. Not converted to seconds. The naming test and the vocabulary's unit list include it.
2. **Optional body fields.** Every body field stays optional, so incomplete records are kept and reported as incomplete. The subject lives in the envelope; identity fields are not schema-required.
3. **Flat records.** One record is one CSV row; one role per assignment record.
4. **Body time is the source of truth.** Intake derives `occurredAt` and `interval` from the body's time fields. If a submitter supplies both and they disagree, the record is refused.
5. **Rule-specific completeness** through `missingFields` is accepted.
6. **References** are `{ id, scope }`, as subjects: `source` is the id in the operator's file, resolved later through aliases; `ledger` is a Ledger id. Either is valid.
7. **One default registry**, `standardObservationRegistry`, holds the vocabulary and operator record types; `observationRegistryV1` stays the vocabulary-only base. The operator record modules import nothing from the observations index, so there is no cycle.
8. **Version pins.** Each type's structure is pinned by digest in the tests (identity, subjects, time, field names, kinds, flags, units, bounds, option values, reference kinds and the schema, with wording removed), as for the vocabulary.
9. **One fact, one type.** Duty and rest periods are `crew.duty-period`; the person-level record is `person.rest-assessment` and references the periods it concerns. The same principle removed the other overlaps listed under "One fact, one type".
10. **Stored units** are the vocabulary's (meters, meters per second, percent) plus `Hours`.
11. **Coordinator requirement** stays without make and model for now.

## For later work

- File import and entry forms: derive the envelope's `occurredAt` and `interval` from the body's time fields and refuse a record whose submitted envelope time disagrees; resolve `source`-scoped references through aliases; generate forms and templates from `fields`; offer entry in feet, statute miles and knots with explicit conversion to the stored units.
- File import and entry forms: the adapter conformance kit validates only the `operator.record` envelope; intake must validate the body against the registered record type.
- Check kinds: a "record complete" check kind can be generic over `missingRequiredFields` and `missingFields`, with `missingReplayFields` for a thin-replay note.
- The Part 108 and Part 107 checks: derived values (aircraft total time, life used on a part, maintenance after an irregularity, duty coverage) are rule computations over these records and observations. Built: one Part 108 rule per item of the per-flight record, reading `flight.record` with `flight.report`, `aircraft.identity`, `flight.plan` and role assignments.
- The Part 108 checks: the coordinator requirement may need to be recorded per aircraft make and model.
