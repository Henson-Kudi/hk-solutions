import { PRODUCT_KEYS, features } from '@hk/contracts/product-manifest';
import {
  countryPackConformance,
  createPackRegistry,
  findPackIssues,
  findUnconfirmedValues,
  isProductOffered,
  isSystemRole,
  standardPostingRules,
  type PackConformanceSubject,
} from '@hk/country-packs/kernel';
import { AE_CHART, IFRS_STANDARD } from './chart';
import { aePack } from './pack';

// Invented numbers of the right shape. None is a real registration.
const subject: PackConformanceSubject = {
  pack: aePack,
  asOf: '2026-01-15',
  samples: {
    validTaxIds: ['100000000000003', '104999999999993'],
    invalidTaxIds: [
      '10000000000000',
      '1000000000000030',
      '10000000000000A',
      'TRN100000000000003',
    ],
  },
};

describe('ae pack conformance', () => {
  for (const testCase of countryPackConformance) {
    it(testCase.name, () => testCase.run(subject));
  }
});

describe('ae pack', () => {
  it('is well formed', () => {
    expect(findPackIssues(aePack)).toEqual([]);
  });

  it('registers as the UAE', () => {
    expect(createPackRegistry([aePack]).get('AE')).toBe(aePack);
  });

  it('keeps its books in AED, to two decimals', () => {
    expect(aePack.currencies).toEqual({
      functional: ['AED'],
      minorUnits: { AED: 2 },
    });
  });

  it('speaks English for now', () => {
    expect(aePack.locales).toEqual(['en-AE']);
  });

  it('starts the fiscal year in January and numbers invoices without gaps', () => {
    expect(aePack.fiscal.defaultYearStartMonth).toBe(1);
    expect(
      aePack.fiscal.legalNumbering.map((rule) => [
        rule.documentType,
        rule.gapFree,
      ]),
    ).toEqual([
      ['sales.invoice', true],
      ['sales.credit_note', true],
    ]);
  });

  it('takes cash, cards and bank transfers, and has no mobile money', () => {
    expect(aePack.payments.map((method) => [method.key, method.kind])).toEqual([
      ['cash', 'cash'],
      ['card', 'card'],
      ['bank_transfer', 'bank_transfer'],
    ]);
    expect(aePack.capabilities).not.toContain('payments.mobile_money');
  });

  it('offers every product except payroll, which waits for its engine', () => {
    expect(
      PRODUCT_KEYS.filter((key) => !isProductOffered(aePack, key)),
    ).toEqual(['payroll']);
    expect(aePack.payroll).toBeUndefined();
    expect(aePack.eInvoicing).toBeUndefined();
  });

  it('switches on the features its capabilities allow, and no others', () => {
    const context = {
      capabilities: aePack.capabilities,
      enabledProducts: [...PRODUCT_KEYS],
    };
    expect(features.isOn(context, 'tax.corporate_tax')).toBe(true);
    expect(features.isOn(context, 'payments.mobile_money')).toBe(false);
    expect(features.isOn(context, 'reports.syscohada')).toBe(false);
    expect(features.isOn(context, 'payroll.wps')).toBe(false);
    expect(features.isOn(context, 'einvoicing.fta')).toBe(false);
  });

  it('lists the VAT and Corporate Tax workpapers and the audit file', () => {
    expect(aePack.reports.map((report) => report.key)).toEqual([
      'ae.vat201',
      'ae.corporate_tax',
      'ae.audit_file',
    ]);
  });

  it('starts from the standard posting rules, with tax on advances', () => {
    expect(aePack.tax.advances.taxDueOnReceipt).toBe(true);
    expect(aePack.postingRules).toEqual(
      standardPostingRules({ taxOnAdvances: true }),
    );
  });

  it('has no value an adviser has confirmed yet', () => {
    // This is the honest state today. When values are confirmed, this test
    // changes to list what is still waiting, and at go-live to an empty list.
    expect(findUnconfirmedValues(aePack).map((item) => item.where)).toEqual([
      'numbering sales.invoice',
      'numbering sales.credit_note',
      'tax VAT_STD / vat from 2018-01-01',
      'tax VAT_ZERO / vat from 2018-01-01',
      'tax VAT_RC / vat from 2018-01-01',
      'tax rounding',
      'tax on advances',
    ]);
  });
});

describe('ae chart of accounts', () => {
  // The table an accountant reviews: which account holds each role.
  const EXPECTED_ROLES = {
    'cash.main': '1110',
    'bank.main': '1210',
    'ar.trade': '1310',
    supplier_advances: '1320',
    'inventory.goods': '1410',
    'vat.input': '1510',
    'vat.credit': '1520',
    'ap.trade': '2110',
    customer_advances: '2120',
    'vat.output': '2210',
    'vat.payable': '2220',
    'inter_branch.clearing': '2910',
    'equity.retained_earnings': '3400',
    'equity.current_year_result': '3500',
    'income.sales.goods': '4110',
    'income.sales.services': '4120',
    'income.sales.freight': '4130',
    'income.sales.rebates': '4190',
    'income.discounts_received': '4210',
    'income.other.forfeited_deposits': '4220',
    'fx.gain.trade': '4230',
    'fx.gain.financial': '4240',
    'expense.cogs': '5110',
    'expense.purchases.goods': '5120',
    'expense.purchases.freight': '5130',
    'expense.purchases.rebates': '5190',
    'expense.sales.transport': '5240',
    'rounding.difference': '5290',
    'expense.discounts_allowed': '5320',
    'fx.loss.trade': '5330',
    'fx.loss.financial': '5340',
  };

  it('has one template, a four-digit IFRS-style chart', () => {
    expect(AE_CHART.templates).toEqual([IFRS_STANDARD]);
    expect(IFRS_STANDARD.framework).toBe('IFRS');
    expect(IFRS_STANDARD.accounts).toHaveLength(68);
  });

  it('maps each role to its account', () => {
    const map = Object.fromEntries(
      IFRS_STANDARD.accounts
        .filter((account) => account.systemRole !== undefined)
        .map((account) => [account.systemRole, account.code]),
    );
    expect(map).toEqual(EXPECTED_ROLES);
  });

  it('uses only roles from the shared list', () => {
    for (const role of Object.keys(EXPECTED_ROLES)) {
      expect(isSystemRole(role)).toBe(true);
    }
  });

  it('puts each account in the class its first digit names', () => {
    const classes: Record<string, string> = {
      '1': 'ASSET',
      '2': 'LIABILITY',
      '3': 'EQUITY',
      '4': 'INCOME',
      '5': 'EXPENSE',
    };
    for (const account of IFRS_STANDARD.accounts) {
      expect(account.code).toMatch(/^[1-5]\d{3}$/);
      expect(account.type).toBe(classes[account.code.slice(0, 1)]);
      expect(account.frameworkClass).toBe(account.code.slice(0, 1));
    }
  });

  it('locks every account that holds a role', () => {
    for (const account of IFRS_STANDARD.accounts) {
      if (account.systemRole !== undefined) {
        expect(account.locked).toBe(true);
      }
    }
  });

  it('lets a branch add its own cash and bank accounts', () => {
    const policy = (code: string) =>
      IFRS_STANDARD.accounts.find((account) => account.code === code)
        ?.branchPolicy;
    expect(policy('1100')).toBe('BRANCH_EXTENDABLE');
    expect(policy('1200')).toBe('BRANCH_EXTENDABLE');
  });

  it('keeps equity and VAT accounts at business level', () => {
    for (const account of IFRS_STANDARD.accounts) {
      const isEquity = account.type === 'EQUITY';
      const isVat = account.subtype.startsWith('VAT_');
      if (isEquity || isVat) {
        expect(account.branchPolicy).toBe('HIDDEN_IN_BRANCHES');
      }
    }
  });

  it('has the UAE-specific accounts', () => {
    const names = Object.fromEntries(
      IFRS_STANDARD.accounts.map((account) => [account.code, account.name.en]),
    );
    expect(names['2120']).toBe('Customer advances');
    expect(names['2320']).toBe('WPS clearing');
    expect(names['2330']).toBe('End-of-service benefits provision');
    expect(names['2230']).toBe('Corporate tax payable');
  });

  it('requires, for each product, roles that exist, and holds no role nothing needs', () => {
    const held = new Set(Object.keys(EXPECTED_ROLES));
    const required = Object.values(AE_CHART.requiredRoles).flat();
    for (const role of required) {
      expect(held.has(role)).toBe(true);
    }
    expect([...held].filter((role) => !required.includes(role))).toEqual([]);
  });

  it('holds no mobile money role, because the country has no such method', () => {
    expect(Object.keys(EXPECTED_ROLES)).not.toContain('mobile_money.main');
  });
});
