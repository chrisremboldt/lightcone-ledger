import type { IndicatorRational } from '@ledger/contracts';

/** An exact non-negative fraction. Exposure and rates never pass through floating point. */
export interface Rational {
  numerator: bigint;
  denominator: bigint;
}

function gcd(left: bigint, right: bigint): bigint {
  while (right) [left, right] = [right, left % right];
  return left;
}

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n || numerator < 0n)
    throw new RangeError('A rational needs a non-negative numerator and positive denominator');
  const divisor = gcd(numerator, denominator) || 1n;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export const ZERO: Rational = { numerator: 0n, denominator: 1n };

export function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

/** left minus right, or undefined when the difference would be negative. */
export function subtract(left: Rational, right: Rational): Rational | undefined {
  const numerator = left.numerator * right.denominator - right.numerator * left.denominator;
  return numerator < 0n ? undefined : rational(numerator, left.denominator * right.denominator);
}

export function multiply(left: Rational, right: Rational): Rational {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function divide(left: Rational, right: Rational): Rational {
  if (right.numerator === 0n) throw new RangeError('Division by zero');
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

export function compare(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** A base-ten decimal string such as 12 or 2.5, exactly. */
export function parseDecimal(text: string): Rational | undefined {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  return rational(BigInt(match[1]! + fraction), 10n ** BigInt(fraction.length));
}

/**
 * The exact decimal a JSON number was written as, such as 1234.5 for the double nearest 1234.5. JavaScript prints
 * the shortest text that reads back as the same double, which is the decimal the source sent.
 */
export function decimalOfNumber(value: number): Rational | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (!match) return undefined;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt(match[1]! + fraction);
  return exponent >= 0 ? rational(digits * 10n ** BigInt(exponent)) : rational(digits, 10n ** BigInt(-exponent));
}

/** Rounded half up to the given number of fraction digits. */
export function formatDecimal(value: Rational, fractionDigits: number): string {
  const scale = 10n ** BigInt(fractionDigits);
  const scaled = (value.numerator * scale * 2n + value.denominator) / (value.denominator * 2n);
  const whole = (scaled / scale).toString();
  if (fractionDigits === 0) return whole;
  return `${whole}.${(scaled % scale).toString().padStart(fractionDigits, '0')}`;
}

export function rationalView(value: Rational): IndicatorRational {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}
