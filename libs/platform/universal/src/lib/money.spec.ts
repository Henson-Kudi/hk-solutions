import { currencyCode, minorUnitsOf, parseCurrencyCode } from './currency';
import { DomainError } from './domain-error';
import { Money, parseMoney } from './money';

const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

const amounts = (parts: Money[]): string[] =>
  parts.map((part) => part.amount.toString());

describe('currency', () => {
  it('accepts three upper-case letters only', () => {
    expect(parseCurrencyCode('XAF').ok).toBe(true);
    for (const bad of ['xaf', 'XA', 'XAFF', 'X4F', '', ' XAF']) {
      const result = parseCurrencyCode(bad);
      expect(!result.ok && result.error.code).toBe('CURRENCY_CODE_INVALID');
    }
    expect(code(() => currencyCode('fcfa'))).toBe('CURRENCY_CODE_INVALID');
  });

  it('knows the minor units of the launch currencies', () => {
    expect(minorUnitsOf(currencyCode('XAF'))).toBe(0);
    expect(minorUnitsOf(currencyCode('AED'))).toBe(2);
  });

  it('knows three-decimal currencies and defaults to two', () => {
    expect(minorUnitsOf(currencyCode('KWD'))).toBe(3);
    expect(minorUnitsOf(currencyCode('USD'))).toBe(2);
    expect(minorUnitsOf(currencyCode('EUR'))).toBe(2);
  });
});

describe('Money', () => {
  describe('creation', () => {
    it('is built from a decimal string and a currency', () => {
      const money = Money.of('1500.50', 'AED');
      expect(money.amount.toString()).toBe('1500.5');
      expect(money.currency).toBe('AED');
      expect(Object.isFrozen(money)).toBe(true);
    });

    it('throws on a bad amount or currency', () => {
      expect(code(() => Money.of('1,500', 'AED'))).toBe('DECIMAL_INVALID');
      expect(code(() => Money.of('1500', 'aed'))).toBe('CURRENCY_CODE_INVALID');
      expect(code(() => Money.of(1500 as unknown as string, 'AED'))).toBe(
        'DECIMAL_INVALID',
      );
    });

    it('parses boundary input into a Result', () => {
      const good = parseMoney({ amount: '250', currency: 'XAF' });
      expect(good.ok && good.value.toJSON()).toEqual({
        amount: '250',
        currency: 'XAF',
      });

      const numberAmount = parseMoney({ amount: 250, currency: 'XAF' });
      expect(!numberAmount.ok && numberAmount.error.code).toBe('MONEY_INVALID');

      const badAmount = parseMoney({ amount: '2e5', currency: 'XAF' });
      expect(!badAmount.ok && badAmount.error.code).toBe('DECIMAL_INVALID');

      const badCurrency = parseMoney({ amount: '250', currency: 'FCFA' });
      expect(!badCurrency.ok && badCurrency.error.code).toBe(
        'CURRENCY_CODE_INVALID',
      );

      expect(parseMoney(null).ok).toBe(false);
      expect(parseMoney('250 XAF').ok).toBe(false);
    });

    it('round-trips through JSON as strings', () => {
      const json = JSON.stringify(Money.of('0.10', 'AED'));
      expect(json).toBe('{"amount":"0.1","currency":"AED"}');
      const back = parseMoney(JSON.parse(json));
      expect(back.ok && back.value.equals(Money.of('0.1', 'AED'))).toBe(true);
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts in one currency', () => {
      const total = Money.of('0.10', 'AED').plus(Money.of('0.20', 'AED'));
      expect(total.equals(Money.of('0.30', 'AED'))).toBe(true);
      expect(total.minus(Money.of('0.30', 'AED')).isZero()).toBe(true);
    });

    it('refuses to combine or compare two currencies', () => {
      const xaf = Money.of('100', 'XAF');
      const aed = Money.of('100', 'AED');
      expect(code(() => xaf.plus(aed))).toBe('MONEY_CURRENCY_MISMATCH');
      expect(code(() => xaf.minus(aed))).toBe('MONEY_CURRENCY_MISMATCH');
      expect(code(() => xaf.compare(aed))).toBe('MONEY_CURRENCY_MISMATCH');
      expect(code(() => Money.sum('XAF', [xaf, aed]))).toBe(
        'MONEY_CURRENCY_MISMATCH',
      );
      expect(xaf.equals(aed)).toBe(false);
    });

    it('multiplies and divides without rounding', () => {
      expect(Money.of('19.99', 'AED').times('3').amount.toString()).toBe(
        '59.97',
      );
      expect(Money.of('1000', 'XAF').times('0.1925').amount.toString()).toBe(
        '192.5',
      );
      expect(Money.of('10', 'AED').dividedBy('4').amount.toString()).toBe(
        '2.5',
      );
    });

    it('sums a list, and an empty list is zero in the given currency', () => {
      const total = Money.sum('XAF', [
        Money.of('100', 'XAF'),
        Money.of('250', 'XAF'),
      ]);
      expect(total.toJSON()).toEqual({ amount: '350', currency: 'XAF' });
      expect(Money.sum('XAF', []).toJSON()).toEqual({
        amount: '0',
        currency: 'XAF',
      });
    });

    it('reports sign and compares', () => {
      const debt = Money.of('-5', 'AED');
      expect(debt.isNegative()).toBe(true);
      expect(debt.abs().isPositive()).toBe(true);
      expect(debt.negated().equals(Money.of('5', 'AED'))).toBe(true);
      expect(debt.compare(Money.zero('AED'))).toBe(-1);
      expect(Money.zero('AED').isZero()).toBe(true);
    });
  });

  describe('rounding', () => {
    it('rounds a line to 4 decimals', () => {
      const line = Money.of('33.333333', 'AED').roundToLine();
      expect(line.amount.toString()).toBe('33.3333');
    });

    it('rounds a total to the minor unit of its currency', () => {
      expect(
        Money.of('1192.5', 'XAF').roundToMinorUnit().amount.toString(),
      ).toBe('1192');
      expect(
        Money.of('1193.5', 'XAF').roundToMinorUnit().amount.toString(),
      ).toBe('1194');
      expect(
        Money.of('10.125', 'AED').roundToMinorUnit().amount.toString(),
      ).toBe('10.12');
      expect(
        Money.of('10.125', 'KWD').roundToMinorUnit().amount.toString(),
      ).toBe('10.125');
    });

    it('lets a pack choose another rounding mode', () => {
      expect(
        Money.of('1192.5', 'XAF').roundToMinorUnit('HALF_UP').amount.toString(),
      ).toBe('1193');
    });

    it('reports the rounding difference so it can be posted', () => {
      const original = Money.of('1192.5', 'XAF');
      const { rounded, difference } = original.roundToMinorUnitWithDifference();
      expect(rounded.amount.toString()).toBe('1192');
      expect(difference.amount.toString()).toBe('-0.5');
      expect(original.plus(difference).equals(rounded)).toBe(true);
    });

    it('knows whether an amount is already in minor units', () => {
      expect(Money.of('100', 'XAF').isInMinorUnits()).toBe(true);
      expect(Money.of('100.5', 'XAF').isInMinorUnits()).toBe(false);
      expect(Money.of('100.50', 'AED').isInMinorUnits()).toBe(true);
      expect(Money.of('100.505', 'AED').isInMinorUnits()).toBe(false);
    });
  });

  describe('allocate', () => {
    it('splits a zero-decimal currency without losing a franc', () => {
      expect(amounts(Money.of('100', 'XAF').allocate(['1', '1', '1']))).toEqual(
        ['34', '33', '33'],
      );
    });

    it('splits a two-decimal currency without losing a fils', () => {
      expect(amounts(Money.of('0.05', 'AED').allocate(['1', '1']))).toEqual([
        '0.03',
        '0.02',
      ]);
      expect(amounts(Money.of('100', 'AED').allocate(['70', '30']))).toEqual([
        '70',
        '30',
      ]);
    });

    it('gives the leftover to the parts that lost the most', () => {
      // Exact shares: 16.67, 33.33, 50.00. The first lost the larger fraction.
      expect(amounts(Money.of('100', 'XAF').allocate(['1', '2', '3']))).toEqual(
        ['17', '33', '50'],
      );
    });

    it('gives nothing to a zero ratio', () => {
      expect(amounts(Money.of('10', 'XAF').allocate(['0', '1', '0']))).toEqual([
        '0',
        '10',
        '0',
      ]);
    });

    it('mirrors a negative amount', () => {
      expect(
        amounts(Money.of('-100', 'XAF').allocate(['1', '1', '1'])),
      ).toEqual(['-34', '-33', '-33']);
    });

    it('accepts fractional ratios such as tax rates', () => {
      expect(
        amounts(Money.of('1000', 'XAF').allocate(['0.175', '0.0175'])),
      ).toEqual(['909', '91']);
    });

    it('always adds back up to the original amount', () => {
      const cases: [string, string, string[]][] = [
        ['1', 'XAF', ['1', '1', '1']],
        ['999999999999', 'XAF', ['3', '7', '11', '13']],
        ['0.01', 'AED', ['1', '1', '1', '1', '1']],
        ['12345.67', 'AED', ['0.3333', '0.3333', '0.3334']],
        ['-0.07', 'AED', ['5', '3', '1']],
        ['10.001', 'KWD', ['1', '2']],
      ];
      for (const [amount, currency, ratios] of cases) {
        const original = Money.of(amount, currency);
        const parts = original.allocate(ratios);
        expect(parts).toHaveLength(ratios.length);
        expect(Money.sum(currency, parts).equals(original)).toBe(true);
        expect(parts.every((part) => part.isInMinorUnits())).toBe(true);
      }
    });

    it('refuses an amount that is not in minor units', () => {
      expect(code(() => Money.of('100.5', 'XAF').allocate(['1', '1']))).toBe(
        'MONEY_NOT_IN_MINOR_UNITS',
      );
    });

    it('refuses empty, negative or all-zero ratios', () => {
      const money = Money.of('100', 'XAF');
      expect(code(() => money.allocate([]))).toBe(
        'MONEY_ALLOCATION_RATIOS_INVALID',
      );
      expect(code(() => money.allocate(['1', '-1']))).toBe(
        'MONEY_ALLOCATION_RATIOS_INVALID',
      );
      expect(code(() => money.allocate(['0', '0']))).toBe(
        'MONEY_ALLOCATION_RATIOS_INVALID',
      );
    });
  });
});
