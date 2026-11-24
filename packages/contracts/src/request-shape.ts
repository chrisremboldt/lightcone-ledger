/**
 * Sentences for a request refused for its shape. A JSON Schema validator reports each failure as a keyword and a
 * location; these read it back as the property and what was expected, never the validator's own phrase. The errors
 * must come from a validator run with `verbose` on, so each carries the schema and value it is about.
 */

/** The parts of a validator error the sentences read (Ajv's ErrorObject with `verbose`). */
export interface SchemaError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly params: Record<string, unknown>;
  readonly schema?: unknown;
  readonly parentSchema?: unknown;
  readonly data?: unknown;
}

type Schema = {
  readonly description?: string;
  readonly const?: unknown;
  readonly properties?: Record<string, Schema>;
  readonly anyOf?: readonly Schema[];
  readonly oneOf?: readonly Schema[];
  readonly required?: readonly string[];
  readonly format?: string;
};

const asSchema = (value: unknown): Schema => (value && typeof value === 'object' ? (value as Schema) : {});

/** Where a value is, as a person names it: `payload.subject.id`, `items[2]`, or the part of the request itself. */
export function requestPlace(part: string, instancePath: string): string {
  const steps = instancePath
    .split('/')
    .slice(1)
    .map((step) => step.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!steps.length) return part === 'body' ? 'The request body' : part === 'querystring' ? 'The query' : `The ${part}`;
  const named = steps.reduce(
    (path, step) => (/^\d+$/.test(step) ? `${path}[${step}]` : path ? `${path}.${step}` : step),
    '',
  );
  return part === 'querystring' ? `Query parameter ${named}` : part === 'params' ? `Path parameter ${named}` : named;
}

const typeWords: Record<string, string> = {
  string: 'text',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
  null: 'null',
};

const formatWords: Record<string, string> = {
  'date-time': 'a date and time with its offset, such as 2026-11-10T15:00:00Z',
  date: 'a date, such as 2026-11-10',
  time: 'a time of day with its offset, such as 15:00:00Z',
  uuid: 'a UUID',
  uri: 'an absolute URI',
  email: 'an email address',
};

function shown(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…"` : text;
}

const listed = (values: readonly unknown[]) => values.map((value) => JSON.stringify(value)).join(', ');

function kindOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number') return Number.isInteger(value) ? 'a whole number' : 'a number';
  return typeWords[typeof value] ?? typeof value;
}

/** The property names an object's schema forbids that the value carries. */
function forbiddenPresent(schema: Schema, data: unknown): string[] {
  const named = [...(schema.required ?? []), ...(schema.anyOf ?? []).flatMap((branch) => branch.required ?? [])];
  return data && typeof data === 'object' ? named.filter((name) => name in (data as object)) : named;
}

/** One failed keyword as a sentence. */
function leafSentence(error: SchemaError, part: string): string {
  const place = requestPlace(part, error.instancePath);
  const { params } = error;
  const parent = asSchema(error.parentSchema);
  const value = shown(error.data);
  switch (error.keyword) {
    case 'required':
      return `${place} has no ${String(params.missingProperty)}, which is required.`;
    case 'additionalProperties': {
      const taken = Object.keys(parent.properties ?? {});
      return `${place} has ${String(params.additionalProperty)}, which it does not take.${taken.length ? ` It takes ${taken.join(', ')}.` : ''}`;
    }
    case 'type': {
      const types = String(params.type).split(',');
      return `${place} must be ${types.map((type) => typeWords[type] ?? type).join(' or ')}; it is ${kindOfValue(error.data)}.`;
    }
    case 'const':
      return `${place} must be ${JSON.stringify(params.allowedValue)}; it is ${value}.`;
    case 'enum':
      return `${place} must be one of ${listed((params.allowedValues as unknown[]) ?? [])}; it is ${value}.`;
    case 'minLength':
      return Number(params.limit) === 1
        ? `${place} must not be empty.`
        : `${place} must be at least ${String(params.limit)} characters long.`;
    case 'maxLength':
      return `${place} must be at most ${String(params.limit)} characters long.`;
    case 'minimum':
      return `${place} must be at least ${String(params.limit)}; it is ${value}.`;
    case 'maximum':
      return `${place} must be at most ${String(params.limit)}; it is ${value}.`;
    case 'exclusiveMinimum':
      return `${place} must be more than ${String(params.limit)}; it is ${value}.`;
    case 'exclusiveMaximum':
      return `${place} must be less than ${String(params.limit)}; it is ${value}.`;
    case 'multipleOf':
      return `${place} must be a multiple of ${String(params.multipleOf)}; it is ${value}.`;
    case 'pattern':
      return `${place} is ${value}, which is not written in the form it takes (${String(params.pattern)}).${parent.description ? ` ${parent.description}` : ''}`;
    case 'format':
      return `${place} must be ${formatWords[String(params.format)] ?? `in the ${String(params.format)} format`}; it is ${value}.`;
    case 'minItems':
      return `${place} must list at least ${String(params.limit)} ${Number(params.limit) === 1 ? 'item' : 'items'}.`;
    case 'maxItems':
      return `${place} may list at most ${String(params.limit)} items.`;
    case 'uniqueItems':
      return `${place} lists the same item twice, at ${Math.min(Number(params.i), Number(params.j))} and ${Math.max(Number(params.i), Number(params.j))}.`;
    case 'minProperties':
      return `${place} must have at least ${String(params.limit)} ${Number(params.limit) === 1 ? 'property' : 'properties'}.`;
    case 'maxProperties':
      return `${place} may have at most ${String(params.limit)} properties.`;
    case 'dependentRequired':
    case 'dependencies':
      return `${place} has ${String(params.property)} but no ${String(params.missingProperty)}; the two are given together.`;
    case 'not': {
      const forbidden = forbiddenPresent(asSchema(error.schema), error.data);
      const why = asSchema(error.schema).description;
      return forbidden.length
        ? `${place} has ${forbidden.join(', ')}, which ${forbidden.length === 1 ? 'is' : 'are'} not taken here.${why ? ` ${why}` : ''}`
        : `${place} is given in a form that is not taken here.${why ? ` ${why}` : ''}`;
    }
    case 'false schema':
      return `${place} is not taken here.`;
    default:
      return `${place} is not in the form this request takes.`;
  }
}

/** The values a discriminating property takes in a schema, looking through unions. */
function discriminatorValues(schema: Schema, key: string): unknown[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const values = branches.map((branch) => discriminatorValues(branch, key));
    return values.every((each) => each !== undefined) ? values.flat() : undefined;
  }
  const property = schema.properties?.[key];
  if (!property) return undefined;
  if (property.const !== undefined) return [property.const];
  const consts = (property.anyOf ?? []).map((branch) => branch.const);
  return consts.length && consts.every((each) => each !== undefined) ? consts : undefined;
}

/** The property every branch of a union of objects fixes to its own values, such as `kind`. */
function discriminator(branches: readonly Schema[], data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const candidates = new Set(branches.flatMap((branch) => Object.keys(branch.properties ?? {})));
  for (const key of ['kind', 'type', ...candidates])
    if (branches.every((branch) => discriminatorValues(branch, key) !== undefined)) return key;
  return undefined;
}

/** Sentences that are each one way to fix the request, as one sentence. */
function alternatives(sentences: readonly string[]): string {
  return (
    [...new Set(sentences)]
      .map((each, index) => (index ? each.replace(/^The /, 'the ') : each).replace(/\.$/, ''))
      .join('; or ') + '.'
  );
}

/** A union none of whose forms the value fits: which form it meant and what that form lacks, or the forms there are. */
function unionSentence(union: SchemaError, inner: readonly SchemaError[], part: string): string {
  const place = requestPlace(part, union.instancePath);
  const branches = asSchema(union.schema) as unknown as readonly Schema[];
  if (union.keyword === 'oneOf' && union.params.passingSchemas)
    return `${place} fits more than one of the forms it may take; give only the properties of one.`;
  if (Array.isArray(branches) && branches.every((branch) => branch.const !== undefined))
    return `${place} must be one of ${listed(branches.map((branch) => branch.const))}; it is ${shown(union.data)}.`;
  const key = Array.isArray(branches) ? discriminator(branches, union.data) : undefined;
  if (key) {
    const given = (union.data as Record<string, unknown>)[key];
    const meant = branches
      .map((branch, index) => (discriminatorValues(branch, key)!.includes(given) ? index : -1))
      .filter((index) => index >= 0)
      .map((index) => inner.filter((error) => error.schemaPath.startsWith(`${union.schemaPath}/${index}/`)))
      .filter((own) => own.length)
      .map((own) => sentence(own, part));
    if (meant.length) return alternatives(meant);
    const values = [...new Set(branches.flatMap((branch) => discriminatorValues(branch, key)!))];
    const field = requestPlace(part, `${union.instancePath}/${key}`);
    return given === undefined
      ? `${place} has no ${key}, which is required. It is one of ${listed(values)}.`
      : `${field} ${shown(given)} is not one Ledger takes here. It is one of ${listed(values)}.`;
  }
  const leaves = inner.filter(isLeaf);
  if (leaves.length && leaves.every((error) => error.keyword === 'type' && error.instancePath === union.instancePath)) {
    const types = [...new Set(leaves.flatMap((error) => String(error.params.type).split(',')))];
    return `${place} must be ${types.map((type) => typeWords[type] ?? type).join(' or ')}; it is ${kindOfValue(union.data)}.`;
  }
  const firsts = [...new Set(leaves.map((error) => leafSentence(error, part)))];
  return firsts.length
    ? `${place} fits none of the forms it may take: ${alternatives(firsts).replace(/^The /, 'the ')}`
    : `${place} fits none of the forms it may take.`;
}

const wrappers = new Set(['if', 'allOf', '$ref']);
const unions = new Set(['anyOf', 'oneOf']);
const isLeaf = (error: SchemaError) => !wrappers.has(error.keyword) && !unions.has(error.keyword);

function sentence(errors: readonly SchemaError[], part: string): string {
  const meaningful = errors.filter((error) => !wrappers.has(error.keyword));
  // The validator stops at the first failure; a union's error follows those of its branches.
  const top = meaningful.at(-1);
  if (!top) return `${requestPlace(part, '')} is not in the form this request takes.`;
  if (!unions.has(top.keyword)) return leafSentence(top, part);
  const prefix = `${top.schemaPath}/`;
  return unionSentence(
    top,
    meaningful.filter((error) => error.schemaPath.startsWith(prefix)),
    part,
  );
}

/** The sentence for a request part refused by its schema: the property and what was expected. */
export function requestShapeRefusal(errors: readonly SchemaError[], part: string): string {
  return sentence(errors, part);
}
