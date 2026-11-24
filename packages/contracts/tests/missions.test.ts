import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { canonicalDigest, sha256 } from '../../integrity/src/index.js';
import { LedgerClient } from '../src/client.js';
import {
  CommandSchema,
  FlightMissionRevisionParamsSchema,
  FlightMissionRevisionResponseSchema,
  InputSchema,
  MissionRevisionRecordSchema,
  MissionSourceSchema,
} from '../src/index.js';
import { FlightMissionResponseSchema } from '../src/openapi.js';
import {
  authorizeMissionSource,
  missionBinding,
  missionCorridorExample,
  missionCurrentRead,
  missionEmptyRead,
  missionFailedRead,
  missionInput,
  missionInvalidCases,
  missionPendingRead,
  missionRecord,
  missionRevision2Input,
  missionRevision2Record,
  missionRevision2Source,
  missionRevision2SourceText,
  missionRevisionRead,
  missionSource,
  missionSourceText,
} from '../fixtures/demo/v1/missions.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('recorded mission geometry handoff', () => {
  it('pins bounded planned geometry, exact source mapping and immutable revision identity', () => {
    const source = ajv.compile(MissionSourceSchema);
    const input = ajv.compile(InputSchema);
    const record = ajv.compile(MissionRevisionRecordSchema);
    for (const [raw, text, normalized, retained] of [
      [missionCorridorExample.source, missionSourceText, missionInput, missionRecord],
      [missionRevision2Source, missionRevision2SourceText, missionRevision2Input, missionRevision2Record],
    ] as const) {
      expect(source(raw), JSON.stringify(source.errors)).toBe(true);
      expect(input(normalized), JSON.stringify(input.errors)).toBe(true);
      expect(record(retained), JSON.stringify(record.errors)).toBe(true);
      expect(JSON.parse(text)).toEqual(raw);
      const { sourceRevision, occurredAt, ...payload } = raw;
      expect(normalized.sourceRevision).toBe(sourceRevision);
      expect(normalized.occurredAt).toBe(occurredAt);
      expect(normalized.payload).toEqual(payload);
      const bytes = Buffer.from(text);
      const original = { sha256: sha256(bytes), byteLength: bytes.byteLength, bytesBase64: bytes.toString('base64') };
      expect(retained.original).toEqual({ sha256: original.sha256, byteLength: original.byteLength });
      expect(retained.contentDigest).toBe(
        canonicalDigest({
          version: 'ledger.mission-content.1',
          sourceId: normalized.sourceId,
          flightId: normalized.subject.flightId,
          sourceRevision,
          occurredAt,
          fidelity: normalized.fidelity,
          payload,
          original,
        }),
      );
      expect(retained.authority.requiredCapabilities).toEqual(['input:write', 'mission:write']);
      expect(retained.authority.grantedSources).toContain(retained.sourceId);
    }
    for (const invalid of [
      missionInvalidCases.zeroRevision,
      missionInvalidCases.thirdCoordinate,
      missionInvalidCases.implicitInterpolation,
    ]) {
      expect(source(invalid)).toBe(false);
    }
    expect(
      source({
        ...missionSource,
        route: {
          ...missionSource.route,
          geometry: { type: 'LineString', coordinates: Array.from({ length: 257 }, () => [0, 0]) },
        },
      }),
    ).toBe(false);
    expect(input({ ...missionInput, sourceSessionId: 'unsupported-session' })).toBe(false);
    expect(input({ ...missionInput, effectiveAt: missionInput.occurredAt })).toBe(false);
    expect(input({ ...missionInput, subject: { originationKey: 'cannot-create-a-flight' } })).toBe(false);
    expect(missionBinding.missionId).not.toBe(missionBinding.sourceMissionId);
    const grant = authorizeMissionSource(
      { id: 'mission-author', revision: 1, capabilities: [], missionSources: [] },
      missionInput.sourceId,
    );
    expect(ajv.compile(CommandSchema)(grant)).toBe(true);
    expect(grant.missionSources).toEqual([missionInput.sourceId]);
    expect(grant.capabilities).toEqual(['input:write', 'mission:write']);
    expect(grant.commandLinkSources).toBeUndefined();
  });

  it('separates accepted and projected heads and reads one exact retained revision without current claims', async () => {
    const current = ajv.compile(FlightMissionResponseSchema);
    for (const shown of [missionEmptyRead, missionPendingRead, missionFailedRead, missionCurrentRead]) {
      expect(current(shown), JSON.stringify(current.errors)).toBe(true);
    }
    expect(missionPendingRead.acceptedHead.record.sourceRevision).toBe(2);
    expect(missionPendingRead.projectedHead.sourceRevision).toBe(1);
    expect(missionFailedRead.projectedHead).toEqual(missionPendingRead.projectedHead);
    const exact = ajv.compile(FlightMissionRevisionResponseSchema);
    expect(exact(missionRevisionRead), JSON.stringify(exact.errors)).toBe(true);
    expect(exact({ mission: null })).toBe(false);
    expect(exact({ ...missionRevisionRead, meta: missionCurrentRead.meta })).toBe(false);
    const params = ajv.compile(FlightMissionRevisionParamsSchema);
    expect(params({ id: missionInput.subject.flightId, revision: 1 })).toBe(true);
    expect(params({ id: missionInput.subject.flightId, revision: 0 })).toBe(false);
    const paths: string[] = [];
    const client = new LedgerClient('http://ledger.invalid', 'fixture-token', async (input) => {
      const url = String(input);
      paths.push(url);
      return Response.json(url.includes('/revisions/') ? missionRevisionRead : missionPendingRead);
    });
    expect(await client.flightMission('flight/one')).toEqual(missionPendingRead);
    expect(await client.flightMissionRevision('flight/one', 1)).toEqual(missionRevisionRead);
    expect(paths).toEqual([
      'http://ledger.invalid/v1/flights/flight%2Fone/mission',
      'http://ledger.invalid/v1/flights/flight%2Fone/mission/revisions/1',
    ]);
  });
});
