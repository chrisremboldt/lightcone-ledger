import { describe, expect, it } from 'vitest';
import { aircraftLabel } from '../../apps/web/src/labels.js';

describe('aircraftLabel', () => {
  it('shortens only the simulator’s own ids for the seeded fictional fleets', () => {
    expect(aircraftLabel('aircraft-alpha-02')).toBe('Aircraft A-02');
    expect(aircraftLabel('DJI-BETA-01')).toBe('DJI dock aircraft B-01');
    expect(aircraftLabel(undefined)).toBe('Aircraft unassigned');
  });

  it('shows any other id exactly as recorded', () => {
    for (const id of ['N123AB', 'AC-1', 'aircraft-n123-4', 'DJI-M30T-1', 'aircraft-alphabet-2', 'aircraft-far-field'])
      expect(aircraftLabel(id)).toBe(id);
  });
});
