import { expect, it } from 'vitest';
import { flightPredepartureConfiguration } from '../../apps/api/src/flight-predeparture.js';

it('requires exact opt-in source and release identities without an implicit tenant fallback', () => {
  const config = {
    version: 'flight.predeparture-config.1',
    tenants: [
      {
        tenantId: 'tenant-alpha',
        source: {
          principalId: 'source-alpha',
          missionSourceId: 'planner-alpha',
          automaticReleasePrincipalId: 'release-alpha',
        },
      },
    ],
  };
  expect(flightPredepartureConfiguration(undefined)).toBeUndefined();
  expect(flightPredepartureConfiguration(JSON.stringify(config))).toEqual(config);
  for (const value of [
    '',
    true,
    { ...config, tenants: [] },
    { ...config, tenants: [...config.tenants, ...config.tenants] },
    { ...config, token: 'credential' },
    { ...config, tenants: [{ ...config.tenants[0], source: { principalId: 'source-alpha' } }] },
  ])
    expect(() => flightPredepartureConfiguration(value)).toThrow();
});
