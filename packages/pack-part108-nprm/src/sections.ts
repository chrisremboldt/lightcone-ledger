import type { RulePackLeaf, RulePackSection } from '@ledger/contracts';
import { inParagraphOrder, placedLeaf } from '@ledger/domain';

// The sections of the proposed part a pack version's rules quote, as the notice's table of contents names them.

const sectionTitles: Readonly<Record<string, string>> = {
  '108.40': 'Operator recordkeeping requirements',
  '108.45': 'Operator reporting requirements',
  '108.120': 'General operating requirements',
  '108.150': 'Operating location',
  '108.165': 'Area of operations',
  '108.170': 'Preflight requirements',
  '108.175': 'Operating restrictions',
  '108.180': 'Operations in controlled airspace',
  '108.210': 'Operation of multiple unmanned aircraft',
  '108.305': 'Operations supervisor',
  '108.310': 'Flight coordinator',
  '108.315': 'Personnel knowledge and training',
  '108.330': 'Duty and rest requirements',
  '108.335': 'Security threat assessment for certain personnel',
  '108.505': 'Applications for operating certificates',
  '108.530': 'Recency of operation',
  '108.535': 'Cybersecurity',
  '108.540': 'Training program',
  '108.545': 'Validation tests',
  '108.550': 'Communication and ground risk assessments',
  '108.555': 'Inoperative equipment',
  '108.560': 'Safety management system',
  '108.610': 'Unmanned aircraft maintenance',
  '108.615': 'Life-limited parts',
  '108.620': 'Unmanned aircraft batteries',
  '108.630': 'Operation after maintenance or alterations',
};

/** The section a paragraph reference belongs to and the paragraph as a reader cites it. */
function cited(reference: string): { section: string; paragraph: string } {
  const quoted = /^Proposed 14 CFR (108\.\d+)(.*)$/.exec(reference);
  if (!quoted || !sectionTitles[quoted[1]!]) throw new Error(`No section of the proposed part for ${reference}`);
  return { section: quoted[1]!, paragraph: `§ ${quoted[1]}${quoted[2]}` };
}

/**
 * The leaves placed in the section their paragraph belongs to, ordered by section and then by paragraph, with the
 * sections they use in order.
 */
export function sectioned(leaves: readonly RulePackLeaf[]): { leaves: RulePackLeaf[]; sections: RulePackSection[] } {
  const placed = inParagraphOrder(
    leaves.map((leaf) => {
      const { section, paragraph } = cited(leaf.source.reference);
      return placedLeaf(leaf, section, paragraph);
    }),
  );
  const used = [...new Set(placed.map((leaf) => leaf.section!))];
  return {
    leaves: placed,
    sections: used.map((id) => ({ id, title: `§ ${id} ${sectionTitles[id]}` })),
  };
}
