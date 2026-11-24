import type { RulePackLeaf, RulePackSection, RulePackVersion } from '@ledger/contracts';
import { canonicalDigest } from '@ledger/integrity';

// The sections of a pack version: headings its rules are read under, in the pack's order. A pack that declares none
// is read as one section, its rules in the order of their paragraphs or provision numbers.

/** The id and title of the one section a pack without sections is read as. */
export const UNSECTIONED: RulePackSection = Object.freeze({ id: 'all', title: 'All rules' });

/** The leaf placed in a section, with the paragraph it reads; its digest is computed again over what it now holds. */
export function placedLeaf<Leaf extends RulePackLeaf>(leaf: Leaf, section: string, paragraph: string): Leaf {
  const { digest: _digest, ...content } = leaf;
  const placed = { ...content, section, paragraph };
  return { ...placed, digest: canonicalDigest(placed) } as Leaf;
}

const numbered = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * How a leaf is ordered when its pack declares no sections: by its paragraph, else by its id after the pack's own
 * prefix, words apart (a rule a pack file names provision-4 sorts as provision 4).
 */
function citedAs(leaf: RulePackLeaf, packId: string): string {
  if (leaf.paragraph) return leaf.paragraph;
  return leaf.id.startsWith(`${packId}.`) ? leaf.id.slice(packId.length + 1).replace(/[-_]/g, ' ') : leaf.id;
}

/** Orders leaves by the numbers in how they are cited (provision 2 before provision 10), then by id. */
export function inParagraphOrder<Leaf extends RulePackLeaf>(leaves: readonly Leaf[], packId = ''): Leaf[] {
  return [...leaves].sort(
    (a, b) => numbered.compare(citedAs(a, packId), citedAs(b, packId)) || numbered.compare(a.id, b.id),
  );
}

/**
 * The first problem with a pack version's sections, or undefined: ids are listed once, and either every leaf names a
 * section the version lists, or the version lists none and no leaf names one.
 */
export function packSectionsProblem(pack: Pick<RulePackVersion, 'leaves' | 'sections'>): string | undefined {
  const ids = new Set<string>();
  for (const section of pack.sections ?? []) {
    if (ids.has(section.id)) return `Section ${section.id} is listed twice`;
    ids.add(section.id);
  }
  for (const leaf of pack.leaves) {
    if (!pack.sections && leaf.section !== undefined)
      return `Rule ${leaf.id} names section ${leaf.section}, but the pack lists no sections`;
    if (pack.sections && leaf.section === undefined) return `Rule ${leaf.id} names no section`;
    if (pack.sections && !ids.has(leaf.section!))
      return `Rule ${leaf.id} names section ${leaf.section}, which the pack does not list`;
  }
  return undefined;
}

/** The pack's sections in order, each with its leaves in pack order; one section in paragraph order without any. */
export function sectionsOf<Leaf extends RulePackLeaf>(pack: {
  packId: string;
  leaves: readonly Leaf[];
  sections?: readonly RulePackSection[];
}): { section: RulePackSection; leaves: Leaf[] }[] {
  if (!pack.sections) return [{ section: UNSECTIONED, leaves: inParagraphOrder(pack.leaves, pack.packId) }];
  return pack.sections
    .map((section) => ({ section, leaves: pack.leaves.filter((leaf) => leaf.section === section.id) }))
    .filter((group) => group.leaves.length > 0);
}
