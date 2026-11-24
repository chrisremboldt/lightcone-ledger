import { Type, type Static, type TLiteral, type TSchema, type TUnion } from '@sinclair/typebox';
import { DocumentPurposeIdSchema, ObservationTypeIdPattern } from './observations/envelope.js';
import { RelatedSubjectSchema, SubjectReferenceSchema, type SubjectReference } from './rule-evaluations.js';
import {
  AssuranceBodySchema,
  AssuranceItemIdSchema,
  AssuranceItemRefSchema,
  assuranceTypeValues,
  type AssuranceItemRef,
  type AssuranceType,
} from './sms-assurance.js';
export * from './sms-assurance.js';
import { SafetyReportLinkInForceSchema, type SafetyReportLinkInForce } from './safety-report-submission.js';

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const VersionNumber = Type.Integer({ minimum: 1, maximum: 100000 });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Time = Type.String({ format: 'date-time' });
const Slug = Type.String({ pattern: '^[a-z][a-z0-9_]{0,39}$' });
const Text = (maxLength: number, options: { description?: string } = {}) =>
  Type.String({ minLength: 1, maxLength, pattern: '\\S', ...options });
const literals = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value))) as TUnion<TLiteral<T[number]>[]>;
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T, description?: string) =>
  Type.Object(properties, { additionalProperties: false, ...(description ? { description } : {}) });

export const smsConfidentialityValues = ['ordinary', 'safety_report', 'restricted_asset_information'] as const;
export type SmsConfidentiality = (typeof smsConfidentialityValues)[number];
export const SmsConfidentialitySchema = literals(smsConfidentialityValues);

export const smsRecordClassValues = [
  'srm_output',
  'safety_assurance_output',
  'training_record',
  'safety_communication',
  'sms_documentation',
] as const;
export type SmsRecordClass = (typeof smsRecordClassValues)[number];
export const SmsRecordClassSchema = literals(smsRecordClassValues);

export const smsRecordKindValues = ['hazard', 'risk_matrix', 'document', 'report', 'control', 'assurance'] as const;
export type SmsRecordKind = (typeof smsRecordKindValues)[number];

/** The three risk acceptance authorities, least to most; each is the capability risk:accept:<authority>. */
export const riskAuthorityValues = ['low', 'medium', 'high'] as const;
export type RiskAuthority = (typeof riskAuthorityValues)[number];
export const RiskAuthoritySchema = literals(riskAuthorityValues);
/** Who may accept a risk at a matrix level: one of the three authorities, or nobody. */
export const riskAcceptanceValues = [...riskAuthorityValues, 'not_acceptable'] as const;
export type RiskAcceptance = (typeof riskAcceptanceValues)[number];
export const RiskAcceptanceSchema = literals(riskAcceptanceValues);

export function riskAcceptanceCapability(authority: RiskAuthority): `risk:accept:${RiskAuthority}` {
  return `risk:accept:${authority}`;
}

/**
 * The only acceptance-authority lookup: the lowest held capability that covers the acceptance a level needs, since
 * higher authority covers lower levels. A level nobody may accept is covered by none. It lives here so the API, the
 * simulator and the web app share one implementation.
 */
export function coveringRiskCapability(
  acceptance: RiskAcceptance,
  capabilities: readonly string[],
): `risk:accept:${RiskAuthority}` | undefined {
  const required = (riskAuthorityValues as readonly string[]).indexOf(acceptance);
  if (required < 0) return undefined;
  for (const candidate of riskAuthorityValues.slice(required)) {
    const capability = riskAcceptanceCapability(candidate);
    if (capabilities.includes(capability)) return capability;
  }
  return undefined;
}

export const controlScopeValues = ['area', 'time_window', 'aircraft', 'person_or_role', 'operation_kind'] as const;
export type ControlScope = (typeof controlScopeValues)[number];
export const ControlTypeIdPattern = ObservationTypeIdPattern;
/** Two or more dotted lowercase segments, such as owner.family.rule. */
const ApplicabilityRuleIdPattern = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$';

/** What a registered control type declares. Its digest covers exactly these fields. */
export const ControlTypeDefinitionSchema = strict(
  {
    id: Type.String({ pattern: ControlTypeIdPattern, maxLength: 200 }),
    version: VersionNumber,
    title: Text(120),
    description: Text(2000),
    appliesTo: Type.Array(literals(controlScopeValues), {
      minItems: 1,
      uniqueItems: true,
      description: 'What a control of this type applies to.',
    }),
    parameterSchema: Type.Record(Type.String(), Type.Unknown(), {
      description: 'JSON Schema for the parameters a control of this type records.',
    }),
    checkedAutomatically: Type.Boolean({
      description: 'Whether a deterministic check can tell from retained records that the control was observed.',
    }),
    applicability: Type.Optional(
      strict(
        {
          id: Type.String({ pattern: ApplicabilityRuleIdPattern, maxLength: 200 }),
          version: VersionNumber,
          digest: Digest,
        },
        'The rule that decides from the parameters and a flight plan whether a control of this type applies, pinned by id, version and the digest of its definition. Absent for a type whose controls apply to every flight.',
      ),
    ),
  },
  'ledger.control-type.1',
);
export type ControlTypeDefinitionContent = Static<typeof ControlTypeDefinitionSchema>;
/**
 * How a person picks one parameter of a control type from what the registries hold, by title: a registered
 * observation type (its version goes in versionParameter), or a titled numeric field of the observation type the
 * other two parameters name. Descriptive data on the registration, outside the type's digest.
 */
export const ControlParameterChoiceSchema = Type.Union([
  strict({ from: Type.Literal('observation_type'), versionParameter: Id }),
  strict({ from: Type.Literal('observation_numeric_field'), typeParameter: Id, versionParameter: Id }),
]);
export type ControlParameterChoice = Static<typeof ControlParameterChoiceSchema>;
export type ControlTypeDefinition = ControlTypeDefinitionContent & {
  digest: string;
  /** Parameters a person picks by title, by parameter name. Not part of the digest. */
  parameterChoices?: Record<string, ControlParameterChoice>;
};

/** A registered observation type as a person picks it: its title and the numeric fields it titles. */
export const ObservationTypeChoiceSchema = strict(
  {
    type: Id,
    version: VersionNumber,
    title: Text(200),
    subjectKinds: Type.Array(Id),
    numericFields: Type.Array(strict({ field: Text(400), title: Text(200) })),
  },
  'A registered observation type by its title, with the numeric fields its schema titles, as dot paths.',
);
export type ObservationTypeChoice = Static<typeof ObservationTypeChoiceSchema>;

export const hazardSourceValues = [
  'manual_identification',
  'report',
  'change',
  'investigation',
  'audit',
  'external_notice',
  'flight_finding',
  'finding',
  'assurance',
] as const;

const MatrixAxisEntry = strict({ id: Slug, label: Text(80), description: Text(400) });
export const RiskMatrixBodySchema = strict(
  {
    name: Text(120),
    severities: Type.Array(MatrixAxisEntry, {
      minItems: 5,
      maxItems: 5,
      description: 'Least to most severe.',
    }),
    likelihoods: Type.Array(MatrixAxisEntry, {
      minItems: 5,
      maxItems: 5,
      description: 'Least to most likely.',
    }),
    levels: Type.Array(
      strict({
        id: Slug,
        label: Text(40),
        meaning: Text(400),
        acceptance: Type.Union(
          riskAcceptanceValues.map((value) => Type.Literal(value)),
          {
            description:
              'Who may accept a risk at this level: a person holding risk:accept:<low|medium|high> or a higher one, or nobody (not_acceptable).',
          },
        ),
      }),
      {
        minItems: 2,
        maxItems: 6,
        description:
          "The organization's own levels, least to most serious. A later level never needs less authority than an earlier one.",
      },
    ),
    cells: Type.Array(strict({ severity: Slug, likelihood: Slug, level: Slug }), {
      minItems: 25,
      maxItems: 25,
      description: 'The level of each severity and likelihood, by level id.',
    }),
  },
  "sms.risk-matrix.1: a 5×5 matrix with the organization's own two to six levels, each accepted under one of the three risk:accept capabilities or by nobody.",
);
export type RiskMatrixBody = Static<typeof RiskMatrixBodySchema>;

export const HazardBodySchema = strict(
  {
    description: Text(8000),
    consequence: Text(4000),
    operation: Type.Optional(Text(200)),
    source: strict({ kind: literals(hazardSourceValues), reference: Type.Optional(Text(200)) }),
  },
  'sms.hazard.1: a hazard and its worst credible outcome.',
);
export type HazardBody = Static<typeof HazardBodySchema>;

const legacyDocumentTypeValues = [
  'safety_policy',
  'accountable_executive_designation',
  'roles_and_authority',
  'emergency_response_plan',
  'sms_manual',
  'procedure',
  'safety_notice',
  'other',
] as const;
export const documentTypeValues = [
  ...legacyDocumentTypeValues,
  'oem_manual',
  'service_bulletin',
  'specification',
  'certificate',
  'recordkeeping_plan',
] as const;
export type DocumentType = (typeof documentTypeValues)[number];
const documentBodyFields = {
  revisionLabel: Type.Optional(Text(40)),
  summary: Text(2000),
  text: Type.Optional(Text(100000)),
};
export const DocumentBodySchema = strict(
  {
    documentType: literals(legacyDocumentTypeValues),
    ...documentBodyFields,
  },
  'sms.document.1: SMS documentation. The text or the attached file is the content a signer adopts.',
);
export const DocumentSourceSchema = strict({
  organization: Text(200),
  reference: Type.Optional(Text(200)),
  revision: Text(80),
  issuedAt: Type.Optional(Type.Union([Time, Type.String({ format: 'date' })])),
  receivedAt: Time,
});
export type DocumentSource = Static<typeof DocumentSourceSchema>;
const documentBodyV2Fields = {
  documentType: literals(documentTypeValues),
  ...documentBodyFields,
  documentNumber: Type.Optional(Text(80)),
  changeReason: Text(2000),
  reviewDueAt: Type.Optional(Time),
  purposes: Type.Optional(
    Type.Array(DocumentPurposeIdSchema, {
      maxItems: 50,
      uniqueItems: true,
      description:
        'The purposes this revision serves, ticked from those the adopted rule packs declare. Part of the revision a signer adopts; a rule reads them only once the revision is issued and in force.',
    }),
  ),
};
export const DocumentBodyV2Schema = Type.Union(
  [
    strict({ ...documentBodyV2Fields, origin: Type.Literal('authored') }),
    strict({ ...documentBodyV2Fields, origin: Type.Literal('received'), source: DocumentSourceSchema }),
  ],
  {
    description:
      'sms.document.2: authored or received documentation with an attributable change reason and source revision.',
  },
);
export type DocumentBodyV2 = Static<typeof DocumentBodyV2Schema>;
export type DocumentBody = Omit<Static<typeof DocumentBodySchema>, 'documentType'> & {
  documentType: DocumentType;
  origin?: 'authored' | 'received';
  documentNumber?: string;
  changeReason?: string;
  reviewDueAt?: string;
  purposes?: string[];
  source?: DocumentSource;
};

/** How a report a person records as received came in. */
export const recordedReportChannelValues = ['in_person', 'phone', 'email', 'paper', 'app'] as const;
/** How a report submitted to Ledger itself came in. Only Ledger records these. */
export const submittedReportChannelValues = ['submitted_signed_in', 'submitted_link'] as const;
export const reportChannelValues = [...recordedReportChannelValues, ...submittedReportChannelValues] as const;
export const ReportBodySchema = strict(
  {
    narrative: Text(8000),
    occurredAt: Type.Optional(Time),
    operation: Type.Optional(Text(200)),
    siteReference: Type.Optional(Text(200, { description: 'A site or asset reference. Never coordinates.' })),
    received: strict({ channel: literals(reportChannelValues), receivedAt: Type.Optional(Time) }),
    reporter: Type.Optional(
      Type.Object(
        { name: Type.Optional(Text(200)), contact: Type.Optional(Text(200)) },
        {
          additionalProperties: false,
          minProperties: 1,
          description: 'Who reported and how to reach them, as far as they gave either.',
        },
      ),
    ),
  },
  'sms.report.1: a safety report as received or submitted. Its title, content and reporter are readable only with sms:report:read.',
);
export type ReportBody = Static<typeof ReportBodySchema>;

export const ControlBodySchema = strict(
  {
    hazardId: Id,
    controlType: strict(
      { id: Type.String({ pattern: ControlTypeIdPattern, maxLength: 200 }), version: VersionNumber, digest: Digest },
      'A registered control type, pinned by the digest of its definition.',
    ),
    parameters: Type.Record(Type.String(), Type.Unknown(), {
      description: 'Checked by Ledger against the parameter schema of the pinned control type.',
    }),
    effectiveFrom: Time,
    effectiveUntil: Type.Optional(Time),
  },
  'sms.control.1: a control proposed on a hazard. The record owner owns the control.',
);
export type ControlBody = Static<typeof ControlBodySchema>;

export const SmsLinkSchema = strict({
  relation: literals(['cites', 'affects', 'derived_from']),
  target: Type.Union([
    strict({ kind: Type.Literal('sms_record'), id: Id }),
    strict({ kind: Type.Literal('external'), label: Text(200), reference: Type.Optional(Text(400)) }),
    strict({ kind: Type.Literal('flight'), id: Id }),
    strict({ kind: Type.Literal('finding'), id: Id }),
  ]),
});
export type SmsLink = Static<typeof SmsLinkSchema>;

export const HazardOriginInputSchema = Type.Union(
  [
    strict(
      {
        kind: Type.Literal('finding'),
        findingId: Id,
        evaluationId: Id,
        expectedDependencyBasis: Digest,
      },
      'Promote a finding. evaluationId and expectedDependencyBasis are what the promotion read showed; both must still be current.',
    ),
    strict(
      { kind: Type.Literal('report'), recordId: Id, versionNumber: VersionNumber },
      'Open the hazard from the current version of a safety report.',
    ),
    strict(
      { kind: Type.Literal('assurance'), recordId: Id, versionNumber: VersionNumber, item: AssuranceItemRefSchema },
      'Open the hazard from a finding or an action of the current version of a safety assurance record.',
    ),
    strict({ kind: Type.Literal('manual') }, 'A hazard a person identified directly.'),
  ],
  { description: 'Where a hazard came from. Set once when it is opened and never changed.' },
);
export type HazardOriginInput = Static<typeof HazardOriginInputSchema>;

const NullableId = Type.Union([Id, Type.Null()]);
const NullableVersion = Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]);
export const HazardRuleIdentitySchema = strict(
  {
    packId: NullableId,
    packVersion: NullableVersion,
    ruleId: Id,
    ruleVersion: Type.Integer({ minimum: 0 }),
    ruleDigest: Type.Union([Digest, Type.Null()]),
    bindingId: NullableId,
    bindingVersion: NullableVersion,
    title: Type.String(),
  },
  'The rule that produced the evaluation, kept as data. Ledger never branches on it.',
);
export type HazardRuleIdentity = Static<typeof HazardRuleIdentitySchema>;
export const findingKindValues = ['flight', 'subject'] as const;
export const HazardFindingOriginSchema = strict(
  {
    kind: Type.Literal('finding'),
    findingId: Id,
    findingKind: literals(findingKindValues),
    subject: SubjectReferenceSchema,
    subjectKey: Type.String({ minLength: 1, maxLength: 1000 }),
    evaluationId: Id,
    evaluationDigest: Digest,
    evaluationRecordedAt: Time,
    rule: HazardRuleIdentitySchema,
    related: Type.Optional(RelatedSubjectSchema),
  },
  'findingKind says whether the evaluation is a flight evaluation or a generic rule evaluation. related: the related subject of a finding from a rule that fans out.',
);
export type HazardFindingOrigin = Static<typeof HazardFindingOriginSchema>;
export const HazardOriginSchema = Type.Union(
  [
    HazardFindingOriginSchema,
    strict({ kind: Type.Literal('report'), recordId: Id, versionNumber: VersionNumber, contentDigest: Digest }),
    strict({
      kind: Type.Literal('assurance'),
      recordId: Id,
      versionNumber: VersionNumber,
      bodyDigest: Digest,
      assuranceType: literals(assuranceTypeValues),
      item: AssuranceItemRefSchema,
    }),
    strict({ kind: Type.Literal('manual') }),
  ],
  {
    description:
      'The retained origin of a hazard. A finding origin pins the exact evaluation its author reviewed; a report origin pins the report version by its content digest only.',
  },
);
export type HazardOrigin = Static<typeof HazardOriginSchema>;

const envelopeFields = {
  title: Text(200),
  ownerId: Id,
  dueAt: Type.Optional(Type.Union([Time, Type.Null()])),
  links: Type.Optional(Type.Array(SmsLinkSchema, { maxItems: 50 })),
};
const kindBody = <K extends SmsRecordKind, S extends string, B extends TSchema>(kind: K, schema: S, body: B) =>
  strict({ kind: Type.Literal(kind), schema: Type.Literal(schema), ...envelopeFields, body });
export const SmsRecordDraftSchema = Type.Union([
  kindBody('hazard', 'sms.hazard.1', HazardBodySchema),
  kindBody('risk_matrix', 'sms.risk-matrix.1', RiskMatrixBodySchema),
  kindBody('document', 'sms.document.1', DocumentBodySchema),
  kindBody('document', 'sms.document.2', DocumentBodyV2Schema),
  kindBody('report', 'sms.report.1', ReportBodySchema),
  kindBody('control', 'sms.control.1', ControlBodySchema),
  kindBody('assurance', 'sms.assurance.1', AssuranceBodySchema),
]);
export type SmsRecordDraft = Static<typeof SmsRecordDraftSchema>;

/** The organization's own id for a record, such as H-001. Set once when the record is opened. */
export const SmsRecordReferenceSchema = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: '^\\S(?:.*\\S)?$',
  description:
    "The organization's own id for the record, such as H-001 or IA-2026-02. Set once when it is opened and never revised; no two records of one kind carry the same reference, so opening a second one with it is refused (409 reference_in_use).",
});

export const SmsRecordOpenCommandSchema = strict(
  {
    kind: Type.Literal('sms.record.open'),
    record: SmsRecordDraftSchema,
    confidentiality: Type.Optional(SmsConfidentialitySchema),
    origin: Type.Optional(HazardOriginInputSchema),
    reference: Type.Optional(SmsRecordReferenceSchema),
  },
  'Open an SMS record. Ledger assigns its record class from the kind; status is derived from its decisions. Only a hazard takes an origin; without one it is manual.',
);
export type SmsRecordOpenCommand = Static<typeof SmsRecordOpenCommandSchema>;

export const SmsRecordReviseCommandSchema = strict(
  {
    kind: Type.Literal('sms.record.revise'),
    recordId: Id,
    expectedRevision: Revision,
    record: SmsRecordDraftSchema,
  },
  'Record a new version of an SMS record. Earlier versions stay on the record.',
);
export type SmsRecordReviseCommand = Static<typeof SmsRecordReviseCommandSchema>;

export const SmsAttachmentAddCommandSchema = strict(
  {
    kind: Type.Literal('sms.attachment.add'),
    recordId: Id,
    expectedRevision: Revision,
    attachment: strict({ uploadId: Id, label: Text(200) }),
  },
  'Attach a finalized upload. Its confidentiality is the class declared when the upload was created.',
);
export type SmsAttachmentAddCommand = Static<typeof SmsAttachmentAddCommandSchema>;

export const SmsRecordLinksCommandSchema = strict(
  {
    kind: Type.Literal('sms.record.links'),
    recordId: Id,
    expectedRevision: Revision,
    links: Type.Array(SmsLinkSchema, { maxItems: 50 }),
  },
  'Set the links of an ordinary SMS record. Ledger records which links were added and removed. The record keeps its version, so its signatures and assessments stay current.',
);
export type SmsRecordLinksCommand = Static<typeof SmsRecordLinksCommandSchema>;

const MatrixPosition = strict({ severity: Slug, likelihood: Slug });
export const SignatureIntentSchema = strict(
  {
    intent: Text(2000),
    contentDigest: Digest,
    reviewed: Type.Literal(true),
  },
  'The exact intent statement and content digest the signer was shown. Ledger recomputes both before signing.',
);
export type SignatureIntent = Static<typeof SignatureIntentSchema>;

export const SmsRiskAssessmentDecisionSchema = strict({
  kind: Type.Literal('risk.assess'),
  note: Text(4000),
  matrix: strict({ recordId: Id, versionNumber: VersionNumber }),
  initial: MatrixPosition,
  controls: Type.Array(strict({ recordId: Id, versionNumber: VersionNumber }), {
    minItems: 0,
    maxItems: 30,
    description: 'The current version of each control record on this hazard that the residual risk relies on.',
  }),
  residual: MatrixPosition,
  newHazardCheck: strict({
    answer: literals(['none_identified', 'new_hazards_identified']),
    note: Type.Optional(Text(2000)),
  }),
  evidence: Type.Optional(
    strict(
      { evaluationId: Id },
      'Required for a hazard opened from a finding: the finding evaluation the assessor reviewed. It must still be the latest.',
    ),
  ),
});
export const SmsRiskAcceptanceDecisionSchema = strict({
  kind: Type.Literal('risk.accept'),
  note: Text(4000),
  assessmentId: Id,
  signature: SignatureIntentSchema,
});
export const SmsMatrixAdoptionDecisionSchema = strict({
  kind: Type.Literal('matrix.adopt'),
  note: Text(4000),
  versionNumber: VersionNumber,
  signature: SignatureIntentSchema,
});
export const SmsDocumentAdoptionDecisionSchema = strict({
  kind: Type.Literal('document.adopt'),
  note: Text(4000),
  versionNumber: VersionNumber,
  signature: SignatureIntentSchema,
});
export const SmsAssuranceSignDecisionSchema = strict(
  {
    kind: Type.Literal('assurance.sign'),
    note: Text(4000),
    versionNumber: VersionNumber,
    signature: SignatureIntentSchema,
  },
  'Sign the current version of a safety assurance record. Signing sets the actions it lists.',
);
export const SmsActionCloseDecisionSchema = strict(
  {
    kind: Type.Literal('action.close'),
    note: Text(4000, { description: 'What was done.' }),
    actionId: AssuranceItemIdSchema,
  },
  'Record what was done on an open action of a safety assurance record and close it. Its owner or the record’s owner closes it.',
);
export const SmsDocumentReviewDecisionSchema = strict({
  kind: Type.Literal('document.review'),
  note: Text(4000),
  versionNumber: VersionNumber,
  attachmentIds: Type.Array(Id, { maxItems: 100, uniqueItems: true }),
});
export const SmsDocumentIssueDecisionSchema = strict({
  kind: Type.Literal('document.issue'),
  note: Text(4000),
  versionNumber: VersionNumber,
  adoptionId: Id,
  effectiveFrom: Type.Optional(Time),
  effectiveUntil: Type.Optional(Time),
  recipientIds: Type.Array(Id, { maxItems: 1000, uniqueItems: true }),
  acknowledgementDueAt: Type.Optional(Time),
});
export const SmsDocumentDistributionDecisionSchema = strict({
  kind: Type.Literal('document.distribute'),
  note: Text(4000),
  issueId: Id,
  recipientIds: Type.Array(Id, { minItems: 1, maxItems: 1000, uniqueItems: true }),
  acknowledgementDueAt: Type.Optional(Time),
});
export const SmsDocumentWithdrawalDecisionSchema = strict({
  kind: Type.Literal('document.withdraw'),
  note: Text(4000),
  issueId: Id,
});
export const SmsDocumentPeriodicReviewDecisionSchema = strict(
  {
    kind: Type.Literal('document.periodic-review'),
    note: Text(4000),
    issueId: Id,
    nextReviewDueAt: Time,
  },
  'Record that the revision in force was reviewed and remains current, and when it is next due for review.',
);
export const SmsCloseCitationSchema = strict(
  { id: Id, digest: Digest },
  'A recorded review of an indicator result for a control the hazard’s latest risk acceptance binds, by its id and record digest. Only closing a hazard may cite one.',
);
export type SmsCloseCitation = Static<typeof SmsCloseCitationSchema>;
export const SmsStatusDecisionSchema = strict({
  kind: literals(['record.close', 'record.reopen']),
  note: Text(4000),
  review: Type.Optional(SmsCloseCitationSchema),
});
export const SmsDecisionCommandSchema = strict(
  {
    kind: Type.Literal('decision.record'),
    subject: strict({ kind: Type.Literal('sms'), id: Id }),
    expectedRevision: Revision,
    expectedDependencyBasis: Digest,
    decision: Type.Union([
      SmsRiskAssessmentDecisionSchema,
      SmsRiskAcceptanceDecisionSchema,
      SmsMatrixAdoptionDecisionSchema,
      SmsDocumentAdoptionDecisionSchema,
      SmsDocumentReviewDecisionSchema,
      SmsDocumentIssueDecisionSchema,
      SmsDocumentDistributionDecisionSchema,
      SmsDocumentWithdrawalDecisionSchema,
      SmsDocumentPeriodicReviewDecisionSchema,
      SmsAssuranceSignDecisionSchema,
      SmsActionCloseDecisionSchema,
      SmsStatusDecisionSchema,
    ]),
  },
  'Record a basis-pinned decision on an SMS record. Risk levels are computed by Ledger from the cited matrix version.',
);
export type SmsDecisionCommand = Static<typeof SmsDecisionCommandSchema>;
export type SmsDecisionInput = SmsDecisionCommand['decision'];

export const SmsDocumentAcknowledgeCommandSchema = strict(
  {
    kind: Type.Literal('sms.document.acknowledge'),
    recordId: Id,
    issueId: Id,
    contentDigest: Digest,
    note: Type.Optional(Text(4000)),
  },
  'Record your own acknowledgement of an issued document revision, bound to its issued content digest. Ledger writes the acknowledgement statement. It does not change the document, so work others have open on it stays current.',
);
export type SmsDocumentAcknowledgeCommand = Static<typeof SmsDocumentAcknowledgeCommandSchema>;

export const SmsCommandSchemas = [
  SmsRecordOpenCommandSchema,
  SmsRecordReviseCommandSchema,
  SmsAttachmentAddCommandSchema,
  SmsRecordLinksCommandSchema,
  SmsDecisionCommandSchema,
  SmsDocumentAcknowledgeCommandSchema,
] as const;

export interface SmsPersonRef {
  id: string;
  name: string;
}
export interface MatrixVersionRef {
  recordId: string;
  versionNumber: number;
  bodyDigest: string;
}
export interface AssessedPosition {
  severity: string;
  likelihood: string;
  /** The matrix's own level id. */
  level: string;
  /** Who may accept a risk at that level, as the assessed matrix version says. */
  acceptance: RiskAcceptance;
}
export interface SmsAssessmentOutcome {
  matrix: MatrixVersionRef;
  initial: AssessedPosition;
  controls: SmsAssessedControl[];
  residual: AssessedPosition;
  newHazardCheck: { answer: 'none_identified' | 'new_hazards_identified'; note?: string };
  assessedVersion: { versionNumber: number; bodyDigest: string };
  /** For a hazard opened from a finding: the finding evaluation current when it was assessed. */
  evidence?: SmsEvidencePin;
}
/** A control version as an assessment lists it and a risk acceptance binds it. */
export interface SmsAssessedControl {
  recordId: string;
  versionNumber: number;
  bodyDigest: string;
  title: string;
  controlType: { id: string; version: number; digest: string };
  /** The control type's title, for a reader. */
  type: string;
  /** The control as its type describes it to a person. */
  description: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
/** A control record on a hazard, as the hazard's page lists it. */
export interface SmsHazardControl {
  id: string;
  title: string;
  status: string;
  versionNumber: number;
  bodyDigest: string;
  owner: SmsPersonRef;
  /** title is null when this process has no registration for the pinned type. */
  controlType: { id: string; version: number; digest: string; title: string | null };
  parameters: Record<string, unknown>;
  description: string | null;
  /**
   * The control in the words a person knows its parameters by, such as registered titles, when its type gives them.
   * Read now and never recorded; description keeps the recorded names.
   */
  wording?: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  /** This version is bound by the hazard's latest risk acceptance. */
  accepted: boolean;
}
export interface SmsEvidencePin {
  findingId: string;
  findingKind: (typeof findingKindValues)[number];
  evaluationId: string;
  evaluationDigest: string;
  evaluationRecordedAt: string;
}
export interface SmsAcceptanceOutcome {
  assessmentId: string;
  assessmentDigest: string;
  matrix: MatrixVersionRef;
  /** The matrix's own level id. */
  level: string;
  /** The authority the risk was accepted under. */
  acceptance: RiskAuthority;
}
export interface SmsMatrixAdoptionOutcome {
  matrix: MatrixVersionRef;
  attachments: { id: string; sha256: string }[];
}
export interface SmsDocumentAdoptionOutcome {
  document: MatrixVersionRef;
  attachments: { id: string; sha256: string }[];
  reviewId?: string;
}
export interface SmsAssuranceSignOutcome {
  assurance: MatrixVersionRef;
  attachments: { id: string; sha256: string }[];
}
export interface SmsActionCloseOutcome {
  actionId: string;
  /** The action as the signed version that set it holds it. */
  action: { what: string; ownerId: string; dueOn: string; findingId: string | null };
  setIn: { versionNumber: number; bodyDigest: string };
}
export interface SmsDocumentReviewOutcome {
  document: MatrixVersionRef;
  attachments: { id: string; sha256: string }[];
}
export interface SmsDocumentRecipient {
  id: string;
  name: string;
  principalRevision: number;
}
export interface SmsDocumentIssueOutcome {
  document: MatrixVersionRef;
  adoptionId: string;
  reviewId: string;
  contentDigest: string;
  attachments: { id: string; sha256: string }[];
  effectiveFrom: string;
  effectiveUntil: string | null;
  supersedes: string | null;
  recipients: SmsDocumentRecipient[];
  acknowledgementDueAt: string | null;
}
export interface SmsDocumentDistributionOutcome {
  issueId: string;
  recipients: SmsDocumentRecipient[];
  acknowledgementDueAt: string | null;
}
export interface SmsDocumentWithdrawalOutcome {
  issueId: string;
}
export interface SmsDocumentPeriodicReviewOutcome {
  issueId: string;
  versionNumber: number;
  contentDigest: string;
  nextReviewDueAt: string;
}
export interface SmsStatusOutcome {
  status: string;
  priorStatus: string;
  /** Closing a hazard citing a review of a control's indicator result. */
  review?: SmsCloseCitation & { conclusion: 'effective' | 'ineffective' | 'inconclusive'; controlId: string };
}
/** A review the hazard's owner may cite when closing it. */
export interface SmsClosingReview {
  id: string;
  digest: string;
  conclusion: 'effective' | 'ineffective' | 'inconclusive';
  recordedAt: string;
  reviewer: string;
  control: { id: string; title: string; versionNumber: number };
  resultStatus: string;
}
export interface SmsAuthoritySnapshot {
  policyVersion: string;
  principalId: string;
  name: string;
  kind: string;
  principalRevision: number;
  capabilities: string[];
  checkedCapabilities: string[];
  satisfyingCapability?: string;
}
export interface SmsDecisionRecord {
  version: 'sms.decision.1';
  id: string;
  subjectId: string;
  kind:
    | 'risk.assess'
    | 'risk.accept'
    | 'matrix.adopt'
    | 'document.adopt'
    | 'document.review'
    | 'document.issue'
    | 'document.distribute'
    | 'document.withdraw'
    | 'document.periodic-review'
    | 'assurance.sign'
    | 'action.close'
    | 'record.close'
    | 'record.reopen';
  note: string;
  acceptedRevision: number;
  acceptedBasisRevision: number;
  outcome:
    | SmsAssessmentOutcome
    | SmsAcceptanceOutcome
    | SmsMatrixAdoptionOutcome
    | SmsDocumentAdoptionOutcome
    | SmsDocumentReviewOutcome
    | SmsDocumentIssueOutcome
    | SmsDocumentDistributionOutcome
    | SmsDocumentWithdrawalOutcome
    | SmsDocumentPeriodicReviewOutcome
    | SmsAssuranceSignOutcome
    | SmsActionCloseOutcome
    | SmsStatusOutcome;
  actor: SmsAuthoritySnapshot;
  dependencyBasis: string;
  signature?: { id: string; contentDigest: string };
  recordedAt: string;
}
/** A reader's personal receipt for one issue. It is retained beside the document, not as a change to it. */
export interface SmsDocumentAcknowledgement {
  version: 'sms.document-acknowledgement.1';
  id: string;
  recordId: string;
  issueId: string;
  contentDigest: string;
  statement: string;
  note: string | null;
  actor: SmsAuthoritySnapshot;
  recordedAt: string;
}
/**
 * A document's revision as a sentence names it: a label that is a bare number or code ("3", "B") is "revision 3", a
 * label in words ("Revision 1", "OEM Revision 4") is kept as written, and a document with no label is named by its
 * version.
 */
export function revisionWords(revisionLabel: string | null | undefined, versionNumber: number): string {
  const label = revisionLabel?.trim();
  if (!label) return `version ${versionNumber}`;
  return /\s/.test(label) ? label : `revision ${label}`;
}

export function documentAcknowledgementStatement(issue: {
  title: string;
  revisionLabel: string | null;
  versionNumber: number;
  attachmentIds: string[];
}): string {
  const revision = revisionWords(issue.revisionLabel, issue.versionNumber);
  const files = issue.attachmentIds.length ? ', including its issued files' : '';
  return `I have read ${issue.title}, ${revision}${files}.`;
}
export interface SignatureBinding {
  kind: 'record_version' | 'decision' | 'attachment';
  attachmentId?: string;
  sha256?: string;
  recordId?: string;
  versionNumber?: number;
  bodyDigest?: string;
  decisionId?: string;
  outcomeDigest?: string;
}
export const signingMeaningValues = ['risk.accept', 'matrix.adopt', 'document.adopt', 'assurance.sign'] as const;
export type SigningMeaning = (typeof signingMeaningValues)[number];
export interface SignedContent {
  version: 'sms.signed-content.1';
  meaning: SigningMeaning;
  intent: string;
  tenantId: string;
  subject: { id: string; kind: SmsRecordKind; revision: number; title: string };
  signer: { id: string; name: string };
  bindings: SignatureBinding[];
  statement: Record<string, unknown>;
}
export interface ReauthenticationEvidence {
  method: 'openid_connect' | 'local_fixture';
  verifiedAt: string;
  /** For openid_connect: when the person signed in again at the identity provider (the token's auth_time). */
  authenticatedAt?: string;
  grantId?: string;
}
export interface SmsSignatureRecord {
  id: string;
  decisionId: string;
  subjectId: string;
  subjectRevision: number;
  signer: SmsPersonRef;
  meaning: SignedContent['meaning'];
  intent: string;
  content: SignedContent;
  contentDigest: string;
  authority: SmsAuthoritySnapshot;
  reauthentication: ReauthenticationEvidence;
  signedAt: string;
}
export interface SmsRecordVersion {
  id: string;
  versionNumber: number;
  revision: number;
  schema: string;
  title: string;
  /** Null for a restricted record; its title, body and links come only from the audited content read. */
  body: Record<string, unknown> | null;
  bodyDigest: string;
  owner: SmsPersonRef;
  dueAt: string | null;
  links: SmsLink[];
  recordedBy: SmsPersonRef;
  recordedAt: string;
}
export interface SmsRecordContentVersion {
  id: string;
  versionNumber: number;
  title: string;
  body: Record<string, unknown>;
  links: SmsLink[];
  contentDigest: string;
}
export interface SmsRecordContentResponse {
  recordId: string;
  confidentiality: SmsConfidentiality;
  versions: SmsRecordContentVersion[];
  disclosedAt: string;
}
export interface SmsAttachment {
  id: string;
  documentVersion?: { versionNumber: number; bodyDigest: string };
  label: string;
  confidentiality: SmsConfidentiality;
  sha256: string;
  byteLength: number;
  contentType: string;
  revision: number;
  recordedBy: SmsPersonRef;
  recordedAt: string;
  readable: boolean;
}
export interface SmsAction {
  available: boolean;
  reason?: string;
}
export interface SmsLinkedRecord {
  id: string;
  kind: SmsRecordKind;
  title: string;
  status: string;
  confidentiality: SmsConfidentiality;
}
/** A current link. `record` describes an SMS record target in plain words. */
export type SmsCurrentLink = SmsLink & { record?: SmsLinkedRecord };
export interface SmsLinkedFrom {
  relation: SmsLink['relation'];
  record: SmsLinkedRecord;
}
export interface SmsLinkChange {
  id: string;
  revision: number;
  added: SmsCurrentLink[];
  removed: SmsCurrentLink[];
  recordedBy: SmsPersonRef;
  recordedAt: string;
}
export interface SmsRecordSummary {
  id: string;
  kind: SmsRecordKind;
  /** The organization's own id for the record, when it was opened with one. */
  reference: string | null;
  title: string;
  status: string;
  recordClass: SmsRecordClass;
  confidentiality: SmsConfidentiality;
  owner: SmsPersonRef;
  dueAt: string | null;
  overdue: boolean;
  revision: number;
  projectedRevision: number;
  versionNumber: number;
  openedAt: string;
  updatedAt: string;
  residual?: AssessedPosition;
  /** Present on hazards: where the hazard came from. Hazards recorded before origins existed are manual. */
  origin?: SmsRecordOriginSummary;
  waitingOnMe: boolean;
  /** Present on documents in the documents register. */
  document?: SmsDocumentSummary;
  /** Present on safety assurance records: their type and the actions open and overdue. */
  assurance?: SmsAssuranceSummary;
}
export interface SmsAssuranceSummary {
  assuranceType: AssuranceType;
  /** Actions set by a signature and not closed. */
  openActions: number;
  overdueActions: number;
}
/** An action of a safety assurance record, as its page shows it. */
export interface SmsAssuranceActionView {
  id: string;
  what: string;
  owner: SmsPersonRef;
  dueOn: string;
  findingId: string | null;
  /** proposed: on a version no one has signed yet; open: set by a signature; closed: what was done is recorded. */
  state: 'proposed' | 'open' | 'closed';
  overdue: boolean;
  /** The signed version that set it. */
  setIn: number | null;
  closed: { decisionId: string; by: SmsPersonRef; at: string; note: string } | null;
  close: SmsAction;
}
export interface SmsAssuranceView {
  assuranceType: AssuranceType;
  /** The latest signed version, or null before any signature. */
  signedVersion: number | null;
  actions: SmsAssuranceActionView[];
  /** Hazards opened from a finding or an action of this record. */
  hazards: { item: AssuranceItemRef; record: { id: string; title: string; status: string } }[];
}
/** An open action due within 30 days or overdue, as the Safety home lists it under its owner. */
export interface SmsAssuranceActionDue {
  recordId: string;
  recordTitle: string;
  assuranceType: AssuranceType;
  actionId: string;
  what: string;
  dueOn: string;
  overdue: boolean;
}
export interface SmsDocumentIssueRef {
  issueId: string;
  versionNumber: number;
  revisionLabel: string | null;
  effectiveFrom: string;
}
export interface SmsDocumentSummary {
  documentType: DocumentType;
  documentNumber: string | null;
  origin: 'authored' | 'received';
  inForce: SmsDocumentIssueRef | null;
  scheduled: SmsDocumentIssueRef | null;
  reviewDueAt: string | null;
  /** Readers of the in-force and scheduled issues, for people who control documents. */
  reading: { assigned: number; acknowledged: number; overdue: number } | null;
}
export interface SmsAdoptedMatrix {
  record: SmsRecordSummary;
  version: SmsRecordVersion & { body: RiskMatrixBody };
  adoption: SmsDecisionRecord;
  signature: SmsSignatureRecord | null;
}
export interface SmsBasis {
  revision: number;
  dependencyBasis: string;
}
export const smsDocumentIssueStatusValues = [
  'current',
  'scheduled',
  'expired',
  'superseded',
  'retired',
  'withdrawn',
] as const;
export type SmsDocumentIssueStatus = (typeof smsDocumentIssueStatusValues)[number];
export interface SmsDocumentIssue {
  id: string;
  versionNumber: number;
  revisionLabel: string | null;
  title: string;
  status: SmsDocumentIssueStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  adoptionId: string;
  reviewId: string;
  contentDigest: string;
  attachmentIds: string[];
  supersedes: string | null;
  issuedBy: SmsPersonRef;
  issuedAt: string;
  recipients: (SmsDocumentRecipient & {
    assignedAt: string;
    dueAt: string | null;
    acknowledgedAt: string | null;
    acknowledgementId: string | null;
  })[];
}
export interface SmsDocumentControl {
  issues: SmsDocumentIssue[];
  effectiveIssue: SmsDocumentIssue | null;
  /** Review and signature of the working version since the document was last retired. */
  latestReview: SmsDecisionRecord | null;
  latestAdoption: SmsDecisionRecord | null;
  acknowledgements: SmsDocumentAcknowledgement[];
  /** When the revision in force is next due for periodic review. */
  reviewDueAt: string | null;
}
export interface SmsDocumentReviewDue extends SmsDocumentIssueRef {
  recordId: string;
  title: string;
  reviewDueAt: string;
  overdue: boolean;
}
export interface SmsPersonReading {
  person: SmsPersonRef;
  overdue: number;
  documents: (SmsDocumentIssueRef & { recordId: string; title: string; dueAt: string | null })[];
}
export interface SmsDocumentReadingProgress {
  recordId: string;
  title: string;
  issueId: string;
  versionNumber: number;
  revisionLabel: string | null;
  status: SmsDocumentIssueStatus;
  effectiveFrom: string;
  assigned: number;
  acknowledged: number;
  overdue: number;
  nextDueAt: string | null;
}
export interface SmsDocumentAssignment {
  recordId: string;
  title: string;
  issueId: string;
  versionNumber: number;
  revisionLabel: string | null;
  contentDigest: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  dueAt: string | null;
  acknowledgedAt: string | null;
  status: SmsDocumentIssueStatus;
}
export const SmsNewerRecordSchema = strict({
  eventId: Id,
  eventType: Type.String(),
  streamId: Id,
  sequence: Type.Integer({ minimum: 1 }),
  recordedAt: Time,
});
export type SmsNewerRecord = Static<typeof SmsNewerRecordSchema>;
const EvaluationRefSchema = strict({ id: Id, digest: Digest, recordedAt: Time });
export const SmsEvidenceComparisonSchema = strict(
  {
    pinned: EvaluationRefSchema,
    latestEvaluation: EvaluationRefSchema,
    newerEvaluation: Type.Boolean({ description: 'The finding has been evaluated again since the pin.' }),
    newerRecords: Type.Array(SmsNewerRecordSchema, {
      maxItems: 50,
      description:
        'Records accepted after the pinned evaluation on any stream it read, oldest first. Any of them may change what the rule would say.',
    }),
    newerRecordsTruncated: Type.Boolean(),
    sourceProjectionPending: Type.Boolean({
      description: 'A stream the pinned evaluation read has accepted records not yet projected.',
    }),
  },
  'One pinned finding evaluation compared with what was recorded after it.',
);
export type SmsEvidenceComparison = Static<typeof SmsEvidenceComparisonSchema>;
export const SmsHazardEvidenceSchema = strict(
  {
    sinceOpened: SmsEvidenceComparisonSchema,
    sinceAssessed: Type.Union([SmsEvidenceComparisonSchema, Type.Null()]),
    hazardProjectionPending: Type.Boolean(),
  },
  'Newer evidence since a hazard opened from a finding was opened and since it was last assessed.',
);
export type SmsHazardEvidence = Static<typeof SmsHazardEvidenceSchema>;

export interface SmsRecordDetailResponse {
  record: SmsRecordSummary;
  /** Present on hazards. Hazards recorded before origins existed are manual. */
  origin?: HazardOrigin;
  /** Present on hazards opened from a finding. */
  evidence?: SmsHazardEvidence;
  current: SmsRecordVersion;
  versions: SmsRecordVersion[];
  /** Empty for a restricted record; its links are part of its restricted content. */
  links: SmsCurrentLink[];
  /** Ordinary records whose current links point at this record. */
  linkedFrom: SmsLinkedFrom[];
  linkChanges: SmsLinkChange[];
  attachments: SmsAttachment[];
  decisions: SmsDecisionRecord[];
  signatures: SmsSignatureRecord[];
  matrix: SmsAdoptedMatrix | null;
  assessedMatrix: (SmsRecordVersion & { body: RiskMatrixBody }) | null;
  documentControl?: SmsDocumentControl;
  /** Present on hazards: the control records proposed on it, newest first. */
  controls?: SmsHazardControl[];
  /** Present on hazards: recorded reviews of indicator results for the accepted controls, newest first. */
  closingReviews?: SmsClosingReview[];
  /** Present on hazards and controls: the control types a control may be proposed with. */
  controlTypes?: ControlTypeDefinition[];
  /** Present on hazards and controls: the registered observation types a control parameter may name, by title. */
  observationTypes?: ObservationTypeChoice[];
  /** Present on safety assurance records. */
  assurance?: SmsAssuranceView;
  actions: {
    revise: SmsAction;
    proposeControl: SmsAction;
    link: SmsAction;
    attach: SmsAction;
    assess: SmsAction;
    accept: SmsAction;
    adopt: SmsAction;
    close: SmsAction;
    reopen: SmsAction;
    export: SmsAction;
    readContent: SmsAction;
  };
  basis: SmsBasis;
  computedAt: string;
}
export interface SmsRecordOriginSummary {
  kind: HazardOrigin['kind'];
  findingId?: string;
  /** Present on a finding origin: the subject the finding is about, such as a flight. */
  subject?: SubjectReference;
}
export interface SmsRegisterResponse {
  records: SmsRecordSummary[];
  limit: number;
  hasMore: boolean;
  /** Send as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
  computedAt: string;
}
export interface SmsHomeResponse {
  program: { active: boolean; matrix: SmsAdoptedMatrix | null };
  /**
   * People who may read safety records, with what each may do there: the highest risk level they may accept, and
   * whether they adopt documentation, configure safety records, write them and read safety reports.
   */
  people: (SmsPersonRef & {
    authority: RiskAuthority | null;
    adopts: boolean;
    configures: boolean;
    writes: boolean;
    readsReports: boolean;
  })[];
  attention: {
    waitingOnMe: SmsRecordSummary[];
    awaitingAcceptance: SmsRecordSummary[];
    needsAssessment: SmsRecordSummary[];
    documentsAwaitingAdoption: SmsRecordSummary[];
    /** Controlled document revisions to review or to issue, for people who control documents. */
    documentsToReview: SmsRecordSummary[];
    documentsToIssue: SmsRecordSummary[];
    overdue: SmsRecordSummary[];
    /** Counted open findings about any subject that nobody owns, for people who read evidence. */
    findingsWithoutOwner?: number;
  };
  reading?: SmsDocumentAssignment[];
  /** In-force and scheduled issues with readers still to acknowledge, for people who control documents. */
  readingProgress?: SmsDocumentReadingProgress[];
  /** People with outstanding reading, most overdue first, for people who control documents. */
  readingByPerson?: SmsPersonReading[];
  /** Revisions in force whose periodic review is due within 30 days or overdue, for people who control documents. */
  reviewsDue?: SmsDocumentReviewDue[];
  /** Open safety assurance actions due within 30 days or overdue, by owner, the owners with overdue actions first. */
  assuranceActions: { owner: SmsPersonRef; actions: SmsAssuranceActionDue[] }[];
  /** The reporting links that take reports now, by label. */
  reportLinks: SafetyReportLinkInForce[];
  capabilities: string[];
  computedAt: string;
}
export interface SmsSigningPreviewResponse {
  meaning: SignedContent['meaning'];
  available: boolean;
  reason?: string;
  content: SignedContent | null;
  contentDigest: string | null;
  intent: string | null;
  reauthentication: 'openid_connect' | 'local_fixture';
  basis: SmsBasis;
}
export const SmsSigningPreviewQuerySchema = strict({
  meaning: literals(signingMeaningValues),
});
export type SmsSigningPreviewQuery = Static<typeof SmsSigningPreviewQuerySchema>;
export const SmsRegisterQuerySchema = strict({
  kind: Type.Optional(literals(smsRecordKindValues)),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 200 })),
  cursor: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, description: 'The nextCursor of the previous page.' }),
  ),
  findingId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Only hazards promoted from this finding, from any of its evaluations.',
    }),
  ),
  reference: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 80,
      description: "Only the record of this kind that carries the organization's own id.",
    }),
  ),
});
export type SmsRegisterQuery = Static<typeof SmsRegisterQuerySchema>;
export const SmsRecordParamsSchema = strict({ id: Id });
export const SmsExportCreateSchema = Type.Union([
  strict({ recordId: Id }, 'One record and the records it depends on.'),
  strict(
    { period: strict({ from: Time, to: Time }) },
    'Every record with recorded activity from `from` up to `to`, and the records they depend on.',
  ),
]);
export type SmsExportCreate = Static<typeof SmsExportCreateSchema>;
export interface SmsWithheldItem {
  kind: 'attachment' | 'record_body';
  id: string;
  recordId: string;
  confidentiality: SmsConfidentiality;
  sha256: string;
  byteLength?: number;
  reason: string;
}
export interface SmsExportRecord {
  id: string;
  format: 'ledger.sms-export.1';
  recordId: string | null;
  issuedBy: string;
  issuedAt: string;
  bundleSha256: string;
  manifestDigest: string;
  byteLength: number;
  counts: { records: number; decisions: number; signatures: number; attachments: number; withheld: number };
  withheld: SmsWithheldItem[];
  scope: SmsExportScope;
}
export type SmsExportScope =
  | { kind: 'record_closure'; recordId: string; recordIds: string[]; statement: string }
  | {
      kind: 'period';
      from: string;
      to: string;
      selectedRecordIds: string[];
      recordIds: string[];
      statement: string;
    };
export interface SmsExportResponse {
  export: SmsExportRecord;
}
export const LocalReauthenticationSchema = strict(
  { credential: Type.String({ minLength: 1, maxLength: 400 }) },
  'Local development only: re-present the fixture credential to receive a five-minute, single-use signing grant.',
);
export type LocalReauthentication = Static<typeof LocalReauthenticationSchema>;
export interface LocalReauthenticationResponse {
  grant: string;
  expiresAt: string;
}
export const REAUTHENTICATION_HEADER = 'x-ledger-reauthentication';

const AnyObject = Type.Record(Type.String(), Type.Unknown());
const PersonRefSchema = strict({ id: Id, name: Type.String() });
const ActionSchema = strict({ available: Type.Boolean(), reason: Type.Optional(Type.String()) });
const AssessedPositionSchema = strict({
  severity: Slug,
  likelihood: Slug,
  level: Slug,
  acceptance: RiskAcceptanceSchema,
});
const IssueRefFields = {
  issueId: Id,
  versionNumber: VersionNumber,
  revisionLabel: Type.Union([Type.String(), Type.Null()]),
  effectiveFrom: Time,
};
const IssueRefSchema = strict(IssueRefFields);
const Count = Type.Integer({ minimum: 0 });
const SmsDocumentSummarySchema = strict({
  documentType: literals(documentTypeValues),
  documentNumber: Type.Union([Type.String(), Type.Null()]),
  origin: literals(['authored', 'received']),
  inForce: Type.Union([IssueRefSchema, Type.Null()]),
  scheduled: Type.Union([IssueRefSchema, Type.Null()]),
  reviewDueAt: Type.Union([Time, Type.Null()]),
  reading: Type.Union([strict({ assigned: Count, acknowledged: Count, overdue: Count }), Type.Null()]),
});
export const SmsRecordSummarySchema = strict({
  id: Id,
  kind: literals(smsRecordKindValues),
  reference: Type.Union([Type.String(), Type.Null()], { description: "The organization's own id for the record." }),
  title: Type.String(),
  status: Type.String({ description: 'Derived from decisions; never sent by a client.' }),
  recordClass: SmsRecordClassSchema,
  confidentiality: SmsConfidentialitySchema,
  owner: PersonRefSchema,
  dueAt: Type.Union([Time, Type.Null()]),
  overdue: Type.Boolean(),
  revision: Revision,
  projectedRevision: Revision,
  versionNumber: VersionNumber,
  openedAt: Time,
  updatedAt: Time,
  residual: Type.Optional(AssessedPositionSchema),
  origin: Type.Optional(
    strict(
      {
        kind: literals(['finding', 'report', 'assurance', 'manual']),
        findingId: Type.Optional(Id),
        subject: Type.Optional(SubjectReferenceSchema),
      },
      'Present on hazards. A finding origin names the finding and the subject it is about.',
    ),
  ),
  waitingOnMe: Type.Boolean(),
  document: Type.Optional(SmsDocumentSummarySchema),
  assurance: Type.Optional(
    strict({ assuranceType: literals(assuranceTypeValues), openActions: Count, overdueActions: Count }),
  ),
});
const SmsAssuranceActionDueSchema = strict({
  recordId: Id,
  recordTitle: Type.String(),
  assuranceType: literals(assuranceTypeValues),
  actionId: AssuranceItemIdSchema,
  what: Type.String(),
  dueOn: Type.String({ format: 'date' }),
  overdue: Type.Boolean(),
});
const BasisSchema = strict({ revision: Revision, dependencyBasis: Digest });
export const SmsDocumentIssueSchema = strict({
  id: Id,
  versionNumber: VersionNumber,
  revisionLabel: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  status: literals(smsDocumentIssueStatusValues),
  effectiveFrom: Time,
  effectiveUntil: Type.Union([Time, Type.Null()]),
  adoptionId: Id,
  reviewId: Id,
  contentDigest: Digest,
  attachmentIds: Type.Array(Id),
  supersedes: Type.Union([Id, Type.Null()]),
  issuedBy: PersonRefSchema,
  issuedAt: Time,
  recipients: Type.Array(
    strict({
      id: Id,
      name: Type.String(),
      principalRevision: Revision,
      assignedAt: Time,
      dueAt: Type.Union([Time, Type.Null()]),
      acknowledgedAt: Type.Union([Time, Type.Null()]),
      acknowledgementId: Type.Union([Id, Type.Null()]),
    }),
  ),
});
export const SmsDocumentControlSchema = strict({
  issues: Type.Array(SmsDocumentIssueSchema),
  effectiveIssue: Type.Union([SmsDocumentIssueSchema, Type.Null()]),
  latestReview: Type.Union([AnyObject, Type.Null()]),
  latestAdoption: Type.Union([AnyObject, Type.Null()]),
  acknowledgements: Type.Array(AnyObject),
  reviewDueAt: Type.Union([Time, Type.Null()]),
});
const SmsDocumentReviewDueSchema = strict({
  ...IssueRefFields,
  recordId: Id,
  title: Type.String(),
  reviewDueAt: Time,
  overdue: Type.Boolean(),
});
const SmsPersonReadingSchema = strict({
  person: PersonRefSchema,
  overdue: Count,
  documents: Type.Array(
    strict({ ...IssueRefFields, recordId: Id, title: Type.String(), dueAt: Type.Union([Time, Type.Null()]) }),
  ),
});
export const SmsDocumentReadingProgressSchema = strict({
  recordId: Id,
  title: Type.String(),
  issueId: Id,
  versionNumber: VersionNumber,
  revisionLabel: Type.Union([Type.String(), Type.Null()]),
  status: literals(smsDocumentIssueStatusValues),
  effectiveFrom: Time,
  assigned: Type.Integer({ minimum: 0 }),
  acknowledged: Type.Integer({ minimum: 0 }),
  overdue: Type.Integer({ minimum: 0 }),
  nextDueAt: Type.Union([Time, Type.Null()]),
});
export const SmsDocumentAssignmentSchema = strict({
  recordId: Id,
  title: Type.String(),
  issueId: Id,
  versionNumber: VersionNumber,
  revisionLabel: Type.Union([Type.String(), Type.Null()]),
  contentDigest: Digest,
  effectiveFrom: Time,
  effectiveUntil: Type.Union([Time, Type.Null()]),
  dueAt: Type.Union([Time, Type.Null()]),
  acknowledgedAt: Type.Union([Time, Type.Null()]),
  status: literals(smsDocumentIssueStatusValues),
});
export const SmsHomeResponseSchema = strict({
  program: strict({ active: Type.Boolean(), matrix: Type.Union([AnyObject, Type.Null()]) }),
  people: Type.Array(
    strict({
      id: Id,
      name: Type.String(),
      authority: Type.Union([RiskAuthoritySchema, Type.Null()]),
      adopts: Type.Boolean(),
      configures: Type.Boolean(),
      writes: Type.Boolean(),
      readsReports: Type.Boolean(),
    }),
  ),
  attention: strict({
    waitingOnMe: Type.Array(SmsRecordSummarySchema),
    awaitingAcceptance: Type.Array(SmsRecordSummarySchema),
    needsAssessment: Type.Array(SmsRecordSummarySchema),
    documentsAwaitingAdoption: Type.Array(SmsRecordSummarySchema),
    documentsToReview: Type.Array(SmsRecordSummarySchema),
    documentsToIssue: Type.Array(SmsRecordSummarySchema),
    overdue: Type.Array(SmsRecordSummarySchema),
    findingsWithoutOwner: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  reading: Type.Optional(Type.Array(SmsDocumentAssignmentSchema)),
  readingProgress: Type.Optional(Type.Array(SmsDocumentReadingProgressSchema)),
  readingByPerson: Type.Optional(Type.Array(SmsPersonReadingSchema)),
  reviewsDue: Type.Optional(Type.Array(SmsDocumentReviewDueSchema)),
  assuranceActions: Type.Array(strict({ owner: PersonRefSchema, actions: Type.Array(SmsAssuranceActionDueSchema) }), {
    description: 'Open safety assurance actions due within 30 days or overdue, by owner.',
  }),
  reportLinks: Type.Array(SafetyReportLinkInForceSchema),
  capabilities: Type.Array(Type.String()),
  computedAt: Time,
});
export const SmsControlTypeListResponseSchema = strict(
  {
    controlTypes: Type.Array(
      strict({
        ...ControlTypeDefinitionSchema.properties,
        digest: Digest,
        parameterChoices: Type.Optional(Type.Record(Type.String(), ControlParameterChoiceSchema)),
      }),
    ),
  },
  'Every registered control type: what a control of it applies to, the parameters it needs (parameterSchema) and whether a deterministic check follows it against flights. A control names its type by id, version and digest.',
);
export interface SmsControlTypeListResponse {
  controlTypes: ControlTypeDefinition[];
}

export const SmsRegisterResponseSchema = strict({
  records: Type.Array(SmsRecordSummarySchema),
  limit: Type.Integer(),
  hasMore: Type.Boolean(),
  nextCursor: Type.Union([Id, Type.Null()], { description: 'Newest first by opening time; send as cursor.' }),
  computedAt: Time,
});
export const SmsRecordDetailResponseSchema = strict(
  {
    record: SmsRecordSummarySchema,
    origin: Type.Optional(HazardOriginSchema),
    evidence: Type.Optional(SmsHazardEvidenceSchema),
    current: AnyObject,
    versions: Type.Array(AnyObject),
    links: Type.Array(AnyObject),
    linkedFrom: Type.Array(AnyObject),
    linkChanges: Type.Array(AnyObject),
    attachments: Type.Array(AnyObject),
    decisions: Type.Array(AnyObject),
    signatures: Type.Array(AnyObject),
    matrix: Type.Union([AnyObject, Type.Null()]),
    assessedMatrix: Type.Union([AnyObject, Type.Null()]),
    documentControl: Type.Optional(SmsDocumentControlSchema),
    controls: Type.Optional(Type.Array(AnyObject)),
    closingReviews: Type.Optional(Type.Array(AnyObject)),
    controlTypes: Type.Optional(Type.Array(AnyObject)),
    observationTypes: Type.Optional(Type.Array(ObservationTypeChoiceSchema)),
    assurance: Type.Optional(AnyObject),
    actions: strict({
      revise: ActionSchema,
      proposeControl: ActionSchema,
      link: ActionSchema,
      attach: ActionSchema,
      assess: ActionSchema,
      accept: ActionSchema,
      adopt: ActionSchema,
      close: ActionSchema,
      reopen: ActionSchema,
      export: ActionSchema,
      readContent: ActionSchema,
    }),
    basis: BasisSchema,
    computedAt: Time,
  },
  'One SMS record with every version, attachment, decision and signature. Unavailable actions carry the reason.',
);
export const SmsSigningPreviewResponseSchema = strict(
  {
    meaning: literals(signingMeaningValues),
    available: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    content: Type.Union([AnyObject, Type.Null()]),
    contentDigest: Type.Union([Digest, Type.Null()]),
    intent: Type.Union([Type.String(), Type.Null()]),
    reauthentication: literals(['openid_connect', 'local_fixture']),
    basis: BasisSchema,
  },
  'The exact content and intent statement a signature would bind to, computed by Ledger for the signed-in person.',
);
export const SmsExportResponseSchema = strict({
  export: strict({
    id: Id,
    format: Type.Literal('ledger.sms-export.1'),
    recordId: Type.Union([Id, Type.Null()]),
    issuedBy: Id,
    issuedAt: Time,
    bundleSha256: Digest,
    manifestDigest: Digest,
    byteLength: Type.Integer({ minimum: 1 }),
    counts: strict({
      records: Type.Integer(),
      decisions: Type.Integer(),
      signatures: Type.Integer(),
      attachments: Type.Integer(),
      withheld: Type.Integer(),
    }),
    withheld: Type.Array(
      strict({
        kind: literals(['attachment', 'record_body']),
        id: Id,
        recordId: Id,
        confidentiality: SmsConfidentialitySchema,
        sha256: Digest,
        byteLength: Type.Optional(Type.Integer()),
        reason: Type.String(),
      }),
    ),
    scope: Type.Union([
      strict({
        kind: Type.Literal('record_closure'),
        recordId: Id,
        recordIds: Type.Array(Id),
        statement: Type.String(),
      }),
      strict({
        kind: Type.Literal('period'),
        from: Time,
        to: Time,
        selectedRecordIds: Type.Array(Id),
        recordIds: Type.Array(Id),
        statement: Type.String(),
      }),
    ]),
  }),
});
export const LocalReauthenticationResponseSchema = strict({ grant: Type.String(), expiresAt: Time });
export const SmsFindingPromotionParamsSchema = strict({ findingId: Id });
export const SmsFindingPromotionResponseSchema = strict(
  {
    origin: HazardFindingOriginSchema,
    evaluation: strict({
      outcome: Type.String(),
      evidenceState: Type.String(),
      summary: Type.String(),
    }),
    findingStatus: literals(['open', 'acknowledged', 'responding', 'resolved']),
    basis: strict(
      { dependencyBasis: Digest },
      'Send it as expectedDependencyBasis when opening the hazard; it changes when the finding’s evidence does.',
    ),
    existingHazard: Type.Union([strict({ recordId: Id, title: Type.String() }), Type.Null()], {
      description: 'A hazard already opened from this exact evaluation.',
    }),
    computedAt: Time,
  },
  'What promoting a finding to a hazard would record as its origin: the finding’s latest evaluation and the basis to pin.',
);
export type SmsFindingPromotionResponse = Static<typeof SmsFindingPromotionResponseSchema>;
export const SmsRecordContentResponseSchema = strict(
  {
    recordId: Id,
    confidentiality: SmsConfidentialitySchema,
    versions: Type.Array(
      strict({
        id: Id,
        versionNumber: VersionNumber,
        title: Type.String(),
        body: AnyObject,
        links: Type.Array(SmsLinkSchema),
        contentDigest: Digest,
      }),
    ),
    disclosedAt: Time,
  },
  'The restricted title, body and links of every version. Each read is retained as a disclosure to the reader.',
);
