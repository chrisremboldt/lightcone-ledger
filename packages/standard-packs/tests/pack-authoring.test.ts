import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { listCheckKinds } from '../../domain/src/check-kinds.js';
import { buildPackFile, checkKindsPrintout, packTemplate } from '../src/index.js';
import { withRuleVersions } from '../src/pack-rule-versions.js';

// Writing a pack of one's own: an obligation in a procedure, every check kind printable, rule versions numbered from
// the version built before, and a printout that names records and fields by their labels.

const repository = join(import.meta.dirname, '..', '..', '..');

/** An invented manual: one paragraph a check kind runs, one an obligation type fits. */
const SOURCE = `Example Ridge Survey Operations Manual, revision 3 (invented)

4.1 Wind. No launch when the wind at takeoff is above 22 kt.

6.4 Docks. Each dock is inspected at intervals of not more than 30 days.
`;

let packs = 0;
function manual(version = 1, windLimit = '22 kt') {
  return parse(`
pack:
  id: example-ridge-${process.pid}-${++packs}.operations-manual
  version: ${version}
  title: Example Ridge Survey Operations Manual (invented)
source:
  file: source.txt
  kind: procedure
  reference: Example Ridge Survey Operations Manual, revision 3
rules:
  - id: wind
    paragraph: '4.1'
    title: Wind at takeoff at most 22 kt
    quote: No launch when the wind at takeoff is above 22 kt.
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
        onFile: flight record
        select: latest
        where:
          - field: values.recordType
            oneOf: [flight.record]
    check:
      kind: value.within-limit
      version: 2
      params:
        field: values.record.windAtTakeoffMetersPerSecond
        comparison: at_most
        limit: ${windLimit}
provisions:
  - number: 6.4
    title: Each dock inspected within 30 days before each flight from it
    quote: Each dock is inspected at intervals of not more than 30 days.
    obligation: maintenance.dock-inspected-within-days
    parameters:
      days: 30
      inspectionKinds: [scheduled]
`);
}

describe('Obligations in a procedure', () => {
  it('builds a provision in a procedure exactly as in a waiver', () => {
    const built = buildPackFile(manual(), SOURCE).file;
    expect(built.rules.map((rule) => rule.id.slice(built.packId.length + 1))).toEqual(['provision-6.4', 'wind']);
    expect(built.rules[0]).toMatchObject({ check: { kind: 'record.before-flight' } });
  });

  it('refuses an obligation under rules, saying where it goes', () => {
    const description = manual();
    description.rules.push({
      id: 'docks',
      title: 'Each dock inspected within 30 days',
      quote: 'Each dock is inspected at intervals of not more than 30 days.',
      obligation: 'maintenance.dock-inspected-within-days',
      parameters: { days: 30, inspectionKinds: ['scheduled'] },
    });
    expect(() => buildPackFile(description, SOURCE)).toThrow(
      'Rule docks (Each dock inspected within 30 days) names obligation maintenance.dock-inspected-within-days, but a rule under rules is written by check kind. An obligation goes in a provision under provisions, in a procedure exactly as in a waiver: number, title, quote, obligation and its parameters.',
    );
  });

  it('says so in the procedure template, which builds as written', () => {
    const template = packTemplate('procedure');
    expect(template['pack.yaml']).toContain('# provisions:');
    expect(template['pack.yaml']).toContain('An obligation named under rules is');
    expect(template['pack.yaml']).toContain(
      'crew.duty-period version 1: type crew.duty-period, no where on values.recordType',
    );
    expect(() => buildPackFile(parse(template['pack.yaml']!), template['source.txt']!)).not.toThrow();
  });
});

describe('Every check kind, printed from the registry', () => {
  it('prints every registered kind with its inputs and each parameter, required or not', () => {
    const printed = checkKindsPrintout().join('\n');
    for (const kind of listCheckKinds()) expect(printed).toContain(`${kind.id} version ${kind.version}: ${kind.title}`);
    const duty = checkKindsPrintout('duty.within-limits').join('\n');
    expect(duty).toContain('    periods (required): Recorded duty and rest periods of the person, read in full.');
    expect(duty).toContain('    window (optional):');
    expect(duty).toContain('    dutySelect (required): a selection of the records that count');
    expect(duty).toContain('    maxDutyHours (optional): a duration in hours, or written with its unit, such as 12 h');
    expect(duty).toContain('  Give at least one of maxDutyHours, minRestHours, maxRollingDutyHours.');
    expect(duty).toContain('  minRestHours is given together with restWithinHours.');
    expect(checkKindsPrintout('value.within-limit@2').join('\n')).toContain('    quantity (required)');
    expect(() => checkKindsPrintout('value.nowhere')).toThrow('This Ledger has no check kind value.nowhere.');
  });
});

describe('Rule versions of a version built beside an earlier one', () => {
  it('gives a changed rule the next version, keeps the others and says which changed', () => {
    const first = buildPackFile(manual(1), SOURCE);
    const description = manual(2, '25 kt');
    description.pack.id = first.file.packId;
    const second = buildPackFile(description, SOURCE);
    const { built, changes } = withRuleVersions(second, { file: first.file, path: 'packs/v1.pack.json' });
    const versions = Object.fromEntries(
      built.file.rules.map((rule) => [rule.id.slice(built.file.packId.length + 1), rule.version]),
    );
    expect(versions).toEqual({ 'provision-6.4': 1, wind: 2 });
    expect(changes).toMatchObject({
      earlier: { version: 1 },
      changed: [{ id: `${first.file.packId}.wind`, from: 1, to: 2 }],
      added: [],
      removed: [],
      unchanged: 1,
    });
    expect(built.reports.find((report) => report.rule.id.endsWith('.wind'))!.rule.version).toBe(2);
  });
});

describe('The build printout', () => {
  it('names records and fields by their labels, never a field path, and lists the rules that changed', () => {
    const folder = mkdtempSync(join(tmpdir(), 'ledger-pack-authoring-'));
    const out = join(folder, 'packs');
    const write = (name: string, version: number, limit: string) => {
      const description = manual(version, limit);
      description.pack.id = 'example-ridge.printout-manual';
      mkdirSync(join(folder, name));
      writeFileSync(join(folder, name, 'pack.yaml'), JSON.stringify(description));
      writeFileSync(join(folder, name, 'source.txt'), SOURCE);
    };
    write('v1', 1, '22 kt');
    write('v2', 2, '25 kt');
    const build = (name: string) =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'packages/standard-packs/src/pack-cli.ts', 'build', join(folder, name), '--out', out],
        { cwd: repository, encoding: 'utf8' },
      );
    build('v1');
    const printed = build('v2');
    const rules = printed.slice(printed.indexOf('\n\n'), printed.indexOf('Wrote '));
    expect(rules).not.toMatch(/values\.|interval\.|operator\.record|flight\.record/u);
    expect(rules).toContain(
      'reads flight records about the flight (latest, required; without one: "No flight record on file")',
    );
    expect(rules).toContain('fields read: the flight record’s Wind at takeoff (check parameter field)');
    expect(rules).toContain('and the component named by its flight plan');
    expect(printed).toContain('changed: example-ridge.printout-manual.wind version 1 becomes version 2');
    expect(printed).toContain(
      '1 changed, 0 added, 0 no longer in this version, 1 unchanged and keeping their versions',
    );
  }, 60_000);
});
