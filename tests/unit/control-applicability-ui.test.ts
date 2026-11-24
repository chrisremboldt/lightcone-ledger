import { describe, expect, test } from 'vitest';
import type { FlightControlResult, MissionAvoidanceNotApplicable } from '../../packages/contracts/src/index.js';
import { missionAvoidanceOutside } from '../../packages/contracts/fixtures/demo/v1/mission-avoidance.js';
import {
  applicabilityCountWords,
  applicabilitySentences,
  appliesBecause,
  avoidanceNotApplicableEntries,
  briefingOthersWords,
  decidedByWords,
  departureBriefingWords,
  listedNotApplicableEntries,
  notApplicableHeading,
  notApplicableOutlines,
  notApplicablePage,
  NOT_APPLICABLE_PAGE_SIZE,
} from '../../apps/web/src/flight-controls.js';
import { circlesInView, fitCoordinates, offsetCoordinate } from '../../apps/web/src/geography.js';

const verdict = /\b(compliant|authori[sz]ed|go|no-go|approved|cleared)\b/i;
const rule = { id: 'ledger.control-applicability.area-reach', version: 1, digest: 'c'.repeat(64) };
const farSentence = 'The planned corridor stays at least 19 400 m from the area; the control applies within 500 m.';

function notApplicable(index: number): MissionAvoidanceNotApplicable {
  const { geometry: _geometry, ...candidate } = structuredClone(missionAvoidanceOutside.candidates[0]!);
  return {
    ...candidate,
    controlId: `control-far-${index}`,
    controlEventId: `control-far-${index}-version-2`,
    controlVersion: 2,
    controlDigest: index.toString(16).padStart(64, '0'),
    applicability: {
      ...candidate.applicability,
      outcome: 'does_not_apply',
      basis: 'rule',
      rule,
      measured: [{ name: 'clearanceAtLeastMeters', value: 19400, unit: 'm' }],
      summary: farSentence,
      reasons: [],
    },
    title: `Fictional far quarry ${index}`,
    area: { center: { latitude: 40.2 + index / 1000, longitude: -105 }, radiusMeters: 300 },
    applicabilityDigest: index.toString(16).padStart(64, 'e'),
  };
}

describe('wording for controls that do not apply', () => {
  test('route review counts the controls that apply apart from those that overlap and do not', () => {
    expect(applicabilityCountWords(2, 100)).toBe(
      '2 accepted controls apply to this route; 100 more overlap the mission interval and do not apply',
    );
    expect(applicabilityCountWords(1, 1)).toBe(
      '1 accepted control applies to this route; 1 more overlap the mission interval and do not apply',
    );
    expect(applicabilityCountWords(3, 0)).toBe('3 accepted controls apply to this route');
    expect(applicabilityCountWords(0, 0)).toBe('No accepted control overlaps the mission interval');
    expect(notApplicableHeading(100)).toBe('Do not apply to this route (100)');
  });

  test('names the rule, the mission revision and the control version that decided it', () => {
    expect(decidedByWords(rule, 3, 2)).toBe(
      'Decided by ledger.control-applicability.area-reach version 1 for mission revision 3 and control version 2.',
    );
    expect(decidedByWords(null, 3, 2)).toBe(
      'Decided by no applicability rule for mission revision 3 and control version 2.',
    );
  });

  test('the briefing line and the departure line count the controls that do not apply', () => {
    expect(briefingOthersWords(100)).toBe(
      '100 other accepted controls overlap this flight’s interval and do not apply to its route; the release lists each with its measurement.',
    );
    expect(briefingOthersWords(1)).toBe(
      '1 other accepted control overlaps this flight’s interval and does not apply to its route; the release lists it with its measurement.',
    );
    expect(departureBriefingWords(2, 100)).toBe('2 controls need a briefing. 100 do not apply to this route.');
    expect(departureBriefingWords(1, 1)).toBe('1 control needs a briefing. 1 does not apply to this route.');
    expect(departureBriefingWords(0, 0)).toBe('0 controls need a briefing.');
  });

  test('no line uses a verdict word', () => {
    for (const words of [
      applicabilityCountWords(2, 3),
      notApplicableHeading(3),
      decidedByWords(rule, 1, 1),
      briefingOthersWords(3),
      departureBriefingWords(2, 3),
    ])
      expect(words).not.toMatch(verdict);
  });
});

describe('entries of controls that do not apply', () => {
  test('a route review entry shows its title, the recorded sentence and what decided it, from the entry alone', () => {
    const recorded = notApplicable(7);
    const [entry] = avoidanceNotApplicableEntries([recorded], 3);
    expect(entry).toEqual({
      key: recorded.controlEventId,
      controlId: recorded.controlId,
      title: 'Fictional far quarry 7',
      summary: farSentence,
      decidedBy:
        'Decided by ledger.control-applicability.area-reach version 1 for mission revision 3 and control version 2.',
    });
  });

  test('the map outlines come from the entries alone; an entry with no area is listed and not drawn', () => {
    const placed = notApplicable(1);
    const unplaced = { ...notApplicable(2), area: null };
    expect(notApplicableOutlines([placed, unplaced])).toEqual([
      {
        id: placed.controlEventId,
        label: 'Fictional far quarry 1',
        note: farSentence,
        center: { latitude: 40.201, longitude: -105 },
        radiusMeters: 300,
      },
    ]);
    expect(avoidanceNotApplicableEntries([placed, unplaced], 3).map((entry) => entry.title)).toEqual([
      'Fictional far quarry 1',
      'Fictional far quarry 2',
    ]);
  });

  test('a compact entry of the controls list keeps its title and recorded sentence', () => {
    const [entry] = listedNotApplicableEntries([
      {
        hazardId: 'hazard-fictional',
        control: { id: 'control-far', versionNumber: 2, bodyDigest: 'a'.repeat(64), title: 'Far quarry' },
        applicability: { outcome: 'does_not_apply', basis: 'rule', measured: [], digest: 'b'.repeat(64) },
        summary: farSentence,
      },
    ]);
    expect(entry).toEqual({
      key: 'control-far:2',
      controlId: 'control-far',
      title: 'Far quarry',
      summary: farSentence,
    });
  });

  test('a result that applies shows the recorded sentence its applicability digest names, and only that', () => {
    const candidate = missionAvoidanceOutside.candidates[0]!;
    const sentences = applicabilitySentences([candidate]);
    const result = (digest: string, outcome: 'applies' | 'does_not_apply' = 'applies'): FlightControlResult => ({
      result: 'pass',
      summary: 'The planned route keeps clear of this area.',
      applicability: { outcome, basis: 'undetermined', measured: [], digest },
    });
    expect(appliesBecause(result(candidate.applicabilityDigest), sentences)).toBe(candidate.applicability.summary);
    expect(appliesBecause(result('f'.repeat(64)), sentences)).toBeNull();
    expect(appliesBecause(result(candidate.applicabilityDigest, 'does_not_apply'), sentences)).toBeNull();
    expect(appliesBecause({ result: 'pass', summary: 'Kept clear.' }, sentences)).toBeNull();
    expect(appliesBecause(result(candidate.applicabilityDigest), undefined)).toBeNull();
  });
});

describe('long lists of controls that do not apply', () => {
  const entries = Array.from({ length: 512 }, (_, index) => index);

  test('show 50 at a time, and every one after enough pages', () => {
    expect(NOT_APPLICABLE_PAGE_SIZE).toBe(50);
    expect(notApplicablePage(entries, 1)).toEqual({ shown: entries.slice(0, 50), remaining: 462 });
    expect(notApplicablePage(entries, 2).shown).toHaveLength(100);
    expect(notApplicablePage(entries, 11)).toEqual({ shown: entries, remaining: 0 });
    expect(notApplicablePage(entries, 0).shown).toHaveLength(50);
    expect(notApplicablePage([1, 2], 1)).toEqual({ shown: [1, 2], remaining: 0 });
  });

  test('a map draws only the areas that reach into its view, at most the limit', () => {
    const route = { latitude: 41.88, longitude: -87.63 };
    const view = fitCoordinates([offsetCoordinate(route, -1000, -1000), offsetCoordinate(route, 1000, 1000)])!;
    const near = Array.from({ length: 60 }, (_, index) => ({
      id: `near-${index}`,
      center: offsetCoordinate(route, 200, index * 10),
      radiusMeters: 50,
    }));
    const edge = { id: 'edge', center: offsetCoordinate(route, 0, 2400), radiusMeters: 1500 };
    const far = { id: 'far', center: offsetCoordinate(route, 0, 20_000), radiusMeters: 500 };
    expect(circlesInView([far, edge], view, 50).shown.map((circle) => circle.id)).toEqual(['edge']);
    const capped = circlesInView([...near, far], view, 50);
    expect(capped.shown).toHaveLength(50);
    expect(capped.more).toBe(10);
  });
});
