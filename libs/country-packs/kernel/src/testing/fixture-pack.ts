import type { ProductManifest } from '@hk/contracts/product-manifest';
import {
  DomainError,
  Money,
  err,
  localizedText,
  ok,
  type Result,
} from '@hk/platform/universal';
import {
  TAX_ERRORS,
  type CountryPack,
  type TaxCalculation,
  type TaxCodeDef,
  type TaxLineResult,
  type TaxRequest,
} from '../lib/country-pack';
import { createRateTable, type SourceNote } from '../lib/effective-dated';
import type { PackConformanceSubject } from '../lib/conformance';

/**
 * A pack for the kernel's own tests.
 *
 * EVERY VALUE HERE IS INVENTED. The rates, accounts and ID format describe no
 * real country. The pack borrows a registered country code only because a
 * pack must have one.
 */

const source: SourceNote = {
  reference: 'Invented for tests',
  confirmedBy: 'kernel tests',
  confirmedOn: '2020-01-01',
};

const text = (value: string) => localizedText(value, `${value} (fr)`);

export const FIXTURE_AS_OF = '2026-01-15';

export const fixtureCodes = (): TaxCodeDef[] => [
  {
    code: 'STD',
    name: text('Standard'),
    treatment: 'standard',
    components: [
      {
        key: 'vat',
        name: text('VAT'),
        rate: createRateTable('fixture.std.vat', [
          {
            effectiveFrom: '2010-01-01',
            effectiveTo: '2019-12-31',
            value: '0.08',
            source,
          },
          { effectiveFrom: '2020-01-01', value: '0.10', source },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'DUO',
    name: text('Standard with surcharge'),
    treatment: 'standard',
    components: [
      {
        key: 'vat',
        name: text('VAT'),
        rate: createRateTable('fixture.duo.vat', [
          { effectiveFrom: '2010-01-01', value: '0.10', source },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
      {
        key: 'surcharge',
        name: text('Surcharge'),
        rate: createRateTable('fixture.duo.surcharge', [
          { effectiveFrom: '2010-01-01', value: '0.015', source },
        ]),
        outputRole: 'vat.payable',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'ZERO',
    name: text('Zero rated'),
    treatment: 'zero_rated',
    components: [
      {
        key: 'vat',
        name: text('VAT'),
        rate: createRateTable('fixture.zero.vat', [
          { effectiveFrom: '2010-01-01', value: '0', source },
        ]),
        outputRole: 'vat.output',
        inputRole: 'vat.input',
      },
    ],
  },
  {
    code: 'EXEMPT',
    name: text('Exempt'),
    treatment: 'exempt',
    components: [],
  },
];

/** A straightforward engine: each component is a share of the net, rounded per line. */
export const fixtureCalculate =
  (codes: readonly TaxCodeDef[]) =>
  (request: TaxRequest): Result<TaxCalculation> => {
    const [first] = request.lines;
    const currency = first?.net.currency ?? 'XAF';
    if (request.lines.some((line) => line.net.currency !== currency)) {
      return err(
        new DomainError(
          TAX_ERRORS.CURRENCY_MIXED,
          'All lines must be in one currency.',
        ),
      );
    }
    const lines: TaxLineResult[] = [];
    for (const line of request.lines) {
      const code = codes.find((candidate) => candidate.code === line.taxCode);
      if (!code) {
        return err(
          new DomainError(TAX_ERRORS.CODE_UNKNOWN, 'Unknown tax code.'),
        );
      }
      const components = [];
      for (const component of code.components) {
        const rate = component.rate.valueAt(request.date);
        if (!rate.ok) return rate;
        components.push({
          key: component.key,
          rate: rate.value,
          amount: line.net.times(rate.value).roundToMinorUnit('HALF_UP'),
          role:
            request.direction === 'sale'
              ? component.outputRole
              : component.inputRole,
        });
      }
      const tax = Money.sum(
        currency,
        components.map((component) => component.amount),
      );
      lines.push({
        id: line.id,
        taxCode: line.taxCode,
        net: line.net,
        components,
        tax,
        gross: line.net.plus(tax),
      });
    }
    return ok({
      lines,
      totalNet: Money.sum(
        currency,
        lines.map((line) => line.net),
      ),
      totalTax: Money.sum(
        currency,
        lines.map((line) => line.tax),
      ),
      totalGross: Money.sum(
        currency,
        lines.map((line) => line.gross),
      ),
    });
  };

const TAX_ID = /^FX\d{6}$/;

export const fixtureTaxIdValidator = (value: string): Result<string> => {
  const canonical = typeof value === 'string' ? value.trim() : '';
  return TAX_ID.test(canonical)
    ? ok(canonical)
    : err(
        new DomainError(
          'TAX_ID_INVALID',
          'The tax registration number is not in the expected format.',
        ),
      );
};

/** A new pack each call, so a test can change its copy freely. */
export const createFixturePack = (): CountryPack => {
  const codes = fixtureCodes();
  return {
    code: 'CM',
    name: text('Fixture country'),
    currencies: { functional: ['XAF'], minorUnits: { XAF: 0 } },
    locales: ['fr-CM', 'en-CM'],
    fiscal: {
      defaultYearStartMonth: 1,
      legalNumbering: [
        {
          documentType: 'sales.invoice',
          gapFree: true,
          resets: 'fiscal_year',
          source,
        },
      ],
    },
    business: {
      legalForms: [
        { key: 'sole_trader', name: text('Sole trader') },
        { key: 'company', name: text('Company') },
      ],
      registrationFields: [
        {
          key: 'tax_id',
          label: text('Tax id'),
          required: true,
          kind: 'text',
          sensitive: true,
          validate: fixtureTaxIdValidator,
        },
        {
          key: 'region',
          label: text('Region'),
          required: false,
          kind: 'select',
          options: [
            { key: 'north', label: text('North') },
            { key: 'south', label: text('South') },
          ],
        },
      ],
      taxIdValidator: fixtureTaxIdValidator,
    },
    chart: {
      codePattern: /^[1-9]\d+$/,
      requiredRoles: {
        core: ['ar.trade', 'cash.main'],
        sales: ['income.sales.goods', 'vat.output'],
      },
      templates: [
        {
          key: 'fixture.standard',
          name: text('Fixture chart'),
          framework: 'FIXTURE',
          accounts: [
            {
              code: '41',
              name: text('Receivables'),
              type: 'ASSET',
              subtype: 'AR',
            },
            {
              code: '411',
              name: text('Trade receivables'),
              type: 'ASSET',
              subtype: 'AR',
              parentCode: '41',
              systemRole: 'ar.trade',
              locked: true,
            },
            {
              code: '44',
              name: text('Tax payable'),
              type: 'LIABILITY',
              subtype: 'TAX',
              branchPolicy: 'HIDDEN_IN_BRANCHES',
            },
            {
              code: '4431',
              name: text('VAT collected'),
              type: 'LIABILITY',
              subtype: 'VAT_OUTPUT',
              parentCode: '44',
              systemRole: 'vat.output',
            },
            {
              code: '4432',
              name: text('Surcharge collected'),
              type: 'LIABILITY',
              subtype: 'VAT_OUTPUT',
              parentCode: '44',
              systemRole: 'vat.payable',
            },
            {
              code: '445',
              name: text('VAT recoverable'),
              type: 'ASSET',
              subtype: 'VAT_INPUT',
              systemRole: 'vat.input',
            },
            {
              code: '57',
              name: text('Cash'),
              type: 'ASSET',
              subtype: 'CASH',
              systemRole: 'cash.main',
              branchPolicy: 'BRANCH_EXTENDABLE',
              currency: 'XAF',
            },
            {
              code: '70',
              name: text('Sales'),
              type: 'INCOME',
              subtype: 'SALES',
              systemRole: 'income.sales.goods',
            },
          ],
        },
      ],
    },
    postingRules: {
      rules: [
        {
          eventType: 'sales.invoice.issued',
          lineKind: 'line.receivable',
          role: 'ar.trade',
          side: 'debit',
          dimensions: ['branch', 'contact'],
        },
        {
          eventType: 'sales.invoice.issued',
          lineKind: 'line.revenue',
          role: 'income.sales.goods',
          side: 'credit',
          dimensions: ['branch', 'project'],
        },
        {
          eventType: 'sales.invoice.issued',
          lineKind: 'line.tax',
          role: 'vat.output',
          side: 'credit',
        },
      ],
    },
    tax: {
      codes,
      defaultSaleCode: 'STD',
      defaultPurchaseCode: 'STD',
      notLiableCode: 'EXEMPT',
      // Invented rule: a business in the north region is liable.
      isLiable: (registration) => registration['region'] === 'north',
      rounding: { level: 'line', mode: 'HALF_UP', source },
      advances: { taxDueOnReceipt: true, source },
      calculate: fixtureCalculate(codes),
    },
    reports: [
      {
        key: 'fixture.vat_return',
        name: text('VAT return'),
        kind: 'tax_return',
      },
    ],
    payments: [
      { key: 'cash', name: text('Cash'), kind: 'cash' },
      { key: 'momo', name: text('Mobile money'), kind: 'mobile_money' },
    ],
    capabilities: ['payments.mobile_money'],
    products: {
      accounting: 'AVAILABLE',
      sales: 'AVAILABLE',
      inventory: 'BETA',
      pos: 'AVAILABLE',
      payroll: 'UNAVAILABLE',
    },
  };
};

export const createFixtureSubject = (
  pack: CountryPack = createFixturePack(),
): PackConformanceSubject => ({
  pack,
  asOf: FIXTURE_AS_OF,
  samples: {
    validTaxIds: ['FX123456', 'FX000001'],
    invalidTaxIds: ['FX12345', 'AB123456', 'FX1234567', 'FX12 3456'],
  },
});

export const fixtureManifest = (
  overrides: Partial<ProductManifest> = {},
): ProductManifest => ({
  key: 'sales',
  displayName: text('Sales'),
  requiresProducts: [],
  requiresCapabilities: [],
  optionalCapabilities: [],
  coreScopes: [],
  publicRoutes: ['/sales'],
  consumes: [],
  produces: ['sales.invoice.issued'],
  permissions: [],
  schema: 'sales',
  requiredSystemRoles: ['income.sales.goods', 'vat.output'],
  meters: [],
  ...overrides,
});
