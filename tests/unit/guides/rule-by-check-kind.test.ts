import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isCheckedRuleLeaf,
  type CheckedRuleLeaf,
  type PackFileCheckedRule,
} from '../../../packages/contracts/src/index.js';
import { runCheckedRule } from '../../../packages/domain/src/checked-rules.js';
import { buildPackFolder, verifiedPackFile } from '../../../packages/standard-packs/src/index.js';

// The worked rule by check kind of docs/guides/write-a-rule-pack.md, "A rule by check kind, start to finish". If this
// test changes, change the guide with it.

/** Invented for the guide: a sentence of an operations manual, not a regulation. */
const SOURCE = `Example Ridge Survey Operations Manual, revision 3 (invented)

4 Limits

4.2 Visibility. No flight is launched unless the visibility from the
control station, as recorded in the preflight assessment, is at least
3 statute miles.
`;

const DESCRIPTION = `
pack:
  id: example-ridge.operations-manual
  version: 1
  title: Example Ridge Survey Operations Manual (invented)

source:
  file: source.txt
  kind: procedure
  reference: Example Ridge Survey Operations Manual, revision 3

rules:
  - id: visibility
    paragraph: '4.2'
    title: Visibility at least 3 statute miles before launch
    quote: >-
      No flight is launched unless the visibility from the control station, as recorded in the preflight
      assessment, is at least 3 statute miles.
    target:
      subjectKind: flight
    population:
      of: in_adoption_dates
    reads:
      - name: quantity
        type: operator.record
        versions: [1]
        about: target
        required: true
        onFile: preflight assessment
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.preflight-assessment]
    check:
      kind: value.within-limit
      version: 2
      params:
        field: values.record.visibilityMeters
        comparison: at_least
        limit: 3 sm
`;

/** pnpm pack:build on a folder holding the description, changed as a test says, and the source. */
function build(change: (description: string) => string = (description) => description) {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-guide-rule-'));
  writeFileSync(join(folder, 'pack.yaml'), change(DESCRIPTION));
  writeFileSync(join(folder, 'source.txt'), SOURCE);
  return buildPackFolder(folder);
}
const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-20T18:00:00.000Z' };

function assessment(visibilityMeters?: number) {
  return {
    id: `assessment-${visibilityMeters ?? 'none'}`,
    type: 'operator.record',
    version: 1,
    occurredAt: '2026-11-20T15:30:00.000Z',
    observation: {
      values: {
        recordType: 'flight.preflight-assessment',
        recordVersion: 1,
        record: { assessedAt: '2026-11-20T15:30:00Z', ...(visibilityMeters === undefined ? {} : { visibilityMeters }) },
      },
    },
  };
}

describe('A rule by check kind, start to finish', () => {
  test('builds from the manual’s sentence, keeping the limit in metres with what was written', () => {
    const built = build();
    const rule = built.file.rules[0] as PackFileCheckedRule;
    expect(rule.id).toBe('example-ridge.operations-manual.visibility');
    expect(rule.check).toEqual({
      kind: 'value.within-limit',
      version: 2,
      params: {
        field: 'values.record.visibilityMeters',
        comparison: 'at_least',
        limit: 4828.032,
        unit: 'm',
        textUnit: 'mi',
      },
      written: { limit: '3 sm' },
    });
    expect(built.reports[0]!.line).toBe(5);
  });

  test('states each result in the manual’s unit, with the stored value beside it', () => {
    const leaf = verifiedPackFile(build().file).version.leaves.find(isCheckedRuleLeaf) as CheckedRuleLeaf;
    const run = (visibilityMeters?: number) =>
      runCheckedRule(leaf, leaf.check.params, { quantity: [assessment(visibilityMeters)] }, clock);
    expect(run(8000)).toMatchObject({ outcome: 'pass' });
    expect(run(8000).summary).toContain('3 mi (4828.03 m)');
    expect(run(3200)).toMatchObject({ outcome: 'attention' });
    expect(run()).toMatchObject({ evidenceState: 'insufficient' });
  });

  test('refuses the two mistakes the guide names: a misspelt field and a unit of another quantity', () => {
    expect(() => build((text) => text.replace('values.record.visibilityMeters', 'values.record.visibility'))).toThrow(
      'Rule visibility (Visibility at least 3 statute miles before launch): check parameter field names values.record.visibility: flight.preflight-assessment records (version 1) have no field visibility.',
    );
    expect(() => build((text) => text.replace('limit: 3 sm', 'limit: 3 kt'))).toThrow(
      'limit is written "3 kt", which is a speed; the value it is compared with is a distance or height, stored in m. Write it in one of m, ft, mi, sm, nm.',
    );
  });
});
