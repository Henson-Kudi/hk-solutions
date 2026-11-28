import { PRODUCT_KEYS, features } from '@hk/contracts/product-manifest';
import {
  countryPackConformance,
  createPackRegistry,
  findPackIssues,
  findUnconfirmedValues,
  isProductOffered,
  isSystemRole,
  type ChartTemplate,
  type PackConformanceSubject,
} from '@hk/country-packs/kernel';
import { CM_CHART, SYSCOHADA_NORMAL, SYSCOHADA_SMT } from './chart';
import { cmPack } from './pack';
import { CM_POSTING_RULES } from './posting-rules';

// Invented numbers of the right shape. None is a real taxpayer.
const subject: PackConformanceSubject = {
  pack: cmPack,
  asOf: '2026-01-15',
  samples: {
    validTaxIds: ['M012345678901A', 'P098765432109Z'],
    invalidTaxIds: [
      'M01234567890A',
      'M0123456789012A',
      '0123456789012A',
      'M012345678901',
    ],
  },
};

const roleMap = (template: ChartTemplate): Record<string, string> =>
  Object.fromEntries(
    template.accounts
      .filter((account) => account.systemRole !== undefined)
      .map((account) => [account.systemRole, account.code]),
  );

describe('cm pack conformance', () => {
  for (const testCase of countryPackConformance) {
    it(testCase.name, () => testCase.run(subject));
  }
});

describe('cm pack', () => {
  it('is well formed', () => {
    expect(findPackIssues(cmPack)).toEqual([]);
  });

  it('registers as Cameroon', () => {
    expect(createPackRegistry([cmPack]).get('CM')).toBe(cmPack);
  });

  it('keeps its books in XAF, which has no minor unit', () => {
    expect(cmPack.currencies).toEqual({
      functional: ['XAF'],
      minorUnits: { XAF: 0 },
    });
  });

  it('speaks French and English, French first', () => {
    expect(cmPack.locales).toEqual(['fr-CM', 'en-CM']);
  });

  it('starts the fiscal year in January and numbers invoices without gaps', () => {
    expect(cmPack.fiscal.defaultYearStartMonth).toBe(1);
    expect(
      cmPack.fiscal.legalNumbering.map((rule) => [
        rule.documentType,
        rule.gapFree,
      ]),
    ).toEqual([
      ['sales.invoice', true],
      ['sales.credit_note', true],
    ]);
  });

  it('takes cash, MTN MoMo, Orange Money and cards', () => {
    expect(cmPack.payments.map((method) => [method.key, method.kind])).toEqual([
      ['cash', 'cash'],
      ['mtn_momo', 'mobile_money'],
      ['orange_money', 'mobile_money'],
      ['card', 'card'],
    ]);
  });

  it('offers every product except payroll, which waits for its engine', () => {
    expect(
      PRODUCT_KEYS.filter((key) => !isProductOffered(cmPack, key)),
    ).toEqual(['payroll']);
    expect(cmPack.payroll).toBeUndefined();
    expect(cmPack.capabilities).not.toContain('payroll.engine');
  });

  it('switches on the features its capabilities allow, and no others', () => {
    const context = {
      capabilities: cmPack.capabilities,
      enabledProducts: [...PRODUCT_KEYS],
    };
    expect(features.isOn(context, 'payments.mobile_money')).toBe(true);
    expect(features.isOn(context, 'reports.syscohada')).toBe(true);
    expect(features.isOn(context, 'payroll.wps')).toBe(false);
    expect(features.isOn(context, 'payroll.cnps')).toBe(false);
    expect(features.isOn(context, 'einvoicing.fta')).toBe(false);
  });

  it('lists the SYSCOHADA statements and the tax returns', () => {
    expect(cmPack.reports.map((report) => report.key)).toEqual([
      'syscohada.bilan',
      'syscohada.compte_de_resultat',
      'syscohada.tft',
      'syscohada.notes',
      'cm.vat_return',
      'cm.dsf',
    ]);
  });

  it('has no value an accountant has confirmed yet', () => {
    // This is the honest state today. When values are confirmed, this test
    // changes to list what is still waiting, and at go-live to an empty list.
    expect(findUnconfirmedValues(cmPack).map((item) => item.where)).toEqual([
      'numbering sales.invoice',
      'numbering sales.credit_note',
      'tax TVA_STD / tva from 2005-01-01',
      'tax TVA_STD / cac from 2005-01-01',
      'tax TVA_EXPORT / tva from 2005-01-01',
      'tax rounding',
      'tax on advances',
    ]);
  });
});

describe('cm chart of accounts', () => {
  // The table an accountant reviews: which account holds each role.
  const EXPECTED_ROLES = {
    'equity.retained_earnings': '121',
    'equity.current_year_result': '131',
    'inter_branch.clearing': '185',
    'inventory.goods': '311',
    'ap.trade': '401',
    supplier_advances: '4091',
    'ar.trade': '411',
    customer_advances: '4191',
    'vat.output': '4431',
    'vat.payable': '4441',
    'vat.credit': '4449',
    'vat.input': '4452',
    'bank.main': '521',
    'mobile_money.main': '552',
    'cash.main': '571',
    'expense.purchases.goods': '601',
    'expense.cogs': '6031',
    'rounding.difference': '658',
    'expense.discounts_allowed': '673',
    'fx.loss': '676',
    'income.sales.goods': '701',
    'income.sales.services': '706',
    'income.other.forfeited_deposits': '758',
    'income.discounts_received': '773',
    'fx.gain': '776',
  };

  it('offers the normal system first, then SMT', () => {
    expect(CM_CHART.templates.map((template) => template.key)).toEqual([
      'syscohada.normal',
      'syscohada.smt',
    ]);
  });

  it.each([SYSCOHADA_NORMAL, SYSCOHADA_SMT])(
    '$key maps each role to its SYSCOHADA account',
    (template) => {
      expect(roleMap(template)).toEqual(EXPECTED_ROLES);
    },
  );

  it('uses only roles from the shared list', () => {
    for (const role of Object.keys(EXPECTED_ROLES)) {
      expect(isSystemRole(role)).toBe(true);
    }
  });

  it('makes SMT a shorter list drawn from the normal chart', () => {
    const normal = new Map(
      SYSCOHADA_NORMAL.accounts.map((account) => [account.code, account]),
    );
    expect(SYSCOHADA_SMT.accounts.length).toBeLessThan(
      SYSCOHADA_NORMAL.accounts.length,
    );
    for (const account of SYSCOHADA_SMT.accounts) {
      expect(normal.get(account.code)).toBe(account);
    }
    expect(SYSCOHADA_NORMAL.accounts).toHaveLength(85);
    expect(SYSCOHADA_SMT.accounts).toHaveLength(59);
  });

  it.each([SYSCOHADA_NORMAL, SYSCOHADA_SMT])(
    '$key puts every account in the class its code starts with',
    (template) => {
      for (const account of template.accounts) {
        expect(account.frameworkClass).toBe(account.code.slice(0, 1));
        expect(account.code).toMatch(/^[1-8]\d+$/);
      }
    },
  );

  it.each([SYSCOHADA_NORMAL, SYSCOHADA_SMT])(
    '$key gives each class the account types SYSCOHADA puts there',
    (template) => {
      const allowed: Record<string, string[]> = {
        '1': ['EQUITY', 'LIABILITY'],
        '2': ['ASSET'],
        '3': ['ASSET'],
        '4': ['ASSET', 'LIABILITY'],
        '5': ['ASSET'],
        '6': ['EXPENSE'],
        '7': ['INCOME'],
        '8': ['EXPENSE', 'INCOME'],
      };
      for (const account of template.accounts) {
        expect(allowed[account.code.slice(0, 1)]).toContain(account.type);
      }
    },
  );

  it('locks every account that holds a role', () => {
    for (const account of SYSCOHADA_NORMAL.accounts) {
      if (account.systemRole !== undefined) {
        expect(account.locked).toBe(true);
      }
    }
  });

  it('lets a branch add its own cash, bank and mobile money accounts', () => {
    const policy = (code: string) =>
      SYSCOHADA_NORMAL.accounts.find((account) => account.code === code)
        ?.branchPolicy;
    expect(policy('52')).toBe('BRANCH_EXTENDABLE');
    expect(policy('55')).toBe('BRANCH_EXTENDABLE');
    expect(policy('57')).toBe('BRANCH_EXTENDABLE');
  });

  it('keeps equity and tax accounts at business level', () => {
    for (const account of SYSCOHADA_NORMAL.accounts) {
      const isEquity = account.type === 'EQUITY';
      const isVat = account.subtype.startsWith('VAT_');
      if (isEquity || isVat) {
        expect(account.branchPolicy).toBe('HIDDEN_IN_BRANCHES');
      }
    }
  });

  it('requires, for each product, roles that exist', () => {
    const held = new Set(Object.keys(EXPECTED_ROLES));
    const required = Object.values(CM_CHART.requiredRoles).flat();
    expect(required.length).toBeGreaterThan(0);
    for (const role of required) {
      expect(held.has(role)).toBe(true);
    }
    // Every role some account holds is required by something: no dead roles.
    expect([...held].filter((role) => !required.includes(role))).toEqual([]);
  });
});

describe('cm posting rules', () => {
  const journal = (eventType: string) =>
    CM_POSTING_RULES.rules
      .filter((rule) => rule.eventType === eventType)
      .map((rule) => `${rule.side} ${rule.role} (${rule.lineKind})`);

  it('posts a sales invoice: receivable against revenue and VAT', () => {
    expect(journal('sales.invoice.issued')).toEqual([
      'debit ar.trade (line.receivable)',
      'credit income.sales.goods (line.revenue.goods)',
      'credit income.sales.services (line.revenue.services)',
      'credit vat.output (line.tax)',
      'debit customer_advances (line.advance_applied)',
      'credit ar.trade (line.advance_settled)',
    ]);
  });

  it('posts a pre-order payment to customer advances, with VAT due on receipt', () => {
    expect(journal('sales.preorder.payment_received')).toEqual([
      'credit customer_advances (line.advance)',
      'debit customer_advances (line.advance_tax)',
      'credit vat.output (line.tax)',
    ]);
  });

  it('posts a forfeited deposit to other income', () => {
    expect(journal('sales.preorder.forfeited')).toEqual([
      'debit customer_advances (line.advance)',
      'credit income.other.forfeited_deposits (line.forfeit)',
    ]);
  });

  it('posts a supplier bill: purchases and recoverable VAT against the payable', () => {
    expect(journal('purchases.bill.recorded')).toEqual([
      'debit expense.purchases.goods (line.purchase.goods)',
      'debit vat.input (line.tax)',
      'credit ap.trade (line.payable)',
    ]);
  });

  it('carries the branch on every line', () => {
    for (const rule of CM_POSTING_RULES.rules) {
      expect(rule.dimensions).toContain('branch');
    }
  });
});
