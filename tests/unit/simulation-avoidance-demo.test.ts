import { describe, expect, it } from 'vitest';
import { simulationAvoidanceDemoConfiguration } from '../../apps/api/src/simulation-avoidance-demo.js';
import { simulationAvoidanceDemoConfig } from '../../packages/contracts/fixtures/demo/v1/simulation-avoidance-demo.js';

describe('hosted avoidance demo configuration', () => {
  it('requires explicit closed tenant and source identities and has no implicit operator fallback', () => {
    expect(simulationAvoidanceDemoConfiguration(undefined)).toBeUndefined();
    expect(simulationAvoidanceDemoConfiguration(JSON.stringify(simulationAvoidanceDemoConfig))).toEqual(
      simulationAvoidanceDemoConfig,
    );
    for (const value of [
      '',
      true,
      { ...simulationAvoidanceDemoConfig, tenants: [] },
      {
        ...simulationAvoidanceDemoConfig,
        tenants: [...simulationAvoidanceDemoConfig.tenants, ...simulationAvoidanceDemoConfig.tenants],
      },
      { ...simulationAvoidanceDemoConfig, token: 'credential' },
      {
        ...simulationAvoidanceDemoConfig,
        tenants: [{ ...simulationAvoidanceDemoConfig.tenants[0], source: { principalId: 'principal-alpha-source' } }],
      },
    ])
      expect(() => simulationAvoidanceDemoConfiguration(value)).toThrow();
  });
});
