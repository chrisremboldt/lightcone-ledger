import { Type, type Static } from '@sinclair/typebox';
import {
  CheckedRuleLeafSchema,
  ProcedureSourceSchema,
  RetainedDocumentSourceSchema,
  RuleParagraphSchema,
  RuleSectionIdSchema,
} from './checked-rules.js';
import { DocumentPurposeIdSchema, DocumentTypesSchema } from './observations/envelope.js';
import { smsRecordKindValues } from './sms.js';

const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Dependency = Type.Union(
  [
    'flight.activity',
    'flight.scheduledEnd',
    'flight.observations',
    'authorization.status',
    'authorization.scope',
    'command-link.reports',
    'command-link.scope',
    'clock.wall',
  ].map((value) => Type.Literal(value)),
);
const ObservationField = Type.Union(
  ['activity', 'state', 'phase', 'landingTime', 'landedAt'].map((value) => Type.Literal(value)),
);

export const RulePackVersionParamsSchema = Type.Object(
  { packId: Identifier, version: Version },
  { additionalProperties: false },
);
export type RulePackVersionParams = Static<typeof RulePackVersionParamsSchema>;

const FlightObservationBindingSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    inputKind: Type.Literal('flight.observation'),
    supportedFields: Type.Array(ObservationField),
    correctionHandling: Type.Literal('active_claims_selected_by_caller'),
    digest: Digest,
  },
  { additionalProperties: false },
);
const AuthorizationStatusBindingSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    inputKind: Type.Literal('airspace.status'),
    supportedFields: Type.Array(
      Type.Union(
        [
          'authorizationId',
          'status',
          'authorizationRecord.startTime',
          'authorizationRecord.endTime',
          'callback.startTime',
          'callback.duration',
        ].map((value) => Type.Literal(value)),
      ),
    ),
    correctionHandling: Type.Literal('active_claims_selected_by_caller'),
    intervalHandling: Type.Literal('reported_utc_half_open_required', {
      description:
        'The pure check requires an explicit reported UTC interval. Poll records use startTime/endTime; callbacks use startTime plus duration in minutes. Missing intervals stay insufficient.',
    }),
    callbackDurationUnit: Type.Literal('minute'),
    digest: Digest,
  },
  { additionalProperties: false },
);
const CommandLinkStatusBindingSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    inputKind: Type.Literal('command-link.status'),
    supportedFields: Type.Array(
      Type.Union(
        [
          'sourceId',
          'sourceSessionId',
          'occurredAt',
          'subject.flightId',
          'payload.sourceEventId',
          'payload.incidentId',
          'payload.aircraftId',
          'payload.status',
        ].map((value) => Type.Literal(value)),
      ),
    ),
    correctionHandling: Type.Literal('immutable_receipts_selected_by_caller'),
    digest: Digest,
  },
  { additionalProperties: false },
);
export const RulePackBindingSchema = Type.Union([
  FlightObservationBindingSchema,
  AuthorizationStatusBindingSchema,
  CommandLinkStatusBindingSchema,
]);
export type RulePackBinding = Static<typeof RulePackBindingSchema>;

const AutomatedProcedureLeafSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    title: Identifier,
    source: Type.Object(
      {
        kind: Type.Literal('operator_procedure'),
        reference: Identifier,
        text: Type.String(),
        encoding: Type.Literal('utf-8'),
        byteLength: Type.Integer({ minimum: 0 }),
        sha256: Digest,
        textSpan: Type.Object(
          {
            start: Type.Integer({ minimum: 0 }),
            end: Type.Integer({ minimum: 0 }),
            unit: Type.Literal('utf8_byte'),
          },
          { additionalProperties: false, description: 'Zero-based half-open byte offsets into this source text.' },
        ),
      },
      { additionalProperties: false },
    ),
    review: Type.Literal('ai_drafted'),
    adopted: Type.Literal(false),
    bindingId: Identifier,
    bindingVersion: Version,
    bindingDigest: Digest,
    dependencies: Type.Array(Dependency),
    coverage: Type.Literal('automated', { description: 'This demo procedure has an implemented evaluator check.' }),
    section: Type.Optional(RuleSectionIdSchema),
    paragraph: Type.Optional(RuleParagraphSchema),
    digest: Digest,
  },
  { additionalProperties: false },
);
const RegulatoryCoverageLeafSchema = Type.Object(
  {
    id: Identifier,
    version: Version,
    title: Identifier,
    source: Type.Union([RetainedDocumentSourceSchema, ProcedureSourceSchema], {
      description:
        'A quoted paragraph of a retained regulatory document, or an organization’s own provision carried whole, as a pack file carries it.',
    }),
    review: Type.Literal('ai_drafted'),
    adopted: Type.Literal(false),
    dependencies: Type.Array(Dependency, { maxItems: 0 }),
    coverage: Type.Union([Type.Literal('manual'), Type.Literal('unsupported')], {
      description: 'manual: a person checks it. unsupported: no record type or check kind covers it yet.',
    }),
    waitingFor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1000,
        description:
          'manual: what the person confirms, and why no record shows it. unsupported: what Ledger would need to check it. Absent on leaves of built-in packs, which state it beside the pack.',
      }),
    ),
    section: Type.Optional(RuleSectionIdSchema),
    paragraph: Type.Optional(RuleParagraphSchema),
    digest: Digest,
  },
  {
    additionalProperties: false,
    description: 'A provision the rule pack carries that no check runs: a person checks it, or nothing covers it yet.',
  },
);
export const RulePackLeafSchema = Type.Union([
  AutomatedProcedureLeafSchema,
  RegulatoryCoverageLeafSchema,
  CheckedRuleLeafSchema,
]);
export type RulePackLeaf = Static<typeof RulePackLeafSchema>;

/** The largest number of sections a pack version declares. */
export const RULE_PACK_SECTION_LIMIT = 100;

export const RulePackSectionSchema = Type.Object(
  {
    id: RuleSectionIdSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        'The section as a person reads it as a heading, such as “§ 108.40 Operator recordkeeping requirements”.',
    }),
  },
  { additionalProperties: false, description: 'A section of a pack version: its rules are read together under it.' },
);
export type RulePackSection = Static<typeof RulePackSectionSchema>;

export const RulePackPurposeSchema = Type.Object(
  {
    id: DocumentPurposeIdSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'What a person calls a document serving this purpose, such as "Safety policy".',
    }),
    documentTypes: Type.Optional(DocumentTypesSchema),
    source: Type.Union([RetainedDocumentSourceSchema, ProcedureSourceSchema], {
      description: 'The paragraph or provision the purpose is quoted from.',
    }),
  },
  {
    additionalProperties: false,
    description:
      'A purpose a controlled document can serve, which the pack looks for. A person ticks the purposes a document serves when editing it; a rule asks whether a document serving the purpose is in force.',
  },
);
export type RulePackPurpose = Static<typeof RulePackPurposeSchema>;

/** The pattern of an operator record type's name, such as `flight.record`. */
const RecordTypeName = Type.String({ pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$', minLength: 3, maxLength: 120 });

export const RequiredRecordHolderSchema = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal('operator_record'), recordType: RecordTypeName },
      { additionalProperties: false, description: 'An operator record type, by name.' },
    ),
    Type.Object(
      {
        kind: Type.Literal('safety_record'),
        recordKind: Type.Union(smsRecordKindValues.map((value) => Type.Literal(value))),
      },
      { additionalProperties: false, description: 'One of Ledger’s own safety records, by kind.' },
    ),
  ],
  { description: 'A kind of Ledger record that holds a required record.' },
);
export type RequiredRecordHolder = Static<typeof RequiredRecordHolderSchema>;

const QuotedSourceSchema = Type.Union([RetainedDocumentSourceSchema, ProcedureSourceSchema]);

export const RulePackRequiredRecordSchema = Type.Object(
  {
    id: DocumentPurposeIdSchema,
    title: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'What must be kept, in plain words, such as "Record of each flight".',
    }),
    source: Type.Union([RetainedDocumentSourceSchema, ProcedureSourceSchema], {
      description: 'The paragraph or provision that lists the record, quoted as rules quote.',
    }),
    keptBy: Type.String({
      minLength: 1,
      maxLength: 300,
      description: 'Who the text says keeps it, in the text’s own words.',
    }),
    heldBy: Type.Array(RequiredRecordHolderSchema, { minItems: 1, maxItems: 20 }),
    retention: Type.Optional(
      Type.Object(
        { source: QuotedSourceSchema },
        {
          additionalProperties: false,
          description:
            'The words that say how long the record is kept, quoted and pinned. Absent when the text states no period. Ledger computes nothing from them and removes nothing.',
        },
      ),
    ),
  },
  {
    additionalProperties: false,
    description:
      'A record the pack’s text requires the organization to keep: the paragraph that lists it, who keeps it, the Ledger records that hold it, and how long the text says it is kept (docs/design/required-records.md).',
  },
);
export type RulePackRequiredRecord = Static<typeof RulePackRequiredRecordSchema>;

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * A quoted paragraph as a person reads it. A paragraph quoted from a retained XML or HTML document carries that
 * document's element tags, such as a paragraph or page marker; the pinned quote keeps them, and this drops them,
 * puts a paragraph break between paragraphs and reads character entities. Text without tags that was wrapped to a
 * line length, each wrapped line ending in a space, has its lines joined and its paragraphs kept; any other text
 * without tags is returned as it is.
 */
export function readableQuote(text: string): string {
  const tag = /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?\/?>/g;
  if (!tag.test(text)) {
    // Plain text wrapped to a line length ends a wrapped line with a space; a paragraph ends without one.
    const joined = text.replace(/[ \t]+\n(?=\S)/g, ' ');
    if (joined === text) return text;
    return joined
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  }
  return text
    .replace(/<[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?\/>/g, '')
    .replace(/<\/(?:P|p|FP|fp)>\s*<(?:P|p|FP|fp)(?:\s[^<>]*)?>/g, '\n\n')
    .replace(tag, '')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#')
        return String.fromCodePoint(
          name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
        );
      return entities[name.toLowerCase()] ?? whole;
    })
    .split('\n\n')
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

const CalendarDate = Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$' });

/** What a waiver's conditions cover: the flights whose latest plan cites the certificate, or every flight. */
export const waiverConditionsCoverValues = ['flights_citing_certificate', 'every_flight'] as const;

export const RulePackWaiverSchema = Type.Object(
  {
    certificateNumber: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'The certificate number as a flight plan cites it in its operating authority reference.',
    }),
    conditionsCover: Type.Union(
      waiverConditionsCoverValues.map((value) => Type.Literal(value)),
      {
        description:
          'flights_citing_certificate: the conditions about a flight cover a flight whose latest plan cites the certificate; for any other flight they do not apply. every_flight: they cover every flight. Conditions about people and aircraft cover those a covered flight names; a condition about the organization is evaluated once for it.',
      },
    ),
    effective: Type.Object(
      { from: CalendarDate, through: CalendarDate },
      {
        additionalProperties: false,
        description:
          'The dates the certificate states it is effective, first and last, as written on it. Ledger shows them and starts an adoption from them; it does not decide whether the waiver is in effect in law.',
      },
    ),
  },
  {
    additionalProperties: false,
    description: 'What a waiver pack states about the waiver it carries. Absent on packs that do not carry a waiver.',
  },
);
export type RulePackWaiver = Static<typeof RulePackWaiverSchema>;

export const RulePackVersionSchema = Type.Object(
  {
    packId: Identifier,
    version: Version,
    title: Identifier,
    status: Type.Union([Type.Literal('draft'), Type.Literal('assembled')], {
      description:
        'draft: a pack offered for adoption. assembled: Ledger assembled it from the controls a person accepted; only the accepted-controls pack carries it, and its versions recorded before this label existed carry draft.',
    }),
    review: Type.Union([Type.Literal('ai_drafted'), Type.Literal('accepted_and_signed')], {
      description:
        'ai_drafted: the text was drafted with assistance and has not been reviewed. accepted_and_signed: every rule quotes a control version a person accepted with a signature; only the accepted-controls pack carries it.',
    }),
    adopted: Type.Literal(false),
    bindings: Type.Array(RulePackBindingSchema),
    leaves: Type.Array(RulePackLeafSchema),
    sections: Type.Optional(
      Type.Array(RulePackSectionSchema, {
        minItems: 1,
        maxItems: RULE_PACK_SECTION_LIMIT,
        description:
          'The sections of the pack version in reading order. Each rule then names one of them. Absent: the rules are read in the order of their paragraphs or provision numbers.',
      }),
    ),
    purposes: Type.Optional(
      Type.Array(RulePackPurposeSchema, {
        maxItems: 100,
        description: 'The document purposes the pack looks for. Absent on packs that look for none.',
      }),
    ),
    requiredRecords: Type.Optional(
      Type.Array(RulePackRequiredRecordSchema, {
        maxItems: 100,
        description: 'The records the pack’s text requires to be kept. Absent on packs that declare none.',
      }),
    ),
    waiver: Type.Optional(RulePackWaiverSchema),
    digest: Digest,
  },
  {
    additionalProperties: false,
    description:
      'An available draft of procedures or proposed-requirement coverage, not an operator adoption. Source SHA-256 hashes exact UTF-8 text bytes. Binding, leaf and pack digests use ledger.v6.sha256.jcs.1 over the object without its own digest; nested digests remain included.',
  },
);
export type RulePackVersion = Static<typeof RulePackVersionSchema>;

export const DocumentPurposesResponseSchema = Type.Object(
  {
    purposes: Type.Array(
      Type.Object(
        {
          id: DocumentPurposeIdSchema,
          title: Type.String({ minLength: 1, maxLength: 200 }),
          documentTypes: Type.Array(Type.String(), {
            description: 'The document types that serve it by being what they are, as any declaring pack names them.',
          }),
          declaredBy: Type.Array(
            Type.Object(
              {
                packId: Identifier,
                version: Version,
                packTitle: Identifier,
                reference: Identifier,
                text: Type.String({ description: 'The paragraph or provision the purpose quotes.' }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1 },
          ),
        },
        { additionalProperties: false },
      ),
      { description: 'Ordered by title, then id.' },
    ),
  },
  {
    additionalProperties: false,
    description:
      'The document purposes the packs the organization has adopted declare (adoptions in effect or still to come), each with the paragraphs it quotes.',
  },
);
export type DocumentPurposesResponse = Static<typeof DocumentPurposesResponseSchema>;

export const RulePackVersionResponseSchema = Type.Object(
  { pack: RulePackVersionSchema },
  { additionalProperties: false },
);
export type RulePackVersionResponse = Static<typeof RulePackVersionResponseSchema>;

export const RulePackOriginSchema = Type.Union(
  [
    Type.Object({ kind: Type.Literal('built_in') }, { additionalProperties: false }),
    Type.Object(
      { kind: Type.Literal('organization_file'), file: Type.String({ minLength: 1, maxLength: 255 }) },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      'Where this Ledger got a pack version. built_in: it ships with Ledger. organization_file: the organization’s own pack file, by its name in the folder LEDGER_PACKS_DIR names.',
  },
);
export type RulePackOrigin = Static<typeof RulePackOriginSchema>;

export const RulePackSummarySchema = Type.Object(
  { packId: Identifier, version: Version, title: Identifier, digest: Digest, origin: RulePackOriginSchema },
  { additionalProperties: false, description: 'One registered pack version; read the version for its rules.' },
);
export type RulePackSummary = Static<typeof RulePackSummarySchema>;
export const RulePackListResponseSchema = Type.Object(
  { packs: Type.Array(RulePackSummarySchema, { maxItems: 500 }) },
  { additionalProperties: false, description: 'Every rule pack version this Ledger can adopt, by pack and version.' },
);
export type RulePackListResponse = Static<typeof RulePackListResponseSchema>;
