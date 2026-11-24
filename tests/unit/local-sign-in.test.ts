import { describe, expect, it } from 'vitest';
import { fictionalPeople, operators } from '../../apps/web/src/demo/fictional-organizations.js';
import { developmentToken, heldOrganizations, offeredOrganizations } from '../../apps/web/src/local-sign-in.js';

describe('local sign-in choices', () => {
  it('offers only the seeded organizations the database holds, and none before it is read', () => {
    expect(offeredOrganizations(operators, null)).toEqual([]);
    expect(offeredOrganizations(operators, []).map((item) => item.key)).toEqual([]);
    expect(
      offeredOrganizations(operators, ['tenant-ridge-survey', 'tenant-beta', 'tenant-alpha']).map((item) => item.key),
    ).toEqual(['alpha', 'beta']);
  });

  it('finds the seeded organizations the API knows, by their first person’s development token', async () => {
    const asked: string[] = [];
    const held = await heldOrganizations(operators, fictionalPeople, async (token) => {
      asked.push(token);
      return token.startsWith('ledger-dev-beta-');
    });
    expect(held).toEqual(['tenant-beta']);
    expect(asked).toEqual(['ledger-dev-alpha-operator', 'ledger-dev-beta-operator', 'ledger-dev-utility-safety']);
    expect(await heldOrganizations(operators, fictionalPeople, async () => false)).toEqual([]);
  });

  it('reads a development token as pnpm org:create prints it', () => {
    expect(developmentToken('  ledger-dev-AbC_123  ')).toBe('ledger-dev-AbC_123');
    expect(developmentToken('ledger-service-abc')).toBeUndefined();
    expect(developmentToken('ledger-dev-')).toBeUndefined();
  });
});
