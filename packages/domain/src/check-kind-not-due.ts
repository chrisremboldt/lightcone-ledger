import { fieldPath } from './check-kind-library-records.js';
import { observationField, valueIsOneOf, type CheckObservation } from './check-kinds.js';

// A record the operator marked as needing no answer, such as an occurrence it recorded as not reportable. A check that
// counts records needing an answer leaves such a record out, and says so and who decided.

export interface NotDueCondition {
  field: string;
  oneOf: (string | number | boolean)[];
  /** The field naming who decided, when the record keeps it. */
  byField?: string;
}

export interface NotDue {
  anyOf: NotDueCondition[];
  /** What the record is recorded as, such as "not reportable". */
  words: string;
}

export const notDueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['anyOf', 'words'],
  properties: {
    anyOf: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'oneOf'],
        properties: {
          field: fieldPath,
          oneOf: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: ['string', 'number', 'boolean'] },
          },
          byField: fieldPath,
        },
      },
    },
    words: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

/** Who a reference or name field names, as the operator wrote it. */
function named(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    return (value as { id: string }).id;
  return undefined;
}

/**
 * The sentence for a record that needs no answer, or undefined when it needs one. `what` names the record, such as
 * "The event at 2026-10-06T14:31:00.000Z".
 */
export function notDueSentence(
  observation: CheckObservation,
  notDue: NotDue | undefined,
  what: string,
): string | undefined {
  const condition = notDue?.anyOf.find((item) => valueIsOneOf(observationField(observation, item.field), item.oneOf));
  if (!notDue || !condition) return undefined;
  const by = condition.byField === undefined ? undefined : named(observationField(observation, condition.byField));
  const who = by ? ` by ${by}` : '; the record does not say who decided';
  return `${what} is recorded as ${notDue.words}${who}, so it is not counted.`;
}
