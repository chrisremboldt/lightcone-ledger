import type { RulePackLeaf, RulePackSection } from '@ledger/contracts';
import { inParagraphOrder, placedLeaf } from '@ledger/domain';

// The sections of Part 107 a pack version's rules quote, as the retained edition titles them.

const sectionTitles: Readonly<Record<string, string>> = {
  '107.9': 'Safety event reporting',
  '107.12': 'Requirement for a remote pilot certificate with a small UAS rating',
  '107.13': 'Registration',
  '107.15': 'Condition for safe operation',
  '107.17': 'Medical condition',
  '107.19': 'Remote pilot in command',
  '107.21': 'In-flight emergency',
  '107.27': 'Alcohol or drugs',
  '107.31': 'Visual line of sight aircraft operation',
  '107.36': 'Carriage of hazardous material',
  '107.41': 'Operation in certain airspace',
  '107.49': 'Preflight familiarization, inspection, and actions for aircraft operation',
  '107.51': 'Operating limitations for small unmanned aircraft',
  '107.65': 'Aeronautical knowledge recency',
};

/** The section a paragraph reference belongs to and the paragraph as a reader cites it. */
function cited(reference: string): { section: string; paragraph: string } {
  const quoted = /^14 CFR ((107\.\d+).*?) \(edition of [\d-]+\)$/.exec(reference);
  if (!quoted || !sectionTitles[quoted[2]!]) throw new Error(`No section of Part 107 for ${reference}`);
  return { section: quoted[2]!, paragraph: quoted[1]!.replace(/107\./g, '§ 107.') };
}

/** The leaves placed in their sections, ordered by section and then by paragraph, with the sections in order. */
export function sectioned(leaves: readonly RulePackLeaf[]): { leaves: RulePackLeaf[]; sections: RulePackSection[] } {
  const placed = inParagraphOrder(
    leaves.map((leaf) => {
      const { section, paragraph } = cited(leaf.source.reference);
      return placedLeaf(leaf, section, paragraph);
    }),
  );
  const used = [...new Set(placed.map((leaf) => leaf.section!))];
  return { leaves: placed, sections: used.map((id) => ({ id, title: `§ ${id} ${sectionTitles[id]}` })) };
}
