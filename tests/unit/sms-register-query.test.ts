import { describe, expect, it } from 'vitest';
import {
  narrowed,
  registerCount,
  registerParams,
  registerPath,
  unnarrowed,
} from '../../apps/web/src/sms-register-query.js';

describe('a narrowed safety register', () => {
  it('reads the plain register exactly as before when nothing narrows or orders it', () => {
    expect(narrowed(unnarrowed)).toBe(false);
    expect(registerPath('hazard', unnarrowed)).toBe('/v1/sms/records?kind=hazard');
    expect(registerPath('report', { ...unnarrowed, search: '   ' })).toBe('/v1/sms/records?kind=report');
  });

  it('sends only what narrows or orders it, and the cursor of the next page', () => {
    const query = { ...unnarrowed, search: ' H-10 ', status: 'accepted', order: 'due' as const };
    expect(registerParams(query)).toEqual({ search: 'H-10', status: 'accepted', order: 'due' });
    expect(registerPath('hazard', query, '2027-01-15T17:00:00.000Z|hazard-1')).toBe(
      '/v1/sms/records?kind=hazard&search=H-10&status=accepted&order=due&cursor=2027-01-15T17%3A00%3A00.000Z%7Chazard-1',
    );
    expect(
      registerParams({ ...unnarrowed, assuranceType: 'audit', openedFrom: '2026-11-01', openedUntil: '2026-11-30' }),
    ).toEqual({ assuranceType: 'audit', openedFrom: '2026-11-01', openedUntil: '2026-11-30' });
    expect(narrowed({ ...unnarrowed, order: 'oldest' })).toBe(true);
  });

  it('counts what is shown, with + while more can be read', () => {
    expect(registerCount(3, false, unnarrowed)).toBe('3 recorded');
    expect(registerCount(200, true, unnarrowed)).toBe('200+ recorded');
    expect(registerCount(1, false, { ...unnarrowed, search: 'ridge' })).toBe('1 matches');
    expect(registerCount(4, true, { ...unnarrowed, status: 'closed' })).toBe('4+ match');
  });
});
