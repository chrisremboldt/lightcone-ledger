import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import type { PackFile } from '../../contracts/src/index.js';
import { getRulePackVersion, listRulePackVersions } from '../../domain/src/rule-pack-registry.js';
import { buildPackFolder, findQuotation } from '../src/index.js';
import {
  comparePack,
  packFileQuotations,
  readNewText,
  registeredPackQuotations,
  type ComparedPack,
  type PackComparison,
  type QuotationComparison,
} from '../src/pack-compare.js';
import { comparisonReportLines, countsLines } from '../src/pack-compare-printout.js';
import { writeNextVersion } from '../src/pack-next-version.js';

// A new text compared with the one a pack quotes: two invented editions of the invented waiver, a built-in pack
// against its own retained text, and the start of the next version that pnpm pack:build refuses until it is settled.

const repository = join(import.meta.dirname, '..', '..', '..');
const example = fileURLToPath(new URL('../examples/invented-waiver/', import.meta.url));
const amendmentPath = join(example, 'amendment-1.txt');
const amendment = readFileSync(amendmentPath);

const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'packages/standard-packs/src/pack-cli.ts', ...args], {
    cwd: repository,
    encoding: 'utf8',
  });

const compareExample = () =>
  comparePack(packFileQuotations(buildPackFolder(example).file, 'pack_folder'), readNewText(amendment));

const provision = (comparison: PackComparison, number: number): QuotationComparison =>
  comparison.rules.find((rule) => rule.id.endsWith(`.provision-${number}`))!;

const newWords = (span: { start: number; end: number }, text = amendment) =>
  text.subarray(span.start, span.end).toString('utf8');

describe('Two editions of the invented waiver', () => {
  const comparison = compareExample();

  it('finds an unchanged provision byte for byte and gives its new span', () => {
    const listed = provision(comparison, 1);
    expect(listed).toMatchObject({ result: 'unchanged', moved: false, old: { start: 342, end: 418, line: 11 } });
    expect(listed.occurrences).toEqual([{ start: 457, end: 533, line: 14, exact: true }]);
    expect(newWords(listed.occurrences[0]!)).toBe(
      'Only the aircraft registered as FICT-0301 may be operated\nunder this waiver.',
    );
  });

  it('finds a re-wrapped provision by its words, where pnpm pack:build will find it', () => {
    const training = provision(comparison, 3);
    expect(training.result).toBe('unchanged_but_for_spacing');
    expect(training.occurrences).toHaveLength(1);
    expect(training.occurrences[0]!.exact).toBe(false);
    expect(newWords(training.occurrences[0]!)).toBe(
      'Each remote pilot completes the Bridge inspection\noperations course within the 12 calendar months\nbefore the operation.',
    );
    const built = findQuotation(amendment.toString('utf8'), training.quotation);
    expect(training.occurrences[0]).toMatchObject({ start: built.start, end: built.end, line: built.line });
  });

  it('shows the nearest passage to a reworded provision and what differs word by word', () => {
    const height = provision(comparison, 2);
    expect(height).toMatchObject({ result: 'changed', occurrences: [], moved: false });
    expect(height.nearest).toMatchObject({ line: 17, lastLine: 18, matchedWords: 10, quotationWords: 12 });
    expect(height.nearest!.text).toBe(
      '3. Maximum height. The aircraft is not flown higher than 300 feet above\nground level.',
    );
    expect(newWords(height.nearest!)).toBe('The aircraft is not flown higher than 300 feet above\nground level.');
    expect(height.nearest!.differences).toEqual([
      { kind: 'same', words: 'The aircraft is not' },
      { kind: 'quotation_only', words: 'operated' },
      { kind: 'new_text_only', words: 'flown' },
      { kind: 'same', words: 'higher than' },
      { kind: 'quotation_only', words: '250' },
      { kind: 'new_text_only', words: '300' },
      { kind: 'same', words: 'feet above ground level.' },
    ]);
  });

  it('reports a removed provision as not found', () => {
    const speed = provision(comparison, 4);
    expect(speed).toMatchObject({ result: 'not_found', occurrences: [] });
    expect(speed.nearest!.share).toBeLessThan(comparison.method.nearest.threshold);
  });

  it('marks the provision that left the order the others keep', () => {
    expect(provision(comparison, 5)).toMatchObject({ result: 'unchanged', moved: true });
    expect(comparison.rules.filter((rule) => rule.moved).map((rule) => rule.id)).toEqual([
      'alpha-dispatch.waiver-exw-0042.provision-5',
    ]);
  });

  it('lists the added provision among the passages no rule quotes, and says how the text was cut', () => {
    expect(comparison.method.passages).toMatchObject({ cutBy: 'blank_lines', designatorLines: 0 });
    const openings = comparison.passages.unquoted.map((passage) => passage.opening);
    expect(openings.filter((opening) => /^\d\. /u.test(opening))).toEqual([
      '3. Maximum height. The aircraft is not flown higher than 300 feet above ground level.',
      '5. Observer. A visual observer watches the airspace above the footbridge for the whole of each flig…',
    ]);
    const reworded = comparison.passages.unquoted.find((passage) => passage.opening.startsWith('3. Maximum'))!;
    expect(reworded.nearestTo).toEqual(['alpha-dispatch.waiver-exw-0042.provision-2']);
    const added = comparison.passages.unquoted.find((passage) => passage.opening.startsWith('5. Observer'))!;
    expect(added).toMatchObject({ line: 24, nearestTo: [] });
    expect(newWords(added)).toMatch(/^5\. Observer\..*each flight\.$/su);
  });

  it('ends with the count of each result, and gives the same report for the same inputs', () => {
    expect(comparison.counts).toEqual({
      rules: {
        compared: 5,
        unchanged: 2,
        unchangedButForSpacing: 1,
        changed: 1,
        notFound: 1,
        moved: 1,
        moreThanOnce: 0,
      },
      otherQuotations: {
        compared: 0,
        unchanged: 0,
        unchangedButForSpacing: 0,
        changed: 0,
        notFound: 0,
        moved: 0,
        moreThanOnce: 0,
      },
      passages: { total: 8, quotedByNoRule: 5 },
    });
    expect(JSON.stringify(compareExample())).toBe(JSON.stringify(comparison));
  });

  it('prints what the words did, how each step was made, and never whether a rule applies', () => {
    const printed = [
      ...comparisonReportLines(comparison, 'invented-waiver', 'amendment-1.txt'),
      ...countsLines(comparison),
    ];
    const report = printed.join('\n');
    expect(report).toContain(
      'The new text is compared exactly as the file holds it: 859 bytes of UTF-8, not re-encoded',
    );
    expect(report).toContain('scoring 3 for each word found in order and taking 1 off for each word passed over');
    expect(report).toContain('fewer than 60% of the quotation’s words the result is Not found');
    expect(report).toContain('The new text is cut into 8 passages at blank lines');
    expect(report).toContain(
      '      The aircraft is not [-operated-] {+flown+} higher than [-250-] {+300+} feet above ground level.',
    );
    expect(report).toContain('  Moved: the pack’s other quotations found in the new text keep the order they had');
    expect(report).not.toMatch(/still applies|no longer applies|compliant/iu);
    expect(printed.slice(-2)).toEqual([
      'Rules: 5 compared. Unchanged 2, unchanged but for spacing 1, changed 1, not found 1. Of those in the new text, moved: 1; there more than once: 0.',
      'Passages of the new text: 8, of which no rule quotes 5.',
    ]);
  });
});

/** An invented manual with paragraph designators, a character of more than one byte and a sentence it repeats. */
const DESIGNATED = `Example Ridge Survey Operations Manual, revision 4 (invented)

§ 4.1 Launch limits — wind and cloud.
    (a) No launch when the wind at takeoff is above 22 kt.
    (b) No launch when the cloud base is below 500 ft.
    (1) The remote pilot records the wind.
    (2) The remote pilot records the cloud base.

§ 4.2 Logs.
    (a) The remote pilot signs the log.
    (b) The observer countersigns it. The remote pilot signs the log.
`;

function invented(quotations: Record<string, string>): ComparedPack {
  return {
    packId: 'example-ridge.operations-manual',
    version: 1,
    title: 'Example Ridge Survey Operations Manual (invented)',
    from: 'pack_file',
    quotations: Object.entries(quotations).map(([id, words]) => ({
      kind: 'rule',
      id: `example-ridge.operations-manual.${id}`,
      version: 1,
      title: id,
      reference: `Operations Manual: ${id}`,
      bytes: Buffer.from(words, 'utf8'),
    })),
  };
}

describe('Spans, passages and repeated quotations', () => {
  const bytes = Buffer.from(DESIGNATED, 'utf8');
  const comparison = comparePack(
    invented({
      wind: '(a) No launch when the wind at takeoff is above 22 kt.',
      cloud: '(b) No launch when the cloud base is below 500 ft.\n    (1) The remote pilot records the wind.',
      signed: 'The remote pilot signs the log.',
    }),
    readNewText(bytes),
  );
  const rule = (id: string) => comparison.rules.find((item) => item.id.endsWith(`.${id}`))!;

  it('gives spans in bytes of the new text as the file holds it', () => {
    const [found] = rule('wind').occurrences;
    expect(newWords(found!, bytes)).toBe('(a) No launch when the wind at takeoff is above 22 kt.');
    // The section sign and the dash before it are more than one byte each, so the span is not a character index.
    const character = DESIGNATED.indexOf('(a) No launch');
    expect(found!.start).toBe(Buffer.byteLength(DESIGNATED.slice(0, character), 'utf8'));
    expect(found!.start).toBe(character + 3);
    expect(found).toMatchObject({ line: 4, exact: true });
  });

  it('cuts at lines that begin with a paragraph designator where the text has them, and says so', () => {
    expect(comparison.method.passages).toMatchObject({ cutBy: 'paragraph_designators', designatorLines: 8 });
    expect(comparison.method.passages.cut).toContain('at each line that begins with a paragraph designator');
    expect(comparison.passages.total).toBe(9);
    expect(comparison.passages.unquoted.map((passage) => passage.opening)).toEqual([
      'Example Ridge Survey Operations Manual, revision 4 (invented)',
      '§ 4.1 Launch limits — wind and cloud.',
      '(2) The remote pilot records the cloud base.',
      '§ 4.2 Logs.',
    ]);
  });

  it('reports a quotation that is in the new text more than once with every span', () => {
    const signed = rule('signed');
    expect(signed.result).toBe('unchanged');
    expect(signed.occurrences.map((found) => found.line)).toEqual([10, 11]);
    expect(signed.occurrences.map((found) => newWords(found, bytes))).toEqual([
      'The remote pilot signs the log.',
      'The remote pilot signs the log.',
    ]);
    expect(comparison.counts.rules.moreThanOnce).toBe(1);
    expect(comparisonReportLines(comparison, 'pack', 'text').join('\n')).toContain(
      '2 times. Which one is meant is for a person to read.',
    );
  });

  it('takes a quotation that begins or ends inside a longer run of characters, as the builder does', () => {
    const rewrapped = Buffer.from(DESIGNATED.replace('cloud base is below', 'cloud\n    base is under'), 'utf8');
    const fragments = comparePack(
      invented({
        wind: 'launch when the wind at takeoff is above 22',
        cloud: 'No launch when the cloud base is below 500 ft',
        records: 'pilot records the cloud',
      }),
      readNewText(rewrapped),
    );
    const [wind, cloud, records] = fragments.rules;
    expect(wind).toMatchObject({ result: 'unchanged', occurrences: [{ line: 4, exact: true }] });
    expect(cloud).toMatchObject({ result: 'changed', nearest: { matchedWords: 9, quotationWords: 10 } });
    expect(cloud!.nearest!.differences).toEqual([
      { kind: 'same', words: 'No launch when the cloud base is' },
      { kind: 'quotation_only', words: 'below' },
      { kind: 'new_text_only', words: 'under' },
      { kind: 'same', words: '500 ft' },
    ]);
    expect(records).toMatchObject({ result: 'unchanged', occurrences: [{ line: 8 }] });
    const respaced = comparePack(invented({ cloud: 'launch when the cloud base is under 500' }), readNewText(rewrapped))
      .rules[0]!;
    const built = findQuotation(rewrapped.toString('utf8'), respaced.quotation);
    expect(respaced.result).toBe('unchanged_but_for_spacing');
    expect(respaced.occurrences).toEqual([{ start: built.start, end: built.end, line: built.line, exact: false }]);
    expect(newWords(respaced.occurrences[0]!, rewrapped)).toBe('launch when the cloud\n    base is under 500');
  });

  it('reports every quotation as not found in an empty text', () => {
    const empty = comparePack(
      invented({ wind: 'No launch when the wind at takeoff is above 22 kt.' }),
      readNewText(Buffer.alloc(0)),
    );
    expect(empty.rules[0]).toMatchObject({ result: 'not_found', occurrences: [] });
    expect(empty.rules[0]!.nearest).toBeUndefined();
    expect(empty.passages).toEqual({ total: 0, unquoted: [] });
    expect(comparisonReportLines(empty, 'pack', 'text').join('\n')).toContain(
      'Not found: the quotation is not in the new text, and no word of it is matched there.',
    );
  });

  it('refuses a new text that is not valid UTF-8', () => {
    expect(() => readNewText(Buffer.from([0x34, 0x2e, 0x31, 0xff, 0xfe]), 'manual.txt')).toThrow(
      'manual.txt is not valid UTF-8 text. The new text is compared exactly as the file holds it and is never re-encoded',
    );
  });
});

describe('A built-in pack against its own retained text', () => {
  const retained = {
    'ledger.part107': 'packages/pack-part107/resources/govinfo-cfr-2026-title14-vol2-part107.xml',
    'ledger.part108-nprm': 'packages/pack-part108-nprm/resources/govinfo-fr-2025-14992.htm',
  };

  it('pnpm pack:compare finds every rule of ledger.part107 unchanged, at the span the pack pins', () => {
    const ran = cli('compare', 'ledger.part107', retained['ledger.part107'], '--json');
    expect(ran.status).toBe(0);
    const comparison = JSON.parse(ran.stdout) as PackComparison;
    const latest = listRulePackVersions()
      .filter((pack) => pack.packId === 'ledger.part107')
      .at(-1)!;
    expect(comparison.pack).toMatchObject({ packId: 'ledger.part107', version: latest.version, from: 'built_in' });
    expect(comparison.rules).toHaveLength(getRulePackVersion('ledger.part107', latest.version)!.leaves.length);
    for (const rule of comparison.rules) {
      expect(rule).toMatchObject({ result: 'unchanged', moved: false });
      expect(rule.occurrences).toContainEqual(expect.objectContaining({ start: rule.old!.start, end: rule.old!.end }));
    }
    expect(comparison.counts.rules).toMatchObject({ unchanged: comparison.rules.length, changed: 0, notFound: 0 });
    expect(comparison.counts.otherQuotations).toMatchObject({ changed: 0, notFound: 0, unchangedButForSpacing: 0 });
  }, 60_000);

  it('finds every quotation of ledger.part108-nprm unchanged, read from the registered version', () => {
    const latest = listRulePackVersions()
      .filter((pack) => pack.packId === 'ledger.part108-nprm')
      .at(-1)!;
    const pack = registeredPackQuotations(getRulePackVersion('ledger.part108-nprm', latest.version)!);
    const text = readFileSync(join(repository, retained['ledger.part108-nprm']));
    const comparison = comparePack(pack, readNewText(text));
    expect(comparison.counts.rules).toMatchObject({
      compared: pack.quotations.filter((quotation) => quotation.kind === 'rule').length,
      unchangedButForSpacing: 0,
      changed: 0,
      notFound: 0,
      moved: 0,
    });
    expect(comparison.counts.rules.unchanged).toBe(comparison.counts.rules.compared);
    expect(comparison.counts.otherQuotations.unchanged).toBe(comparison.counts.otherQuotations.compared);
    for (const rule of comparison.rules)
      expect(rule.occurrences).toContainEqual(expect.objectContaining({ start: rule.old!.start, end: rule.old!.end }));
  }, 60_000);
});

describe('The start of the next version', () => {
  it('is refused by pnpm pack:build, naming each rule a person must settle, and builds once they are', () => {
    const work = mkdtempSync(join(tmpdir(), 'ledger-pack-compare-'));
    const next = join(work, 'next');
    const wrote = cli('compare', example, amendmentPath, '--write-next', next);
    expect(wrote.status).toBe(0);
    expect(wrote.stdout).toContain(`Wrote the start of version 2 in ${next}`);
    expect(wrote.stdout).toContain('3 quotations kept as written');
    expect(wrote.stdout).toContain('    Provision 2 (Maximum height): its words changed');
    expect(wrote.stdout.trimEnd().split('\n').at(-1)).toBe('Passages of the new text: 8, of which no rule quotes 5.');
    expect(readFileSync(join(next, 'source.txt')).equals(amendment)).toBe(true);

    const refused = cli('build', next);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('has 2 quotations a person must settle before it builds');
    expect(refused.stderr).toContain(
      [
        '  Provision 2 (Maximum height): its words changed in the new text.',
        '    Old quotation: "The aircraft is not operated higher than 250 feet above ground level."',
        '    Nearest passage of the new text (line 17): "3. Maximum height. The aircraft is not flown higher than 300 feet above ground level."',
      ].join('\n'),
    );
    expect(refused.stderr).toContain(
      [
        "  Rule provision-4 (Planned ground speed within the holder's limit): nothing near its words is in the new text.",
        '    Old quotation: "The planned ground speed of the aircraft does not exceed the limit the holder sets"',
      ].join('\n'),
    );
    expect(existsSync(join(next, 'alpha-dispatch.waiver-exw-0042-v2.pack.json'))).toBe(false);

    // The description is otherwise as it was: its comments, and every quotation the new text holds once.
    const description = readFileSync(join(next, 'pack.yaml'), 'utf8');
    expect(description).toContain('# Everything here is invented: the waiver, its holder and its numbers.');
    expect(description).toContain('# Left by pnpm pack:compare for a person: settle it, then delete settle.');
    const document = parseDocument(description);
    expect(document.getIn(['pack', 'version'])).toBe(2);
    expect(document.hasIn(['provisions', 0, 'settle'])).toBe(false);
    expect(document.hasIn(['provisions', 2, 'settle'])).toBe(false);
    expect(document.hasIn(['provisions', 3, 'settle'])).toBe(false);

    // A person settles the two: the reworded provision quotes the new words, the removed one is taken out.
    document.setIn(['provisions', 1, 'quote'], 'The aircraft is not flown higher than 300 feet above ground level.');
    document.setIn(['provisions', 1, 'parameters', 'maxFeetAboveGround'], 300);
    document.deleteIn(['provisions', 1, 'settle']);
    document.delete('rules');
    writeFileSync(join(next, 'pack.yaml'), document.toString());
    const file = join(next, 'alpha-dispatch.waiver-exw-0042-v2.pack.json');
    const succeeded = cli('build', next);
    expect(succeeded.status).toBe(0);
    expect(succeeded.stdout).toContain('Built alpha-dispatch.waiver-exw-0042 version 2');
    expect(succeeded.stdout).toContain(`Wrote ${file}`);
    const built = JSON.parse(readFileSync(file, 'utf8')) as PackFile;
    expect(built).toMatchObject({ packId: 'alpha-dispatch.waiver-exw-0042', version: 2 });
    expect(built.sources[0]!.text).toBe(amendment.toString('utf8'));
    expect(built.rules.map((rule) => rule.id.split('.').at(-1))).toEqual([
      'provision-1',
      'provision-2',
      'provision-3',
      'provision-5',
    ]);

    // The built file is compared like a folder, and now every quotation it pins is in the text.
    const settled = cli('compare', file, amendmentPath, '--json');
    expect(settled.status).toBe(0);
    expect((JSON.parse(settled.stdout) as PackComparison).counts.rules).toMatchObject({
      compared: 4,
      unchanged: 4,
      moved: 0,
    });
  }, 60_000);

  it('marks a quotation the new text holds more than once, an occurrence out of date and a changed retention', () => {
    const work = mkdtempSync(join(tmpdir(), 'ledger-pack-compare-'));
    const folder = join(work, 'notes');
    mkdirSync(folder);
    writeFileSync(
      join(folder, 'notes.txt'),
      `Example Ridge Survey field notes, issue 1 (invented)

1. The crew is briefed before each flight.

2. The log is signed. After a flight over water the log is signed.

3. The holder keeps a log of each flight for 12 months.
`,
    );
    writeFileSync(
      join(folder, 'pack.yaml'),
      `pack:
  id: example-ridge-${process.pid}.field-notes
  version: 3
  title: Example Ridge Survey field notes (invented)
source:
  file: notes.txt
  kind: procedure
  reference: Example Ridge Survey field notes (invented)
rules:
  - id: briefing
    title: Crew briefed before each flight
    quote: The crew is briefed before each flight.
    coverage: manual
    waitingFor: Confirm that the crew was briefed.
  - id: signed-over-water
    title: Log signed after a flight over water
    quote: log is signed.
    occurrence: 2
    coverage: manual
    waitingFor: Confirm that the log was signed.
records:
  - id: flight-log
    title: Log of each flight
    quote: The holder keeps a log of each flight
    keptBy: The holder
    heldBy: [flight.record]
    retention:
      quote: for 12 months
`,
    );
    const issueTwo = Buffer.from(`Example Ridge Survey field notes, issue 2 (invented)

1. The crew is briefed before each flight. A visiting observer is told:
The crew is briefed before each flight.

2. After a flight over water the log is signed.

3. The holder keeps a log of each flight for 24 months.
`);
    const comparison = comparePack(
      packFileQuotations(buildPackFolder(folder).file, 'pack_folder'),
      readNewText(issueTwo),
    );
    expect(comparison.otherQuotations.map((other) => [other.kind, other.result])).toEqual([
      ['required_record', 'unchanged'],
      ['retention', 'changed'],
    ]);
    const next = join(work, 'next');
    const written = writeNextVersion(folder, next, comparison, issueTwo);
    expect(written).toMatchObject({ version: 4, sourceFile: 'notes.txt', kept: 1 });
    expect(written.toSettle).toEqual([
      { label: 'Rule briefing (Crew briefed before each flight)', result: 'more_than_once' },
      { label: 'Rule signed-over-water (Log signed after a flight over water)', result: 'occurrence_out_of_date' },
      { label: 'Record flight-log retention', result: 'changed' },
    ]);
    expect(readFileSync(join(next, 'notes.txt')).equals(issueTwo)).toBe(true);
    expect(() => buildPackFolder(next)).toThrow(
      [
        '  Rule briefing (Crew briefed before each flight): its words are in the new text more than once, starting on lines 3, 4.',
        '    Old quotation: "The crew is briefed before each flight."',
        '    Say which with occurrence: N (1 for the first), or quote more of it, then delete settle.',
        '  Rule signed-over-water (Log signed after a flight over water): its words are in the new text once, on line 6, but it gives occurrence: 2.',
        '    Old quotation: "log is signed."',
        '    Remove occurrence, then delete settle.',
        '  Record flight-log retention: its words changed in the new text.',
        '    Old quotation: "for 12 months"',
        '    Nearest passage of the new text (line 8): "3. The holder keeps a log of each flight for 24 months."',
      ].join('\n'),
    );
    expect(() => writeNextVersion(folder, next, comparison, issueTwo)).toThrow('already holds files');
  });

  it('is written only for a pack folder', () => {
    const next = join(mkdtempSync(join(tmpdir(), 'ledger-pack-compare-')), 'next');
    const ran = cli('compare', 'ledger.part107', amendmentPath, '--write-next', next);
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain('--write-next starts the next version of a pack folder; ledger.part107 is not one');
    expect(existsSync(next)).toBe(false);
  }, 60_000);
});
