import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import {
  FlightPredepartureConfigSchema,
  FlightPredepartureProgressSchema,
  type FlightPredepartureProgress,
} from '../src/flight-predeparture.js';
import { PrincipalResponseSchema } from '../src/openapi.js';
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
export const predepartureProgress: FlightPredepartureProgress = {
  version: 'flight.predeparture-progress.1',
  expectedRevision: 0,
  execution: {
    runId: 'ordinary-1',
    reservationId: 'attempt-1',
    aircraftId: 'aircraft-1',
    sourceMissionId: 'mission-1',
  },
  sourceObservedAt: '2026-10-18T18:00:00.000Z',
  phase: 'evaluating',
  code: 'mission_projected',
  retryable: true,
  reason: 'Checking the recorded route before dispatch.',
  needsHumanReview: false,
  references: {
    mission: {
      missionId: 'mission',
      eventId: 'event',
      sourceRevision: 1,
      contentDigest: '1'.repeat(64),
      recordDigest: '2'.repeat(64),
    },
    briefings: [],
  },
};
it('bounds ordinary workflow reports without authoring a human decision or accepting tenant overrides', () => {
  const valid = ajv.compile(FlightPredepartureProgressSchema);
  expect(valid(predepartureProgress), JSON.stringify(valid.errors)).toBe(true);
  for (const changed of [
    { ...predepartureProgress, tenantId: 'another-tenant' },
    { ...predepartureProgress, sourceObservedAt: 'unknown' },
    { ...predepartureProgress, phase: 'approved' },
    { ...predepartureProgress, references: { ...predepartureProgress.references, humanApproved: true } },
    {
      ...predepartureProgress,
      references: {
        ...predepartureProgress.references,
        briefings: Array(65).fill({ controlEventId: 'control', briefing: { id: 'briefing', digest: '0'.repeat(64) } }),
      },
    },
  ])
    expect(valid(changed)).toBe(false);
  const config = ajv.compile(FlightPredepartureConfigSchema);
  const value = {
    version: 'flight.predeparture-config.1',
    tenants: [
      {
        tenantId: 'tenant-alpha',
        source: {
          principalId: 'source',
          missionSourceId: 'mission-planner',
          automaticReleasePrincipalId: 'release-service',
        },
      },
    ],
  };
  expect(config(value)).toBe(true);
  expect(config({ ...value, token: 'not-a-configured-identity' })).toBe(false);
  const principal = ajv.compile(PrincipalResponseSchema);
  const authority = {
    principal: {
      id: 'source',
      tenantId: 'tenant-alpha',
      name: 'Mission source',
      capabilities: ['flight:read'],
      revision: 1,
      commandLinkSources: [],
      missionSources: [],
      monitoringSources: [],
    },
  };
  expect(principal(authority)).toBe(true);
  expect(principal({ principal: { ...authority.principal, kind: 'source' } })).toBe(true);
  expect(principal({ principal: { ...authority.principal, kind: 'assumed-human' } })).toBe(false);
});
