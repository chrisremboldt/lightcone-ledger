import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  crewDutyPeriodRecordV1,
  isCheckedRuleLeaf,
  operatorRecordTypesV1,
  recordRuleRead,
  type CheckedRuleLeaf,
  type PackFileCheckedRule,
} from '../../../packages/contracts/src/index.js';
import { runCheckedRule } from '../../../packages/domain/src/checked-rules.js';
import { buildPackFolder, verifiedPackFile } from '../../../packages/standard-packs/src/index.js';
import { fieldPathProblems } from '../../../packages/standard-packs/src/pack-field-paths.js';

// Every complete pack description in docs/guides/write-a-rule-pack.md, built with the source text the guide gives
// before it, and the worked rule over duty and rest periods run on records. If this test changes, change the guide.

const repository = join(import.meta.dirname, '..', '..', '..');
const guide = readFileSync(join(repository, 'docs', 'guides', 'write-a-rule-pack.md'), 'utf8');

/** Each fenced block of the guide, in order, with its language. */
const blocks = [...guide.matchAll(/```(\w+)\n([\s\S]*?)```/gu)].map((match) => ({
  language: match[1]!,
  text: match[2]!,
}));

/** Each complete description, naming its pack and holding rules or provisions, with the source text the nearest text block before it holds. */
const described = blocks.flatMap((block, index) => {
  if (block.language !== 'yaml' || !block.text.startsWith('pack:') || !/^(rules|provisions):/mu.test(block.text))
    return [];
  const source = blocks
    .slice(0, index)
    .reverse()
    .find((before) => before.language === 'text' && !before.text.includes(' version '));
  return [{ description: block.text, source: source?.text ?? '' }];
});

function build(description: string, source: string) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-guide-rules-'));
  writeFileSync(join(folder, 'pack.yaml'), description);
  writeFileSync(join(folder, 'source.txt'), source);
  return buildPackFolder(folder);
}

const dutyDescription = described.find((item) => item.description.includes('kind: duty.within-limits'))!;

const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-21T00:00:00.000Z' };

/** A duty or rest period as the import stores it: an observation of its own type, not an operator.record. */
function period(id: string, kind: 'duty' | 'rest', start: string, end: string) {
  return {
    id,
    type: 'crew.duty-period',
    version: 1,
    occurredAt: start,
    interval: { start, end },
    observation: { values: { period: kind }, interval: { start, end } },
  };
}

const assignment = {
  id: 'assignment-1',
  type: 'operator.record',
  version: 1,
  occurredAt: '2026-11-20T16:00:00.000Z',
  interval: { start: '2026-11-20T16:00:00.000Z', end: '2026-11-20T17:00:00.000Z' },
  observation: {
    values: {
      recordType: 'operation.role-assignment',
      recordVersion: 1,
      record: { personId: { scope: 'source', id: 'RIDGE-P-01' }, role: 'pilot_in_command' },
    },
    interval: { start: '2026-11-20T16:00:00.000Z', end: '2026-11-20T17:00:00.000Z' },
  },
};

describe('The worked rules of the guide to writing a rule pack', () => {
  test('every complete description in the guide builds with the source text before it', () => {
    expect(described.length).toBeGreaterThanOrEqual(2);
    for (const { description, source } of described) expect(() => build(description, source)).not.toThrow();
  });

  test('the duty and rest rule reads the duty periods as their own observation type', () => {
    const built = build(dutyDescription.description, dutyDescription.source);
    const rule = built.file.rules[0] as PackFileCheckedRule;
    expect(rule.reads.find((read) => read.name === 'periods')).toMatchObject({
      type: 'crew.duty-period',
      versions: [1],
      about: { related: 'pilot' },
    });
    expect(rule.reads.find((read) => read.name === 'periods')!.where ?? []).toEqual([]);
    expect(rule.check.params).toMatchObject({ maxDutyHours: 12, minRestHours: 10, restWithinHours: 24 });
  });

  test('runs on duty periods: within the limits, too long, none overlapping the assignment', () => {
    const leaf = verifiedPackFile(build(dutyDescription.description, dutyDescription.source).file).version.leaves.find(
      isCheckedRuleLeaf,
    ) as CheckedRuleLeaf;
    const run = (periods: ReturnType<typeof period>[]) =>
      runCheckedRule(leaf, leaf.check.params, { window: [assignment], periods }, clock);
    const rest = period('rest-1', 'rest', '2026-11-19T20:00:00.000Z', '2026-11-20T08:00:00.000Z');
    const within = run([rest, period('duty-1', 'duty', '2026-11-20T08:00:00.000Z', '2026-11-20T18:00:00.000Z')]);
    expect(within).toMatchObject({ outcome: 'pass' });
    const long = run([rest, period('duty-1', 'duty', '2026-11-20T08:00:00.000Z', '2026-11-20T21:00:00.000Z')]);
    expect(long).toMatchObject({ outcome: 'attention' });
    expect(long.summary).toContain('The duty period lasts 13 h against at most 12 h;');
    const elsewhere = run([rest, period('duty-1', 'duty', '2026-11-20T08:00:00.000Z', '2026-11-20T12:00:00.000Z')]);
    expect(elsewhere.summary).toContain('No recorded duty period overlaps the window.');
    expect(run([])).toMatchObject({ reasonCode: 'record_not_on_file' });
    expect(run([]).summary).toBe('No duty or rest period of the pilot in command on file.');
  });

  test('refuses the read the guide warns of, a duty period selected inside operator.record, saying what to write', () => {
    const wrong = dutyDescription.description.replace(
      '        type: crew.duty-period\n        versions: [1]\n        about:\n          related: pilot\n        required: true\n        onFile: duty or rest period of the pilot in command\n        select: all\n',
      '        type: operator.record\n        versions: [1]\n        about:\n          related: pilot\n        required: true\n        onFile: duty or rest period of the pilot in command\n        select: all\n        where:\n          - field: values.recordType\n            oneOf: [crew.duty-period]\n',
    );
    expect(wrong).not.toBe(dutyDescription.description);
    expect(() => build(wrong, dutyDescription.source)).toThrow(
      'Read periods selects crew.duty-period records by values.recordType, but crew.duty-period records are not stored inside operator.record: each is a crew.duty-period observation of its own, so this read would find none. Write the read as type: crew.duty-period, versions: [1], with no condition on values.recordType',
    );
  });

  test('every record type is read as recordRuleRead says, and every path it gives passes the build', () => {
    for (const definition of operatorRecordTypesV1) {
      const read = recordRuleRead(definition);
      expect(read.where.length === 0, definition.recordType).toBe(definition.observed !== undefined);
      const rule = {
        reads: [
          {
            name: 'subject',
            type: read.type,
            versions: read.versions,
            about: 'target',
            select: 'all',
            where: [...read.where, ...read.fields.map((field) => ({ field: field.path, filled: true }))],
          },
        ],
        check: { kind: 'value.one-of', version: 1, params: {} },
        applicability: [],
      } as unknown as PackFileCheckedRule;
      expect(fieldPathProblems(rule), definition.recordType).toEqual([]);
    }
    expect(recordRuleRead(crewDutyPeriodRecordV1)).toMatchObject({ type: 'crew.duty-period', where: [] });
  });
});
