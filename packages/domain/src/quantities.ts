/**
 * A quantity as a sentence states it: in the unit the rule's text uses, when the rule declares one, with the stored
 * value beside it in parentheses. Rules store meters and meters per second; their texts often say feet, miles or knots.
 */

const textUnits = {
  m: { stored: 'm', factor: 1 },
  km: { stored: 'm', factor: 1000 },
  ft: { stored: 'm', factor: 0.3048 },
  mi: { stored: 'm', factor: 1609.344 },
  nm: { stored: 'm', factor: 1852 },
  'm/s': { stored: 'm/s', factor: 1 },
  'km/h': { stored: 'm/s', factor: 1 / 3.6 },
  kn: { stored: 'm/s', factor: 1852 / 3600 },
  mph: { stored: 'm/s', factor: 0.44704 },
} as const;

export type TextUnit = keyof typeof textUnits;

/** The parameter a kind takes for the unit its rule's text uses. */
export const textUnitSchema = {
  enum: Object.keys(textUnits),
  description:
    'The unit the rule’s text states this quantity in: the summary states the value in it, with the stored value in parentheses.',
} as const;

const twoDecimals = (value: number) => String(Math.round(value * 100) / 100);

/**
 * "400 ft (121.92 m)" for 121.92 stored in m with the rule's text in ft; "121.92 m" with no text unit, or one that
 * does not convert from the stored unit.
 */
export function quantityText(value: number, storedUnit: string | undefined, textUnit?: string): string {
  const stored = storedUnit ? `${twoDecimals(value)} ${storedUnit}` : twoDecimals(value);
  const unit = textUnit && Object.hasOwn(textUnits, textUnit) ? textUnits[textUnit as TextUnit] : undefined;
  if (!unit || !storedUnit || unit.stored !== storedUnit || textUnit === storedUnit) return stored;
  return `${twoDecimals(value / unit.factor)} ${textUnit} (${stored})`;
}
