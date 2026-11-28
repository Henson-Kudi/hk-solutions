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
import { SOURCES } from '../sources';
import { CAC_SHARE_OF_VAT, CM_TAX_CODES } from './codes';
import { CM_TAX_ROUNDING, createCmTaxEngine } from './engine';

const DATE = '2026-01-15';
const engine = createCmTaxEngine();

const xaf = (amount: string) => Money.of(amount, 'XAF');

const request = (
  lines: [net: string, taxCode: string][],
  overrides: Partial<TaxRequest> = {},
): TaxRequest => ({
  date: DATE,
  direction: 'sale',
  lines: lines.map(([net, taxCode], index) => ({
    id: `line-${index + 1}`,
    net: xaf(net),
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

const amounts = (result: TaxCalculation) =>
  result.lines.map((line) => ({
    tax: line.tax.amount.toString(),
    gross: line.gross.amount.toString(),
    ...Object.fromEntries(
      line.components.map((component) => [
        component.key,
        component.amount.amount.toString(),
      ]),
    ),
  }));

describe('Cameroon VAT: standard rate vectors', () => {
  it.each(STANDARD_VAT_VECTORS)(
    'net $net XAF: TVA $tva + CAC $cac = $total',
    ({ net, tva, cac, total }) => {
      const result = calculate(request([[net, 'TVA_STD']]));
      expect(amounts(result)).toEqual([
        {
          tva,
          cac,
          tax: total,
          gross: Decimal.from(net).plus(total).toString(),
        },
      ]);
      expect(result.totalTax.amount.toString()).toBe(total);
    },
  );

  // The vectors are worked out by hand. This checks the working itself, so a
  // typing mistake in a vector cannot hide behind a matching mistake in code.
  it.each(STANDARD_VAT_VECTORS)(
    'vector for net $net follows the stated method',
    ({ net, tva, cac, total }) => {
      const amount = Decimal.from(net);
      expect(amount.times('0.1925').round(0, 'HALF_UP').toString()).toBe(total);
      expect(amount.times('0.175').round(0, 'HALF_UP').toString()).toBe(tva);
      expect(Decimal.from(total).minus(tva).toString()).toBe(cac);
    },
  );
});

describe('Cameroon VAT: rates', () => {
  const standard = CM_TAX_CODES.find((code) => code.code === 'TVA_STD');
  const component = (key: string) => {
    const found = standard?.components.find((item) => item.key === key);
    if (!found) throw new Error(`no component ${key}`);
    return found;
  };

  it('charges 17.5% VAT and 1.75% surcharge: 19.25% in all', () => {
    const tva = component('tva').rate.valueAt(DATE);
    const cac = component('cac').rate.valueAt(DATE);
    expect(tva.ok && tva.value).toBe('0.175');
    expect(cac.ok && cac.value).toBe('0.0175');
    expect(Decimal.sum(['0.175', '0.0175']).toString()).toBe('0.1925');
  });

  it('keeps the surcharge at 10% of the VAT in every period', () => {
    const tvaEntries = component('tva').rate.entries;
    const cacEntries = component('cac').rate.entries;
    expect(cacEntries.map((entry) => entry.effectiveFrom)).toEqual(
      tvaEntries.map((entry) => entry.effectiveFrom),
    );
    tvaEntries.forEach((entry, index) => {
      expect(Decimal.from(entry.value).times(CAC_SHARE_OF_VAT).toString()).toBe(
        cacEntries[index]?.value,
      );
    });
  });

  it('has no rate, and so no answer, before the rates begin', () => {
    const result = engine.calculate(
      request([['1000', 'TVA_STD']], { date: '2004-12-31' }),
    );
    expect(!result.ok && result.error.code).toBe(RATE_ERRORS.NOT_IN_EFFECT);
    expect(
      engine.calculate(request([['1000', 'TVA_STD']], { date: '2005-01-01' }))
        .ok,
    ).toBe(true);
  });

  it('marks every rate as not yet confirmed by an accountant', () => {
    for (const code of CM_TAX_CODES) {
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
        code: 'TVA_STD',
        name: localizedText('VAT', 'TVA'),
        treatment: 'standard',
        components: [
          {
            key: 'tva',
            name: localizedText('VAT', 'TVA'),
            rate: createRateTable('test.tva', [
              {
                effectiveFrom: '2005-01-01',
                effectiveTo: '2029-12-31',
                value: '0.175',
                source,
              },
              { effectiveFrom: '2030-01-01', value: '0.20', source },
            ]),
            outputRole: 'vat.output',
          },
          {
            key: 'cac',
            name: localizedText('CAC', 'CAC'),
            rate: createRateTable('test.cac', [
              {
                effectiveFrom: '2005-01-01',
                effectiveTo: '2029-12-31',
                value: '0.0175',
                source,
              },
              { effectiveFrom: '2030-01-01', value: '0.02', source },
            ]),
            outputRole: 'vat.output',
          },
        ],
      },
    ];
    const changing = createCmTaxEngine(codes);
    const on = (date: string) =>
      amounts(calculate(request([['10000', 'TVA_STD']], { date }), changing));
    expect(on('2029-12-31')).toEqual([
      { tva: '1750', cac: '175', tax: '1925', gross: '11925' },
    ]);
    expect(on('2030-01-01')).toEqual([
      { tva: '2000', cac: '200', tax: '2200', gross: '12200' },
    ]);
  });
});

describe('Cameroon VAT: rounding', () => {
  it('rounds half up, per line, with a source note', () => {
    expect(CM_TAX_ROUNDING.level).toBe('line');
    expect(CM_TAX_ROUNDING.mode).toBe('HALF_UP');
    expect(CM_TAX_ROUNDING.source.reference.length).toBeGreaterThan(0);
  });

  it('always charges 19.25% rounded once, and never a negative surcharge', () => {
    for (let net = 0; net <= 3000; net += 1) {
      const [line] = calculate(request([[String(net), 'TVA_STD']])).lines;
      const [tva, cac] = line?.components ?? [];
      if (!line || !tva || !cac) throw new Error('missing result');
      const expected = Decimal.fromInteger(net)
        .times('0.1925')
        .round(0, 'HALF_UP');
      expect(line.tax.amount.equals(expected)).toBe(true);
      expect(tva.amount.plus(cac.amount).equals(line.tax)).toBe(true);
      expect(cac.amount.isNegative()).toBe(false);
      // The surcharge is within one franc of a true 10% of the VAT.
      const exact = Decimal.fromInteger(net).times('0.0175');
      expect(cac.amount.amount.minus(exact).abs().lessThan('1')).toBe(true);
    }
  });

  it('rounds each line, so two lines can differ from one line of the sum', () => {
    const separate = calculate(
      request([
        ['1000', 'TVA_STD'],
        ['1000', 'TVA_STD'],
      ]),
    );
    const together = calculate(request([['2000', 'TVA_STD']]));
    // 192.5 rounds to 193 twice; 385 is exact.
    expect(separate.totalTax.amount.toString()).toBe('386');
    expect(together.totalTax.amount.toString()).toBe('385');
  });

  it('mirrors an invoice exactly on a credit note', () => {
    for (const net of ['1000', '100', '999', '2600', '123456']) {
      const invoice = calculate(request([[net, 'TVA_STD']]));
      const credit = calculate(request([[`-${net}`, 'TVA_STD']]));
      expect(credit.totalTax.plus(invoice.totalTax).isZero()).toBe(true);
      expect(credit.totalGross.plus(invoice.totalGross).isZero()).toBe(true);
    }
  });

  it('rounds to the minor unit of the document currency', () => {
    const result = calculate({
      date: DATE,
      direction: 'sale',
      lines: [
        { id: 'usd', net: Money.of('100.00', 'USD'), taxCode: 'TVA_STD' },
      ],
    });
    expect(amounts(result)).toEqual([
      { tva: '17.5', cac: '1.75', tax: '19.25', gross: '119.25' },
    ]);
    expect(result.totalTax.currency).toBe('USD');
  });

  it('never returns a fraction of a franc', () => {
    const result = calculate(
      request([
        ['333.3333', 'TVA_STD'],
        ['0.5', 'TVA_STD'],
      ]),
    );
    for (const line of result.lines) {
      expect(line.tax.isInMinorUnits()).toBe(true);
      for (const item of line.components) {
        expect(item.amount.isInMinorUnits()).toBe(true);
      }
    }
    expect(result.totalTax.isInMinorUnits()).toBe(true);
  });
});

describe('Cameroon VAT: codes', () => {
  it('has the four codes, with the standard one as the default', () => {
    expect(engine.codes.map((code) => [code.code, code.treatment])).toEqual([
      ['TVA_STD', 'standard'],
      ['TVA_EXPORT', 'zero_rated'],
      ['TVA_EXEMPT', 'exempt'],
      ['TVA_OUT_OF_SCOPE', 'out_of_scope'],
    ]);
    expect(engine.defaultSaleCode).toBe('TVA_STD');
    expect(engine.defaultPurchaseCode).toBe('TVA_STD');
  });

  it.each(['TVA_EXPORT', 'TVA_EXEMPT', 'TVA_OUT_OF_SCOPE'])(
    '%s charges nothing',
    (code) => {
      const result = calculate(request([['250000', code]]));
      expect(result.totalTax.isZero()).toBe(true);
      expect(result.totalGross.amount.toString()).toBe('250000');
    },
  );

  it('reports a zero VAT component on an export, and none on an exempt sale', () => {
    const exported = calculate(request([['5000', 'TVA_EXPORT']]));
    expect(exported.lines[0]?.components).toEqual([
      { key: 'tva', rate: '0', amount: xaf('0'), role: 'vat.output' },
    ]);
    const exempt = calculate(request([['5000', 'TVA_EXEMPT']]));
    expect(exempt.lines[0]?.components).toEqual([]);
  });

  it('posts sales tax to VAT charged and purchase tax to VAT recoverable', () => {
    const roles = (direction: TaxRequest['direction']) =>
      calculate(
        request([['1000', 'TVA_STD']], { direction }),
      ).lines[0]?.components.map((item) => [item.key, item.role]);
    expect(roles('sale')).toEqual([
      ['tva', 'vat.output'],
      ['cac', 'vat.output'],
    ]);
    expect(roles('purchase')).toEqual([
      ['tva', 'vat.input'],
      ['cac', 'vat.input'],
    ]);
  });

  it('says VAT is due when an advance is received', () => {
    expect(engine.advances.taxDueOnReceipt).toBe(true);
  });
});

describe('Cameroon VAT: a whole document', () => {
  it('adds up a mixed invoice', () => {
    const result = calculate(
      request([
        ['10000', 'TVA_STD'],
        ['2600', 'TVA_STD'],
        ['5000', 'TVA_EXEMPT'],
        ['7500', 'TVA_EXPORT'],
      ]),
    );
    expect(result.lines.map((line) => line.id)).toEqual([
      'line-1',
      'line-2',
      'line-3',
      'line-4',
    ]);
    expect(result.totalNet.amount.toString()).toBe('25100');
    // 1925 + 501 + 0 + 0
    expect(result.totalTax.amount.toString()).toBe('2426');
    expect(result.totalGross.amount.toString()).toBe('27526');
  });

  it('gives zero totals for a document with no lines', () => {
    const result = calculate(request([]));
    expect(result.lines).toEqual([]);
    expect(result.totalNet.isZero()).toBe(true);
    expect(result.totalTax.isZero()).toBe(true);
    expect(result.totalGross.isZero()).toBe(true);
  });

  it('refuses an unknown code, even next to valid lines', () => {
    const result = engine.calculate(
      request([
        ['1000', 'TVA_STD'],
        ['1000', 'TVA_REDUCED'],
      ]),
    );
    expect(!result.ok && result.error.code).toBe(TAX_ERRORS.CODE_UNKNOWN);
  });

  it('refuses lines in different currencies', () => {
    const result = engine.calculate({
      date: DATE,
      direction: 'sale',
      lines: [
        { id: 'a', net: xaf('1000'), taxCode: 'TVA_STD' },
        { id: 'b', net: Money.of('10', 'EUR'), taxCode: 'TVA_STD' },
      ],
    });
    expect(!result.ok && result.error.code).toBe(TAX_ERRORS.CURRENCY_MIXED);
  });

  it('refuses a date that is not a date', () => {
    const result = engine.calculate(
      request([['1000', 'TVA_STD']], { date: '15/01/2026' }),
    );
    expect(!result.ok && result.error.code).toBe(RATE_ERRORS.DATE_INVALID);
  });

  it('does not need a rate for a code that has none', () => {
    // An exempt sale dated before the rate tables begin still calculates.
    const result = engine.calculate(
      request([['1000', 'TVA_EXEMPT']], { date: '1990-01-01' }),
    );
    expect(result.ok && result.value.totalTax.isZero()).toBe(true);
  });
});
