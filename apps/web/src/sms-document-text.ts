export interface DocumentTextMatch {
  start: number;
  end: number;
}

export interface DocumentTextSection {
  title: string;
  level: number;
  start: number;
  /** Where the heading marker (`# `) ends and its title begins. */
  titleStart: number;
  /** End of the heading line, before its line break. */
  end: number;
}

export interface DocumentTextPart {
  text: string;
  start: number;
  matchIndex: number | null;
  sectionIndex: number | null;
  /** Heading level when this part lies on a heading line. */
  heading: number | null;
  /** True for the literal `#` marker of a heading line. */
  marker: boolean;
}

export function documentTextMatches(text: string, query: string): DocumentTextMatch[] {
  if (!query.length) return [];
  const literal = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(literal, 'giu'))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function documentTextSections(text: string): DocumentTextSection[] {
  const sections: DocumentTextSection[] = [];
  for (const match of text.matchAll(/(^|\r\n|\n|\r)(#{1,6}[ \t]+)([^\r\n]*)/g)) {
    const title = match[3].replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (!title) continue;
    const start = match.index + match[1].length;
    sections.push({
      title,
      level: match[2].trimEnd().length,
      start,
      titleStart: start + match[2].length,
      end: start + match[2].length + match[3].length,
    });
  }
  return sections;
}

/** Every part is an exact source slice; navigation, headings and highlighting never rewrite the document. */
export function documentTextParts(
  text: string,
  matches: DocumentTextMatch[],
  sections: DocumentTextSection[],
): DocumentTextPart[] {
  const boundaries = new Set([0, text.length]);
  for (const match of matches) {
    boundaries.add(match.start);
    boundaries.add(match.end);
  }
  const sectionAt = new Map(sections.map((section, index) => [section.start, index]));
  for (const section of sections) {
    boundaries.add(section.start);
    boundaries.add(section.titleStart);
    boundaries.add(section.end);
  }
  const offsets = [...boundaries].sort((left, right) => left - right);
  const parts: DocumentTextPart[] = [];
  let matchIndex = 0;
  let sectionIndex = 0;
  for (let index = 0; index < offsets.length - 1; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1];
    while (matchIndex < matches.length && matches[matchIndex].end <= start) matchIndex += 1;
    while (sectionIndex < sections.length && sections[sectionIndex].end <= start) sectionIndex += 1;
    const match = matches[matchIndex];
    const section = sections[sectionIndex];
    const onHeading = section !== undefined && section.start <= start && end <= section.end;
    parts.push({
      text: text.slice(start, end),
      start,
      matchIndex: match && match.start <= start && match.end >= end ? matchIndex : null,
      sectionIndex: sectionAt.get(start) ?? null,
      heading: onHeading ? section.level : null,
      marker: onHeading && end <= section.titleStart,
    });
  }
  return parts;
}

export function nextDocumentMatch(current: number, count: number, direction: 1 | -1): number {
  return count > 0 ? (((current + direction) % count) + count) % count : -1;
}
