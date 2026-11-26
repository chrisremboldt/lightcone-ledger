import {
  ACCEPTED_CONTROL_PACK_ID,
  isCheckedRuleLeaf,
  isRetainedDocumentSource,
  type RulePackOrigin,
  type RulePackSummary,
  type RulePackVersion,
} from '@ledger/contracts';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import { checkedPackProblem } from './checked-rules.js';
import { declaredRecordTypesProblem, registerDeclaredRecordTypes } from './organization-record-types.js';
import { packSectionsProblem } from './rule-pack-sections.js';

export interface RetainedRuleSource {
  sourceId: string;
  url: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  readPath: string;
  filename: string;
  bytes: Buffer;
}

export interface RulePackRegistration {
  packId: string;
  versions: readonly RulePackVersion[];
  sources?: readonly RetainedRuleSource[];
  /** Where each version came from, by version number. A version not listed is built in. */
  origins?: Readonly<Record<number, RulePackOrigin>>;
}

interface RulePackRegistry {
  packs: Map<string, Map<number, RulePackVersion>>;
  sources: Map<string, RetainedRuleSource>;
  origins: Map<string, RulePackOrigin>;
}

// One process can load this module both from source and from its build (tests do), so the
// registrations live on a process-wide key that both copies share.
const registryKey = Symbol.for('ledger.rule-pack-registry.1');
const registry: RulePackRegistry = ((globalThis as Record<symbol, RulePackRegistry | undefined>)[registryKey] ??= {
  packs: new Map(),
  sources: new Map(),
  origins: new Map(),
});
const BUILT_IN: RulePackOrigin = Object.freeze({ kind: 'built_in' });
const originKey = (packId: string, version: number) => `${packId}@${version}`;

function verifiedVersions(registration: RulePackRegistration): Map<number, RulePackVersion> {
  if (registration.versions.length === 0) throw new Error(`Rule pack ${registration.packId} has no versions`);
  const versions = new Map<number, RulePackVersion>();
  for (const candidate of registration.versions) {
    if (candidate.packId !== registration.packId)
      throw new Error(`Rule pack ${registration.packId} contains a version of ${candidate.packId}`);
    if (versions.has(candidate.version))
      throw new Error(`Rule pack ${registration.packId} version ${candidate.version} is listed twice`);
    const { digest, ...content } = candidate;
    if (canonicalDigest(content) !== digest)
      throw new Error(`Rule pack ${registration.packId} version ${candidate.version} does not match its digest`);
    const problem = checkedPackProblem(candidate) ?? packSectionsProblem(candidate);
    if (problem) throw new Error(`Rule pack ${registration.packId} version ${candidate.version}: ${problem}`);
    versions.set(candidate.version, Object.freeze(structuredClone(candidate)));
  }
  return versions;
}

function verifiedSources(registration: RulePackRegistration): RetainedRuleSource[] {
  const sourceIds = new Set<string>();
  return (registration.sources ?? []).map((source) => {
    if (registry.sources.has(source.sourceId) || sourceIds.has(source.sourceId))
      throw new Error(`Rule source ${source.sourceId} is already registered`);
    if (source.bytes.length !== source.byteLength || sha256(source.bytes) !== source.sha256)
      throw new Error(`Rule source ${source.sourceId} does not match its pinned bytes`);
    sourceIds.add(source.sourceId);
    return Object.freeze({ ...source, bytes: Buffer.from(source.bytes) });
  });
}

/** Every quoted paragraph must be the exact bytes at its span in a retained document known to the registry. */
function verifyRetainedSpans(versions: Iterable<RulePackVersion>, sources: readonly RetainedRuleSource[]): void {
  for (const version of versions)
    for (const leaf of version.leaves) {
      if (!isRetainedDocumentSource(leaf.source)) continue;
      const { document, textSpan, text } = leaf.source;
      const source =
        sources.find((candidate) => candidate.sourceId === document.sourceId) ??
        registry.sources.get(document.sourceId);
      const quoted = source?.bytes.subarray(textSpan.start, textSpan.end);
      if (!source || source.sha256 !== document.sha256 || !quoted?.equals(Buffer.from(text, 'utf8')))
        throw new Error(
          `Rule ${leaf.id} version ${leaf.version} does not match its span in rule source ${document.sourceId}`,
        );
    }
}

/**
 * Every relief a rule declares names another registered pack and a checked rule that one of its versions holds. A
 * relieved pack is therefore registered before the pack that relieves it.
 */
function verifyReliefs(packId: string, versions: Iterable<RulePackVersion>): void {
  for (const version of versions)
    for (const leaf of version.leaves.filter(isCheckedRuleLeaf))
      for (const relief of leaf.relieves ?? []) {
        const label = `Rule ${leaf.id} version ${leaf.version} of pack ${packId}`;
        if (relief.packId === packId) throw new Error(`${label} cannot relieve a rule of its own pack`);
        const relieved = registry.packs.get(relief.packId);
        if (!relieved) throw new Error(`${label} relieves rules of ${relief.packId}, which is not registered`);
        const held = new Set(
          [...relieved.values()].flatMap((candidate) => candidate.leaves.filter(isCheckedRuleLeaf).map(({ id }) => id)),
        );
        const unknown = relief.ruleIds.find((ruleId) => !held.has(ruleId));
        if (unknown) throw new Error(`${label} relieves ${unknown}, which no version of ${relief.packId} holds`);
      }
}

function verifiedRegistration(registration: RulePackRegistration) {
  // Each organization's accepted-controls pack lives in its adoptions, never in this registry.
  if (registration.packId === ACCEPTED_CONTROL_PACK_ID)
    throw new Error(`Rule pack ${registration.packId} is assembled from accepted controls and cannot be registered`);
  // The assembled and accepted_and_signed labels describe the accepted-controls pack alone.
  for (const version of registration.versions)
    if (version.status !== 'draft' || version.review !== 'ai_drafted')
      throw new Error(
        `Rule pack ${registration.packId} version ${version.version} carries labels only the accepted-controls pack carries`,
      );
  const versions = verifiedVersions(registration);
  const declarations = declaredRecordTypesProblem([...versions.values()]);
  if (declarations) throw new Error(`Rule pack ${registration.packId}: ${declarations}`);
  verifyReliefs(registration.packId, versions.values());
  const sources = verifiedSources(registration);
  verifyRetainedSpans(versions.values(), sources);
  return { versions, sources };
}

/** The first reason registerRulePack would refuse a registration, apart from its pack id being taken, or undefined. */
export function rulePackRegistrationProblem(registration: RulePackRegistration): string | undefined {
  try {
    verifiedRegistration(registration);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export function registerRulePack(registration: RulePackRegistration): void {
  if (registry.packs.has(registration.packId))
    throw new Error(`Rule pack ${registration.packId} is already registered`);
  const { versions, sources } = verifiedRegistration(registration);
  registerDeclaredRecordTypes(registration.packId, [...versions.values()]);
  registry.packs.set(registration.packId, versions);
  for (const source of sources) registry.sources.set(source.sourceId, source);
  for (const version of versions.keys())
    registry.origins.set(
      originKey(registration.packId, version),
      Object.freeze(structuredClone(registration.origins?.[version] ?? BUILT_IN)),
    );
}

/** Where a registered pack version came from, or undefined when it is not registered. */
export function rulePackOrigin(packId: string, version: number): RulePackOrigin | undefined {
  if (!registry.packs.get(packId)?.has(version)) return undefined;
  return structuredClone(registry.origins.get(originKey(packId, version)) ?? BUILT_IN);
}

export function isRulePackRegistered(packId: string): boolean {
  return registry.packs.has(packId);
}

export function getRulePackVersion(packId: string, version: number): RulePackVersion | undefined {
  const pack = registry.packs.get(packId)?.get(version);
  return pack ? structuredClone(pack) : undefined;
}

/** Every registered pack version, by pack id and version. */
export function listRulePackVersions(): RulePackSummary[] {
  return [...registry.packs.values()]
    .flatMap((versions) => [...versions.values()])
    .map(({ packId, version, title, digest }) => ({
      packId,
      version,
      title,
      digest,
      origin: rulePackOrigin(packId, version)!,
    }))
    .sort((a, b) => (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : a.version - b.version));
}

export async function getRuleSource(sourceId: string): Promise<RetainedRuleSource | undefined> {
  const source = registry.sources.get(sourceId);
  return source ? { ...source, bytes: Buffer.from(source.bytes) } : undefined;
}
