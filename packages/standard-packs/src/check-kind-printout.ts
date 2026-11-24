import { ObservationFieldPathPattern } from '@ledger/contracts';
import { listCheckKinds, type CheckKindDefinition } from '@ledger/domain';
import { PackFileError } from './pack-files.js';

// What `pnpm pack:kinds` prints for a check kind, read from its registered definition: what it asks, the inputs a rule
// names its reads after, and every parameter with whether it is required and its unit. Nothing here names a kind.

interface Schema {
  type?: unknown;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  dependencies?: Record<string, unknown>;
}

const quantities: [suffix: string, words: string][] = [
  ['MetersPerSecond', 'a speed in metres per second, or written with its unit, such as 22 kt'],
  ['Meters', 'a distance or height in metres, or written with its unit, such as 400 ft or 3 sm'],
  ['Hours', 'a duration in hours, or written with its unit, such as 12 h'],
  ['Percent', 'a percentage, or written with its unit, such as 25 %'],
  ['Count', 'a count'],
];

/** The words for a value of the schema, with the unit its name gives a number. */
function valueWords(name: string, schema: Schema): string {
  if (schema.enum) return `one of ${schema.enum.map(String).join(', ')}`;
  if (schema.const !== undefined) return `exactly ${String(schema.const)}`;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.properties && (schema.properties.where || schema.properties.recordType))
    return 'a selection of the records that count: recordType with recordVersion (an operator record type), or where: a list of conditions, each a field and oneOf (the values it holds) or filled: true';
  if (types.length > 1 && types.every((type) => ['string', 'number', 'integer', 'boolean'].includes(type as string)))
    return 'a value: text, a number or true or false';
  if (types.includes('number') || types.includes('integer')) {
    const unit = quantities.find(
      ([suffix]) => name.endsWith(suffix) || name.endsWith(suffix.replace('Meters', 'Metres')),
    );
    const whole = types.includes('integer') && !types.includes('number') ? 'a whole number' : 'a number';
    if (unit) return unit[1];
    if (name === 'hours' || /Hours$/u.test(name)) return 'a duration in hours, or written with its unit, such as 12 h';
    if (/^(limit|min|max|threshold)/iu.test(name))
      return `${whole} in the unit the compared field is stored in, or written with its unit (3 sm, 22 kt, 25 %), which is converted to it`;
    return whole;
  }
  if (types.includes('boolean') && types.length === 1) return 'true or false';
  if (types.includes('string') && types.length === 1)
    return schema.pattern === ObservationFieldPathPattern
      ? 'a field path, as pnpm ledger records columns <type> prints it (values.record.<field>, values.<field>, interval.start)'
      : 'text';
  if (types.includes('array') && types.length === 1)
    return schema.items ? `a list, each ${valueWords(name, schema.items)}` : 'a list';
  if (types.includes('object') || schema.properties)
    return `a group of named values${schema.properties ? `: ${Object.keys(schema.properties).join(', ')}` : ''}`;
  if (schema.anyOf || schema.oneOf)
    return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].map((branch) => valueWords(name, branch)).join('; or ');
  return types.filter(Boolean).join(' or ') || 'a value';
}

/** Every parameter named anywhere in the schema, in the order the schema lists them. */
function parametersOf(schema: Schema): Map<string, Schema> {
  const found = new Map<string, Schema>();
  const add = (node: Schema) => {
    for (const [name, property] of Object.entries(node.properties ?? {}))
      if (!found.has(name)) found.set(name, property);
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) add(branch);
  };
  add(schema);
  return found;
}

/** The sentences the schema's alternatives and dependencies make about which parameters go together. */
function togetherLines(schema: Schema): string[] {
  const lines: string[] = [];
  const alternatives = (branches: Schema[] | undefined, words: string) => {
    if (!branches?.length) return;
    const sets = branches.map((branch) => branch.required ?? []);
    if (sets.every((set) => set.length > 0))
      lines.push(`${words} ${sets.map((set) => set.join(' with ')).join(', ')}.`);
  };
  alternatives(schema.anyOf, 'Give at least one of');
  alternatives(schema.oneOf, 'Give exactly one of');
  const said = new Set<string>();
  for (const [name, needs] of Object.entries(schema.dependencies ?? {})) {
    if (!Array.isArray(needs) || !needs.length) continue;
    const together = [name, ...needs].sort().join('\u0000');
    if (said.has(together)) continue;
    said.add(together);
    lines.push(`${name} is given together with ${needs.join(' and ')}.`);
  }
  return lines;
}

/** What one check kind asks and takes, as `pnpm pack:kinds` prints it. */
export function checkKindLines(kind: CheckKindDefinition): string[] {
  const schema = kind.parameterSchema as Schema;
  const required = new Set(schema.required ?? []);
  const parameters = [...parametersOf(schema)];
  return [
    `${kind.id} version ${kind.version}: ${kind.title}`,
    `  What it asks: ${kind.description}`,
    '  Inputs (name each read of the rule after the input it fills):',
    ...kind.inputs.map(
      (input) => `    ${input.name} (${input.optional ? 'optional' : 'required'}): ${input.description}`,
    ),
    `  Parameters${parameters.length ? '' : ': none'}${parameters.length ? ' (under check params; a rule may leave one to adoptionParameters, set when the pack is adopted):' : ''}`,
    ...parameters.map(
      ([name, property]) =>
        `    ${name} (${required.has(name) ? 'required' : 'optional'}): ${valueWords(name, property)}${property.description ? `. ${property.description}` : ''}`,
    ),
    ...togetherLines(schema).map((line) => `  ${line}`),
    ...(kind.adoptionDates ? [`  Reads the adoption's dates: ${kind.adoptionDates}`] : []),
  ];
}

const byIdAndVersion = (a: CheckKindDefinition, b: CheckKindDefinition) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version;

/**
 * The lines for every registered check kind, or for those named: an id (every version of it) or id@version. Throws
 * with the kinds there are when a name matches none.
 */
export function checkKindsPrintout(name?: string): string[] {
  const kinds = listCheckKinds().sort(byIdAndVersion);
  if (!name)
    return [
      `Check kinds this Ledger has (${kinds.length}). pnpm pack:kinds <kind> prints one of them.`,
      '',
      ...kinds.flatMap((kind) => [...checkKindLines(kind), '']),
    ];
  const [id, version] = name.split('@');
  const matching = kinds.filter(
    (kind) => kind.id === id && (version === undefined || String(kind.version) === version),
  );
  if (!matching.length)
    throw new PackFileError(
      `This Ledger has no check kind ${name}. Its check kinds: ${[...new Set(kinds.map((kind) => kind.id))].join(', ')}.`,
    );
  return matching.flatMap((kind, index) => [...(index ? [''] : []), ...checkKindLines(kind)]);
}
