import { Decimal } from './decimal';
import { DomainError } from './domain-error';

const code = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.code : 'NOT_A_DOMAIN_ERROR';
  }
  return 'DID_NOT_THROW';
};

describe('Decimal', () => {
  describe('parsing', () => {
    it.each([
      '0',
      '1500',
      '-0.25',
      '19.2500',
      '0001',
      '12345678901234567890.1234',
    ])('accepts the plain decimal string %s', (input) => {
      expect(Decimal.parse(input).ok).toBe(true);
    });

    it.each([
      '',
      ' 1',
      '1 ',
      '+1',
      '1e3',
      '1,000',
      '.5',
      '5.',
      '0x10',
      'NaN',
      'Infinity',
      '-',
      '1.2.3',
      '١٢',
    ])('rejects %p', (input) => {
      const result = Decimal.parse(input);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe('DECIMAL_INVALID');
    });

    it('rejects a string longer than 64 characters', () => {
      expect(Decimal.parse('1'.repeat(65)).ok).toBe(false);
    });

    it('rejects a JS number that reaches it at runtime', () => {
      expect(code(() => Decimal.from(0.1 as unknown as string))).toBe(
        'DECIMAL_INVALID',
      );
      expect(Decimal.parse(5 as unknown as string).ok).toBe(false);
    });

    it('accepts a bigint and another Decimal', () => {
      expect(Decimal.from(12345678901234567890n).toString()).toBe(
        '12345678901234567890',
      );
      const value = Decimal.from('1.5');
      expect(Decimal.from(value)).toBe(value);
    });

    it('fromInteger accepts safe integers only', () => {
      expect(Decimal.fromInteger(-3).toString()).toBe('-3');
      expect(code(() => Decimal.fromInteger(0.5))).toBe(
        'DECIMAL_NOT_AN_INTEGER',
      );
      expect(code(() => Decimal.fromInteger(2 ** 53))).toBe(
        'DECIMAL_NOT_AN_INTEGER',
      );
      expect(code(() => Decimal.fromInteger(Number.NaN))).toBe(
        'DECIMAL_NOT_AN_INTEGER',
      );
    });
  });

  describe('arithmetic', () => {
    it('is exact where JS numbers are not', () => {
      expect(Decimal.from('0.1').plus('0.2').toString()).toBe('0.3');
      expect(Decimal.from('1.15').times('100').toString()).toBe('115');
      expect(Decimal.from('0.3').minus('0.1').toString()).toBe('0.2');
    });

    it('keeps every digit of a numeric(20,4) product', () => {
      // The largest numeric(20,4) value, squared. BigInt gives the exact answer
      // in units of 10^-8 to compare against.
      const amount = '9999999999999999.9999';
      const digits = ((10n ** 20n - 1n) ** 2n).toString();
      const expected = `${digits.slice(0, -8)}.${digits.slice(-8)}`;
      expect(expected).toBe('99999999999999999998000000000000.00000001');
      expect(Decimal.from(amount).times(amount).toString()).toBe(expected);
    });

    it('divides, rounding only past 60 significant digits', () => {
      expect(Decimal.from('1').dividedBy('8').toString()).toBe('0.125');
      expect(Decimal.from('1').dividedBy('3').toString()).toBe(
        `0.${'3'.repeat(60)}`,
      );
    });

    it('throws on division by zero', () => {
      expect(code(() => Decimal.ONE.dividedBy('0'))).toBe(
        'DECIMAL_DIVISION_BY_ZERO',
      );
    });

    it('negates and takes the absolute value', () => {
      expect(Decimal.from('-2.5').abs().toString()).toBe('2.5');
      expect(Decimal.from('2.5').negated().toString()).toBe('-2.5');
    });

    it('never produces a negative zero', () => {
      expect(Decimal.ZERO.negated().toString()).toBe('0');
      expect(Decimal.from('-0').toString()).toBe('0');
      expect(Decimal.from('-0.4').round(0).toString()).toBe('0');
      expect(Decimal.from('-0.4').round(0).isNegative()).toBe(false);
      expect(Decimal.from('-0.004').toFixed(2)).toBe('0.00');
    });

    it('does not change its operands', () => {
      const a = Decimal.from('1');
      a.plus('1');
      expect(a.toString()).toBe('1');
      expect(Object.isFrozen(a)).toBe(true);
    });

    it('sums, and finds the lowest and highest', () => {
      expect(Decimal.sum(['0.1', '0.2', Decimal.from('0.3')]).toString()).toBe(
        '0.6',
      );
      expect(Decimal.sum([]).toString()).toBe('0');
      expect(Decimal.min('3', '1.5', '2').toString()).toBe('1.5');
      expect(Decimal.max('3', '1.5', '20').toString()).toBe('20');
    });
  });

  describe('rounding', () => {
    it.each([
      ['2.5', 'HALF_EVEN', '2'],
      ['3.5', 'HALF_EVEN', '4'],
      ['-2.5', 'HALF_EVEN', '-2'],
      ['2.5', 'HALF_UP', '3'],
      ['-2.5', 'HALF_UP', '-3'],
      ['2.1', 'UP', '3'],
      ['-2.1', 'UP', '-3'],
      ['2.9', 'DOWN', '2'],
      ['-2.9', 'DOWN', '-2'],
    ] as const)('rounds %s with %s to %s', (input, mode, expected) => {
      expect(Decimal.from(input).round(0, mode).toString()).toBe(expected);
    });

    it("uses banker's rounding by default", () => {
      expect(Decimal.from('0.125').round(2).toString()).toBe('0.12');
      expect(Decimal.from('0.135').round(2).toString()).toBe('0.14');
    });

    it('rejects a scale that is not an integer from 0 to 30', () => {
      expect(code(() => Decimal.ONE.round(-1))).toBe('DECIMAL_INVALID_SCALE');
      expect(code(() => Decimal.ONE.round(1.5))).toBe('DECIMAL_INVALID_SCALE');
      expect(code(() => Decimal.ONE.round(31))).toBe('DECIMAL_INVALID_SCALE');
    });
  });

  describe('comparison', () => {
    it('compares by value, ignoring trailing zeros', () => {
      expect(Decimal.from('1.50').equals('1.5')).toBe(true);
      expect(Decimal.from('1').compare('2')).toBe(-1);
      expect(Decimal.from('2').compare('1')).toBe(1);
      expect(Decimal.from('2').compare('2.000')).toBe(0);
      expect(Decimal.from('1').lessThan('2')).toBe(true);
      expect(Decimal.from('2').lessThanOrEqual('2')).toBe(true);
      expect(Decimal.from('3').greaterThan('2')).toBe(true);
      expect(Decimal.from('2').greaterThanOrEqual('2')).toBe(true);
    });

    it('reports its sign', () => {
      expect(Decimal.ZERO.isZero()).toBe(true);
      expect(Decimal.ZERO.isPositive()).toBe(false);
      expect(Decimal.ZERO.isNegative()).toBe(false);
      expect(Decimal.from('-0.0001').isNegative()).toBe(true);
      expect(Decimal.from('0.0001').isPositive()).toBe(true);
    });
  });

  describe('output', () => {
    it('prints plain notation, never an exponent', () => {
      expect(Decimal.from('0.000000000001').toString()).toBe('0.000000000001');
      expect(Decimal.from('100000000000000000000000').toString()).toBe(
        '100000000000000000000000',
      );
      expect(Decimal.from('19.2500').toString()).toBe('19.25');
    });

    it('prints a fixed number of decimals for storage', () => {
      expect(Decimal.from('19.25').toFixed(4)).toBe('19.2500');
      expect(Decimal.from('1500').toFixed(0)).toBe('1500');
      expect(Decimal.from('0.12345').toFixed(4)).toBe('0.1234');
      expect(Decimal.from('0.12345').toFixed(4, 'HALF_UP')).toBe('0.1235');
    });

    it('serialises to a JSON string', () => {
      expect(JSON.stringify({ rate: Decimal.from('0.1925') })).toBe(
        '{"rate":"0.1925"}',
      );
    });

    it('counts decimal places without trailing zeros', () => {
      expect(Decimal.from('1.500').decimalPlaces()).toBe(1);
      expect(Decimal.from('1500').decimalPlaces()).toBe(0);
    });
  });

  describe('JS operators', () => {
    it('throws instead of coercing to a number or string', () => {
      const a = Decimal.from('1') as unknown as number;
      const b = Decimal.from('2') as unknown as number;
      expect(code(() => a + b)).toBe('DECIMAL_OPERATOR_USED');
      expect(code(() => a < b)).toBe('DECIMAL_OPERATOR_USED');
      expect(code(() => +a)).toBe('DECIMAL_OPERATOR_USED');
    });

    it('still works in a template literal', () => {
      expect(`${Decimal.from('1.5')}`).toBe('1.5');
    });
  });
});
