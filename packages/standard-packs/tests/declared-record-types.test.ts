import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findOperatorRecordDefinition, recordImportColumns, type PackFile } from '../../contracts/src/index.js';
import { validateObservation } from '../../domain/src/observation-registry.js';
import { observationRegistry } from '../../domain/src/observation-registry.js';
import { recordTypesOfPacks } from '../../domain/src/organization-record-types.js';
import { buildPackFile, readPackFolder, registerPackFolder, verifiedPackFile } from '../src/index.js';

const example = new URL('../../../examples/declared-record-type/', import.meta.url);
const exampleSource = readFileSync(new URL('source.txt', example), 'utf8');
const TYPE = 'example-ridge-procedures.airframe-check';

let packs = 0;
/** The worked example under a pack id of its own, so each test registers its own pack and types. */
function described(change: (description: any, id: string) => void = () => {}) {
  const description = parse(readFileSync(new URL('pack.yaml', example), 'utf8'));
  const id = `declaring-${process.pid}-${++packs}`;
  description.pack.id = id;
  const text = JSON.stringify(description).replaceAll('example-ridge-procedures', id);
  const renamed = JSON.parse(text);
  change(renamed, id);
  return { description: renamed, id };
}

const build = (change?: (description: any, id: string) => void) => {
  const { description, id } = described(change);
  return { file: buildPackFile(description, exampleSource).file, id };
};

const refusal = (change: (description: any, id: string) => void) => {
  try {
    build(change);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('The description was not refused');
};

const declaredType = (description: any) => description.recordTypes[0];

function folderWith(files: Record<string, PackFile>): string {
  const folder = mkdtempSync(join(tmpdir(), 'ledger-declared-types-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(folder, name), JSON.stringify(content));
  return folder;
}

describe('record types a pack declares', () => {
  it('builds the worked example: the declaration with its digest, in the pack version and its digest', () => {
    const { file, id } = build();
    expect(file.recordTypes?.map((declared) => declared.id)).toEqual([`${id}.airframe-check`]);
    const { version } = verifiedPackFile(file);
    expect(version.recordTypes?.[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(version.recordTypes?.[0]?.fields.map((field) => field.name)).toEqual([
      'checkedAt',
      'inspectorId',
      'result',
      'airframeHours',
    ]);
    // The declaration is bound by the pack's digest: any change to it makes another pack version.
    const changed = structuredClone(file);
    changed.recordTypes![0]!.fields[0]!.label = 'Checked on';
    expect(() => verifiedPackFile(changed)).toThrow(/digest/);
  });

  it('makes the same definition a built-in type is: import columns, units and the place in time', () => {
    const { file, id } = build();
    const types = recordTypesOfPacks([verifiedPackFile(file).version]);
    const definition = types.find(`${id}.airframe-check`, 1)!;
    expect(definition.declaredBy).toEqual({
      packId: id,
      digest: verifiedPackFile(file).version.recordTypes![0]!.digest,
    });
    expect(recordImportColumns(definition).map((column) => column.key)).toEqual([
      'subjectId',
      'checkedAt',
      'inspectorId',
      'result',
      'airframeHours',
      'replaces',
    ]);
    expect(recordImportColumns(definition).find((column) => column.key === 'checkedAt')).toMatchObject({
      placesRecord: true,
      takesDate: true,
    });
    expect(recordImportColumns(definition).find((column) => column.key === 'airframeHours')?.units?.stored).toBe('h');
    // The built-in types are there too, behind the same interface.
    expect(types.find('aircraft.identity', 1)?.title).toBeTruthy();
  });

  it('builds a pack that declares record types and has no rules yet', () => {
    const { file } = build((description) => delete description.rules);
    expect(file.rules).toEqual([]);
    expect(verifiedPackFile(file).version.leaves).toEqual([]);
    expect(refusal((description) => delete description.rules && delete description.recordTypes)).toMatch(
      /makes no rules and declares no record types/,
    );
  });

  it('refuses a declaring pack whose id is not one word, or is a domain of the types built into Ledger', () => {
    expect(
      refusal((description, id) => {
        description.pack.id = `${id}.manual`;
        declaredType(description).id = `${id}.manual.airframe-check`;
      }),
    ).toMatch(/must match pattern|one word/);
    expect(
      refusal((description) => {
        description.pack.id = 'aircraft';
        declaredType(description).id = 'aircraft.airframe-check';
        description.rules[0].reads[0].where[0].oneOf = ['aircraft.airframe-check'];
      }),
    ).toMatch(/aircraft is a domain of record types built into Ledger/);
    expect(refusal((description) => (declaredType(description).id = 'other-pack.airframe-check'))).toMatch(
      /does not start with its pack id/,
    );
  });

  it('refuses a declaration a pack author can fix, saying what to change', () => {
    expect(refusal((description) => (declaredType(description).fields[3].name = 'airframe'))).toMatch(
      /a number’s name ends in its unit, such as airframeHours/,
    );
    expect(refusal((description) => (declaredType(description).fields[0].name = 'checked'))).toMatch(
      /ends in At|placed in time by checkedAt/,
    );
    expect(refusal((description) => (declaredType(description).fields[1].name = 'inspector'))).toMatch(
      /a reference field’s name ends in Id/,
    );
    expect(
      refusal((description) => {
        for (const field of declaredType(description).fields) field.required = false;
      }),
    ).toMatch(/must be required/);
    expect(refusal((description) => (declaredType(description).fields[2].kind = 'choice'))).toMatch(
      /recordTypes item 1/,
    );
    expect(refusal((description) => (declaredType(description).subjectKinds = ['vessel']))).toMatch(
      /recordTypes item 1/,
    );
  });

  it('refuses a rule that reads a field the declared type does not have, listing the fields it has', () => {
    expect(refusal((description) => (description.rules[0].check.params.field = 'values.record.outcome'))).toMatch(
      /have no field outcome\. Their fields: checkedAt \(date time\); inspectorId/,
    );
  });

  it('refuses a rule that reads a type another pack declares', () => {
    const other = build();
    registerPackFolder(folderWith({ 'other.pack.json': other.file }));
    expect(findOperatorRecordDefinition(observationRegistry(), `${other.id}.airframe-check`, 1)).toBeDefined();
    expect(
      refusal((description) => (description.rules[0].reads[0].where[0].oneOf = [`${other.id}.airframe-check`])),
    ).toMatch(/A rule reads the record types built into Ledger and those its own pack declares/);
  });

  it('registers a loaded declaration so records on file are read, and keeps it out of other organizations', () => {
    const mine = build();
    registerPackFolder(folderWith({ 'mine.pack.json': mine.file }));
    const version = verifiedPackFile(mine.file).version;
    const registered = findOperatorRecordDefinition(observationRegistry(), `${mine.id}.airframe-check`, 1);
    expect(registered?.declaredBy?.digest).toBe(version.recordTypes![0]!.digest);
    // An organization that has not adopted the pack does not have the type; one that has, does.
    expect(recordTypesOfPacks([]).find(`${mine.id}.airframe-check`, 1)).toBeUndefined();
    expect(recordTypesOfPacks([]).definitions.some((definition) => definition.declaredBy)).toBe(false);
    expect(recordTypesOfPacks([version]).find(`${mine.id}.airframe-check`, 1)?.title).toBe('Airframe check');
  });

  it('validates a record of a declared type only with the digest of the declaration it was written under', () => {
    const { file, id } = build();
    const version = verifiedPackFile(file).version;
    const { registry } = recordTypesOfPacks([version]);
    const digest = version.recordTypes![0]!.digest;
    const observation = (values: Record<string, unknown>) => ({
      type: 'operator.record',
      version: 1,
      subject: { kind: 'aircraft', id: 'RIDGE-AC-1', scope: 'source' },
      occurredAt: '2026-11-02T15:00:00Z',
      fidelity: 'documented_schema_conformant',
      limitations: [],
      originalArtifactId: 'artifact-1',
      values: {
        recordType: `${id}.airframe-check`,
        recordVersion: 1,
        record: {
          checkedAt: '2026-11-02T15:00:00Z',
          inspectorId: { id: 'RIDGE-P-01', scope: 'source' },
          result: 'serviceable',
          airframeHours: 112.5,
        },
        ...values,
      },
    });
    expect(() => validateObservation(registry, observation({ declarationDigest: digest }))).not.toThrow();
    expect(() => validateObservation(registry, observation({}))).toThrow(/name the declaration/);
    expect(() => validateObservation(registry, observation({ declarationDigest: 'a'.repeat(64) }))).toThrow(/pins is/);
    expect(() =>
      validateObservation(recordTypesOfPacks([]).registry, observation({ declarationDigest: digest })),
    ).toThrow(/is not registered/);
  });
});

describe('a later version of a declared type', () => {
  /** Version 1 and a version 2 of one pack, the second changed by `change`. */
  function twoVersions(change: (description: any) => void) {
    const first = described();
    const second = structuredClone(first.description);
    second.pack.version = 2;
    change(second);
    return {
      first: buildPackFile(first.description, exampleSource).file,
      second: buildPackFile(second, exampleSource).file,
    };
  }

  const loading = (files: { first: PackFile; second: PackFile }) => () =>
    readPackFolder(folderWith({ 'a-v1.pack.json': files.first, 'a-v2.pack.json': files.second }));

  it('may add a field and an option under a new version of the type', () => {
    const files = twoVersions((description) => {
      const declared = declaredType(description);
      declared.version = 2;
      declared.fields.push({ name: 'remarks', label: 'Remarks', kind: 'long_text' });
      declared.fields[2].options.push({ value: 'not-checked', label: 'Not checked' });
    });
    expect(loading(files)().map((loaded) => loaded.version.version)).toEqual([1, 2]);
  });

  it('refuses a version that leaves out a field or changes its unit, naming the file and saying why', () => {
    const dropped = twoVersions((description) => {
      declaredType(description).version = 2;
      declaredType(description).fields.splice(3, 1);
    });
    expect(loading(dropped)).toThrow(/a-v2\.pack\.json was refused\. .*leaves out airframeHours, which version 1 has/);
    const unit = twoVersions((description) => {
      declaredType(description).version = 2;
      Object.assign(declaredType(description).fields[3], { name: 'airframeCount', unit: 'Count' });
    });
    expect(loading(unit)).toThrow(/leaves out airframeHours/);
    const kind = twoVersions((description) => {
      declaredType(description).version = 2;
      Object.assign(declaredType(description).fields[2], { kind: 'text', options: undefined });
      delete declaredType(description).fields[2].options;
    });
    expect(loading(kind)).toThrow(/makes result text; in version 1 it is select/);
  });

  it('refuses the same type and version declared with other content', () => {
    const relabelled = twoVersions((description) => (declaredType(description).fields[0].label = 'Checked on'));
    expect(loading(relabelled)).toThrow(/is declared differently by pack versions 1 and 2/);
  });
});

it('declares in the guide what the worked example declares', () => {
  const description = parse(readFileSync(new URL('pack.yaml', example), 'utf8'));
  expect(description.recordTypes[0].id).toBe(TYPE);
  const guide = readFileSync(new URL('../../../docs/guides/write-a-rule-pack.md', import.meta.url), 'utf8');
  const block = [...guide.matchAll(/```yaml\n([\s\S]*?)```/gu)].find((match) => match[1]!.includes('recordTypes:'))!;
  const shown = parse(block[1]!);
  const withoutHelp = (declared: any) => ({
    ...declared,
    fields: declared.fields.map(({ help: _help, ...field }: any) => field),
  });
  expect(shown.pack.id).toBe(description.pack.id);
  expect(withoutHelp(shown.recordTypes[0])).toEqual(withoutHelp(description.recordTypes[0]));
});
