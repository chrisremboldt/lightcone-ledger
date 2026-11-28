import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isPackFileCheckedRule } from '../../contracts/src/index.js';
import { buildPackFile, buildPackFolder, verifiedPackFile } from '../src/index.js';

// The worked examples under examples/ that are a pack folder: each builds, and loads as startup loads it. Their
// integration tests adopt them; this keeps them building where no database runs.

const folder = (name: string) => join(import.meta.dirname, '..', '..', '..', 'examples', name);

describe('examples/flight-risk-assessment', () => {
  const description = () => parse(readFileSync(join(folder('flight-risk-assessment'), 'pack.yaml'), 'utf8'));
  const source = readFileSync(join(folder('flight-risk-assessment'), 'source.txt'), 'utf8');

  it('builds: a declared assessment and two rules that total its points, one level fixed, one set on adoption', () => {
    const built = buildPackFolder(folder('flight-risk-assessment'));
    const { version } = verifiedPackFile(built.file);
    expect(version.recordTypes?.map((type) => type.id)).toEqual(['example-ridge-risk.flight-risk-assessment']);
    const rules = built.file.rules.filter(isPackFileCheckedRule);
    expect(rules.map((rule) => [rule.id, rule.check.kind, rule.check.version, rule.check.params.level])).toEqual([
      ['example-ridge-risk.second-pilot-review', 'record.points-total', 1, 5],
      ['example-ridge-risk.chief-pilot-review', 'record.points-total', 1, undefined],
    ]);
    expect(rules[1]!.adoptionParameters).toEqual([
      {
        name: 'level',
        title: 'The level the chief pilot has set (points)',
        valueType: 'integer',
        minimum: 5,
        maximum: 15,
      },
    ]);
    // The points a rule uses are the ones its quoted text states.
    for (const report of built.reports) {
      expect(report.quoted).toContain('5 m/s to under 8 m/s, 2 points');
      expect(report.quoted).toContain('new to the operator, 3 points');
    }
    expect(rules[0]!.check.params.fields).toEqual(rules[1]!.check.params.fields);
  });

  it('is refused, naming the field, when its bands overlap or an option has no points', () => {
    const changed = (change: (fields: Record<string, unknown>[]) => void) => {
      const edited = description();
      change(edited.rules[0].check.params.fields);
      return () => buildPackFile(edited, source);
    };
    expect(changed((fields) => ((fields[0]!.bands as { to?: number }[])[0]!.to = 6))).toThrow(
      'Rule example-ridge-risk.second-pilot-review: The bands of “Wind at launch” (windAtLaunchMetersPerSecond) overlap: "below 6" and "5 to under 8" both hold 5.',
    );
    expect(changed((fields) => (fields[2]!.bands as unknown[]).pop())).toThrow(
      "The bands of “Pilot's flights in the last 90 days” (pilotFlightsLast90DaysCount) leave values of 10 and above with no points; the field takes values up to 10000.",
    );
    expect(changed((fields) => (fields[1]!.options as unknown[]).pop())).toThrow(
      '“The site” (siteFamiliarity) has no points for new-site.',
    );
  });
});

describe('examples/preflight-checklist', () => {
  const description = () => parse(readFileSync(join(folder('preflight-checklist'), 'pack.yaml'), 'utf8'));
  const source = readFileSync(join(folder('preflight-checklist'), 'source.txt'), 'utf8');

  it('builds: a checklist of twelve items in four sections, and three rules by check kinds Ledger already has', () => {
    const built = buildPackFolder(folder('preflight-checklist'));
    const { version } = verifiedPackFile(built.file);
    const declared = version.recordTypes![0]!;
    expect(declared.id).toBe('example-ridge-checklist.preflight-checklist');
    const items = declared.fields.filter((field) => field.kind === 'select');
    expect(items).toHaveLength(12);
    for (const item of items)
      expect(item.kind === 'select' && item.options.map((option) => option.value)).toEqual([
        'done',
        'not-applicable',
        'defect-found',
      ]);
    expect([...new Set(items.map((item) => item.heading))]).toEqual([
      'Airframe',
      'Batteries',
      'Control station',
      'Site',
    ]);
    // Each item's label is the item as the manual words it.
    for (const item of items) expect(source).toContain(item.label);
    const rules = built.file.rules.filter(isPackFileCheckedRule);
    expect(rules.map((rule) => [rule.id, rule.check.kind, rule.check.version])).toEqual([
      ['example-ridge-checklist.completed-before-takeoff', 'record.made-before', 1],
      ['example-ridge-checklist.every-item-answered', 'record.complete', 2],
      ['example-ridge-checklist.no-defect-found', 'value.one-of', 2],
    ]);
    // One rule reads every item.
    expect(rules[2]!.check.params.fields).toEqual(items.map((item) => `values.record.${item.name}`));
  });

  it('binds a heading by the declaration’s digest, and leaves a declaration without headings as it was', () => {
    const digestOf = (edited: unknown) =>
      verifiedPackFile(buildPackFile(edited, source).file).version.recordTypes![0]!.digest;
    const renamed = description();
    renamed.recordTypes[0].fields[2].heading = 'Frame';
    expect(digestOf(renamed)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestOf(renamed)).not.toBe(digestOf(description()));
    // The example that declares a type with no headings builds the pack it built before headings existed.
    const plain = buildPackFolder(folder('declared-record-type')).file;
    expect(plain.recordTypes![0]!.fields.some((field) => 'heading' in field)).toBe(false);
    expect(plain.digest).toBe('b36dd7d006a98e2e17c50b0fd84f0096a72cdbdc35e23a354bc6af11e592b591');
  });

  it('is refused when its one rule over the items names a field the checklist does not have', () => {
    const edited = description();
    edited.rules[2].check.params.fields.push('values.record.rotors');
    expect(() => buildPackFile(edited, source)).toThrow(
      /Rule no-defect-found .*check parameter fields names values\.record\.rotors: example-ridge-checklist\.preflight-checklist records \(version 1\) have no field rotors\./,
    );
  });
});
