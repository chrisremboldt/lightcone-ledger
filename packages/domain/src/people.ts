import {
  PEOPLE_DIRECTORY_DEFAULT_LIMIT,
  PEOPLE_DIRECTORY_MAX_LIMIT,
  PEOPLE_DIRECTORY_MAX_PERSON_BYTES,
  PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES,
  type OrganizationPeopleQuery,
  type OrganizationPeopleResponse,
  type OrganizationPerson,
} from '@ledger/contracts';
import { DomainError, type AuthContext, type PoolClient } from '@ledger/persistence';
import { historyCursor, historyLimit, historyPage } from './history.js';
import { responseMeta } from './index.js';

interface PersonRow {
  id: string | null;
  name: string | null;
  kind: 'human';
  revision: string;
}

function person(row: PersonRow): OrganizationPerson {
  if (!row.id || row.name === null)
    throw new DomainError(
      413,
      'people_directory_entry_too_large',
      'A directory identity exceeds the supported size. Review its name and identifier.',
    );
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new DomainError(500, 'unsupported_directory_identity', 'A directory identity could not be read.');
  const result = { id: row.id, name: row.name, kind: row.kind, revision };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > PEOPLE_DIRECTORY_MAX_PERSON_BYTES)
    throw new DomainError(
      413,
      'people_directory_entry_too_large',
      'A directory identity exceeds the supported size. Review its name and identifier.',
    );
  return result;
}

export async function getOrganizationPeople(
  client: PoolClient,
  principal: AuthContext,
  query: OrganizationPeopleQuery = {},
  requestId = '',
): Promise<OrganizationPeopleResponse> {
  const limit = historyLimit(query.limit, PEOPLE_DIRECTORY_DEFAULT_LIMIT, PEOPLE_DIRECTORY_MAX_LIMIT);
  if (query.search !== undefined && (typeof query.search !== 'string' || [...query.search].length > 200))
    throw new DomainError(400, 'invalid_people_search', 'Name search must contain at most 200 characters.');
  const search =
    (await client.query<{ search: string }>('SELECT lower($1::text) AS search', [query.search?.trim() ?? ''])).rows[0]
      .search || undefined;
  const filters = { search };
  const prior = historyCursor(query.cursor, principal, 'organization-people', filters, false);
  let upper = prior?.upper;
  if (!upper) {
    const boundary = (
      await client.query<{ id: string | null; present: boolean }>(
        `SELECT CASE WHEN char_length(MAX(id)) BETWEEN 1 AND 200 THEN MAX(id) ELSE NULL END AS id, MAX(id) IS NOT NULL AS present
       FROM principals WHERE tenant_id=$1 AND active AND kind='human'
       AND ($2::text IS NULL OR strpos(lower(name),$2)>0)`,
        [principal.tenantId, search ?? null],
      )
    ).rows[0];
    if (boundary.present && boundary.id === null)
      throw new DomainError(
        413,
        'people_directory_entry_too_large',
        'A directory identifier exceeds the supported size.',
      );
    upper = { id: boundary.id ?? '', time: null };
  }
  const rows = await client.query<PersonRow>(
    `SELECT CASE WHEN char_length(p.id) BETWEEN 1 AND 200 THEN p.id ELSE NULL END AS id,
      CASE WHEN octet_length(p.name)<=$6 THEN p.name ELSE NULL END AS name, p.kind, p.revision
     FROM principals p WHERE p.tenant_id=$1 AND p.active AND p.kind='human'
      AND ($2::text IS NULL OR strpos(lower(p.name),$2)>0)
      AND ($3::text IS NULL OR p.id>$3) AND p.id<=$4
     ORDER BY p.id LIMIT $5`,
    [
      principal.tenantId,
      search ?? null,
      prior?.position.id ?? null,
      upper.id,
      limit + 1,
      PEOPLE_DIRECTORY_MAX_PERSON_BYTES,
    ],
  );
  const people = rows.rows.slice(0, limit).map(person);
  const response: OrganizationPeopleResponse = {
    people,
    page: {
      ...historyPage(rows.rows, limit, prior, principal, 'organization-people', filters, 'id_ascending', upper),
      order: 'id_ascending',
      consistency: 'live_directory',
    },
    meta: await responseMeta(client, requestId, principal),
  };
  if (
    (response.page.nextCursor?.length ?? 0) > 4096 ||
    Buffer.byteLength(JSON.stringify(response), 'utf8') > PEOPLE_DIRECTORY_MAX_RESPONSE_BYTES
  )
    throw new DomainError(
      413,
      'people_directory_page_too_large',
      'This directory page exceeds the supported size. Use a smaller limit or a narrower name search.',
    );
  return response;
}
