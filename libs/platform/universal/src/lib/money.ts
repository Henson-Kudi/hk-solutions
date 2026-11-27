import {
  currencyCode,
  minorUnitsOf,
  parseCurrencyCode,
  type CurrencyCode,
} from './currency';
import { Decimal, type DecimalInput, type RoundingMode } from './decimal';
import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/** Decimal places kept on a document line, and the scale of numeric(20,4) columns. */
export const LINE_SCALE = 4;

/** Money at an API or storage boundary: the amount is a decimal string, never a number. */
export interface MoneyJson {
  amount: string;
  currency: string;
}

export interface RoundedMoney {
  rounded: Money;
  /** rounded minus original. Post this to the rounding-difference account. */
  difference: Money;
}

/**
 * An exact amount in one currency. Immutable.
 *
 * Arithmetic never rounds. Round on purpose, in two places only: a line with
 * roundToLine() and a document total with roundToMinorUnit().
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  /** For values the code already trusts. Throws a DomainError on a bad amount or currency. */
  static of(amount: DecimalInput, currency: string): Money {
    return new Money(Decimal.from(amount), currencyCode(currency));
  }

  /** For input the caller has to validate. */
  static parse(input: MoneyJson): Result<Money> {
    const amount = Decimal.parse(input.amount);
    if (!amount.ok) {
      return amount;
    }
    const currency = parseCurrencyCode(input.currency);
    if (!currency.ok) {
      return currency;
    }
    return ok(new Money(amount.value, currency.value));
  }

  static zero(currency: string): Money {
    return new Money(Decimal.ZERO, currencyCode(currency));
  }

  /** The currency is a parameter so that an empty list still has a well-defined total. */
  static sum(currency: string, items: Iterable<Money>): Money {
    let total = Money.zero(currency);
    for (const item of items) {
      total = total.plus(item);
    }
    return total;
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a quantity or a rate. The result is not rounded. */
  times(factor: DecimalInput): Money {
    return new Money(this.amount.times(factor), this.currency);
  }

  /** Divide by a quantity or a rate. The result is not rounded. */
  dividedBy(divisor: DecimalInput): Money {
    return new Money(this.amount.dividedBy(divisor), this.currency);
  }

  negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.compare(other.amount);
  }

  /** Same currency and same value. Unlike compare(), a different currency is false, not an error. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isPositive(): boolean {
    return this.amount.isPositive();
  }

  /** Round to 4 decimals, the precision of a document line. */
  roundToLine(mode: RoundingMode = 'HALF_EVEN'): Money {
    return new Money(this.amount.round(LINE_SCALE, mode), this.currency);
  }

  /** Round to the currency's smallest unit: XAF to 0 decimals, AED to 2. */
  roundToMinorUnit(mode: RoundingMode = 'HALF_EVEN'): Money {
    return new Money(
      this.amount.round(minorUnitsOf(this.currency), mode),
      this.currency,
    );
  }

  /** roundToMinorUnit() plus the amount the rounding added or removed. */
  roundToMinorUnitWithDifference(
    mode: RoundingMode = 'HALF_EVEN',
  ): RoundedMoney {
    const rounded = this.roundToMinorUnit(mode);
    return { rounded, difference: rounded.minus(this) };
  }

  /** True when the amount has no more decimals than the currency's minor unit. */
  isInMinorUnits(): boolean {
    return this.amount.decimalPlaces() <= minorUnitsOf(this.currency);
  }

  /**
   * Split this amount in proportion to `ratios` without losing or inventing a
   * minor unit: the parts always add up to this amount exactly.
   *
   * Each part is first rounded toward zero. The minor units left over go, one
   * each, to the parts that lost the largest fraction, earliest part first on a
   * tie. So 100 XAF over [1, 1, 1] is [34, 33, 33].
   *
   * This amount must already be in minor units. Ratios cannot be negative and
   * cannot all be zero.
   */
  allocate(ratios: readonly DecimalInput[]): Money[] {
    if (!this.isInMinorUnits()) {
      throw new DomainError(
        'MONEY_NOT_IN_MINOR_UNITS',
        'Round the amount to its minor unit before allocating it.',
        { kind: 'invariant' },
      );
    }
    const weights = ratios.map((ratio) => Decimal.from(ratio));
    const totalWeight = Decimal.sum(weights);
    if (
      weights.length === 0 ||
      weights.some((weight) => weight.isNegative()) ||
      totalWeight.isZero()
    ) {
      throw new DomainError(
        'MONEY_ALLOCATION_RATIOS_INVALID',
        'Allocation needs at least one ratio, none negative, and a total above zero.',
        { kind: 'invariant' },
      );
    }

    const scale = minorUnitsOf(this.currency);
    const unit = Decimal.ONE.dividedBy(`1${'0'.repeat(scale)}`);
    const total = this.amount.abs();

    const exact = weights.map((weight) =>
      total.times(weight).dividedBy(totalWeight),
    );
    const parts = exact.map((share) => share.round(scale, 'DOWN'));

    const byLargestLoss = exact
      .map((share, index) => ({
        index,
        lost: share.minus(parts[index] as Decimal),
      }))
      .sort((a, b) => b.lost.compare(a.lost) || a.index - b.index);

    // Each part lost less than one unit, so the leftover is always fewer
    // units than there are parts and this loop hands all of it out.
    let leftover = total.minus(Decimal.sum(parts));
    for (const { index } of byLargestLoss) {
      if (!leftover.isPositive()) {
        break;
      }
      parts[index] = (parts[index] as Decimal).plus(unit);
      leftover = leftover.minus(unit);
    }

    const negative = this.amount.isNegative();
    return parts.map(
      (part) => new Money(negative ? part.negated() : part, this.currency),
    );
  }

  /** The amount in its shortest exact form: { amount: "1500.5", currency: "AED" }. */
  toJSON(): MoneyJson {
    return { amount: this.amount.toString(), currency: this.currency };
  }

  /** For debugging only. User-facing formatting goes through i18n. */
  toString(): string {
    return `${this.amount.toString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'MONEY_CURRENCY_MISMATCH',
        'Amounts in different currencies cannot be combined.',
        {
          kind: 'invariant',
          details: { left: this.currency, right: other.currency },
        },
      );
    }
  }
}

/** True when the value has the shape of MoneyJson. It does not validate the contents. */
export const isMoneyJson = (value: unknown): value is MoneyJson => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof MoneyJson, unknown>>;
  return (
    typeof candidate.amount === 'string' &&
    typeof candidate.currency === 'string'
  );
};

/** Parse an unknown boundary value into Money. */
export const parseMoney = (value: unknown): Result<Money> =>
  isMoneyJson(value)
    ? Money.parse(value)
    : err(
        new DomainError(
          'MONEY_INVALID',
          'Money must be an object with string fields "amount" and "currency".',
        ),
      );
