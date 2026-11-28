import {
  RATE_ERRORS,
  TAX_ERRORS,
  createRateTable,
  type TaxCalculation,
  type TaxCodeDef,
  type TaxRequest,
} from '@hk/country-packs/kernel';
import { Decimal, Money, localizedText } from '@hk/platform/universal';
import { STANDARD_VAT_VECTORS } from '../../testing/vat-vectors';
import { AE_REGISTRATION_FIELDS } from '../business';
import { SOURCES } from '../sources';
import { AE_TAX_CODES } from './codes';
import {
  AE_TAX_ROUNDING,
  AE_VAT_STATUS_FIELD,
  createAeTaxEngine,
  isLiableForAeVat,
} from './engine';

const DATE = '2026-01-15';
const engine = createAeTaxEngine();

const aed = (amount: string) => Money.of(amount, 'AED');

const request = (
  lines: [net: string, taxCode: string][],
  overrides: Partial<TaxRequest> = {},
): TaxRequest => ({
  date: DATE,
  direction: 'sale',
  lines: lines.map(([net, taxCode], index) => ({
    id: `line-${index + 1}`,
    net: aed(net),
    taxCode,
  })),
  ...overrides,
});

const calculate = (input: TaxRequest, on = engine): TaxCalculation => {
  const result = on.calculate(input);
  if (!result.ok) {
    throw new Error(`calculate failed: ${result.error.code}`);
  }
  return result.value;
};

const totals = (result: TaxCalculation) => ({
  net: result.totalNet.amount.toString(),
  tax: result.totalTax.amount.toString(),
  gross: result.totalGross.amount.toString(),
});

describe('UAE VAT: standard rate vectors', () => {
  it.each(STANDARD_VAT_VECTORS)('net $net AED: VAT $tax', ({ net, tax }) => {
    const result = calculate(request([[net, 'VAT_STD']]));
    expect(totals(result)).toEqual({
      net: Decimal.from(net).toString(),
      tax,
      gross: Decimal.from(net).plus(tax).toString(),
    });
    expect(result.lines[0]?.components.map((item) => item.key)).toEqual([
      'vat',
    ]);
  });

  // The vectors are worked out by hand. This checks the working itself, so a
  // typing mistake in a vector cannot hide behind a matching mistake in code.
  it.each(STANDARD_VAT_VECTORS)(
    'vector for net $net follows the stated method',
    ({ net, tax }) => {
      expect(
        Decimal.from(net).times('0.05').round(2, 'HALF_UP').toString(),
      ).toBe(tax);
    },
  );
});

describe('UAE VAT: rates', () => {
  it('charges 5% from the day VAT began, and nothing can be calculated before', () => {
    const standard = AE_TAX_CODES.find((code) => code.code === 'VAT_STD');
    const rate = standard?.components[0]?.rate;
    expect(rate?.entries).toHaveLength(1);
    expect(rate?.entries[0]?.effectiveFrom).toBe('2018-01-01');
    expect(rate?.entries[0]?.value).toBe('0.05');

    const before = engine.calculate(
      request([['100', 'VAT_STD']], { date: '2017-12-31' }),
    );
    expect(!before.ok && before.error.code).toBe(RATE_ERRORS.NOT_IN_EFFECT);
    expect(
      engine.calculate(request([['100', 'VAT_STD']], { date: '2018-01-01' }))
        .ok,
    ).toBe(true);
  });

  it('marks every rate as not yet confirmed by an adviser', () => {
    for (const code of AE_TAX_CODES) {
      for (const item of code.components) {
        expect(item.rate.unconfirmed()).toHaveLength(item.rate.entries.length);
      }
    }
  });

  it('uses the rate in force on the document date when a rate changes', () => {
    // An invented future change, to prove the engine reads the date.
    const source = SOURCES.vatStandardRate;
    const codes: TaxCodeDef[] = [
      {
        code: 'VAT_STD',
        name: localizedText('VAT', 'TVA'),
        treatment: 'standard',
        components: [
          {
            key: 'vat',
            name: localizedText('VAT', 'TVA'),
            rate: createRateTable('test.vat', [
              {
                effectiveFrom: '2018-01-01',
                effectiveTo: '2029-12-31',
                value: '0.05',
                source,
              },
              { effectiveFrom: '2030-01-01', value: '0.10', source },
            ]),
            outputRole: 'vat.output',
          },
        ],
      },
    ];
    const changing = createAeTaxEngine(codes);
    const taxOn = (date: string) =>
      totals(calculate(request([['200', 'VAT_STD']], { date }), changing)).tax;
    expect(taxOn('2029-12-31')).toBe('10');
    expect(taxOn('2030-01-01')).toBe('20');
  });
});

describe('UAE VAT: rounding', () => {
  it('rounds half up to the fils, per line, with a source note', () => {
    expect(AE_TAX_ROUNDING.level).toBe('line');
    expect(AE_TAX_ROUNDING.mode).toBe('HALF_UP');
    expect(AE_TAX_ROUNDING.source.reference).toContain('art. 61');
  });

  it('charges 5% rounded to the fils on every amount up to 30 dirhams', () => {
    for (let fils = 0; fils <= 3000; fils += 1) {
      const net = Decimal.fromInteger(fils).dividedBy('100');
      const result = calculate(request([[net.toString(), 'VAT_STD']]));
      const expected = net.times('0.05').round(2, 'HALF_UP');
      expect(result.totalTax.amount.equals(expected)).toBe(true);
      expect(result.totalTax.isInMinorUnits()).toBe(true);
      expect(result.totalGross.amount.equals(net.plus(expected))).toBe(true);
    }
  });

  it('rounds each line, so two lines can differ from one line of the sum', () => {
    const separate = calculate(
      request([
        ['0.10', 'VAT_STD'],
        ['0.10', 'VAT_STD'],
      ]),
    );
    const together = calculate(request([['0.20', 'VAT_STD']]));
    // 0.005 rounds to 0.01 twice; 0.01 is exact.
    expect(totals(separate).tax).toBe('0.02');
    expect(totals(together).tax).toBe('0.01');
  });

  it('mirrors an invoice exactly on a credit note', () => {
    for (const net of ['19.90', '0.10', '33.33', '1234.56']) {
      const invoice = calculate(request([[net, 'VAT_STD']]));
      const credit = calculate(request([[`-${net}`, 'VAT_STD']]));
      expect(credit.totalTax.plus(invoice.totalTax).isZero()).toBe(true);
      expect(credit.totalGross.plus(invoice.totalGross).isZero()).toBe(true);
    }
  });

  it('rounds to the minor unit of the document currency', () => {
    // The Kuwaiti dinar has three decimals.
    const result = calculate({
      date: DATE,
      direction: 'sale',
      lines: [{ id: 'kwd', net: Money.of('1.010', 'KWD'), taxCode: 'VAT_STD' }],
    });
    expect(totals(result).tax).toBe('0.051');
    expect(result.totalTax.currency).toBe('KWD');
  });

  it('never returns a fraction of a fils', () => {
    const result = calculate(
      request([
        ['33.3333', 'VAT_STD'],
        ['0.005', 'VAT_STD'],
      ]),
    );
    for (const line of result.lines) {
      expect(line.tax.isInMinorUnits()).toBe(true);
    }
    expect(result.totalTax.isInMinorUnits()).toBe(true);
  });
});

describe('UAE VAT: codes', () => {
  it('has the five codes, with the standard one as the default', () => {
    expect(engine.codes.map((code) => [code.code, code.treatment])).toEqual([
      ['VAT_STD', 'standard'],
      ['VAT_ZERO', 'zero_rated'],
      ['VAT_EXEMPT', 'exempt'],
      ['VAT_OUT_OF_SCOPE', 'out_of_scope'],
      ['VAT_RC', 'reverse_charge'],
    ]);
    expect(engine.defaultSaleCode).toBe('VAT_STD');
    expect(engine.defaultPurchaseCode).toBe('VAT_STD');
  });

  it.each(['VAT_ZERO', 'VAT_EXEMPT', 'VAT_OUT_OF_SCOPE'])(
    '%s charges nothing',
    (code) => {
      expect(totals(calculate(request([['2500', code]])))).toEqual({
        net: '2500',
        tax: '0',
        gross: '2500',
      });
    },
  );

  it('reports a zero VAT component on a zero-rated sale, and none on an exempt one', () => {
    const zero = calculate(request([['500', 'VAT_ZERO']]));
    expect(zero.lines[0]?.components).toEqual([
      { key: 'vat', rate: '0', amount: aed('0'), role: 'vat.output' },
    ]);
    const exempt = calculate(request([['500', 'VAT_EXEMPT']]));
    expect(exempt.lines[0]?.components).toEqual([]);
  });

  it('posts sales tax to output VAT and purchase tax to input VAT', () => {
    const role = (direction: TaxRequest['direction']) =>
      calculate(request([['100', 'VAT_STD']], { direction })).lines[0]
        ?.components[0]?.role;
    expect(role('sale')).toBe('vat.output');
    expect(role('purchase')).toBe('vat.input');
  });

  it('says VAT is due when an advance is received', () => {
    expect(engine.advances.taxDueOnReceipt).toBe(true);
  });
});

describe('UAE VAT: reverse charge', () => {
  it('on a purchase, the buyer accounts for 5% and pays the supplier the net', () => {
    const result = calculate(
      request([['1000', 'VAT_RC']], { direction: 'purchase' }),
    );
    expect(totals(result)).toEqual({ net: '1000', tax: '50', gross: '1000' });
    expect(result.lines[0]?.components).toEqual([
      {
        key: 'vat',
        rate: '0.05',
        amount: aed('50'),
        role: 'vat.input',
        counterRole: 'vat.output',
      },
    ]);
  });

  it('on a sale, the seller charges nothing', () => {
    const result = calculate(request([['1000', 'VAT_RC']]));
    expect(totals(result)).toEqual({ net: '1000', tax: '0', gross: '1000' });
    expect(result.lines[0]?.components).toEqual([
      { key: 'vat', rate: '0.05', amount: aed('0'), role: 'vat.output' },
    ]);
  });

  it('rounds the self-accounted tax to the fils', () => {
    const result = calculate(
      request([['33.33', 'VAT_RC']], { direction: 'purchase' }),
    );
    expect(totals(result)).toEqual({
      net: '33.33',
      tax: '1.67',
      gross: '33.33',
    });
  });

  it('keeps reverse charge tax out of what is owed on a mixed bill', () => {
    const result = calculate(
      request(
        [
          ['1000', 'VAT_RC'],
          ['200', 'VAT_STD'],
        ],
        { direction: 'purchase' },
      ),
    );
    // Tax accounted for: 50 + 10. Owed to suppliers: 1000 + 210.
    expect(totals(result)).toEqual({ net: '1200', tax: '60', gross: '1210' });
  });

  it('has no rate before VAT began', () => {
    const result = engine.calculate(
      request([['1000', 'VAT_RC']], {
        direction: 'purchase',
        date: '2017-06-01',
      }),
    );
    expect(!result.ok && result.error.code).toBe(RATE_ERRORS.NOT_IN_EFFECT);
  });
});

describe('UAE VAT: who is liable', () => {
  it.each([
    ['registered', true],
    ['not_registered', false],
  ])('a business that is %s: liable is %s', (status, expected) => {
    expect(engine.isLiable({ vat_status: status })).toBe(expected);
  });

  it('has an answer for every status onboarding offers', () => {
    const field = AE_REGISTRATION_FIELDS.find(
      (item) => item.key === AE_VAT_STATUS_FIELD,
    );
    const statuses = field?.options?.map((option) => option.key) ?? [];
    expect(
      statuses.filter((status) => isLiableForAeVat({ vat_status: status })),
    ).toEqual(['registered']);
  });

  it('treats a missing or unknown status as not liable', () => {
    expect(engine.isLiable({})).toBe(false);
    expect(engine.isLiable({ vat_status: '' })).toBe(false);
    expect(engine.isLiable({ vat_status: 'REGISTERED' })).toBe(false);
    // Holding a TRN is not the question asked. (Invented number.)
    expect(engine.isLiable({ trn: '100000000000003' })).toBe(false);
  });

  it('gives a business that is not liable a code that charges nothing', () => {
    expect(engine.notLiableCode).toBe('VAT_OUT_OF_SCOPE');
    const result = calculate(request([['750', engine.notLiableCode]]));
    expect(totals(result)).toEqual({ net: '750', tax: '0', gross: '750' });
  });
});

describe('UAE VAT: a whole document', () => {
  it('adds up a mixed invoice', () => {
    const result = calculate(
      request([
        ['1234.56', 'VAT_STD'],
        ['19.90', 'VAT_STD'],
        ['500', 'VAT_EXEMPT'],
        ['750', 'VAT_ZERO'],
      ]),
    );
    // 61.73 + 1.00
    expect(totals(result)).toEqual({
      net: '2504.46',
      tax: '62.73',
      gross: '2567.19',
    });
  });

  it('gives zero totals for a document with no lines', () => {
    const result = calculate(request([]));
    expect(result.lines).toEqual([]);
    expect(totals(result)).toEqual({ net: '0', tax: '0', gross: '0' });
    expect(result.totalTax.currency).toBe('AED');
  });

  it('refuses an unknown code, even next to valid lines', () => {
    const result = engine.calculate(
      request([
        ['100', 'VAT_STD'],
        ['100', 'VAT_REDUCED'],
      ]),
    );
    expect(!result.ok && result.error.code).toBe(TAX_ERRORS.CODE_UNKNOWN);
  });

  it('refuses lines in different currencies', () => {
    const result = engine.calculate({
      date: DATE,
      direction: 'sale',
      lines: [
        { id: 'a', net: aed('100'), taxCode: 'VAT_STD' },
        { id: 'b', net: Money.of('10', 'USD'), taxCode: 'VAT_STD' },
      ],
    });
    expect(!result.ok && result.error.code).toBe(TAX_ERRORS.CURRENCY_MIXED);
  });

  it('refuses a date that is not a date', () => {
    const result = engine.calculate(
      request([['100', 'VAT_STD']], { date: '15/01/2026' }),
    );
    expect(!result.ok && result.error.code).toBe(RATE_ERRORS.DATE_INVALID);
  });
});
