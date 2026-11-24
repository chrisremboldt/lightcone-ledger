import type { CheckedRuleLeaf, RulePackPurpose, RulePackVersion, RulePackWaiver, RuleRelief } from '@ledger/contracts';
import { defineCheckedRule, withPopulation } from '@ledger/domain';
import { canonicalDigest, sha256 } from '@ledger/integrity';
import {
  findObligationType,
  limitedToCitingFlights,
  obligationParameterProblems,
  type EvidenceMode,
  type ObligationParameters,
  type ObligationType,
} from './obligations.js';

/** One provision of a waiver: where it sits in the certificate, and the obligation type it carries. */
export interface WaiverProvision {
  number: string;
  title: string;
  /** Zero-based half-open UTF-8 byte offsets of the provision in the certificate, and the digest of those bytes. */
  start: number;
  end: number;
  sha256: string;
  obligation: string;
  parameters?: ObligationParameters;
  /** The version of the rule built for the provision; raised when a later waiver version changes it. Defaults to 1. */
  ruleVersion?: number;
  /** Rules of other packs the provision relieves while the waiver is adopted in active mode. */
  relieves?: readonly RuleRelief[];
}

/** A waiver as data: the pack it becomes, the certificate it quotes and its provisions. */
export interface WaiverDefinition {
  packId: string;
  version: number;
  title: string;
  certificate: {
    number: string;
    holder: string;
    responsiblePerson: string;
    byteLength: number;
    sha256: string;
  };
  /** Which flights the conditions cover, and the dates the certificate states it is effective. */
  conditionsCover: RulePackWaiver['conditionsCover'];
  effective: RulePackWaiver['effective'];
  provisions: readonly WaiverProvision[];
}

/** How each provision is covered: by the checked rule built for it, or by what stands in for one. */
export interface ProvisionCoverage {
  number: string;
  title: string;
  obligation: string;
  evidence: EvidenceMode;
  ruleId?: string;
  waitingFor?: string;
}

function provisionText(certificate: Buffer, provision: WaiverProvision): string {
  const bytes = certificate.subarray(provision.start, provision.end);
  if (provision.end <= provision.start || sha256(bytes) !== provision.sha256)
    throw new Error(`Provision ${provision.number} does not match its pinned span in the certificate`);
  const quoted = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!quoted.startsWith(`${provision.number}. ${provision.title}.`))
    throw new Error(`Provision ${provision.number} does not start with its number and title`);
  return quoted;
}

function obligationOf(provision: WaiverProvision): ObligationType {
  const type = findObligationType(provision.obligation);
  if (!type) throw new Error(`Provision ${provision.number} names unknown obligation type ${provision.obligation}`);
  const problems = obligationParameterProblems(type, provision.parameters);
  if (problems.length) throw new Error(`Provision ${provision.number}: ${problems.join('; ')}`);
  return type;
}

function provisionRule(
  definition: WaiverDefinition,
  provision: WaiverProvision,
  type: ObligationType,
  quoted: string,
): CheckedRuleLeaf {
  const checked = type.check!(provision.parameters ?? {});
  const covered = type.covers ? withPopulation(checked, type.covers.population, type.covers.onFile) : checked;
  const spec =
    definition.conditionsCover === 'flights_citing_certificate'
      ? limitedToCitingFlights(covered, definition.certificate.number)
      : covered;
  return defineCheckedRule({
    ...spec,
    // A relieving provision is named for what it grants, so a relieved result can say which provision relieved it.
    ...(provision.relieves ? { title: `Special provision ${provision.number}: ${provision.title}` } : {}),
    id: `${definition.packId}.provision-${provision.number}`,
    version: provision.ruleVersion ?? 1,
    ...(provision.relieves ? { relieves: structuredClone([...provision.relieves]) } : {}),
    source: {
      kind: 'waiver_or_exemption',
      reference: `Certificate ${definition.certificate.number}, special provision ${provision.number}: ${provision.title} (fictional)`,
      text: quoted,
    },
  });
}

/**
 * Builds a waiver's rule pack from its definition and the retained certificate bytes. Each provision whose obligation
 * type has a check becomes a checked rule quoting the provision; the others are listed with how they are evidenced.
 * Throws if the certificate, a provision span, an obligation type or a parameter does not match.
 */
export function waiverRulePack(definition: WaiverDefinition, certificate: Buffer) {
  if (certificate.length !== definition.certificate.byteLength || sha256(certificate) !== definition.certificate.sha256)
    throw new Error(`Certificate ${definition.certificate.number} does not match its pinned bytes`);
  const numbers = definition.provisions.map((provision) => provision.number);
  if (new Set(numbers).size !== numbers.length)
    throw new Error(`Certificate ${definition.certificate.number} lists a provision number twice`);
  const leaves: CheckedRuleLeaf[] = [];
  const purposes: RulePackPurpose[] = [];
  const provisions: ProvisionCoverage[] = definition.provisions.map((provision) => {
    const quoted = provisionText(certificate, provision);
    const type = obligationOf(provision);
    const coverage = { number: provision.number, title: provision.title, obligation: type.id, evidence: type.evidence };
    if (!type.check) return { ...coverage, waitingFor: type.waitingFor! };
    const leaf = provisionRule(definition, provision, type, quoted);
    leaves.push(leaf);
    const purpose = type.purpose?.(provision.parameters ?? {});
    if (purpose && !purposes.some((declared) => declared.id === purpose.id))
      purposes.push({ ...purpose, source: structuredClone(leaf.source) });
    return { ...coverage, ruleId: leaf.id };
  });
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: definition.packId,
    version: definition.version,
    title: definition.title,
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves,
    ...(purposes.length ? { purposes } : {}),
    waiver: {
      certificateNumber: definition.certificate.number,
      conditionsCover: definition.conditionsCover,
      effective: { ...definition.effective },
    },
  };
  const version: RulePackVersion = { ...content, digest: canonicalDigest(content) };
  return { packId: definition.packId, versions: [version], provisions };
}
