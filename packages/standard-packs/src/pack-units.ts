import {
  convertToStoredUnit,
  entryUnitNamed,
  entryUnitNames,
  operatorRecordUnitValues,
  storedUnit,
  type OperatorRecordUnit,
} from '@ledger/contracts';
import { findCheckKind } from '@ledger/domain';
import { PackFileError } from './pack-files.js';

// A limit a pack description writes with its unit, such as "5 sm", is kept in the unit Ledger stores, converted as the
// import converts a number column: the same unit names, the same factors and the same rounding.

const quantityWords: Record<OperatorRecordUnit, string> = {
  Meters: 'a distance or height',
  MetersPerSecond: 'a speed',
  Hours: 'a duration',
  Percent: 'a percentage',
  Count: 'a count',
};

/** "5 sm" as a number and a unit name; undefined for anything else. */
export function writtenQuantity(text: string): { value: number; unit: string } | undefined {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(%|[a-zA-Z][a-zA-Z/]*)\s*$/u.exec(text);
  return match ? { value: Number(match[1]), unit: match[2]! } : undefined;
}

/** The quantity a unit name measures, by the names the import accepts. */
function quantityOf(unit: string): OperatorRecordUnit | undefined {
  return operatorRecordUnitValues.find((quantity) => entryUnitNamed(quantity, unit));
}

/** The quantity a stored unit, a field path or a parameter's own name says a number is: its name ends in the unit. */
function quantityNamed(name: string | undefined): OperatorRecordUnit | undefined {
  if (!name) return undefined;
  const last = name.split('.').at(-1)!;
  return (['MetersPerSecond', 'Meters', 'Hours', 'Percent', 'Count'] as const).find((quantity) =>
    last.endsWith(quantity),
  );
}

function quantityStored(unit: unknown): OperatorRecordUnit | undefined {
  return typeof unit === 'string'
    ? operatorRecordUnitValues.find((quantity) => storedUnit(quantity).unit === unit)
    : undefined;
}

interface SchemaProperty {
  type?: unknown;
  enum?: unknown[];
}

/** What a rule's parameters were written as, beside what they are kept as. */
export interface WrittenParameters {
  params: Record<string, unknown>;
  /** Each parameter written with a unit, as written. */
  written: Record<string, string>;
  /**
   * A sentence for each number written with a unit when nothing says what quantity it is. The builder reports these
   * after the rule's field paths, since a misspelt field is the usual reason.
   */
  unmeasured: string[];
}

/**
 * The check's parameters with each number written with its unit kept in the stored unit. The quantity a number must
 * be comes from the stored unit the rule gives (`unit`), else from the field it compares, else from the parameter's
 * own name; a number whose quantity none of them gives is left as written and named in `unmeasured`. When the kind states quantities in the rule text's unit and the rule gives neither, the stored unit and
 * the unit as written are set so the sentence states the limit in that unit.
 */
export function parametersWithUnits(
  check: { kind: string; version: number; params: Record<string, unknown> },
  where: string,
): WrittenParameters {
  const kind = findCheckKind(check.kind, check.version);
  const properties = ((kind?.parameterSchema as { properties?: Record<string, SchemaProperty> } | undefined)
    ?.properties ?? {}) as Record<string, SchemaProperty>;
  const params = { ...check.params };
  const written: Record<string, string> = {};
  const unmeasured: string[] = [];
  let shownIn: { quantity: OperatorRecordUnit; unit: string } | undefined;
  for (const [name, value] of Object.entries(check.params)) {
    const type = properties[name]?.type;
    if (typeof value !== 'string' || (type !== 'number' && type !== 'integer')) continue;
    const quantity = writtenQuantity(value);
    if (!quantity) continue;
    const measured = quantityOf(quantity.unit);
    const names = (of: OperatorRecordUnit) => entryUnitNames(of).join(', ');
    if (!measured)
      throw new PackFileError(
        `${where}: ${name} is written "${value}"; ${quantity.unit} is not a unit Ledger knows. Write it in one of ${operatorRecordUnitValues.map((of) => names(of)).join('; ')}.`,
      );
    const expected =
      quantityStored(check.params.unit) ??
      quantityNamed(typeof check.params.field === 'string' ? check.params.field : undefined) ??
      quantityNamed(name);
    if (!expected) {
      unmeasured.push(
        `${where}: ${name} is written "${value}", but nothing says what it measures: neither the rule's unit nor the field it compares names one. Write the number alone, in the unit the field is stored in.`,
      );
      continue;
    }
    if (expected !== measured)
      throw new PackFileError(
        `${where}: ${name} is written "${value}", which is ${quantityWords[measured]}; the value it is compared with is ${quantityWords[expected]}, stored in ${storedUnit(expected).unit}. Write it in one of ${names(expected)}.`,
      );
    const converted = convertToStoredUnit(quantity.value, expected, quantity.unit)!;
    if (type === 'integer' && !Number.isInteger(converted))
      throw new PackFileError(
        `${where}: ${name} is written "${value}", which is ${converted} ${storedUnit(expected).unit}; it must be a whole number in that unit.`,
      );
    params[name] = converted;
    written[name] = value.trim();
    shownIn ??= { quantity: expected, unit: entryUnitNamed(expected, quantity.unit)!.unit };
  }
  const textUnits = properties.textUnit?.enum;
  const stored = shownIn && storedUnit(shownIn.quantity).unit;
  if (
    shownIn &&
    properties.unit &&
    (params.unit === undefined || params.unit === stored) &&
    params.textUnit === undefined &&
    Array.isArray(textUnits) &&
    textUnits.includes(shownIn.unit)
  ) {
    params.unit = stored;
    if (shownIn.unit !== stored) params.textUnit = shownIn.unit;
  }
  return { params, written, unmeasured };
}

/**
 * Whether each parameter a pack file says was written with a unit holds that value in the stored unit: the problem
 * when one does not, so a file edited by hand after it was built is refused.
 */
export function writtenParameterProblem(
  params: Record<string, unknown>,
  written: Record<string, string> | undefined,
): string | undefined {
  for (const [name, text] of Object.entries(written ?? {})) {
    const quantity = writtenQuantity(text);
    const measured = quantity && quantityOf(quantity.unit);
    const stored = measured && convertToStoredUnit(quantity.value, measured, quantity.unit);
    if (stored === undefined || stored !== params[name])
      return `parameter ${name} is ${JSON.stringify(params[name])}, but the file says it was written "${text}"${stored === undefined ? ', which is not a number with a unit Ledger knows' : `, which is ${stored} ${storedUnit(measured!).unit}`}. Build the pack again with pnpm pack:build`;
  }
  return undefined;
}

/** What an obligation parameter written with its unit is kept as, beside what was written. */
export interface WrittenObligationParameters<Parameters> {
  parameters: Parameters;
  /** Each parameter written with a unit: as written, and the number kept in the parameter's own unit. */
  written: Record<string, { text: string; kept: number; unit: string }>;
}

/**
 * An obligation's parameters with each quantity written with its unit, such as "400 ft" or "22 kt", kept as a number
 * in the parameter's own unit, converted by the import's factors. A number written alone keeps its meaning.
 */
export function obligationParametersWithUnits<Parameters extends Readonly<Record<string, unknown>>>(
  specs: readonly { name: string; unit?: { quantity: OperatorRecordUnit; in: string } }[],
  parameters: Parameters,
  where: string,
): WrittenObligationParameters<Parameters> {
  const kept: Record<string, unknown> = { ...parameters };
  const written: WrittenObligationParameters<Parameters>['written'] = {};
  for (const spec of specs) {
    const value = parameters[spec.name];
    if (!spec.unit || typeof value !== 'string') continue;
    const quantity = writtenQuantity(value);
    if (!quantity) continue;
    const names = entryUnitNames(spec.unit.quantity).join(', ');
    const entered = entryUnitNamed(spec.unit.quantity, quantity.unit);
    if (!entered) {
      const measured = quantityOf(quantity.unit);
      throw new PackFileError(
        measured
          ? `${where}: ${spec.name} is written "${value}", which is ${quantityWords[measured]}; it is ${quantityWords[spec.unit.quantity]}. Write it in one of ${names}.`
          : `${where}: ${spec.name} is written "${value}"; ${quantity.unit} is not a unit Ledger knows for it. Write it in one of ${names}.`,
      );
    }
    const target = entryUnitNamed(spec.unit.quantity, spec.unit.in)!;
    const number = Math.round(((quantity.value * entered.factor) / target.factor) * 1_000_000) / 1_000_000;
    kept[spec.name] = number;
    written[spec.name] = { text: value.trim(), kept: number, unit: target.unit };
  }
  return { parameters: kept as Parameters, written };
}
