import { describe, expect, it } from 'vitest';
import type { RuleEvaluationRecord } from '../../packages/contracts/src/index.js';
import { controlTypeDefinitionContent, controlTypeDigest } from '../../packages/domain/src/control-types.js';
import { operatingLimitControlType } from '../../packages/domain/src/control-type-library.js';
import { observationTypeChoices } from '../../packages/domain/src/observation-registry.js';
import { getRulePackVersion } from '../../packages/domain/src/rule-pack-registry.js';
import { summaryWordingOf } from '../../packages/domain/src/rule-evaluation-reads.js';
import { EXAMPLE_WEATHER_PACK_ID, WIND_FOR_FLIGHT_LEAF_ID } from '../../packages/pack-example-weather/src/index.js';

describe('named things a person picks instead of raw names', () => {
  it('offers registered observation types by title, with the numeric fields their schemas title', () => {
    const wind = observationTypeChoices().find((choice) => choice.type === 'weather.wind' && choice.version === 1);
    expect(wind).toMatchObject({ title: 'Wind reading', subjectKinds: expect.arrayContaining(['site']) });
    expect(wind!.numericFields).toContainEqual({ field: 'values.speedMetersPerSecond', title: 'Wind speed (m/s)' });
    const battery = observationTypeChoices().find((choice) => choice.type === 'battery.state');
    expect(battery!.numericFields.map((field) => field.field)).toContain('values.totalRemainingPercent');
    // A field inside a list is not offered: a limit reads one value.
    expect(battery!.numericFields.map((field) => field.field)).not.toContain('values.packs.remainingPercent');
    for (const choice of observationTypeChoices()) expect(choice.title).not.toBe(choice.type);
  });

  it('words an operating limit by titles for screens, and keeps the recorded wording and digest as they were', () => {
    const parameters = {
      observationType: 'weather.wind',
      observationVersion: 1,
      field: 'values.speedMetersPerSecond',
      comparison: 'at_most' as const,
      limit: 10,
      unit: 'm/s',
      scope: 'subject_kind' as const,
      subjectKind: 'site' as const,
    };
    expect(operatingLimitControlType.wording!(parameters)).toBe(
      'Keep the Wind speed (m/s) of each Wind reading at most 10 m/s, for every site.',
    );
    expect(operatingLimitControlType.describe(parameters)).toBe(
      'Keep the reported values.speedMetersPerSecond of weather.wind version 1 at most 10 m/s, for every site.',
    );
    const content = controlTypeDefinitionContent(operatingLimitControlType);
    expect(content).not.toHaveProperty('parameterChoices');
    const { parameterChoices: _choices, wording: _wording, ...unchanged } = operatingLimitControlType;
    expect(controlTypeDigest(operatingLimitControlType)).toBe(controlTypeDigest(unchanged));
  });

  it('returns a rule’s wording beside an evaluation only when it gave the recorded summary', () => {
    const pack = getRulePackVersion(EXAMPLE_WEATHER_PACK_ID, 2)!;
    const leaf = pack.leaves.find((item) => item.id === WIND_FOR_FLIGHT_LEAF_ID)!;
    const template = (leaf as { wording: { attention: string } }).wording.attention;
    const details = {
      runCount: 1,
      limit: 10,
      firstRunStartedAt: '2026-11-19T10:03:26.000Z',
      secondsOutside: 80,
      worstValue: 14.2,
      worstValueAt: '2026-11-19T10:04:06.000Z',
      recordedNote: '',
    };
    const summary = template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => String(details[name as 'limit']));
    const record = {
      id: 'evaluation-fictional',
      pack: { id: pack.packId, version: pack.version, digest: pack.digest },
      rule: { id: leaf.id, digest: leaf.digest },
      check: (leaf as { check: object }).check,
      evidence: [],
      outcome: 'attention',
      summary,
      details,
    } as unknown as RuleEvaluationRecord;
    expect(summaryWordingOf([record])).toEqual({ 'evaluation-fictional': template });
    expect(summaryWordingOf([{ ...record, summary: 'The check’s own summary.' }])).toEqual({});
    expect(summaryWordingOf([{ ...record, pack: { ...record.pack, digest: 'a'.repeat(64) } }])).toEqual({});
  });
});
