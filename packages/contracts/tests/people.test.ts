import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { LedgerClient } from '../src/client.js';
import { OrganizationPeopleQuerySchema, OrganizationPersonSchema, PEOPLE_DIRECTORY_MAX_LIMIT } from '../src/people.js';
import { OrganizationPeopleResponseSchema } from '../src/openapi.js';
import { peopleContinuation, peopleContinuationQuery, peoplePage, peopleQuery } from '../fixtures/demo/v1/people.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('organization people directory contract', () => {
  it('permits only bounded searches and minimal human identities in scoped directory pages', () => {
    const query = ajv.compile(OrganizationPeopleQuerySchema);
    for (const value of [peopleQuery, peopleContinuationQuery, {}, { limit: PEOPLE_DIRECTORY_MAX_LIMIT }])
      expect(query(value), JSON.stringify(query.errors)).toBe(true);
    for (const value of [
      { limit: PEOPLE_DIRECTORY_MAX_LIMIT + 1 },
      { limit: 0 },
      { search: 'x'.repeat(201) },
      { tenantId: 'foreign' },
      { role: 'human' },
    ])
      expect(query(value)).toBe(false);
    const person = ajv.compile(OrganizationPersonSchema);
    expect(person(peoplePage.people[0]), JSON.stringify(person.errors)).toBe(true);
    for (const value of [
      { ...peoplePage.people[0], kind: 'service' },
      { ...peoplePage.people[0], revision: 0 },
      { ...peoplePage.people[0], capabilities: ['decision:write'] },
      { ...peoplePage.people[0], tenantId: 'foreign' },
      { ...peoplePage.people[0], email: 'private@example.invalid' },
    ])
      expect(person(value)).toBe(false);
    const response = ajv.compile(OrganizationPeopleResponseSchema);
    for (const value of [peoplePage, peopleContinuation])
      expect(response(value), JSON.stringify(response.errors)).toBe(true);
    expect(response({ ...peoplePage, page: { ...peoplePage.page, consistency: 'live_projection' } })).toBe(false);
    expect(
      response({
        ...peoplePage,
        people: Array.from({ length: PEOPLE_DIRECTORY_MAX_LIMIT + 1 }, () => peoplePage.people[0]),
      }),
    ).toBe(false);
  });

  it('encodes directory queries and reads through the authenticated public client without a write key', async () => {
    const calls: { url: string; method: string; authorization: string | null; key: string | null; body: unknown }[] =
      [];
    const client = new LedgerClient('https://ledger.invalid', 'fixture-token', async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        key: headers.get('idempotency-key'),
        body: init?.body ?? null,
      });
      return Response.json(peoplePage);
    });
    expect(await client.organizationPeople()).toEqual(peoplePage);
    expect(await client.organizationPeople({ search: 'Sam %_\\ /?', limit: 2, cursor: 'opaque/page+' })).toEqual(
      peoplePage,
    );
    expect(calls).toEqual([
      {
        url: 'https://ledger.invalid/v1/organization/people',
        method: 'GET',
        authorization: 'Bearer fixture-token',
        key: null,
        body: null,
      },
      {
        url: 'https://ledger.invalid/v1/organization/people?search=Sam+%25_%5C+%2F%3F&limit=2&cursor=opaque%2Fpage%2B',
        method: 'GET',
        authorization: 'Bearer fixture-token',
        key: null,
        body: null,
      },
    ]);
  });
});
