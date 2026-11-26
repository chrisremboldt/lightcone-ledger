/**
 * A summary and a description for every operation in the API reference, keyed by operationId.
 *
 * The summary is one imperative line. The description says what the operation records or returns, then names the
 * capability the route checks, in the form "Needs `capability`." Keep it in step with the route handlers in
 * apps/api/src: tests/unit/route-descriptions.test.ts fails when an operation has no entry or an entry has no
 * operation.
 */
export const routeDescriptions: Record<string, { summary: string; description: string }> = {
  // Flight predeparture coordination
  flightPredeparture: {
    summary: 'Read the predeparture progress of one flight',
    description:
      'Returns where one flight stands in predeparture coordination: the records on file for it and the latest progress its configured mission source reported. Available only on a host where predeparture coordination is configured for the organization. Needs `flight:read`.',
  },
  recordFlightPredepartureProgress: {
    summary: 'Record predeparture progress for one flight',
    description:
      'Records one progress report from the configured mission source for a flight in predeparture coordination. Only that source may report, and only on a host where predeparture coordination is configured. Needs `flight:read`, `input:write` and `mission:write`.',
  },

  // Simulated avoidance demonstration
  simulationAvoidanceDemoPreparationContext: {
    summary: 'Read the preparation context of one demonstration cycle',
    description:
      'Returns what the configured demonstration source needs to prepare one simulated avoidance cycle. Demonstration only: available when the host enables the simulated avoidance demonstration, and only to its configured source. Needs `flight:read`.',
  },
  prepareSimulationAvoidanceDemo: {
    summary: 'Request a simulated avoidance demonstration for a hazard control',
    description:
      'Records a request for one simulated avoidance cycle for an accepted control on a hazard, with fictional flights only. Demonstration only: available when the host enables the simulated avoidance demonstration, and a person must make the request. Needs `flight:read` and `decision:write`.',
  },
  hazardSimulationAvoidanceDemos: {
    summary: 'List the demonstration cycles for one hazard control',
    description:
      'Returns the simulated avoidance cycles recorded for one accepted control on a hazard, a page at a time. Demonstration only: available when the host enables the simulated avoidance demonstration. Needs `flight:read`.',
  },
  simulationAvoidanceDemoRequests: {
    summary: 'List requested demonstration cycles',
    description:
      'Returns the simulated avoidance cycles that have been requested, a page at a time. Demonstration only: available when the host enables the simulated avoidance demonstration. Needs `flight:read`.',
  },
  simulationAvoidanceDemo: {
    summary: 'Read one demonstration cycle',
    description:
      'Returns one simulated avoidance cycle with its latest recorded progress. Demonstration only: available when the host enables the simulated avoidance demonstration. Needs `flight:read`.',
  },
  recordSimulationAvoidanceDemoProgress: {
    summary: 'Record progress for one demonstration cycle',
    description:
      'Records one progress report for a simulated avoidance cycle. Demonstration only: available when the host enables the simulated avoidance demonstration, and only to its configured source. Needs `flight:read`.',
  },

  // Sign-in and authority
  signInConfiguration: {
    summary: 'Read how to sign in to this host',
    description:
      'Returns the public sign-in settings of this host: its deployment name and the OpenID Connect issuers people sign in with. Needs no credential.',
  },
  currentPrincipal: {
    summary: 'Read the signed-in principal and its organization',
    description:
      'Returns the principal behind the credential: its capabilities, the sources and observation grants it holds, its revision, and a summary of its organization. Needs no capability beyond a valid credential.',
  },
  principalAuthorities: {
    summary: 'List the principals of the organization and their authority',
    description:
      'Returns every principal of the organization with the capabilities, sources and grants it holds. Private, not cached. Needs `authority:write`.',
  },
  credentials: {
    summary: 'List the credentials issued in the organization',
    description:
      'Returns the credentials issued to the principals of the organization, without their secrets. Private, not cached. Needs `authority:write`.',
  },
  setPersonNoticeEmail: {
    summary: 'Set the address a person gets email notices at',
    description:
      'Keeps or removes the email address a person of the organization gets notices at; a person with no address gets no email. Recorded as a journal event that says whether an address is kept, never the address. Needs `authority:write`.',
  },
  noticeSettings: {
    summary: 'Read your own notice settings',
    description:
      'Returns the address you get email notices at, which notices arrive by email (assigned to you, due soon, overdue, waiting for your acknowledgement), whether you get a daily or weekly digest, and whether this Ledger sends email at all. Needs no capability: every person reads their own.',
  },
  updateNoticeSettings: {
    summary: 'Change your own notice settings',
    description:
      'Changes your address for email notices, which notices arrive by email and your digest. Only the fields sent change. Recorded as a journal event. Needs no capability: every person sets their own.',
  },
  notices: {
    summary: 'List the organization’s notices',
    description:
      'Every notice Ledger has written for the organization, newest first, a page at a time: what it says, who it is for, by email or the webhook, and its state (waiting, sent, failed with the reason, or given up after five attempts). Filter by state. Needs `authority:write`.',
  },
  noticeWebhook: {
    summary: 'Read the organization’s webhook for notices',
    description:
      'Returns the address notices are posted to, when and by whom it was set, never its secret. Needs `authority:write`.',
  },
  setNoticeWebhook: {
    summary: 'Set or remove the organization’s webhook for notices',
    description:
      'Sets the https address every assignment, due and overdue action and document waiting for acknowledgement is posted to, and makes a new secret that signs each call: the secret is in this response only and is never shown again. A null address removes the webhook. Needs `authority:write`.',
  },
  rolePresets: {
    summary: 'List the role presets people are added from',
    description:
      'Returns each role preset (Dispatcher, Pilot, Safety manager, Administrator, Reader, Nothing yet) with exactly the capabilities and observation grants it gives. The People screen and the command-line client read the same list. Needs `authority:write`.',
  },
  issueDevelopmentToken: {
    summary: 'Issue a development token to a person on a local or test database',
    description:
      'Issues a development token to one active person of the organization and replaces their earlier tokens, which are refused from then on. The token is in this response only: Ledger keeps its hash, and the issue is recorded with who issued it, for whom and, when the body gives one, the reason (`note`). Refused (403 development_tokens_disabled) with LEDGER_ENV=staging, where a person signs in through the identity provider. Private, not cached. Needs `authority:write` and a person signed in.',
  },
  principalAuthority: {
    summary: 'Read the authority of one principal',
    description:
      'Returns one principal with the capabilities, sources and grants it holds. Private, not cached. Needs `authority:write`.',
  },

  // Organization
  organizationPeople: {
    summary: 'List the people of the organization',
    description:
      'Returns the active people of the organization, a page at a time, searchable by name. This is a live directory, not a record of who was briefed. Private, not cached. Needs `flight:read`.',
  },
  organizationCoverage: {
    summary: 'Read the rule packs the organization has adopted and their coverage',
    description:
      'Returns the organization, its rule pack adoptions and what each adoption covers. Needs `flight:read` or `evidence:read`.',
  },
  adoptionRuleCoverage: {
    summary: 'Read the coverage of one adoption by rule',
    description:
      'Returns each rule of one adoption: how it is checked, the size of its population, and its members counted by their latest evaluation under the adoption. Private, not cached. Needs `evidence:read`.',
  },
  ruleCoverageSubjects: {
    summary: 'List the subjects behind one rule coverage count',
    description:
      'Returns the members of one rule’s population behind one count, with each one’s name, latest evaluation, open finding and the records not on file. Private, not cached. Needs `evidence:read`.',
  },
  openFindings: {
    summary: 'List the open findings across every subject',
    description:
      'Returns the open findings about any subject, oldest first: counted findings, or with shown=proposed those from shadow adoptions, which are never counted. Each has its subject and rule, the paragraph the rule checks, its owner and its action. Filters by subject kind, pack, rule, owner (none for nobody), latest result and the days the findings are about; matching says how many the filters select. Each carries its latest evaluation, which a decision about it pins, and when it is about. Also counts what needs attention: counted findings nobody owns and actions past their due day. Private, not cached. Needs `evidence:read`.',
  },
  openFindingGroups: {
    summary: 'List the open findings grouped by rule',
    description:
      'Returns the open findings the same tab and filters select, one group per pack and rule: how many are open, about how many subjects, how many owned and supported by the record now, the oldest opening and the earliest and latest time they are about. The rules with the fewest open findings come first, or with order=most the most. Private, not cached. Needs `evidence:read`.',
  },
  flightsOnRecord: {
    summary: 'List the flights the organization’s own records give',
    description:
      'Returns whether the organization has an order source on record, and the flights its current flight plan records give, upcoming first, then recent, each with its window, aircraft, pilot in command and counted open findings; with counted findings nobody owns and actions past their due day. Private, not cached. Needs `evidence:read`.',
  },
  subjectsOnRecord: {
    summary: 'List the subjects of one kind on record',
    description:
      'Returns the subjects of one kind the organization has on record, with their names, for picking one. Private, not cached. Needs `evidence:read`.',
  },
  documentPurposes: {
    summary: 'List the document purposes the adopted rule packs declare',
    description:
      'Returns the document purposes declared by the organization’s adopted rule packs, for marking on a controlled document. Private, not cached. Needs `sms:read`.',
  },
  requiredRecords: {
    summary: 'List the records the adopted rule packs require',
    description:
      'Returns each record the organization’s adopted rule packs say must be kept: the paragraph quoted, who the text says keeps it, the Ledger records that hold it with how many are on file and the earliest and latest time they are about, and the retention in the text’s own words. It never says a requirement is met. Private, not cached. Needs `evidence:read`.',
  },
  recordkeepingPlanDraft: {
    summary: 'Draft a recordkeeping plan from the required records',
    description:
      'Returns a recordkeeping plan drafted from the required records as read now: a controlled document body of the recordkeeping plan type, ready to open with `sms.record.open`, and the blanks only the organization can fill. Records nothing. Private, not cached. Needs `evidence:read`.',
  },
  organizationDecisions: {
    summary: 'List the latest decisions recorded about subjects',
    description:
      'Returns the most recent decisions people recorded about subjects of the organization. Needs `flight:read`.',
  },
  monitoringWindow: {
    summary: 'Read one monitoring record',
    description:
      'Returns one monitoring record reported by a source, with its digest and processing state. It does not calculate how well a control worked. Needs `flight:read`.',
  },
  hazardMonitoringWindows: {
    summary: 'List the monitoring records for one hazard control',
    description:
      'Returns the monitoring windows recorded for one accepted control on a hazard, a page at a time. Private, not cached. Needs `flight:read`.',
  },
  acceptedAreaControl: {
    summary: 'Read one version of an accepted area control',
    description:
      'Returns one accepted control record on a hazard at one version, with its owner and content. Needs `flight:read`.',
  },

  // Rule packs
  ruleSourceContent: {
    summary: 'Download the original bytes of one rule source document',
    description:
      'Returns the retained rule source document as it was published, with its SHA-256 in the X-Content-SHA256 header. Needs `flight:read` or `evidence:read`.',
  },
  // Links to one produced set (docs/design/shared-links.md)
  createRecordLink: {
    summary: 'Make a link to one produced set',
    description:
      'Makes a link that opens one produced set to someone who does not sign in, until it expires (7 days unless given, 90 at most) or is revoked. Its secret is 256 random bits, returned once; only its SHA-256 is kept. Recorded with who made it and the note saying who it is for. A principal who holds only reads is refused. Needs `evidence:read` and an Idempotency-Key.',
  },
  listRecordLinks: {
    summary: 'List the links to one produced set',
    description:
      'Returns every link made to one produced set, newest first: who it is for, who made it and when, when it expires, whether it was revoked, by whom and why, and each time it was opened, with nothing about who opened it. Never a secret. Needs `evidence:read`.',
  },
  revokeRecordLink: {
    summary: 'Revoke a link to a produced set',
    description:
      'Revokes a link at once: it opens nothing from then on. Recorded with who revoked it and why. A principal who holds only reads is refused. Needs `evidence:read`.',
  },
  openSharedRecords: {
    summary: 'Open the produced set a link opens',
    description:
      'Returns the organization’s name, what the set is and its files, for the secret from the link. Each opening is kept with its time and nothing about who opened it. Unknown, expired and revoked links all answer 404 record_link_not_in_use. Answered with Cache-Control no-store, Referrer-Policy no-referrer and X-Robots-Tag noindex. Needs the link’s secret in the body, and no sign-in.',
  },
  readSharedRecordsFile: {
    summary: 'Read one file of the set a link opens',
    description:
      'Returns one file of the set by its path, checked against the SHA-256 its manifest lists. The opening is kept. Needs the link’s secret in the body, and no sign-in.',
  },
  readSharedRecordsArchive: {
    summary: 'Download the whole set a link opens',
    description:
      'Returns the kept .zip of the set, checked against its recorded SHA-256, with X-Manifest-SHA256. The opening is kept. Needs the link’s secret in the body, and no sign-in.',
  },

  rulePacks: {
    summary: 'List the rule pack versions this host offers',
    description:
      'Returns every rule pack version registered on this host, adopted or not. Needs `flight:read` or `evidence:read`.',
  },
  rulePackVersion: {
    summary: 'Read one rule pack version and its rules',
    description:
      'Returns one rule pack version with its rules and the sources they cite. Needs `flight:read` or `evidence:read`.',
  },

  // Flights
  listFlights: {
    summary: 'List flights',
    description:
      'Returns the flights of the organization, a page at a time, filtered by the query. Needs `flight:read`.',
  },
  createFlight: {
    summary: 'Create a flight',
    description:
      'Records a new flight from an origination request. The same idempotency key with different content conflicts. Needs `flight:create`.',
  },
  getFlight: {
    summary: 'Read one flight',
    description: 'Returns the current summary of one flight. Needs `flight:read`.',
  },
  flightTimeline: {
    summary: 'Read the timeline of one flight',
    description:
      'Returns the recorded events, receipts and decisions of one flight in order, a page at a time. Needs `flight:read`.',
  },
  flightFindings: {
    summary: 'List the findings of one flight',
    description: 'Returns the findings recorded for one flight and the evaluations behind them. Needs `flight:read`.',
  },
  flightRuleSelection: {
    summary: 'Read the current rule selection of one flight',
    description:
      'Returns which adopted rules apply to one flight as of now, and whether the selection has caught up with the latest records. Needs `flight:read`.',
  },
  flightMission: {
    summary: 'Read the current mission of one flight',
    description: 'Returns the latest mission revision recorded for one flight and its binding. Needs `flight:read`.',
  },
  flightMissionRevision: {
    summary: 'Read one mission revision of a flight',
    description: 'Returns one recorded mission revision of a flight. Needs `flight:read`.',
  },
  commandLinkBaseline: {
    summary: 'Read one command link baseline of a flight',
    description:
      'Returns one command link baseline recorded for a flight, with its digest and processing state. Needs `flight:read`.',
  },
  flightRuleSelectionRecord: {
    summary: 'Read one recorded rule selection of a flight',
    description: 'Returns one rule selection recorded for a flight, as it was recorded. Needs `flight:read`.',
  },
  flightTelemetry: {
    summary: 'Read the telemetry of one flight',
    description:
      'Returns the retained telemetry samples of one flight and a cursor for watching it live. Needs `flight:read`.',
  },
  watchFlight: {
    summary: 'Watch one flight for updates as server-sent events',
    description:
      'Streams notifications that a flight or its telemetry changed, carrying identifiers and revisions only; read the telemetry snapshot for the samples. Connections are limited per principal and per host. Needs `flight:read`.',
  },
  listOrders: {
    summary: 'List orders received from order sources',
    description: 'Returns the orders received for the organization, a page at a time. Needs `order:read`.',
  },

  // Intake
  submitInput: {
    summary: 'Submit an input for intake',
    description:
      'Stores one input, such as an observation, order revision or telemetry segment, and queues its processing; the receipt says the bytes are stored and the work is queued. The same idempotency key with different content conflicts. Needs `input:write`, and `flight:create` as well for order and intent revisions.',
  },
  listObservations: {
    summary: 'List the accepted observations of one type for one subject',
    description:
      'Returns the accepted observations of one type for one subject, within the time span the query sets. Private, not cached. Needs `evidence:read`.',
  },
  listRuleEvaluations: {
    summary: 'List the rule evaluations recorded for one subject',
    description:
      'Returns the evaluations of adopted rules recorded for one subject, newest first. Private, not cached. Needs `evidence:read`.',
  },
  getRuleEvaluation: {
    summary: 'Read one recorded rule evaluation',
    description:
      'Returns one recorded rule evaluation with the records it read. Private, not cached. Needs `evidence:read`.',
  },
  listSubjectFindings: {
    summary: 'List the findings opened for one subject',
    description:
      'Returns the findings the rule evaluator opened for one subject, newest first. Private, not cached. Needs `evidence:read`.',
  },

  // Operator records
  listOperatorRecordTypes: {
    summary: 'List the record types and their columns',
    description:
      'Returns the record types your organization has, with their field metadata and the import columns generated from it: those built into Ledger, and those declared by packs your organization has adopted (in effect or still to come). Needs `evidence:read`.',
  },
  operatorRecordTemplate: {
    summary: 'Download an empty import file for one record type',
    description:
      'Returns an empty import file for one version of a record type: a CSV header row, or a JSON records document. Needs `evidence:read`.',
  },
  previewOperatorRecordImport: {
    summary: 'Preview an import of a file of operator records',
    description:
      'Checks every row of an uploaded file against the record type and reports, per row, what would be recorded or why it is refused. It records nothing. Needs `input:write`.',
  },
  commitOperatorRecordImport: {
    summary: 'Import a file of operator records',
    description:
      'Records every acceptable row of an uploaded file as an operator record observation, citing the file and the row. Importing the same file again records nothing new. Needs `input:write` and an observation grant for operator records under the source.',
  },
  listOperatorRecords: {
    summary: 'List the operator records of one type',
    description:
      'Returns the records of one type, newest first, with what is filled in, where each came from and what replaced it. Private, not cached. Needs `evidence:read`.',
  },

  // Control windows and indicators
  openControlWindow: {
    summary: 'Open a window for an accepted control',
    description:
      'Records a window for an accepted control: the period, the subjects it covers and whether they are declared complete, the observation types it expects and the indicator definitions it is for. Needs `monitoring:write`.',
  },
  listControlWindows: {
    summary: 'List the windows for one control',
    description:
      'Returns every window for one control, newest first, including older source-reported windows in the same shape. Needs `evidence:read`.',
  },
  getControlWindow: {
    summary: 'Read one control window',
    description: 'Returns one control window with its current revision. Needs `evidence:read`.',
  },
  reviseControlWindow: {
    summary: 'Declare the population of a control window again',
    description:
      'Records a new revision of a window with a newly declared population. The control, period and expectations stay as opened. Needs `monitoring:write`.',
  },
  calculateControlWindowIndicator: {
    summary: 'Calculate one indicator of a control window',
    description:
      'Calculates one of the window’s indicators from its declared population, at the evidence cut of its current revision. It records nothing. Needs `evidence:read`.',
  },
  recordControlIndicatorResult: {
    summary: 'Record one indicator result for a control window',
    description:
      'Records one indicator result for the window at its current revision, with the request that produced it. A changed window or definition conflicts. Needs `decision:write`.',
  },
  listControlIndicatorResults: {
    summary: 'List the indicator results of a control window',
    description:
      'Returns the recorded results for the window and the reviews of them, newest first. Needs `evidence:read`.',
  },
  // Reports
  periodSummary: {
    summary: 'Count what is on file for one period',
    description:
      'Returns the counts of one period, from its first day to its last in the organization’s time zone: flights and flight time from the flight records on file, counted findings by rule (opened and closed in the period, open at its end), actions on findings and of safety assurance records open and overdue at its end, and hazards open at its end by level. Each count is of recorded things; what is not counted is counted apart. A part the reader may not read says so instead of a number. No score and no rating. Needs `evidence:read` or `sms:read`; the flights, findings and their actions need `evidence:read`, the hazards and assurance actions `sms:read`.',
  },
  findingsByMonth: {
    summary: 'Count findings opened and closed each month, by rule',
    description:
      'Returns, for each rule as its pack names it, how many counted findings opened and how many closed in each month of the period, months in the organization’s time zone; the twelve months ending with the current one unless a period is given. Needs `evidence:read`.',
  },
  reportIndicators: {
    summary: 'List the indicators with recorded results',
    description:
      'Returns each indicator definition version with at least one recorded result: its title, how many results and the windows they cover. Needs `evidence:read`.',
  },
  indicatorHistory: {
    summary: 'Read one indicator’s recorded results over time',
    description:
      'Returns every recorded result of one indicator definition version, across its control windows, ordered by window: the rate each states or that it states none, its counts, and the limit the definition sets, if any. Needs `evidence:read`.',
  },
  getControlIndicatorResult: {
    summary: 'Read one recorded indicator result',
    description:
      'Returns one recorded indicator result, and whether gathering its request again reads the same inputs. Needs `evidence:read`.',
  },
  reviewControlIndicatorResult: {
    summary: 'Record a person’s review of one indicator result',
    description:
      'Records a person’s review of one recorded indicator result, cited by digest. The caller must be an active person. Needs `decision:write` and `flight:read`.',
  },
  getControlIndicatorReview: {
    summary: 'Read one review of an indicator result',
    description: 'Returns one recorded review of an indicator result. Needs `evidence:read`.',
  },

  // Receipts, uploads and artifacts
  listReceipts: {
    summary: 'List intake receipts',
    description:
      'Returns the receipts for submitted inputs, a page at a time, with their processing state. Needs `flight:read`.',
  },
  getReceipt: {
    summary: 'Read one intake receipt',
    description: 'Returns one receipt with its processing state and any error. Needs `flight:read`.',
  },
  createUpload: {
    summary: 'Start an upload of a file',
    description:
      'Records an upload session for a file of declared type, length and confidentiality; send the bytes next, then finalize. Needs `input:write`.',
  },
  getUpload: {
    summary: 'Read one upload session',
    description: 'Returns one upload session and its state. Needs `evidence:read`.',
  },
  putUploadBytes: {
    summary: 'Send the bytes of an upload',
    description:
      'Stores the bytes of an upload session. Only the principal that started the upload may send them, the length must match the declared length, and different bytes for the same upload conflict. Needs `input:write`.',
  },
  finalizeUpload: {
    summary: 'Finalize an upload into a retained artifact',
    description:
      'Checks the stored bytes against the upload and records them as an immutable artifact. Only the principal that started the upload may finalize it. Needs `input:write`.',
  },
  getArtifact: {
    summary: 'Read one retained artifact',
    description: 'Returns the record of one retained artifact: its type, length and SHA-256. Needs `evidence:read`.',
  },
  readArtifactBytes: {
    summary: 'Download the original bytes of one artifact',
    description:
      'Returns the original bytes of one retained artifact after checking them against its recorded SHA-256. Needs `evidence:read`.',
  },

  // Commands
  submitCommand: {
    summary: 'Submit a command',
    description:
      'Records one command, such as a decision, an evidence correction, a rule pack adoption, a mission release or briefing, a change to a safety record, or a change to people and credentials. Each command kind needs its own capability: `decision:write` for decisions, `correction:write` for corrections, `identity:write` for identity links and flight assignment, `authority:write` for people, authority and credentials, `pack:adopt` for adoptions, `mission:release`, `briefing:write` or `briefing:ack` with `flight:read` for mission commands, `sms:write` or `sms:read` for safety record commands, and `input:write` for observation and subject alias commands. A signed decision (`decision.record` of kind `risk.accept`, `matrix.adopt`, `document.adopt` or `assurance.sign`) also needs a fresh confirmation that the signer is who they say, or it is refused with 403 `reauthentication_required`: on a deployment, a sign-in at the OpenID Connect provider within the last five minutes, so the person signs in the browser; on a local Ledger, for a development token, a grant from `POST /v1/local/reauthentications` sent once in the `x-ledger-reauthentication` header with the decision. `GET /v1/sms/records/{id}/signing` gives the intent and content digest the decision repeats and which of the two ways applies. Needs the capability its command kind needs.',
  },

  // Safety records
  submitSafetyReport: {
    summary: 'Submit a safety report as a signed-in person',
    description:
      'Stores a safety report a person sends, with their name on it only if they choose. It is written as the organization’s safety reporting channel, so nothing kept names a person who sent it without their name. Returns a receipt code once. Takes no idempotency key. Private, not cached. Needs any active person of the organization; no permission.',
  },
  submitSafetyReportThroughLink: {
    summary: 'Submit a safety report through a reporting link',
    description:
      'Stores a safety report sent through a reporting link, with the link’s token in the body. Keeps no principal, address or user agent, and its request log line has none. A link takes at most 20 reports an hour. Returns a receipt code once. Private, not cached. Needs no credential; needs a reporting link in force.',
  },
  safetyReportReceiptStatus: {
    summary: 'Ask whether a submitted safety report is received or closed',
    description:
      'Returns only whether the report a receipt code was given for is received or closed. The code is in the body, never in the path. Private, not cached. Needs no credential; needs the receipt code.',
  },
  safetyReportLinks: {
    summary: 'List the organization’s reporting links',
    description:
      'Returns every reporting link with its label, who issued and revoked it, its expiry and whether it takes reports now. Never returns a token. Private, not cached. Needs `sms:configure`.',
  },
  issueSafetyReportLink: {
    summary: 'Issue a reporting link',
    description:
      'Issues a reporting link with a label and an optional expiry, and returns its token once; Ledger keeps only the token’s SHA-256. A retry with the same idempotency key is refused, since the token cannot be shown again. Needs `sms:configure`.',
  },
  revokeSafetyReportLink: {
    summary: 'Revoke a reporting link',
    description: 'Revokes a reporting link at once; it takes no more reports. Needs `sms:configure`.',
  },
  smsProgram: {
    summary: 'Read whether the organization keeps safety records',
    description:
      'Returns whether the organization has safety records on file and which parts of them the caller can read. Private, not cached. Needs no capability beyond a valid credential.',
  },
  smsHome: {
    summary: 'Read the overview of the organization’s safety records',
    description:
      'Returns the overview of the safety records: whether the program is active, the risk matrix in use and the people who take part in it. To a person who reads the controlled documents alone, only the program and the risk matrix. Private, not cached. Needs `sms:read` or `document:read`.',
  },
  smsRegister: {
    summary: 'List the safety records of one kind',
    description:
      'Returns the safety records of one kind, a page at a time, optionally only those raised from one finding, or the one that carries the organization’s own id (`reference`). Private, not cached. Needs `sms:read`, or `document:read` for the documents and risk matrices.',
  },
  smsControlTypes: {
    summary: 'List the control types a control may be proposed with',
    description:
      'Returns every registered control type: what a control of it applies to, the parameters it needs as a JSON Schema, and whether a deterministic check follows it against flights. A control names its type by id, version and digest. `control.described-measure` states a measure in words, owned by the control record’s owner from its effective date, with no check against flights. Private, not cached. Needs `sms:read`.',
  },
  smsRecord: {
    summary: 'Read one safety record',
    description:
      'Returns one safety record with its versions and what is recorded about it. Restricted content is read through its own route. Private, not cached. Needs `sms:read`, or `document:read` for a document or a risk matrix.',
  },
  smsSigningPreview: {
    summary: 'Preview signing one safety record',
    description:
      'Returns the exact content a signature would cover for one meaning, whether the caller can sign it now, and how they must confirm their sign-in (`reauthentication`): `local_fixture`, a grant from `POST /v1/local/reauthentications` sent in the `x-ledger-reauthentication` header, or `openid_connect`, a sign-in at the identity provider within the last five minutes. A risk at a level the matrix says nobody may accept is not available to sign, with the matrix’s own words. It records nothing. Private, not cached. Needs `sms:read`.',
  },
  smsFindingPromotion: {
    summary: 'Read what raising a hazard from one finding would record',
    description:
      'Returns the finding, its evaluation and any hazard already raised from it, for raising a hazard from that finding. It records nothing. Private, not cached. Needs `sms:write`.',
  },
  smsRecordContent: {
    summary: 'Read the restricted content of one safety record',
    description:
      'Returns the restricted title, body and links of every version of one restricted safety record, and retains a note of each read. The caller must be a person holding the capability for the record’s class: `sms:report:read` for safety reports, `sms:restricted:read` for restricted asset information. Needs `sms:read`.',
  },
  smsAttachmentContent: {
    summary: 'Download the original bytes of one safety record attachment',
    description:
      'Returns the original bytes of one attachment after checking them against its digest. A restricted attachment also needs the capability for its class, `sms:report:read` or `sms:restricted:read`, and each read of one is retained. Needs `sms:read`, or `document:read` for an ordinary attachment of a document or a risk matrix.',
  },
  smsExportPacket: {
    summary: 'Download a readable copy of one safety records export',
    description:
      'Returns an HTML reading copy rendered from the retained export bundle after checking its integrity. Needs `evidence:read`.',
  },
  createSmsExport: {
    summary: 'Export safety records as a bundle',
    description:
      'Records and stores an export bundle of one safety record, or of every record with activity in a period, with the records they depend on. Restricted attachments are never included. Needs `evidence:read`.',
  },
  smsExport: {
    summary: 'Read one safety records export',
    description: 'Returns the record of one safety records export. Private, not cached. Needs `evidence:read`.',
  },
  smsExportContent: {
    summary: 'Download one safety records export bundle',
    description:
      'Returns the ledger.sms-export.1 bundle bytes after checking them against their record. Verify it offline with tools/verifier/sms-cli.mjs. Needs `evidence:read`.',
  },
  localReauthentication: {
    summary: 'Confirm a local sign-in again before signing',
    description:
      'Development and tests only: absent in staging and production, and only for development tokens, on a Ledger whose `GET /v1/sign-in` reports `developmentTokens`. Send your own development token as `credential`, with the same token as bearer. Records a grant that lasts five minutes and is spent by one signed decision: send it in the `x-ledger-reauthentication` header of `POST /v1/commands` with that decision, and keep it nowhere else. Elsewhere, signing needs a sign-in at the OpenID Connect provider within the last five minutes. Needs no capability beyond a valid credential.',
  },

  // Sources
  sourceCapabilities: {
    summary: 'List what each connected source reports',
    description:
      'Returns, for each source, the kinds of observation it reports, their fidelity and their known limitations. Needs `flight:read`.',
  },

  // Exports and packets
  createDecisionExport: {
    summary: 'Export the evidence behind one flight decision',
    description:
      'Records and stores an evidence bundle for one flight decision, with the records it rests on. The response names the bundle format in X-Evidence-Format. Needs `evidence:read`.',
  },
  listDecisionExports: {
    summary: 'List flight evidence exports',
    description:
      'Returns the flight evidence exports, newest first, optionally for one flight or decision. Needs `evidence:read`.',
  },
  createDecisionPacket: {
    summary: 'Refuse to issue a decision packet, which is retired',
    description:
      'No longer issues packets: every request is refused with 410 decision_packet_retired. Issue a finding packet for the finding instead; decision packets issued earlier stay readable. Needs `evidence:read`.',
  },
  listDecisionPackets: {
    summary: 'List decision packets issued earlier',
    description: 'Returns the decision packets issued before they were retired, newest first. Needs `evidence:read`.',
  },
  getDecisionPacket: {
    summary: 'Read one decision packet record',
    description: 'Returns the record of one decision packet issued earlier. Needs `evidence:read`.',
  },
  readDecisionPacketBytes: {
    summary: 'Download the bytes of one decision packet',
    description:
      'Returns the exact retained bytes of one decision packet after checking them against their record, with the format and digests in response headers. Needs `evidence:read`.',
  },
  createFindingPacket: {
    summary: 'Issue a packet for one finding',
    description:
      'Records and stores a packet for one finding: its evaluations, the records they read and the decisions recorded about it. It does not say whether a requirement is met. Needs `evidence:read`.',
  },
  listFindingPackets: {
    summary: 'List finding packets',
    description: 'Returns the finding packets issued, newest first, filtered by the query. Needs `evidence:read`.',
  },
  getFindingPacket: {
    summary: 'Read one finding packet record',
    description: 'Returns the record of one finding packet. Needs `evidence:read`.',
  },
  readFindingPacketBytes: {
    summary: 'Download the bytes of one finding packet',
    description:
      'Returns the exact retained bytes of one finding packet after checking them against their record, with the format and digests in response headers. Needs `evidence:read`.',
  },
  createSubjectExport: {
    summary: 'Export the evidence behind one subject decision',
    description:
      'Records and stores an evidence bundle for one decision recorded about the organization as a subject, with the records it rests on. Needs `evidence:read`.',
  },
  listSubjectExports: {
    summary: 'List subject evidence exports',
    description:
      'Returns the subject evidence exports, newest first, optionally for one decision. Needs `evidence:read`.',
  },
  getSubjectExport: {
    summary: 'Read one subject evidence export',
    description: 'Returns the record of one subject evidence export. Needs `evidence:read`.',
  },
  readSubjectExportBytes: {
    summary: 'Download the bytes of one subject evidence export',
    description:
      'Returns the immutable bundle bytes of one subject evidence export after checking them against their record. Needs `evidence:read`.',
  },
  getDecisionExport: {
    summary: 'Read one flight evidence export',
    description: 'Returns the record of one flight evidence export. Needs `evidence:read`.',
  },
  readDecisionExportBytes: {
    summary: 'Download the bytes of one flight evidence export',
    description:
      'Returns the immutable bundle bytes of one flight evidence export after checking them against their record. X-Evidence-Format names the format and X-Content-SHA256 hashes the bytes. Needs `evidence:read`.',
  },

  // Missions
  flightMissionAvoidance: {
    summary: 'Read the areas the mission of one flight should avoid',
    description:
      'Returns the hazard areas on file that the flight’s current mission crosses or comes near, and how they were calculated. Needs `flight:read`.',
  },
  flightMissionRouteSuggestion: {
    summary: 'Suggest a route for the mission of one flight',
    description:
      'Calculates a route around the hazard areas on file for the flight’s mission. It records nothing; a person chooses whether to use it. Needs `flight:read`.',
  },
  flightMissionRelease: {
    summary: 'Read one mission release of a flight',
    description: 'Returns one mission release recorded for a flight, with the basis it pinned. Needs `flight:read`.',
  },
  flightMissionReleaseFindings: {
    summary: 'List the findings a mission release of one flight would cite',
    description:
      'Returns the open findings on file for a flight that a person releasing its mission would see, and the rules whose findings were relieved. Needs `flight:read`.',
  },
  flightControls: {
    summary: 'List the controls in force for one flight',
    description:
      'Returns the accepted controls that apply to the flight’s mission, and those on file that do not apply, with whether the list is complete. Needs `flight:read`.',
  },
  flightMissionReleaseValidity: {
    summary: 'Read whether one mission release still matches its basis',
    description:
      'Returns the state of one mission release now: scheduled, current, expired, changed or pending, with the current context digest. Needs `flight:read`.',
  },
  flightMissionBriefing: {
    summary: 'Read one briefing of a flight',
    description: 'Returns one briefing recorded for a flight, with the people it was given to. Needs `flight:read`.',
  },
  flightMissionBriefingAcknowledgements: {
    summary: 'List the acknowledgements of one briefing',
    description:
      'Returns each declared recipient of one briefing of a flight with the acknowledgement on file for them, if any. Needs `flight:read`.',
  },

  // Records by subject, and producing them on request
  listRecordSubjects: {
    summary: 'List the subjects your records are about',
    description:
      'Returns the people, aircraft, flights, sites or components of one kind that records are about, by your own id, with the name their records give them, how many records are about each and how many findings about each are open. Needs `evidence:read`.',
  },
  getRecordSubjectFile: {
    summary: 'Read one subject’s file',
    description:
      'Returns every record about one subject grouped by record type, what replaced what, the rules that have evaluated it with the latest result of each, and its open findings. Needs `evidence:read`.',
  },
  createRecordProduction: {
    summary: 'Produce records on request',
    description:
      'Records a production of the records chosen by subjects, record types and dates, with the reason and who asked, and keeps one .zip: a CSV per record type in the import template’s columns plus when and by whom each row was recorded and what replaced it, a printable index.html, and manifest.json with the SHA-256 of every file. Original files are listed, and included when asked. Safety reports and restricted attachments are never included. Needs `evidence:read`.',
  },
  listRecordProductions: {
    summary: 'List produced records',
    description:
      'Returns every production of records, newest first, with who produced it, when, why, who asked and the selection. Needs `evidence:read`.',
  },
  getRecordProduction: {
    summary: 'Read one production of records',
    description:
      'Returns who produced one file, when, why, who asked, the selection, the counts and the digests to keep. Needs `evidence:read`.',
  },
  readRecordProductionBytes: {
    summary: 'Download a production of records',
    description:
      'Returns the kept .zip of one production, checked against its recorded SHA-256 before it is sent. Needs `evidence:read`.',
  },
};
