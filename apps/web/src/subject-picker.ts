import { observationSubjectKindValues, type RecordSubjectsResponse } from '@ledger/contracts';

/**
 * Helpers for choosing a subject already on file when entering or browsing records. They read only subject kinds and
 * the subjects list, never a record type by name.
 */

export type SubjectKind = (typeof observationSubjectKindValues)[number];
type ReadSubjects = (path: string) => Promise<RecordSubjectsResponse>;

/** At most this many subjects of each kind are offered while a person types. */
export const SUBJECT_SUGGESTION_LIMIT = 20;
/** Pages read to tell whether one id is on file before saying nothing either way. */
const ON_FILE_PAGES = 10;
const ON_FILE_PAGE_LIMIT = 200;

const isSubjectKind = (kind: string): kind is SubjectKind =>
  (observationSubjectKindValues as readonly string[]).includes(kind);

/**
 * The kinds of subject a field can name and that have ids of the organization's own: the kind chosen beside it, else
 * every kind it takes. The organization itself is never offered: a record names it by kind alone.
 */
export function searchableKinds(kinds: readonly string[], chosen = ''): SubjectKind[] {
  const candidates = chosen ? [chosen] : kinds;
  return candidates.filter((kind): kind is SubjectKind => isSubjectKind(kind) && kind !== 'organization');
}

export function subjectsPath(sourceId: string, kind: SubjectKind, search: string, limit: number, cursor?: string) {
  return `/v1/operator-records/subjects?${new URLSearchParams({
    kind,
    sourceId,
    limit: String(limit),
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
  })}`;
}

export interface SubjectOption {
  kind: SubjectKind;
  id: string;
  /** The name the subject's records give it; null when none does. */
  name: string | null;
}

/** The subjects on file that match what was typed, by id or name, of each kind in turn. */
export async function suggestSubjects(
  read: ReadSubjects,
  sourceId: string,
  kinds: readonly SubjectKind[],
  typed: string,
): Promise<{ options: SubjectOption[]; more: boolean }> {
  const pages = await Promise.all(
    kinds.map((kind) => read(subjectsPath(sourceId, kind, typed.trim(), SUBJECT_SUGGESTION_LIMIT))),
  );
  return {
    options: pages.flatMap((page, index) =>
      page.subjects
        .filter((item) => item.subject.scope === 'source')
        .map((item) => ({ kind: kinds[index]!, id: item.subject.id, name: item.named ? item.subject.name : null })),
    ),
    more: pages.some((page) => page.page.hasMore),
  };
}

/**
 * Whether a record already names this id as a subject of one of these kinds: true, false, or undefined when the list
 * is too long to say within a few pages. An id is exact: RIDGE-AC-1 and ridge-ac-1 are two subjects.
 */
export async function subjectOnFile(
  read: ReadSubjects,
  sourceId: string,
  kinds: readonly SubjectKind[],
  id: string,
): Promise<boolean | undefined> {
  let unsure = false;
  for (const kind of kinds) {
    let cursor: string | undefined;
    for (let page = 0; page < ON_FILE_PAGES; page += 1) {
      const shown = await read(subjectsPath(sourceId, kind, id, ON_FILE_PAGE_LIMIT, cursor));
      if (shown.subjects.some((item) => item.subject.scope === 'source' && item.subject.id === id)) return true;
      if (shown.truncated) unsure = true;
      cursor = shown.page.hasMore ? (shown.page.nextCursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    if (cursor) unsure = true;
  }
  return unsure ? undefined : false;
}

/** What the form says, before anything is recorded, about an id no record names yet. */
export function newSubjectNote(id: string, kinds: readonly string[]): string {
  return `No record names ${id} yet: recording this makes it a new ${kinds.join(' or ')}.`;
}

/** The status line under the field: how many subjects on file match. */
export function suggestionCount(count: number, more: boolean, typed: string): string {
  const shown = `${count}${more ? '+' : ''}`;
  if (typed)
    return count
      ? `${shown} ${count === 1 && !more ? 'subject on file matches' : 'subjects on file match'} ${typed}.`
      : `No subject on file matches ${typed}.`;
  return count
    ? `${shown} ${count === 1 && !more ? 'subject' : 'subjects'} on file. Type part of an id or name to narrow them.`
    : 'No subject of this kind is on file yet.';
}
