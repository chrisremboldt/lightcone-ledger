import { describe, expect, it } from 'vitest';
import type { RecordSubjectsResponse } from '../../packages/contracts/src/index.js';
import {
  newSubjectNote,
  searchableKinds,
  subjectOnFile,
  suggestionCount,
  suggestSubjects,
} from '../../apps/web/src/subject-picker.js';

type Kind = RecordSubjectsResponse['kind'];

/** A fake subjects read over a sorted list of ids per kind, paged as the API pages them. */
function subjectsOnFile(onFile: Partial<Record<Kind, { id: string; name?: string }[]>>, truncated = false) {
  const asked: string[] = [];
  const read = async (path: string): Promise<RecordSubjectsResponse> => {
    asked.push(path);
    const query = new URL(path, 'http://ledger.test').searchParams;
    const kind = query.get('kind') as Kind;
    const search = query.get('search')?.toLowerCase() ?? '';
    const cursor = query.get('cursor');
    const limit = Number(query.get('limit'));
    const matching = (onFile[kind] ?? [])
      .filter((item) => !cursor || item.id > cursor)
      .filter((item) => !search || `${item.id} ${item.name ?? ''}`.toLowerCase().includes(search));
    const shown = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return {
      kind,
      sourceId: query.get('sourceId')!,
      subjects: shown.map((item) => ({
        subject: { kind, id: item.id, scope: 'source', sourceId: 'operator-records', name: item.name ?? item.id },
        named: Boolean(item.name),
        records: { about: 1, current: 1 },
        openFindings: 0,
        latestAt: null,
      })),
      page: { limit, hasMore, nextCursor: hasMore ? shown.at(-1)!.id : null },
      truncated,
    };
  };
  return { read, asked };
}

describe('choosing a subject already on file', () => {
  it('searches the kind chosen beside the field, else every kind it takes, never the organization', () => {
    expect(searchableKinds(['aircraft', 'flight'])).toEqual(['aircraft', 'flight']);
    expect(searchableKinds(['aircraft', 'flight'], 'flight')).toEqual(['flight']);
    expect(searchableKinds(['flight', 'organization'])).toEqual(['flight']);
    expect(searchableKinds(['flight', 'organization'], 'organization')).toEqual([]);
    expect(searchableKinds(['duty_period'])).toEqual([]);
  });

  it('offers matching subjects by id and the name their records give them, kind by kind', async () => {
    const { read, asked } = subjectsOnFile({
      aircraft: [{ id: 'RIDGE-AC-1', name: 'Survey quadcopter' }, { id: 'RIDGE-AC-2' }],
      flight: [{ id: 'RIDGE-FL-9', name: 'Ridge line survey' }],
    });
    const found = await suggestSubjects(read, 'operator-records', ['aircraft', 'flight'], ' ridge ');
    expect(found).toEqual({
      options: [
        { kind: 'aircraft', id: 'RIDGE-AC-1', name: 'Survey quadcopter' },
        { kind: 'aircraft', id: 'RIDGE-AC-2', name: null },
        { kind: 'flight', id: 'RIDGE-FL-9', name: 'Ridge line survey' },
      ],
      more: false,
    });
    expect(asked[0]).toBe(
      '/v1/operator-records/subjects?kind=aircraft&sourceId=operator-records&limit=20&search=ridge',
    );
    const byName = await suggestSubjects(read, 'operator-records', ['aircraft'], 'quadcopter');
    expect(byName.options.map((option) => option.id)).toEqual(['RIDGE-AC-1']);
  });

  it('tells an id on file from a new one exactly, past the first page, and says nothing when it cannot tell', async () => {
    // Every id here contains AVERY and sorts before it, so the exact one is on the third page of what matches.
    const many = Array.from({ length: 450 }, (_, index) => ({ id: `A-AVERY-${String(index).padStart(4, '0')}` }));
    const { read, asked } = subjectsOnFile({ person: [...many, { id: 'AVERY' }] });
    await expect(subjectOnFile(read, 'operator-records', ['person'], 'AVERY')).resolves.toBe(true);
    expect(asked).toHaveLength(3);
    await expect(subjectOnFile(read, 'operator-records', ['person'], 'avery')).resolves.toBe(false);
    await expect(subjectOnFile(read, 'operator-records', ['person'], 'A-AVERY')).resolves.toBe(false);
    await expect(subjectOnFile(read, 'operator-records', ['person'], 'A-AVERY-0449')).resolves.toBe(true);
    const cut = subjectsOnFile({ person: [{ id: 'AVERY-EXAMPLE' }] }, true);
    await expect(subjectOnFile(cut.read, 'operator-records', ['person'], 'AVERY-OTHER')).resolves.toBeUndefined();
  });

  it('says plainly what a new id makes and how many subjects match', () => {
    expect(newSubjectNote('RIDGE-AC-3', ['aircraft'])).toBe(
      'No record names RIDGE-AC-3 yet: recording this makes it a new aircraft.',
    );
    expect(newSubjectNote('RIDGE-7', ['aircraft', 'flight'])).toBe(
      'No record names RIDGE-7 yet: recording this makes it a new aircraft or flight.',
    );
    expect(suggestionCount(1, false, 'RIDGE')).toBe('1 subject on file matches RIDGE.');
    expect(suggestionCount(20, true, 'RIDGE')).toBe('20+ subjects on file match RIDGE.');
    expect(suggestionCount(0, false, 'RIDGE')).toBe('No subject on file matches RIDGE.');
    expect(suggestionCount(0, false, '')).toBe('No subject of this kind is on file yet.');
    expect(suggestionCount(2, false, '')).toBe('2 subjects on file. Type part of an id or name to narrow them.');
  });
});
