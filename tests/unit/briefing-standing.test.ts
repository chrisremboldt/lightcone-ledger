import { describe, expect, it } from 'vitest';
import {
  briefingLapsed,
  briefingLapsedMessage,
  briefingStanding,
} from '../../packages/domain/src/briefing-standing.js';

const windowEnd = '2026-10-15T14:19:00.000Z';
const controlBoundary = '2026-10-15T14:17:30.000Z';

describe('whether a briefing is in force', () => {
  it('is in force before its valid-until and lapsed from that instant on', () => {
    const bounds = { validUntil: windowEnd, releaseWindowEnd: windowEnd };
    expect(briefingStanding(bounds, '2026-10-15T14:18:59.999Z')).toEqual({
      status: 'in_force',
      validUntil: windowEnd,
      boundary: 'release_window_end',
      evaluatedAt: '2026-10-15T14:18:59.999Z',
    });
    expect(briefingStanding(bounds, windowEnd).status).toBe('lapsed');
    expect(briefingStanding(bounds, '2026-10-15T15:00:00.000Z').status).toBe('lapsed');
  });

  it('names a control boundary when the briefing ends before its release window', () => {
    const standing = briefingStanding({ validUntil: controlBoundary, releaseWindowEnd: windowEnd }, windowEnd);
    expect(standing).toMatchObject({ status: 'lapsed', validUntil: controlBoundary, boundary: 'control_boundary' });
  });

  it('reads instants in any offset as the same instant', () => {
    const standing = briefingStanding(
      { validUntil: '2026-10-15T09:19:00-05:00', releaseWindowEnd: '2026-10-15T14:19:00Z' },
      '2026-10-15T14:18:00Z',
    );
    expect(standing).toEqual({
      status: 'in_force',
      validUntil: windowEnd,
      boundary: 'release_window_end',
      evaluatedAt: '2026-10-15T14:18:00.000Z',
    });
  });

  it('refuses a lapsed briefing with its own code, saying when, why and that a new briefing is needed', () => {
    const standing = briefingStanding({ validUntil: controlBoundary, releaseWindowEnd: windowEnd }, windowEnd);
    const error = briefingLapsed('briefing-1', standing);
    expect(error.status).toBe(409);
    expect(error.code).toBe('briefing_lapsed');
    expect(error.details).toEqual({
      briefingId: 'briefing-1',
      validUntil: controlBoundary,
      boundary: 'control_boundary',
      evaluatedAt: windowEnd,
    });
    expect(error.message).toContain(controlBoundary);
    expect(error.message).toContain('no longer known to hold');
    expect(error.message).toContain('a new briefing is needed');
    expect(
      briefingLapsedMessage(briefingStanding({ validUntil: windowEnd, releaseWindowEnd: windowEnd }, windowEnd)),
    ).toContain('departure window closed');
  });
});
