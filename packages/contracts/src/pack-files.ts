import { Type, type Static } from '@sinclair/typebox';
import {
  CheckReferenceSchema,
  CheckedRuleLeafSchema,
  RuleNamePattern,
  RuleParagraphSchema,
  RuleSectionIdSchema,
} from './checked-rules.js';
import { DeclaredRecordTypeSchema } from './declared-record-types.js';
import { DocumentPurposeIdSchema, DocumentTypesSchema } from './observations/envelope.js';
import {
  RequiredRecordHolderSchema,
  RULE_PACK_SECTION_LIMIT,
  RulePackSectionSchema,
  RulePackWaiverSchema,
} from './rule-packs.js';

const Closed = { additionalProperties: false } as const;
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Reference = Type.String({ minLength: 1, maxLength: 200 });
const ByteOffset = Type.Integer({ minimum: 0 });

export const PACK_FILE_FORMAT = 'ledger.pack-file.1';
/** A pack file's name in the folder LEDGER_PACKS_DIR names. */
export const PACK_FILE_SUFFIX = '.pack.json';
/** Lowercase words joined by dots or hyphens, as pack, rule and source ids are written. */
export const PackFileIdPattern = '^[a-z0-9]+([.-][a-z0-9]+)*$';
const PackFileId = Type.String({ pattern: PackFileIdPattern, maxLength: 200 });
/** The prefix of the packs that ship with Ledger; a pack file never takes it. */
export const BUILT_IN_PACK_PREFIX = 'ledger.';
/** The largest pack file Ledger reads. */
export const PACK_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const PackFileSourceSchema = Type.Object(
  {
    id: PackFileId,
    kind: Type.Union([Type.Literal('operator_procedure'), Type.Literal('waiver_or_exemption')], {
      description:
        'What the document is: the organization’s own procedure, or a waiver or exemption it holds. Every rule quoting the source takes this as its source kind; only a rule quoting a waiver or exemption may relieve a rule of another pack.',
    }),
    reference: Reference,
    text: Type.String({ maxLength: 1024 * 1024 }),
    encoding: Type.Literal('utf-8'),
    byteLength: ByteOffset,
    sha256: Digest,
  },
  { ...Closed, description: 'A source document kept whole: its text and the SHA-256 of its UTF-8 bytes.' },
);
export type PackFileSource = Static<typeof PackFileSourceSchema>;

export const PackFileQuoteSchema = Type.Object(
  {
    source: PackFileId,
    start: ByteOffset,
    end: ByteOffset,
    reference: Reference,
  },
  {
    ...Closed,
    description:
      'The provision a rule quotes: zero-based half-open UTF-8 byte offsets into one of the file’s sources, and how a reader cites it. The rule’s source text is exactly those bytes.',
  },
);
export type PackFileQuote = Static<typeof PackFileQuoteSchema>;

/**
 * A rule a check runs, as data. Every field a checked rule declares is carried as it is, except what Ledger derives on
 * loading: the source (from the quote), the check kind's definition digest, the review labels and the rule's digest. A
 * field a checked rule gains is carried by the same derivation.
 */
export const PackFileCheckedRuleSchema = Type.Object(
  {
    ...Type.Omit(CheckedRuleLeafSchema, ['source', 'review', 'adopted', 'coverage', 'check', 'digest']).properties,
    id: PackFileId,
    quote: PackFileQuoteSchema,
    check: Type.Object(
      {
        ...Type.Omit(CheckReferenceSchema, ['definitionDigest']).properties,
        written: Type.Optional(
          Type.Record(Type.String({ pattern: RuleNamePattern }), Type.String({ minLength: 1, maxLength: 40 }), {
            description:
              'Each parameter the description wrote with its unit, as written, such as "5 sm". Its value in params is kept in the unit Ledger stores; loading checks the two agree.',
          }),
        ),
      },
      {
        ...Closed,
        description:
          'A check kind this Ledger registers in code, by id and version, and its fixed parameters. A file never carries code.',
      },
    ),
  },
  Closed,
);
export type PackFileCheckedRule = Static<typeof PackFileCheckedRuleSchema>;

/** A provision the pack carries that no check runs: a person checks it, or nothing covers it yet. */
export const PackFileCoverageRuleSchema = Type.Object(
  {
    id: PackFileId,
    version: Version,
    title: Reference,
    quote: PackFileQuoteSchema,
    coverage: Type.Union([Type.Literal('manual'), Type.Literal('unsupported')], {
      description: 'manual: a person checks it. unsupported: no record type or check kind covers it yet.',
    }),
    waitingFor: Type.String({
      minLength: 1,
      maxLength: 1000,
      description: 'manual: what the person confirms. unsupported: what Ledger would need to check it.',
    }),
    section: Type.Optional(RuleSectionIdSchema),
    paragraph: Type.Optional(RuleParagraphSchema),
  },
  Closed,
);
export type PackFileCoverageRule = Static<typeof PackFileCoverageRuleSchema>;

export const PackFileRuleSchema = Type.Union([PackFileCheckedRuleSchema, PackFileCoverageRuleSchema]);
export type PackFileRule = Static<typeof PackFileRuleSchema>;

/** True for a pack file rule a check runs. */
export function isPackFileCheckedRule(rule: PackFileRule): rule is PackFileCheckedRule {
  return 'check' in rule;
}

export const PackFilePurposeSchema = Type.Object(
  {
    id: DocumentPurposeIdSchema,
    title: Reference,
    documentTypes: Type.Optional(DocumentTypesSchema),
    quote: PackFileQuoteSchema,
  },
  {
    ...Closed,
    description:
      'A document purpose the pack looks for, quoting the provision it serves: a person ticks it on a controlled document (docs/design/on-file-checks.md).',
  },
);
export type PackFilePurpose = Static<typeof PackFilePurposeSchema>;

export const PackFileRequiredRecordSchema = Type.Object(
  {
    id: PackFileId,
    title: Reference,
    quote: PackFileQuoteSchema,
    keptBy: Type.String({ minLength: 1, maxLength: 300 }),
    heldBy: Type.Array(RequiredRecordHolderSchema, { minItems: 1, maxItems: 20 }),
    retention: Type.Optional(Type.Object({ quote: PackFileQuoteSchema }, Closed)),
  },
  {
    ...Closed,
    description:
      'A record the provision requires to be kept, quoting the provision that lists it and, when it states one, the words saying how long (docs/design/required-records.md). The id starts with the pack id and a dot.',
  },
);
export type PackFileRequiredRecord = Static<typeof PackFileRequiredRecordSchema>;

export const PackFileSchema = Type.Object(
  {
    format: Type.Literal(PACK_FILE_FORMAT),
    packId: PackFileId,
    version: Version,
    title: Reference,
    sources: Type.Array(PackFileSourceSchema, { minItems: 1, maxItems: 20 }),
    rules: Type.Array(PackFileRuleSchema, {
      maxItems: 200,
      description: 'At least one, unless the file declares record types: a pack may declare types and no rules yet.',
    }),
    sections: Type.Optional(
      Type.Array(RulePackSectionSchema, {
        minItems: 1,
        maxItems: RULE_PACK_SECTION_LIMIT,
        description: 'The sections of the pack in reading order; each rule then names one. Absent: none.',
      }),
    ),
    purposes: Type.Optional(Type.Array(PackFilePurposeSchema, { maxItems: 100 })),
    requiredRecords: Type.Optional(Type.Array(PackFileRequiredRecordSchema, { maxItems: 100 })),
    waiver: Type.Optional(RulePackWaiverSchema),
    recordTypes: Type.Optional(
      Type.Array(DeclaredRecordTypeSchema, {
        minItems: 1,
        maxItems: 50,
        description:
          'Record types the pack declares (docs/design/declared-record-types.md). Absent: none, and the digest is as it was without this section.',
      }),
    ),
    digest: Digest,
  },
  {
    ...Closed,
    description:
      'An organization’s rule pack version as data: its source documents, its rules and the digest of the pack version they make. Ledger rebuilds the pack version from the file on loading and refuses the file when the digest differs.',
  },
);
export type PackFile = Static<typeof PackFileSchema>;
