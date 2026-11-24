import type { OrganizationPeopleQuery, OrganizationPeopleResponse } from '../../../src/index.js';
import { canonicalize } from '../../../../integrity/src/index.js';

const cursor = Buffer.from(
  canonicalize({
    v: 1,
    tenant: 'tenant-alpha',
    principal: 'principal-alpha-operator',
    authority: 2,
    resource: 'organization-people',
    filter: canonicalize({ search: 'rivera' }),
    upper: { id: 'person-rivera-2', time: null },
    position: { id: 'person-rivera-1', time: null },
  }),
).toString('base64url');

export const peopleQuery = { search: ' Rivera ', limit: 1 } satisfies OrganizationPeopleQuery;
export const peopleContinuationQuery = { search: 'rivera', limit: 1, cursor } satisfies OrganizationPeopleQuery;
export const peoplePage = {
  people: [{ id: 'person-rivera-1', name: 'Sam Rivera', kind: 'human', revision: 3 }],
  page: {
    limit: 1,
    returned: 1,
    hasMore: true,
    nextCursor: cursor,
    selection: 'initial',
    order: 'id_ascending',
    consistency: 'live_directory',
  },
  meta: {
    requestId: 'people-example-1',
    projectionRevision: 12,
    inputCut: { streams: {}, principalRevision: 2 },
    computedAt: '2026-10-16T15:00:00Z',
    outstandingWork: 0,
  },
} satisfies OrganizationPeopleResponse;
export const peopleContinuation = {
  ...peoplePage,
  people: [{ id: 'person-rivera-2', name: 'Sam Rivera', kind: 'human', revision: 1 }],
  page: { ...peoplePage.page, hasMore: false, nextCursor: null, selection: 'continuation' },
  meta: { ...peoplePage.meta, requestId: 'people-example-2' },
} satisfies OrganizationPeopleResponse;
