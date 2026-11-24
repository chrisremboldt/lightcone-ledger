import type { RulePackLeaf, RulePackVersion } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';
import {
  communicationAssessmentParagraph,
  part108NprmDocument,
  part108NprmFilename,
  quotedSource,
  readRetainedDocument,
  safetyManagementParagraph,
  type QuotedParagraph,
} from './retained-document.js';
import { versionTwo } from './part108-nprm-v2.js';
import { versionThree } from './part108-nprm-v3.js';

export { PART108_NPRM_SOURCE_ID } from './retained-document.js';
export const PART108_NPRM_PACK_ID = 'ledger.part108-nprm';

const VERSION_ONE_DIGEST = '2829a7d8708be8bdd1d97771a0fdbaca2376a70769633ae546e31b1de5298584';

export type RegulatoryLeaf = Extract<RulePackLeaf, { coverage: 'manual' | 'unsupported' }>;

/** A quoted paragraph the engine does not check: a person reviews it, or no record or check kind covers it yet. */
export function retainedLeaf(
  documentBytes: Buffer,
  id: string,
  title: string,
  coverage: RegulatoryLeaf['coverage'],
  paragraph: QuotedParagraph,
): RegulatoryLeaf {
  const content: Omit<RegulatoryLeaf, 'digest'> = {
    id,
    version: 1,
    title,
    source: quotedSource(documentBytes, paragraph),
    review: 'ai_drafted',
    adopted: false,
    dependencies: [],
    coverage,
  };
  return { ...content, digest: canonicalDigest(content) };
}

export { communicationAssessmentParagraph, safetyManagementParagraph };

/** The two entries version 1 shipped with; later versions carry them unchanged. */
export function versionOneLeaves(documentBytes: Buffer): RegulatoryLeaf[] {
  return [
    retainedLeaf(
      documentBytes,
      'ledger.nprm.108.550.a',
      'Communication assessment',
      'manual',
      communicationAssessmentParagraph,
    ),
    retainedLeaf(
      documentBytes,
      'ledger.nprm.108.560.a',
      'Safety management system',
      'unsupported',
      safetyManagementParagraph,
    ),
  ];
}

function versionOne(documentBytes: Buffer): RulePackVersion {
  const content: Omit<RulePackVersion, 'digest'> = {
    packId: PART108_NPRM_PACK_ID,
    version: 1,
    title: 'Part 108 NPRM coverage',
    status: 'draft',
    review: 'ai_drafted',
    adopted: false,
    bindings: [],
    leaves: versionOneLeaves(documentBytes),
  };
  const pack = { ...content, digest: canonicalDigest(content) };
  if (pack.digest !== VERSION_ONE_DIGEST)
    throw new Error(
      `Rule pack ${pack.packId} version 1 changed without a new pack version: its digest is now ${pack.digest}`,
    );
  return pack;
}

/** Reads the retained document and assembles every pinned version; throws if any pinned byte changed. */
export function part108NprmRulePack() {
  const documentBytes = readRetainedDocument();
  return {
    packId: PART108_NPRM_PACK_ID,
    versions: [versionOne(documentBytes), versionTwo(documentBytes), versionThree(documentBytes)],
    sources: [{ ...part108NprmDocument, filename: part108NprmFilename, bytes: documentBytes }],
  };
}
