import {
  BUILT_IN_PACK_PREFIX,
  declaredRecordDefinition,
  declaredRecordTypeProblems,
  isOperatorRecordDefinition,
  listObservationTypes,
  isPackFileCheckedRule,
  PackFileSchema,
  type CheckedRuleLeaf,
  type DeclaredRecordType,
  type OperatorRecordDefinition,
  type PackFile,
  type PackFileCheckedRule,
  type PackFileCoverageRule,
  type PackFileRule,
  type PackFileSource,
  type RulePackLeaf,
  type RulePackRecordType,
  type RulePackVersion,
} from '@ledger/contracts';
import { checkParameterProblem, defineCheckedRule, findCheckKind, observationRegistry } from '@ledger/domain';
import { rulePackRegistrationProblem } from '@ledger/domain/rule-pack-registry';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { Ajv } from 'ajv';
import { fieldPathProblems } from './pack-field-paths.js';
import { writtenParameterProblem } from './pack-units.js';

/** A pack file that cannot be loaded, with a reason written for the person who keeps the file. */
export class PackFileError extends Error {}

const ajv = new Ajv({ strict: false, allErrors: false, allowUnionTypes: true });
const validPackFile = ajv.compile<PackFile>(structuredClone(PackFileSchema));

function schemaProblem(value: unknown): string | undefined {
  if (validPackFile(value)) return undefined;
  const error = validPackFile.errors![0]!;
  const at = error.instancePath ? `at ${error.instancePath}` : 'at the top level';
  const extra = error.params && 'additionalProperty' in error.params ? ` (${error.params.additionalProperty})` : '';
  return `${at}: ${error.message ?? 'is not valid'}${extra}`;
}

function sourceProblem(source: PackFileSource): string | undefined {
  const bytes = Buffer.from(source.text, 'utf8');
  if (bytes.length !== source.byteLength || sha256(bytes) !== source.sha256)
    return `Source ${source.id} does not match its byte length and SHA-256; its text was changed after the file was built`;
  return undefined;
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });

type SourceKind = PackFile['sources'][number]['kind'];

/** The exact words a rule quotes: the bytes at its span in its source. */
function quotedText(rule: PackFileRule, sources: ReadonlyMap<string, { bytes: Buffer }>): string {
  const { source, start, end } = rule.quote;
  const bytes = sources.get(source)?.bytes;
  if (!bytes) throw new PackFileError(`Rule ${rule.id} quotes source ${source}, which the file does not contain`);
  if (start >= end || end > bytes.length)
    throw new PackFileError(
      `Rule ${rule.id} quotes bytes ${start} to ${end} of source ${source}, which has ${bytes.length} bytes`,
    );
  try {
    return fatalUtf8.decode(bytes.subarray(start, end));
  } catch {
    throw new PackFileError(`Rule ${rule.id} quotes bytes ${start} to ${end}, which split a character`);
  }
}

/** Builds one checked rule exactly as a built-in pack builds it, with defineCheckedRule. */
function checkedLeaf(
  rule: PackFileCheckedRule,
  text: string,
  sourceKind: SourceKind,
  ownTypes: readonly OperatorRecordDefinition[],
): CheckedRuleLeaf {
  const { quote, check, ...declared } = rule;
  const kind = findCheckKind(check.kind, check.version);
  if (!kind)
    throw new PackFileError(
      `Rule ${rule.id} names check kind ${check.kind} version ${check.version}, which this Ledger does not have`,
    );
  const written = writtenParameterProblem(check.params, check.written);
  if (written) throw new PackFileError(`Rule ${rule.id}: ${written}`);
  const paths = fieldPathProblems(rule, ownTypes);
  if (paths.length) throw new PackFileError(`Rule ${rule.id}: ${paths.join(' ')}`);
  // A rule whose parameters are all fixed can be checked against the kind's parameter schema now, as adoption would.
  if (rule.adoptionParameters.length === 0) {
    const problem = checkParameterProblem(check.kind, check.version, check.params);
    if (problem) throw new PackFileError(`Rule ${rule.id}: ${problem}`);
  }
  try {
    return defineCheckedRule({
      ...declared,
      source: { kind: sourceKind, reference: quote.reference, text },
      check: { kind, params: check.params },
    });
  } catch (error) {
    throw new PackFileError((error as Error).message);
  }
}

type CoverageLeaf = Extract<RulePackLeaf, { coverage: 'manual' | 'unsupported' }>;

/** Quoted words carried whole, as a rule a person checks carries them. */
function carriedSource(sourceKind: SourceKind, reference: string, text: string): CoverageLeaf['source'] {
  const bytes = Buffer.from(text, 'utf8');
  return {
    kind: sourceKind,
    reference,
    text,
    encoding: 'utf-8',
    byteLength: bytes.length,
    sha256: sha256(bytes),
    textSpan: { start: 0, end: bytes.length, unit: 'utf8_byte' },
  };
}

/** A provision no check runs, carried with its quoted words as a built-in pack carries a paragraph a person reviews. */
function coverageLeaf(rule: PackFileCoverageRule, text: string, sourceKind: SourceKind): CoverageLeaf {
  const content: Omit<CoverageLeaf, 'digest'> = {
    id: rule.id,
    version: rule.version,
    title: rule.title,
    source: carriedSource(sourceKind, rule.quote.reference, text),
    review: 'ai_drafted',
    adopted: false,
    dependencies: [],
    coverage: rule.coverage,
    waitingFor: rule.waitingFor,
    ...(rule.section ? { section: rule.section } : {}),
    ...(rule.paragraph ? { paragraph: rule.paragraph } : {}),
  };
  return { ...content, digest: canonicalDigest(content) };
}

function ruleLeaf(
  rule: PackFileRule,
  text: string,
  sourceKind: SourceKind,
  declared: readonly OperatorRecordDefinition[],
): RulePackLeaf {
  return isPackFileCheckedRule(rule)
    ? checkedLeaf(rule, text, sourceKind, declared)
    : coverageLeaf(rule, text, sourceKind);
}

/** The operator record types built into this Ledger, by name: those no pack declares. */
function builtInRecordTypes(): OperatorRecordDefinition[] {
  return Object.values(observationRegistry().recordTypes)
    .filter(isOperatorRecordDefinition)
    .filter((definition) => !definition.declaredBy);
}

/** The domains of the types this Ledger has without a pack. A pack that declares record types may not take one. */
export function reservedRecordDomains(): Set<string> {
  return new Set(
    [
      ...listObservationTypes(observationRegistry()).map((type) => type.type),
      ...builtInRecordTypes().map((definition) => definition.recordType),
    ].map((id) => id.split('.')[0]!),
  );
}

/** A declaration with its digest: the digest binds every word of it, as a rule's binds the rule. */
export function declarationWithDigest(declared: DeclaredRecordType): RulePackRecordType {
  return { ...structuredClone(declared), digest: canonicalDigest(declared) };
}

/**
 * The record types a pack file declares, each with its digest, and the definitions they make. Throws a PackFileError
 * with every problem a pack author can act on.
 */
export function declaredRecordTypes(
  packId: string,
  declarations: readonly DeclaredRecordType[] | undefined,
): { recordTypes: RulePackRecordType[]; definitions: OperatorRecordDefinition[] } {
  const reserved = reservedRecordDomains();
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const declared of declarations ?? []) {
    if (seen.has(declared.id)) problems.push(`Record type ${declared.id} is declared twice.`);
    seen.add(declared.id);
    problems.push(...declaredRecordTypeProblems(packId, declared, reserved));
  }
  if (problems.length) throw new PackFileError([...new Set(problems)].join(' '));
  const recordTypes = (declarations ?? []).map(declarationWithDigest);
  return { recordTypes, definitions: recordTypes.map((declared) => declaredRecordDefinition(packId, declared)) };
}

/** The pack version a file's sources and rules make, without its stated digest. */
export function packFileVersion(file: Omit<PackFile, 'digest'>): RulePackVersion {
  if (file.packId.startsWith(BUILT_IN_PACK_PREFIX))
    throw new PackFileError(
      `Pack id ${file.packId} starts with ${BUILT_IN_PACK_PREFIX}, which only packs that ship with Ledger use; give your pack your own prefix`,
    );
  const sources = new Map<string, { bytes: Buffer; kind: SourceKind }>();
  for (const source of file.sources) {
    if (sources.has(source.id)) throw new PackFileError(`Source ${source.id} is listed twice`);
    const problem = sourceProblem(source);
    if (problem) throw new PackFileError(problem);
    sources.set(source.id, { bytes: Buffer.from(source.text, 'utf8'), kind: source.kind });
  }
  if (file.waiver && !file.sources.some((source) => source.kind === 'waiver_or_exemption'))
    throw new PackFileError('The file states a waiver but holds no waiver or exemption source');
  if (file.waiver && file.waiver.effective.through < file.waiver.effective.from)
    throw new PackFileError(
      `The waiver's stated effective dates end (${file.waiver.effective.through}) before they start (${file.waiver.effective.from})`,
    );
  const declared = declaredRecordTypes(file.packId, file.recordTypes);
  if (!file.rules.length && !declared.recordTypes.length)
    throw new PackFileError('The file has no rules and declares no record types; a pack file has at least one of them');
  const ids = new Set<string>();
  const leaves = file.rules.map((rule) => {
    if (!rule.id.startsWith(`${file.packId}.`))
      throw new PackFileError(`Rule ${rule.id} does not start with its pack id ${file.packId} and a dot`);
    if (ids.has(rule.id)) throw new PackFileError(`Rule ${rule.id} is listed twice`);
    ids.add(rule.id);
    return ruleLeaf(rule, quotedText(rule, sources), sources.get(rule.quote.source)!.kind, declared.definitions);
  });
  const purposeIds = new Set<string>();
  const purposes = (file.purposes ?? []).map((purpose) => {
    if (purposeIds.has(purpose.id)) throw new PackFileError(`Purpose ${purpose.id} is listed twice`);
    purposeIds.add(purpose.id);
    const quoted = { id: `purpose ${purpose.id}`, quote: purpose.quote } as PackFileRule;
    const kind = sources.get(purpose.quote.source)?.kind;
    return {
      id: purpose.id,
      title: purpose.title,
      ...(purpose.documentTypes ? { documentTypes: [...purpose.documentTypes] } : {}),
      source: carriedSource(kind!, purpose.quote.reference, quotedText(quoted, sources)),
    };
  });
  const requiredRecords = (file.requiredRecords ?? []).map((record) => {
    if (!record.id.startsWith(`${file.packId}.`))
      throw new PackFileError(`Required record ${record.id} does not start with its pack id ${file.packId} and a dot`);
    if (ids.has(record.id)) throw new PackFileError(`Required record ${record.id} is listed twice`);
    ids.add(record.id);
    const carried = (quote: PackFile['rules'][number]['quote'], what: string) =>
      carriedSource(
        sources.get(quote.source)?.kind ?? 'operator_procedure',
        quote.reference,
        quotedText({ id: what, quote } as PackFileRule, sources),
      );
    const holders = new Set(
      [...builtInRecordTypes(), ...declared.definitions].map((definition) => definition.recordType),
    );
    for (const holder of record.heldBy)
      if (holder.kind === 'operator_record' && !holders.has(holder.recordType))
        throw new PackFileError(
          `Required record ${record.id} is held by ${holder.recordType}, which is not a record type this Ledger has or this pack declares`,
        );
    return {
      id: record.id,
      title: record.title,
      source: carried(record.quote, `required record ${record.id}`),
      keptBy: record.keptBy,
      heldBy: structuredClone(record.heldBy),
      ...(record.retention
        ? { retention: { source: carried(record.retention.quote, `retention of ${record.id}`) } }
        : {}),
    };
  });
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: file.packId,
    version: file.version,
    title: file.title,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
    ...(file.sections ? { sections: structuredClone(file.sections) } : {}),
    ...(purposes.length ? { purposes } : {}),
    ...(requiredRecords.length ? { requiredRecords } : {}),
    ...(file.waiver ? { waiver: structuredClone(file.waiver) } : {}),
    // An absent section does not enter the digest, so a pack that declares nothing keeps the digest it had.
    ...(declared.recordTypes.length ? { recordTypes: declared.recordTypes } : {}),
  };
  const version = { ...content, digest: canonicalDigest(content) };
  const problem = rulePackRegistrationProblem({ packId: version.packId, versions: [version] });
  if (problem) throw new PackFileError(problem);
  return version;
}

/**
 * Verifies a parsed pack file as startup does and returns the pack version it makes. Throws a PackFileError when the
 * file does not match the schema, a source or quotation does not match, a rule fails validation or names a check kind
 * this Ledger does not have, or the recomputed digest differs from the stated one.
 */
export function verifiedPackFile(value: unknown): { file: PackFile; version: RulePackVersion } {
  const problem = schemaProblem(value);
  if (problem)
    throw new PackFileError(`The file is not a ${PackFileSchema.properties.format.const} pack file ${problem}`);
  const file = value as PackFile;
  const { digest, ...content } = file;
  const version = packFileVersion(content);
  if (version.digest !== digest)
    throw new PackFileError(
      `Its rules make a pack with digest ${version.digest}, but the file states ${digest}. The file was edited after it was built, or it was built for a Ledger with different check kinds; build it again with pnpm pack:build`,
    );
  return { file, version };
}
