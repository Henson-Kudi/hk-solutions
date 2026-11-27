import { Decimal as DecimalJs } from 'decimal.js';
import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/**
 * A private copy of decimal.js, so this configuration cannot be changed by, or
 * leak into, any other code that loads decimal.js.
 *
 * precision 60: amounts are stored as numeric(20,4), so the product of two
 * amounts has at most 40 significant digits and is always exact. Only a
 * division can be rounded to 60 digits.
 *
 * toExpNeg / toExpPos: never print exponent notation.
 */
const Engine = DecimalJs.clone({
  precision: 60,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/**
 * HALF_EVEN  banker's rounding: a tie goes to the even neighbour (2.5 -> 2, 3.5 -> 4). The default.
 * HALF_UP    a tie goes away from zero (2.5 -> 3, -2.5 -> -3).
 * UP         always away from zero.
 * DOWN       always toward zero (truncate).
 */
export type RoundingMode = 'HALF_EVEN' | 'HALF_UP' | 'UP' | 'DOWN';

const ROUNDING: Record<RoundingMode, DecimalJs.Rounding> = {
  HALF_EVEN: DecimalJs.ROUND_HALF_EVEN,
  HALF_UP: DecimalJs.ROUND_HALF_UP,
  UP: DecimalJs.ROUND_UP,
  DOWN: DecimalJs.ROUND_DOWN,
};

/** A decimal string such as "1500", "-0.25" or "19.2500". No exponent, "+" prefix, spaces or separators. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
const MAX_INPUT_LENGTH = 64;
const MAX_DECIMAL_PLACES = 30;

/** What arithmetic accepts. JS numbers are deliberately not in this list. */
export type DecimalInput = Decimal | string | bigint;

const invalid = (): DomainError =>
  new DomainError('DECIMAL_INVALID', 'Value is not a plain decimal string.');

const checkDecimalPlaces = (decimalPlaces: number): void => {
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > MAX_DECIMAL_PLACES
  ) {
    throw new DomainError(
      'DECIMAL_INVALID_SCALE',
      'Decimal places must be an integer between 0 and 30.',
      { kind: 'invariant' },
    );
  }
};

/**
 * An exact, immutable decimal number.
 *
 * Every operation returns a new Decimal. Values come in and go out as strings.
 * There is no conversion to a JS number, and using an arithmetic or comparison
 * operator on a Decimal throws.
 */
export class Decimal {
  static readonly ZERO = new Decimal(new Engine(0));
  static readonly ONE = new Decimal(new Engine(1));

  private readonly value: DecimalJs;

  private constructor(value: DecimalJs) {
    // decimal.js has a negative zero; one zero is enough here.
    this.value = value.isZero() ? new Engine(0) : value;
    Object.freeze(this);
  }

  /** For input the caller has to validate: request bodies, imports, user entry. */
  static parse(input: string): Result<Decimal> {
    if (
      typeof input !== 'string' ||
      input.length > MAX_INPUT_LENGTH ||
      !PLAIN_DECIMAL.test(input)
    ) {
      return err(invalid());
    }
    return ok(new Decimal(new Engine(input)));
  }

  /** For values the code already trusts. Throws a DomainError on anything else. */
  static from(input: DecimalInput): Decimal {
    if (input instanceof Decimal) {
      return input;
    }
    if (typeof input === 'bigint') {
      return new Decimal(new Engine(input.toString()));
    }
    const parsed = Decimal.parse(input);
    if (!parsed.ok) {
      throw parsed.error;
    }
    return parsed.value;
  }

  /** For counts and whole quantities only. Rejects fractions and unsafe integers. */
  static fromInteger(input: number): Decimal {
    if (!Number.isSafeInteger(input)) {
      throw new DomainError(
        'DECIMAL_NOT_AN_INTEGER',
        'fromInteger accepts safe integers only. Pass decimals as strings.',
        { kind: 'invariant' },
      );
    }
    return new Decimal(new Engine(input));
  }

  static sum(values: Iterable<DecimalInput>): Decimal {
    let total = Decimal.ZERO;
    for (const value of values) {
      total = total.plus(value);
    }
    return total;
  }

  static min(first: DecimalInput, ...rest: DecimalInput[]): Decimal {
    return rest.reduce<Decimal>(
      (lowest, next) =>
        lowest.compare(next) <= 0 ? lowest : Decimal.from(next),
      Decimal.from(first),
    );
  }

  static max(first: DecimalInput, ...rest: DecimalInput[]): Decimal {
    return rest.reduce<Decimal>(
      (highest, next) =>
        highest.compare(next) >= 0 ? highest : Decimal.from(next),
      Decimal.from(first),
    );
  }

  plus(other: DecimalInput): Decimal {
    return new Decimal(this.value.plus(Decimal.from(other).value));
  }

  minus(other: DecimalInput): Decimal {
    return new Decimal(this.value.minus(Decimal.from(other).value));
  }

  times(other: DecimalInput): Decimal {
    return new Decimal(this.value.times(Decimal.from(other).value));
  }

  /** Exact when the result fits in 60 significant digits, otherwise rounded half-even to 60. */
  dividedBy(other: DecimalInput): Decimal {
    const divisor = Decimal.from(other);
    if (divisor.isZero()) {
      throw new DomainError('DECIMAL_DIVISION_BY_ZERO', 'Division by zero.', {
        kind: 'invariant',
      });
    }
    return new Decimal(this.value.dividedBy(divisor.value));
  }

  negated(): Decimal {
    return new Decimal(this.value.negated());
  }

  abs(): Decimal {
    return new Decimal(this.value.abs());
  }

  round(decimalPlaces: number, mode: RoundingMode = 'HALF_EVEN'): Decimal {
    checkDecimalPlaces(decimalPlaces);
    return new Decimal(
      this.value.toDecimalPlaces(decimalPlaces, ROUNDING[mode]),
    );
  }

  /** -1 when this is lower, 0 when equal in value (1.50 equals 1.5), 1 when higher. */
  compare(other: DecimalInput): -1 | 0 | 1 {
    const result = this.value.comparedTo(Decimal.from(other).value);
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }

  equals(other: DecimalInput): boolean {
    return this.compare(other) === 0;
  }

  lessThan(other: DecimalInput): boolean {
    return this.compare(other) < 0;
  }

  lessThanOrEqual(other: DecimalInput): boolean {
    return this.compare(other) <= 0;
  }

  greaterThan(other: DecimalInput): boolean {
    return this.compare(other) > 0;
  }

  greaterThanOrEqual(other: DecimalInput): boolean {
    return this.compare(other) >= 0;
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  /** Whole numbers have 0 decimal places. Trailing zeros do not count: 1.500 has 1. */
  decimalPlaces(): number {
    return this.value.decimalPlaces();
  }

  /** Shortest exact form, never in exponent notation: "1500", "-0.25". */
  toString(): string {
    return this.value.toFixed();
  }

  /** Exactly `decimalPlaces` digits after the point, rounding if needed: toFixed(4) -> "19.2500". */
  toFixed(decimalPlaces: number, mode: RoundingMode = 'HALF_EVEN'): string {
    return this.round(decimalPlaces, mode).value.toFixed(decimalPlaces);
  }

  toJSON(): string {
    return this.toString();
  }

  /**
   * Stops `a + b`, `a < b` and `+a` from quietly turning into string or number
   * operations. Use plus(), compare() and friends.
   */
  valueOf(): never {
    throw new DomainError(
      'DECIMAL_OPERATOR_USED',
      'A Decimal was used with a JS operator. Use its methods instead.',
      { kind: 'invariant' },
    );
  }
}
