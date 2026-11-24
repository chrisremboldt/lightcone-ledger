import { describe, expect, test } from 'vitest';
import { canonicalDigest } from '../../packages/integrity/src/index.js';
import { verifyPinnedControls } from '../../tools/verifier/flight-controls-seen.mjs';

const controls = [{ control: { id: 'control-fictional', versionNumber: 2 }, results: [{ result: 'pass' }] }];
const section = (complete = true, listed: unknown[] = controls) => {
  const content = { version: 'flight.controls-seen.1', controls: listed, notApplicable: [], complete, mission: null };
  return { ...content, digest: canonicalDigest(content) };
};
const briefing = (pinned: unknown, expectedControlsDigest?: string) => ({
  path: '$.entries[0]',
  envelope: {
    type: 'mission.brief',
    payload: {
      kind: 'mission.brief',
      ...(expectedControlsDigest ? { expectedControlsDigest } : {}),
      acceptance: { version: 'flight.mission-briefing.3', ...(pinned ? { controls: pinned } : {}) },
    },
  },
});

const departure = (pinned: unknown, expectedControlsDigest?: string) => ({
  path: '$.entries[1]',
  envelope: {
    type: 'mission.departure-authorize',
    payload: {
      ...(expectedControlsDigest ? { expectedControlsDigest } : {}),
      acceptance: { issuanceBasis: { version: 'mission.departure-issuance.2', controls: pinned } },
    },
  },
});

describe('the offline verifier and pinned controls', () => {
  test('checks a pinned list against the digest its command named', () => {
    const pinned = section();
    expect(verifyPinnedControls(briefing(pinned, pinned.digest))).toBe(true);
    expect(verifyPinnedControls(departure(pinned, pinned.digest))).toBe(true);
  });

  test('a briefing whose command named no digest pins nothing and is not checked for a list', () => {
    expect(verifyPinnedControls(briefing(undefined))).toBe(false);
  });

  test('a departure command names no digest only for the empty list its record pins', () => {
    const empty = section(true, []);
    expect(verifyPinnedControls(departure(empty))).toBe(true);
    expect(verifyPinnedControls(departure(empty, empty.digest))).toBe(true);
    expect(() => verifyPinnedControls(departure(section()))).toThrow(/digest the command named/);
    expect(() => verifyPinnedControls(briefing(empty))).toThrow(/digest the command named/);
  });

  test('refuses a list that does not reproduce or was not the one named', () => {
    const pinned = section();
    expect(() => verifyPinnedControls(briefing({ ...pinned, complete: false }, pinned.digest))).toThrow(
      /does not reproduce/,
    );
    expect(() => verifyPinnedControls(briefing(pinned, section(false).digest))).toThrow(/digest the command named/);
    expect(() => verifyPinnedControls(briefing(undefined, pinned.digest))).toThrow(/does not pin/);
  });
});
