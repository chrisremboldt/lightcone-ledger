import { describe, expect, it } from 'vitest';
import { missionInput, missionSource, missionSourceText } from '../../packages/contracts/fixtures/demo/v1/missions.js';
import { verifyMissionInputSource } from '../../packages/domain/src/missions.js';
import { sha256 } from '../../packages/integrity/src/index.js';

describe('mission source retention', () => {
  it('commits the exact original and flight while allowing an identical fresh upload', () => {
    const bytes = Buffer.from(missionSourceText, 'utf8');
    const first = verifyMissionInputSource(missionInput, bytes);
    expect(first.sha256).toBe(sha256(bytes));
    expect(first.byteLength).toBe(bytes.byteLength);
    expect(verifyMissionInputSource({ ...missionInput, artifactId: 'fresh-artifact' }, bytes)).toEqual(first);
    expect(
      verifyMissionInputSource({ ...missionInput, subject: { flightId: 'another-flight' } }, bytes).contentDigest,
    ).not.toBe(first.contentDigest);
    expect(verifyMissionInputSource(missionInput, Buffer.from(JSON.stringify(missionSource))).contentDigest).not.toBe(
      first.contentDigest,
    );
  });

  it('rejects ambiguous originals and a normalized plan that differs from retained bytes', () => {
    expect(() =>
      verifyMissionInputSource(
        missionInput,
        Buffer.from(missionSourceText.replace('"sourceRevision": 1', '"sourceRevision": 1, "sourceRevision": 1')),
      ),
    ).toThrow();
    expect(() =>
      verifyMissionInputSource(
        missionInput,
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(missionSourceText)]),
      ),
    ).toThrow();
    expect(() => verifyMissionInputSource(missionInput, new Uint8Array([0xff]))).toThrow();
    expect(() =>
      verifyMissionInputSource(
        { ...missionInput, payload: { ...missionInput.payload, lateralToleranceMeters: 99 } },
        Buffer.from(missionSourceText),
      ),
    ).toThrow();
    expect(() => verifyMissionInputSource(missionInput, Buffer.alloc(64 * 1024 + 1, 0x20))).toThrowError(/64 KiB/);
  });

  it('validates reported altitude and interval relationships before accepting their source mapping', () => {
    const inverted = {
      ...missionInput,
      payload: { ...missionInput.payload, altitude: { ...missionInput.payload.altitude, minimum: 80 } },
    };
    const emptyInterval = {
      ...missionInput,
      payload: {
        ...missionInput.payload,
        operatingInterval: { start: missionSource.operatingInterval.start, end: missionSource.operatingInterval.start },
      },
    };
    for (const input of [inverted, emptyInterval]) {
      const bytes = Buffer.from(
        JSON.stringify({ sourceRevision: input.sourceRevision, occurredAt: input.occurredAt, ...input.payload }),
      );
      expect(() => verifyMissionInputSource(input, bytes)).toThrow();
    }
  });
});
