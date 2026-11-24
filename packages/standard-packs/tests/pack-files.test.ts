import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  isCheckedRuleLeaf,
  type CheckedRuleLeaf,
  type PackFile,
  type PackFileCheckedRule,
} from '../../contracts/src/index.js';
import type { CheckObservation } from '../../domain/src/check-kinds.js';
import { narrowRead, runCheckedRule } from '../../domain/src/checked-rules.js';
import { getRulePackVersion, listRulePackVersions } from '../../domain/src/rule-pack-registry.js';
import { sectionsOf } from '../../domain/src/rule-pack-sections.js';
import {
  buildPackFile,
  findQuotation,
  packTemplate,
  packTemplateKinds,
  readPackFolder,
  registerPackFolder,
  registerStandardPacks,
  verifiedPackFile,
} from '../src/index.js';

const example = new URL('../examples/invented-waiver/', import.meta.url);
const exampleSource = readFileSync(new URL('source.txt', example), 'utf8');
const exampleDescription = () => parse(readFileSync(new URL('pack.yaml', example), 'utf8'));

let packs = 0;
/** The invented waiver, under a pack id of its own so each test registers its own pack. */
function describedPack(change: (description: any) => void = () => {}) {
  const description = exampleDescription();
  description.pack.id = `test-${process.pid}-${++packs}.waiver`;
  change(description);
  return description;
}

const build = (change?: (description: any) => void) => buildPackFile(describedPack(change), exampleSource).file;

function folderWith(files: Record<string, unknown>): string {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-pack-files-'));
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(folder, name), typeof content === 'string' ? content : JSON.stringify(content));
  return folder;
}

const resealed = (file: PackFile, change: (copy: PackFile) => void): PackFile => {
  const copy = structuredClone(file);
  change(copy);
  return copy;
};

describe('building a pack file from a description', () => {
  it('makes every provision a rule quoting its exact bytes, a person checking the one no record shows', () => {
    const built = buildPackFile(describedPack(), exampleSource);
    const bytes = Buffer.from(exampleSource, 'utf8');
    expect(built.file.rules.map((rule) => rule.id.split('.').at(-1))).toEqual([
      'provision-1',
      'provision-2',
      'provision-3',
      'provision-5',
      'provision-4',
    ]);
    for (const rule of built.file.rules) {
      const quoted = bytes.subarray(rule.quote.start, rule.quote.end).toString('utf8');
      expect(exampleSource.includes(quoted)).toBe(true);
    }
    // The quotation wraps differently from the source; the span is the source's own bytes.
    const training = built.file.rules[2]!;
    expect(bytes.subarray(training.quote.start, training.quote.end).toString('utf8')).toBe(
      'Each remote pilot completes the Bridge inspection operations\ncourse within the 12 calendar months before the operation.',
    );
    expect(built.file.rules[3]).toEqual({
      id: `${built.file.packId}.provision-5`,
      version: 1,
      title: 'Certificate available at the control station',
      quote: expect.objectContaining({
        reference: 'Certificate of Waiver EXW-0042 (invented), provision 5: Certificate at hand',
      }),
      coverage: 'manual',
      waitingFor: 'Confirm that a copy of this certificate was at the control station throughout the operation.',
      paragraph: 'Provision 5',
    });
    const { version } = verifiedPackFile(built.file);
    expect(version.leaves.map((leaf) => leaf.coverage)).toEqual([
      'automated',
      'automated',
      'automated',
      'manual',
      'automated',
    ]);
    expect(version.leaves[3]).toMatchObject({
      source: {
        kind: 'waiver_or_exemption',
        text: 'A copy of this certificate is kept at the control\nstation during operations.',
      },
      dependencies: [],
      waitingFor: 'Confirm that a copy of this certificate was at the control station throughout the operation.',
    });
    expect(version.digest).toBe(built.file.digest);
    expect(version.leaves[0]!.source).toMatchObject({
      kind: 'waiver_or_exemption',
      reference: 'Certificate of Waiver EXW-0042 (invented), provision 1: Listed aircraft',
      text: 'Only the aircraft registered as FICT-0301 may be operated\nunder this waiver.',
    });
  });

  it('reads a waiver without sections in provision order, and one with sections under them', () => {
    const unsectioned = verifiedPackFile(build()).version;
    expect(unsectioned.sections).toBeUndefined();
    expect(sectionsOf(unsectioned)).toEqual([
      {
        section: { id: 'all', title: 'All rules' },
        leaves: ['provision-1', 'provision-2', 'provision-3', 'provision-4', 'provision-5'].map((ending) =>
          expect.objectContaining({ id: `${unsectioned.packId}.${ending}` }),
        ),
      },
    ]);
    const sectioned = (description: any) => {
      description.sections = [
        { id: 'aircraft', title: 'Aircraft' },
        { id: 'people', title: 'People and training' },
      ];
      for (const provision of [...description.provisions, ...description.rules]) provision.section = 'aircraft';
      description.provisions[2].section = 'people';
    };
    const file = build(sectioned);
    expect(file.sections).toEqual([
      { id: 'aircraft', title: 'Aircraft' },
      { id: 'people', title: 'People and training' },
    ]);
    const { version } = verifiedPackFile(file);
    expect(sectionsOf(version).map(({ section, leaves }) => [section.id, leaves.length])).toEqual([
      ['aircraft', 4],
      ['people', 1],
    ]);
    expect(version.leaves[2]).toMatchObject({ section: 'people', paragraph: 'Provision 3' });
    expect(() =>
      build((description) => {
        sectioned(description);
        delete description.provisions[0].section;
      }),
    ).toThrow(
      /^Provision 1 \(Listed aircraft\) needs section: one of the ids the sections list gives \(aircraft, people\)$/,
    );
    expect(() =>
      build((description) => {
        sectioned(description);
        description.provisions[0].section = 'crew';
      }),
    ).toThrow(/names section crew, which the sections list does not give/);
    // A file edited to name a section it does not list is refused as startup refuses it.
    expect(() => verifiedPackFile(resealed(file, (copy) => (copy.rules[0]!.section = 'crew')))).toThrow(
      /names section crew, which the pack does not list/,
    );
  });

  it('declares the document purposes the pack looks for, its own and those its obligations name', () => {
    const built = buildPackFile(
      describedPack((description) => {
        description.purposes = [
          {
            id: 'invented.certificate-copy',
            title: 'Copy of the certificate',
            documentTypes: ['certificate'],
            quote: 'A copy of this certificate',
          },
        ];
        description.provisions[3] = {
          number: 5,
          title: 'Certificate at hand',
          quote: 'A copy of this certificate is kept at the control station during operations.',
          obligation: 'procedure.on-file',
          parameters: { procedureKind: 'emergency' },
        };
      }),
      exampleSource,
    );
    expect(built.file.purposes!.map(({ id, title }) => [id, title])).toEqual([
      ['invented.certificate-copy', 'Copy of the certificate'],
      ['procedure.emergency', 'Emergency procedure'],
    ]);
    const { version } = verifiedPackFile(built.file);
    expect(version.purposes![0]!.documentTypes).toEqual(['certificate']);
    expect(version.purposes!.map(({ id, source }) => [id, source.text.replace(/\s+/g, ' ')])).toEqual([
      ['invented.certificate-copy', 'A copy of this certificate'],
      ['procedure.emergency', 'A copy of this certificate is kept at the control station during operations.'],
    ]);
    // Without purposes the pack file and its version carry none, so files built before keep their digests.
    expect(build().purposes).toBeUndefined();
    expect(() =>
      build((description) => {
        description.purposes = [{ id: 'Not An Id', title: 'Bad', quote: 'A copy of this certificate' }];
      }),
    ).toThrow();
  });

  it('declares the records the waiver says are kept, quoting what lists them and how long, in its own words', () => {
    const source = `${exampleSource}\n6. Records. The holder keeps a log of each flight and keeps each entry for\n24 calendar months after the flight. The holder keeps the training records.\n`;
    const records = [
      {
        id: 'flight-log',
        title: 'Log of each flight',
        quote: 'The holder keeps a log of each flight',
        keptBy: 'The holder',
        heldBy: ['flight.record', 'safety:document'],
        retention: { quote: 'keeps each entry for 24 calendar months after the flight' },
      },
      {
        id: 'training',
        title: 'Training records',
        quote: 'The holder keeps the training records.',
        keptBy: 'The holder',
        heldBy: ['person.training'],
      },
    ];
    const built = buildPackFile(
      describedPack((description) => {
        description.records = records;
      }),
      source,
    );
    const packId = built.file.packId;
    expect(built.file.requiredRecords!.map(({ id, heldBy }) => [id, heldBy])).toEqual([
      [
        `${packId}.flight-log`,
        [
          { kind: 'operator_record', recordType: 'flight.record' },
          { kind: 'safety_record', recordKind: 'document' },
        ],
      ],
      [`${packId}.training`, [{ kind: 'operator_record', recordType: 'person.training' }]],
    ]);
    const { version } = verifiedPackFile(built.file);
    expect(version.digest).toBe(built.file.digest);
    expect(version.requiredRecords![0]).toMatchObject({
      title: 'Log of each flight',
      keptBy: 'The holder',
      source: { kind: 'waiver_or_exemption', text: 'The holder keeps a log of each flight' },
      retention: { source: { text: 'keeps each entry for\n24 calendar months after the flight' } },
    });
    // A record whose words state no period carries no retention: nothing is computed in its place.
    expect(version.requiredRecords![1]!.retention).toBeUndefined();
    // Without records the pack file and its version carry none, so files built before keep their digests.
    expect(build().requiredRecords).toBeUndefined();

    const refused = (change: (record: any) => void, message: RegExp) =>
      expect(() =>
        buildPackFile(
          describedPack((description) => {
            description.records = structuredClone(records);
            change(description.records[0]);
          }),
          source,
        ),
      ).toThrow(message);
    refused(
      (record) => (record.heldBy = ['flight.notes']),
      /flight\.notes, which is not a record type this Ledger has/,
    );
    refused((record) => (record.heldBy = ['safety:minutes']), /safety:minutes is not a safety record/);
    refused((record) => (record.heldBy = []), /needs heldBy/);
    refused((record) => (record.retention = { quote: 'for 36 calendar months' }), /retention/);
    refused((record) => (record.months = 24), /has months, which is not/);
    // A file edited to name another pack's record id is refused on loading.
    expect(() =>
      verifiedPackFile(
        resealed(built.file, (copy) => {
          copy.requiredRecords![0]!.id = 'other.flight-log';
        }),
      ),
    ).toThrow(/does not start with its pack id/);
  });

  it('lets a waiver provision relieve a rule of another pack, and refuses relief from a procedure', () => {
    registerStandardPacks();
    const relieves = [{ packId: 'ledger.part107', ruleIds: ['ledger.part107.107.31.a'] }];
    const built = buildPackFile(
      describedPack((description) => {
        description.provisions[0].relieves = relieves;
      }),
      exampleSource,
    );
    expect(built.file.sources[0]!.kind).toBe('waiver_or_exemption');
    expect(built.file.rules[0]).toMatchObject({ title: 'Provision 1: Listed aircraft', relieves });
    expect(verifiedPackFile(built.file).version.leaves[0]).toMatchObject({
      source: { kind: 'waiver_or_exemption' },
      relieves,
    });
    expect(() =>
      build((description) => {
        description.source.kind = 'procedure';
        delete description.waiver;
        description.provisions[0].relieves = relieves;
      }),
    ).toThrow('declares relief but does not quote a waiver or exemption');
    expect(() =>
      build((description) => {
        description.provisions[0].relieves = [{ packId: 'ledger.part107', ruleIds: ['ledger.part107.no-such-rule'] }];
      }),
    ).toThrow('which no version of ledger.part107 holds');
    expect(() =>
      build((description) => {
        delete description.source.kind;
      }),
    ).toThrow('source needs kind: waiver');
  });

  it('carries a provision without an obligation as a person check or as not supported, and never drops one', () => {
    const file = build((description) => {
      delete description.provisions[3].obligation;
      description.provisions[3].coverage = 'unsupported';
      description.provisions[3].waitingFor = 'An operator record of where the certificate was kept.';
    });
    expect(file.rules[3]).toMatchObject({ coverage: 'unsupported', title: 'Certificate at hand' });
    expect(() =>
      build((description) => {
        delete description.provisions[3].obligation;
      }),
    ).toThrow('Provision 5 (Certificate at hand) needs obligation');
    expect(() =>
      build((description) => {
        delete description.provisions[3].obligation;
        description.provisions[3].coverage = 'manual';
        delete description.provisions[3].waitingFor;
      }),
    ).toThrow('needs waitingFor: what the person confirms');
    // Left out, the obligation type's own sentence says what the person confirms.
    const defaulted = build((description) => {
      delete description.provisions[3].waitingFor;
    });
    expect(defaulted.rules[3]).toMatchObject({
      coverage: 'manual',
      waitingFor: 'Whether a copy was at the control station is not in a record.',
    });
  });

  it('carries who each provision covers and the record it requires, as the built-in waivers do', () => {
    const rules = build().rules.filter((rule): rule is PackFileCheckedRule => 'check' in rule);
    const covered = (name: string) => {
      const rule = rules.find((item) => item.id.endsWith(name))!;
      return [rule.population?.of, rule.reads.filter((read) => read.onFile).map((read) => read.onFile)];
    };
    // An obligation type's own population: every flight in the adoption's dates, read for the aircraft its plan
    // names or the people it assigns as pilot in command.
    expect(covered('provision-1')).toEqual(['in_adoption_dates', ['flight plan', 'aircraft identity record']]);
    expect(covered('provision-2')).toEqual(['in_adoption_dates', ['flight plan']]);
    expect(covered('provision-3')).toEqual([
      'in_adoption_dates',
      ['remote pilot in command assignment', 'record of the named training'],
    ]);
    // A rule by check kind declares its own.
    expect(covered('provision-4')).toEqual(['in_adoption_dates', ['flight plan']]);
  });

  it('starts a procedure from rules that say who they cover and what must be on file', () => {
    const files = packTemplate('procedure');
    const description = parse(files['pack.yaml']!);
    description.pack.id = `test-${process.pid}-${++packs}.template`;
    const rules = buildPackFile(description, files['source.txt']!).file.rules;
    const checked = rules.filter((rule): rule is PackFileCheckedRule => 'check' in rule);
    expect(checked.map((rule) => [rule.target.subjectKind, rule.population?.of])).toEqual([
      ['person', 'on_record'],
      ['aircraft', 'on_record'],
      ['flight', 'in_adoption_dates'],
      ['flight', 'in_adoption_dates'],
      ['flight', 'in_adoption_dates'],
    ]);
    for (const rule of checked)
      expect(
        rule.reads.some((read) => read.required && read.onFile),
        rule.id,
      ).toBe(true);
    expect(rules).toHaveLength(6);
  });

  it('builds both templates a new pack folder starts with', () => {
    for (const kind of packTemplateKinds) {
      const files = packTemplate(kind);
      const description = parse(files['pack.yaml']!);
      description.pack.id = `test-${process.pid}-${++packs}.template`;
      expect(buildPackFile(description, files['source.txt']!).file.rules.length).toBeGreaterThan(0);
    }
  });

  it('refuses a quotation that is absent, and says where it stops matching', () => {
    expect(() =>
      build((description) => {
        description.provisions[1].quote = 'The aircraft is not operated higher than 300 feet above ground level.';
      }),
    ).toThrow(
      /Provision 2 \(Maximum height\): The quotation .* is not in the source\. Its first 7 words match at line 14; after them the source reads "250 feet/,
    );
  });

  it('refuses a quotation that appears more than once unless the rule says which occurrence', () => {
    const ambiguous = (description: any) => {
      description.rules[0].quote = 'the aircraft';
    };
    expect(() => build(ambiguous)).toThrow(/Rule provision-4 .*appears 2 times in the source, at lines 11, 20\. /);
    const chosen = buildPackFile(
      describedPack((description) => {
        ambiguous(description);
        description.rules[0].occurrence = 2;
      }),
      exampleSource,
    );
    const rule = chosen.file.rules.at(-1)!;
    expect(rule.quote.start).toBe(
      Buffer.byteLength(exampleSource.slice(0, exampleSource.indexOf('the aircraft does'))),
    );
    expect(findQuotation(exampleSource, 'the aircraft', 2).line).toBe(20);
    // Words match exactly, capital letters included.
    expect(findQuotation(exampleSource, 'The aircraft').line).toBe(14);
    expect(() => findQuotation(exampleSource, 'the aircraft', 3)).toThrow('there is no occurrence 3');
  });

  it('refuses a check kind this Ledger does not have, an unknown obligation and parameters the kind refuses', () => {
    expect(() =>
      build((description) => {
        description.rules[0].check.kind = 'value.made-up';
      }),
    ).toThrow('names check kind value.made-up version 2, which this Ledger does not have');
    expect(() =>
      build((description) => {
        description.provisions[0].obligation = 'eligibility.made-up';
      }),
    ).toThrow('names obligation eligibility.made-up, which is not one this Ledger has');
    expect(() =>
      build((description) => {
        description.provisions[1].parameters.maxFeetAboveGround = -5;
      }),
    ).toThrow('parameter maxFeetAboveGround must be a positive number');
    expect(() =>
      build((description) => {
        description.rules[0].adoptionParameters = [];
        description.rules[0].check.params = {
          field: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
          comparison: 'roughly',
          limit: 10,
        };
      }),
    ).toThrow(
      /provision-4: Check value.within-limit parameters \/comparison must be equal to one of the allowed values/,
    );
  });

  it('refuses a field a pack file rule does not have, and a pack id only built-in packs use', () => {
    expect(() =>
      build((description) => {
        description.rules[0].evaluate = 'return true';
      }),
    ).toThrow(/must NOT have additional properties \(evaluate\)/);
    expect(() =>
      build((description) => {
        description.pack.id = 'ledger.my-waiver';
      }),
    ).toThrow('only packs that ship with Ledger use');
  });
});

describe('what a waiver states and what its conditions cover', () => {
  const clock = { mode: 'wall' as const, evaluatedAt: '2026-11-20T12:00:00.000Z' };
  const citing = (description: any) => {
    description.waiver.conditionsCover = 'Flights whose plan  cites the certificate';
  };
  let sequence = 0;
  function record(recordType: string, body: Record<string, unknown>, at: string, end?: string): CheckObservation {
    const interval = end ? { start: at, end } : undefined;
    return {
      id: `${recordType}-${++sequence}`,
      type: 'operator.record',
      version: 1,
      occurredAt: at,
      ...(interval ? { interval } : {}),
      observation: {
        occurredAt: at,
        ...(interval ? { interval } : {}),
        values: { recordType, recordVersion: 1, record: body },
      },
    };
  }
  const plan = (operatingAuthorityReference?: string) =>
    record(
      'flight.plan',
      {
        windowStartsAt: '2026-11-20T09:00:00Z',
        windowEndsAt: '2026-11-20T10:00:00Z',
        plannedMaxHeightAboveGroundMeters: 60,
        ...(operatingAuthorityReference ? { operatingAuthorityReference } : {}),
      },
      '2026-11-20T09:00:00.000Z',
      '2026-11-20T10:00:00.000Z',
    );
  /** Gathers each read by type, conditions and selection, as the engine does once a related subject is resolved. */
  function run(rule: CheckedRuleLeaf, observations: CheckObservation[]) {
    const inputs: Record<string, CheckObservation[]> = {};
    const start = (item: CheckObservation) => Date.parse(item.interval?.start ?? item.occurredAt);
    for (const read of rule.reads)
      inputs[read.name] = narrowRead(
        read,
        observations.filter((item) => item.type === read.type).sort((a, b) => start(b) - start(a)),
        inputs,
      );
    return runCheckedRule(rule, rule.check.params, inputs, clock);
  }
  const leaves = (file: PackFile) => verifiedPackFile(file).version.leaves.filter(isCheckedRuleLeaf);
  const leaf = (file: PackFile, name: string) => leaves(file).find((item) => item.id.endsWith(name))!;

  it('states the certificate, the dates it states and which flights its conditions cover, with no default', () => {
    const file = build();
    expect(file.waiver).toEqual({
      certificateNumber: 'EXW-0042',
      conditionsCover: 'every_flight',
      effective: { from: '2026-10-01', through: '2028-09-30' },
    });
    expect(verifiedPackFile(file).version.waiver).toEqual(file.waiver);
    expect(build(citing).waiver!.conditionsCover).toBe('flights_citing_certificate');
    expect(build(citing).digest).not.toBe(file.digest);
    expect(() => build((description) => delete description.waiver)).toThrow(
      'A waiver description needs a waiver section: certificateNumber, effective (from and through) and conditionsCover, which is "flights whose plan cites the certificate" or "every flight".',
    );
    expect(() => build((description) => delete description.waiver.conditionsCover)).toThrow(
      'waiver needs conditionsCover: "flights whose plan cites the certificate" or "every flight"',
    );
    expect(() => build((description) => (description.waiver.conditionsCover = 'the waiver flights'))).toThrow(
      'waiver needs conditionsCover',
    );
    expect(() => build((description) => (description.waiver.effective.through = '2026-09-30'))).toThrow(
      'waiver effective through (2026-09-30) is before from (2026-10-01)',
    );
    expect(() => build((description) => (description.waiver.effective.from = '1 October 2026'))).toThrow(
      'waiver effective from needs a date written as year-month-day',
    );
    expect(() =>
      build((description) => {
        description.source.kind = 'procedure';
      }),
    ).toThrow('A procedure has no waiver section');
  });

  it('covers every flight when the waiver says so: an ordinary flight is checked against each condition', () => {
    const file = build();
    const height = leaf(file, 'provision-2');
    expect(height.reads.map((read) => read.name)).not.toContain('authority');
    expect(run(height, [plan()])).toMatchObject({ outcome: 'pass', reasonCode: 'planned_within_limit' });
  });

  it('limits each provision about a flight to the flights whose plan cites the certificate', () => {
    const file = build(citing);
    const ordinary = plan();
    const sentence =
      'The latest flight plan does not cite EXW-0042 as its operating authority, so the waiver’s conditions do not cover this flight.';
    for (const name of ['provision-1', 'provision-2', 'provision-3']) {
      const rule = leaf(file, name);
      expect(rule.target.subjectKind, name).toBe('flight');
      expect(rule.population, name).toEqual({ of: 'in_adoption_dates' });
      expect(rule.applicability[0], name).toEqual({
        input: 'authority',
        field: 'values.record.operatingAuthorityReference',
        oneOf: ['EXW-0042'],
        whenAbsent: 'insufficient',
        notMetSummary: sentence,
      });
      expect(run(rule, [ordinary]), name).toEqual({
        applicability: 'not_applicable',
        evidenceState: 'not_applicable',
        outcome: 'not_applicable',
        reasonCode: 'condition_not_met',
        summary: sentence,
        evidence: [ordinary.id],
      });
      expect(run(rule, []), name).toMatchObject({ outcome: 'pending', reasonCode: 'record_not_on_file' });
      expect(run(rule, []).summary, name).toMatch(/^No flight plan on file\./);
    }
    expect(run(leaf(file, 'provision-2'), [plan('EXW-0042')])).toMatchObject({
      outcome: 'pass',
      reasonCode: 'planned_within_limit',
    });
    // The relations read only through a covered flight: its plan's aircraft and the pilots it assigns.
    expect(leaf(file, 'provision-1').related).toMatchObject([{ subjectKind: 'aircraft', from: { read: 'plan' } }]);
    expect(leaf(file, 'provision-3').related).toMatchObject([
      { subjectKind: 'person', fanOut: true, from: { read: 'assignments', field: 'values.record.personId' } },
    ]);
    // A rule by check kind covers every flight unless it says otherwise.
    expect(leaf(file, 'provision-4').applicability).toEqual([]);
  });

  it('checks a procedure on file once for the organization, whatever the waiver covers', () => {
    const file = build((description) => {
      citing(description);
      description.provisions[3] = {
        number: 5,
        title: 'Lost link procedure',
        quote: 'A copy of this certificate is kept at the control station during operations.',
        obligation: 'procedure.on-file',
        parameters: { procedureKind: 'lost_link' },
      };
    });
    const procedure = leaf(file, 'provision-5');
    expect(procedure.target).toEqual({ subjectKind: 'organization' });
    expect(procedure.population).toEqual({ of: 'on_record' });
    expect(procedure.applicability).toEqual([]);
    expect(procedure.reads.map((read) => read.about)).toEqual(['organization', 'organization']);
  });

  it('limits a rule by check kind to the flights citing the certificate with one line', () => {
    const file = build((description) => {
      description.rules[0].covers = 'flights whose plan cites the certificate';
    });
    const speed = leaf(file, 'provision-4');
    expect(speed.applicability.map((condition) => condition.input)).toEqual(['authority']);
    expect(speed.reads.map((read) => read.name)).toEqual(['authority', 'quantity']);
    expect(() => build((description) => (description.rules[0].covers = 'every flight'))).toThrow(
      'covers takes one value, "flights whose plan cites the certificate"; leave it out to cover every flight',
    );
    expect(() =>
      build((description) => {
        description.rules[0].covers = 'flights whose plan cites the certificate';
        description.rules[0].target.subjectKind = 'aircraft';
      }),
    ).toThrow('covers limits a rule about each flight');
    expect(() =>
      build((description) => {
        description.source.kind = 'procedure';
        delete description.waiver;
        description.rules[0].covers = 'flights whose plan cites the certificate';
      }),
    ).toThrow('only a waiver has them');
  });

  it('reports an occurrence to a named party within a stated number of hours', () => {
    const file = build((description) => {
      citing(description);
      description.provisions[3] = {
        number: 5,
        title: 'Occurrence report',
        quote: 'A copy of this certificate is kept at the control station during operations.',
        obligation: 'report.occurrence-within',
        parameters: {
          occurrences: ['occurrence.emergency-deviation', 'occurrence.mechanical-irregularity'],
          party: 'Canal District flight standards office',
          hours: 24,
        },
      };
    });
    const report = leaf(file, 'provision-5');
    expect(report).toMatchObject({ target: { subjectKind: 'flight' }, check: { kind: 'events.answered-within' } });
    const occurrence = (reportedToAuthorityAt?: string) =>
      record(
        'occurrence.mechanical-irregularity',
        {
          occurredAt: '2026-11-20T09:30:00Z',
          irregularityDescription: 'Command link lost for 40 seconds',
          correctiveAction: 'Link antenna replaced',
          ...(reportedToAuthorityAt ? { reportedToAuthorityAt } : {}),
        },
        '2026-11-20T09:30:00.000Z',
      );
    const cited = plan('EXW-0042');
    expect(run(report, [cited, occurrence('2026-11-20T20:00:00Z')])).toMatchObject({ outcome: 'pass' });
    expect(run(report, [cited, occurrence('2026-11-21T10:00:00Z')])).toMatchObject({ outcome: 'attention' });
    // Not yet reported, and its 24 hours not yet over: awaited.
    expect(run(report, [cited, occurrence()])).toMatchObject({ outcome: 'pending' });
    expect(run(report, [cited])).toMatchObject({
      outcome: 'not_applicable',
      summary: 'No occurrence of the kinds the provision names is recorded for this flight.',
    });
    expect(run(report, [plan(), occurrence()])).toMatchObject({
      outcome: 'not_applicable',
      reasonCode: 'condition_not_met',
    });
    expect(() =>
      build((description) => {
        description.provisions[3] = {
          number: 5,
          title: 'Occurrence report',
          quote: 'A copy of this certificate is kept at the control station during operations.',
          obligation: 'report.occurrence-within',
          parameters: { occurrences: ['occurrence.made-up'], party: 'Office', hours: 1.5 },
        };
      }),
    ).toThrow(/occurrences holds occurrence\.made-up, which is not one of .*; .*hours must be a positive whole number/);
  });

  it('holds every maintenance entry for the planned aircraft complete', () => {
    const file = build((description) => {
      citing(description);
      description.provisions[3] = {
        number: 5,
        title: 'Maintenance records',
        quote: 'A copy of this certificate is kept at the control station during operations.',
        obligation: 'record.maintenance-complete',
      };
    });
    const maintenance = leaf(file, 'provision-5');
    expect(maintenance.related).toMatchObject([
      { subjectKind: 'aircraft', from: { read: 'plan', field: 'secondarySubject' } },
    ]);
    const entry = (performedByName?: string) =>
      record(
        'maintenance.action',
        {
          actionDescription: 'Rear left motor replaced',
          performedAt: '2026-11-05T17:00:00Z',
          ...(performedByName ? { performedByName } : {}),
        },
        '2026-11-05T17:00:00.000Z',
      );
    const cited = plan('EXW-0042');
    expect(run(maintenance, [cited, entry('Sam Example')])).toMatchObject({ outcome: 'pass' });
    expect(run(maintenance, [cited, entry('Sam Example'), entry()])).toMatchObject({
      outcome: 'attention',
      reasonCode: 'record_incomplete',
    });
    expect(run(maintenance, [cited])).toMatchObject({ outcome: 'not_applicable' });
  });
});

describe('verifying a pack file', () => {
  it('refuses a file whose rules no longer make its stated digest', () => {
    const file = build();
    const edited = resealed(file, (copy) => {
      (copy.rules[1] as PackFileCheckedRule).check.params.limit = 200;
    });
    expect(() => verifiedPackFile(edited)).toThrow(
      new RegExp(`Its rules make a pack with digest [a-f0-9]{64}, but the file states ${file.digest}`),
    );
  });

  it('refuses a file whose source text changed after it was built', () => {
    const file = build();
    const edited = resealed(file, (copy) => {
      copy.sources[0]!.text = copy.sources[0]!.text.replace('Canal District', 'Canal Quarter');
    });
    expect(() => verifiedPackFile(edited)).toThrow('Source source does not match its byte length and SHA-256');
  });

  it('refuses a rule that names an unknown check kind', () => {
    const file = build();
    const edited = resealed(file, (copy) => {
      (copy.rules[0] as PackFileCheckedRule).check.kind = 'value.made-up';
    });
    expect(() => verifiedPackFile(edited)).toThrow('which this Ledger does not have');
  });
});

describe('loading the pack folder', () => {
  it('registers each file with its origin, and loading the same files again is not an error', () => {
    const file = build();
    const folder = folderWith({ 'waiver.pack.json': file, 'copy.pack.json': file, 'notes.txt': 'ignored' });
    const loaded = registerPackFolder(folder);
    expect(loaded.map(({ name }) => name)).toEqual(['copy.pack.json']);
    expect(getRulePackVersion(file.packId, 1)!.digest).toBe(file.digest);
    expect(listRulePackVersions().find((item) => item.packId === file.packId)).toMatchObject({
      digest: file.digest,
      origin: { kind: 'organization_file', file: 'copy.pack.json' },
    });
    expect(listRulePackVersions().find((item) => item.packId === 'ledger.example-waiver')!.origin).toEqual({
      kind: 'built_in',
    });
    expect(registerPackFolder(folder).map(({ version }) => version.digest)).toEqual([file.digest]);
    expect(registerPackFolder(undefined)).toEqual([]);
  });

  it('loads two versions of one pack from two files', () => {
    const first = build();
    const second = buildPackFile(
      describedPack((description) => {
        description.pack.id = first.packId;
        description.pack.version = 2;
        description.provisions[1].parameters.maxFeetAboveGround = 200;
      }),
      exampleSource,
    ).file;
    registerPackFolder(folderWith({ 'a.pack.json': first, 'b.pack.json': second }));
    expect(getRulePackVersion(first.packId, 2)!.digest).toBe(second.digest);
  });

  it('refuses two files that state different content for one pack id and version, naming both', () => {
    const file = build();
    const other = buildPackFile(
      describedPack((description) => {
        description.pack.id = file.packId;
        description.provisions[1].parameters.maxFeetAboveGround = 200;
      }),
      exampleSource,
    ).file;
    expect(() => readPackFolder(folderWith({ 'a.pack.json': file, 'b.pack.json': other }))).toThrow(
      `Pack file b.pack.json was refused. It states pack ${file.packId} version 1, which a.pack.json also states with different content`,
    );
  });

  it('refuses a file that collides with a registered pack version of different content', () => {
    const file = build();
    registerPackFolder(folderWith({ 'a.pack.json': file }));
    const other = buildPackFile(
      describedPack((description) => {
        description.pack.id = file.packId;
        description.pack.title = 'Another title';
      }),
      exampleSource,
    ).file;
    expect(() => registerPackFolder(folderWith({ 'b.pack.json': other }))).toThrow(
      `Pack file b.pack.json was refused. Pack ${file.packId} version 1 is already registered with different content`,
    );
  });

  it('registers nothing when one file in the folder is refused, and names that file and the reason', () => {
    const good = build();
    const folder = folderWith({ 'a-good.pack.json': good, 'b-broken.pack.json': '{"format":' });
    expect(() => registerPackFolder(folder)).toThrow('Pack file b-broken.pack.json was refused. It is not JSON');
    expect(getRulePackVersion(good.packId, 1)).toBeUndefined();
    expect(() => registerPackFolder(join(folder, 'missing'))).toThrow('cannot be read');
  });
});

describe('field paths and limits written with units', () => {
  /** The invented waiver's rule by check kind with the check given, its value fixed rather than set on adoption. */
  const speedRule = (params: Record<string, unknown>, kind = { kind: 'value.within-limit', version: 2 }) =>
    build((description) => {
      description.rules[0].adoptionParameters = [];
      description.rules[0].check = { ...kind, params };
    });
  const rule = (file: PackFile) => file.rules.find((item) => item.id.endsWith('provision-4')) as PackFileCheckedRule;

  it('refuses a field the record type does not have, listing the fields it has', () => {
    expect(() => speedRule({ field: 'values.record.speed', comparison: 'at_most', limit: 10 })).toThrow(
      /check parameter field names values\.record\.speed: flight\.plan records \(version 1\) have no field speed\. Their fields: .*plannedMaxGroundSpeedMetersPerSecond \(number, MetersPerSecond\)/,
    );
    expect(() =>
      build((description) => {
        description.rules[0].reads[0].where.push({ field: 'values.record.flightKind', oneOf: ['survey'] });
      }),
    ).toThrow('read quantity, condition names values.record.flightKind');
  });

  it('refuses a reference compared without its id, and takes it with .id or where a whole reference is meant', () => {
    const site = (field: string) =>
      build((description) => {
        description.rules[0].adoptionParameters = [];
        description.rules[0].reads[0].name = 'subject';
        description.rules[0].check = {
          kind: 'value.one-of',
          version: 1,
          params: { field, expected: ['RIDGE-SITE-1'] },
        };
      });
    expect(() => site('values.record.siteId')).toThrow(
      'siteId of flight.plan records (version 1) is a reference to a site, stored as its id and scope; read values.record.siteId.id.',
    );
    expect(rule(site('values.record.siteId.id')).check.params.field).toBe('values.record.siteId.id');
    expect(() =>
      build((description) => {
        description.rules[0].reads[0].where.push({ field: 'values.record.siteId', oneOf: ['RIDGE-SITE-1'] });
      }),
    ).toThrow('read values.record.siteId.id');
    const filled = build((description) => {
      description.rules[0].reads[0].where.push({ field: 'values.record.siteId', filled: true });
    });
    expect(rule(filled).reads[0]!.where).toContainEqual({ field: 'values.record.siteId', filled: true });
  });

  it('refuses a read of a record type this Ledger does not register', () => {
    expect(() =>
      build((description) => {
        description.rules[0].reads[0].where[0].oneOf = ['flight.made-up'];
      }),
    ).toThrow('this Ledger registers no record type flight.made-up');
  });

  it('keeps a limit written with its unit in the stored unit, with what was written, and states it in that unit', () => {
    const file = speedRule({
      field: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
      comparison: 'at_most',
      limit: '22 kt',
    });
    expect(rule(file).check).toEqual({
      kind: 'value.within-limit',
      version: 2,
      params: {
        field: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
        comparison: 'at_most',
        limit: 11.317778,
        unit: 'm/s',
        textUnit: 'kn',
      },
      written: { limit: '22 kt' },
    });
    const leaf = verifiedPackFile(file).version.leaves.find((item) => item.id.endsWith('provision-4'));
    const plan = {
      id: 'plan-1',
      type: 'operator.record',
      version: 1,
      occurredAt: '2026-11-20T09:00:00.000Z',
      observation: {
        values: { recordType: 'flight.plan', recordVersion: 1, record: { plannedMaxGroundSpeedMetersPerSecond: 12 } },
      },
    };
    const result = runCheckedRule(
      leaf as CheckedRuleLeaf,
      (leaf as CheckedRuleLeaf).check.params,
      { quantity: [plan] },
      {
        mode: 'wall',
        evaluatedAt: '2026-11-20T12:00:00.000Z',
      },
    );
    expect(result.summary).toContain('22 kn (11.32 m/s)');

    const hours = build((description) => {
      description.rules[0].adoptionParameters = [];
      description.rules[0].check = {
        kind: 'value.within-limit',
        version: 2,
        params: { field: 'values.record.plannedMaxHeightAboveGroundMeters', comparison: 'at_most', limit: '400 ft' },
      };
    });
    expect(rule(hours).check.params).toMatchObject({ limit: 121.92, unit: 'm', textUnit: 'ft' });
    const miles = speedRule({
      field: 'values.record.plannedMaxDistanceFromControlStationMeters',
      comparison: 'at_most',
      limit: '5 sm',
    });
    expect(rule(miles).check).toMatchObject({ params: { limit: 8046.72, textUnit: 'mi' }, written: { limit: '5 sm' } });
  });

  it('refuses a unit of another quantity than the field compared, and a unit Ledger does not know', () => {
    expect(() =>
      speedRule({ field: 'values.record.plannedMaxGroundSpeedMetersPerSecond', comparison: 'at_most', limit: '5 sm' }),
    ).toThrow(
      'limit is written "5 sm", which is a distance or height; the value it is compared with is a speed, stored in m/s. Write it in one of m/s, kn, kt, kts, mph.',
    );
    expect(() =>
      speedRule({
        field: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
        comparison: 'at_most',
        limit: '22 furlongs',
      }),
    ).toThrow('furlongs is not a unit Ledger knows');
  });

  it('takes an obligation parameter written with its unit, keeping a bare number as it was and showing what was written', () => {
    const height = (written: unknown) =>
      buildPackFile(
        describedPack((description) => {
          description.provisions[1].parameters.maxFeetAboveGround = written;
        }),
        exampleSource,
      );
    const bare = height(200);
    const inFeet = height('200 ft');
    const inMeters = height('60.96 m');
    const limit = (built: ReturnType<typeof height>) => (built.file.rules[1] as PackFileCheckedRule).check.params;
    expect(limit(inFeet)).toEqual(limit(bare));
    expect(limit(inMeters)).toEqual(limit(bare));
    expect(bare.reports[1]!.written).toBeUndefined();
    expect(inMeters.reports[1]!.written).toEqual({ maxFeetAboveGround: { text: '60.96 m', kept: 200, unit: 'ft' } });
    expect(() => height('22 kt')).toThrow(
      'maxFeetAboveGround is written "22 kt", which is a speed; it is a distance or height. Write it in one of m, ft, mi, sm, nm.',
    );
    expect(() => height('3 furlongs')).toThrow('furlongs is not a unit Ledger knows for it');
  });

  it('refuses a loaded file whose written limit and stored value disagree, or whose field path reaches nothing', () => {
    const file = speedRule({
      field: 'values.record.plannedMaxGroundSpeedMetersPerSecond',
      comparison: 'at_most',
      limit: '22 kt',
    });
    const index = file.rules.findIndex((item) => item.id.endsWith('provision-4'));
    const edited = resealed(file, (copy) => {
      (copy.rules[index] as PackFileCheckedRule).check.written = { limit: '25 kt' };
    });
    expect(() => verifiedPackFile(edited)).toThrow(
      'parameter limit is 11.317778, but the file says it was written "25 kt", which is 12.861111 m/s',
    );
    const moved = resealed(file, (copy) => {
      (copy.rules[index] as PackFileCheckedRule).check.params.field = 'values.record.groundSpeed';
    });
    expect(() => verifiedPackFile(moved)).toThrow('have no field groundSpeed');
  });
});
