import type { PackFileCheckedRule } from '@ledger/contracts';
import { readNoun, readRecordsWords } from './pack-labels.js';

/** What a rule reads, each record once: two reads of the same records say so once, required if either is. */
export function readsLine(rule: PackFileCheckedRule): string {
  const said = new Map<string, { type: string; about: string; select: string; required: boolean; onFile?: string }>();
  for (const read of rule.reads) {
    const type = readRecordsWords(read);
    const about =
      typeof read.about === 'string'
        ? `the ${read.about === 'target' ? rule.target.subjectKind : read.about}`
        : relatedWords(rule, (read.about as { related: string }).related);
    const select = typeof read.select === 'string' ? read.select : 'selected by another read';
    const key = `${type}\u0000${about}\u0000${select}`;
    const before = said.get(key);
    said.set(key, {
      type,
      about,
      select,
      required: (before?.required ?? false) || read.required === true,
      ...((before?.onFile ?? read.onFile) ? { onFile: before?.onFile ?? read.onFile } : {}),
    });
  }
  return [...said.values()]
    .map(({ type, about, select, required, onFile }) => {
      const missing = onFile ? `; without one: "No ${onFile} on file"` : '';
      return `${type} about ${about} (${select}${required ? ', required' : ''}${missing})`;
    })
    .join('; ');
}

/** The related subject a rule names, as "the aircraft named by its flight plan". */
export function relatedWords(rule: PackFileCheckedRule, name: string): string {
  const relation = rule.related?.find((item) => item.name === name);
  if (!relation) return `the ${name}`;
  const from = rule.reads.find((read) => read.name === relation.from.read);
  return `${relation.fanOut ? 'each' : 'the'} ${relation.subjectKind} named by its ${readNoun(from, relation.from.read)}`;
}
