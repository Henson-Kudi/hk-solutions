import { FEATURES, PRODUCT_KEYS } from '@hk/contracts/product-manifest';
import { localizedText } from '@hk/platform/universal';
import { createFixturePack, fixtureManifest } from '../testing/fixture-pack';
import { brokenPack, pick, type Draft } from '../testing/mutate';
import { CAPABILITY_KEYS, isCapabilityKey } from './capabilities';
import { COUNTRY_CODES, isCountryCode } from './country';
import {
  hasCapability,
  isProductOffered,
  productAvailability,
} from './country-pack';
import { createRateTable, type SourceNote } from './effective-dated';
import { SYSTEM_ROLES, isSystemRole } from './system-roles';
import {
  PACK_AREAS,
  findPackIssues,
  findPackManifestIssues,
  findUnconfirmedValues,
  type PackArea,
} from './validation';

const text = (value: string) => localizedText(value, `${value} (fr)`);
const noText = { en: 'Only English', fr: '' };
const unconfirmed: SourceNote = { reference: 'Invented for tests' };
const confirmed: SourceNote = {
  reference: 'Invented for tests',
  confirmedBy: 'kernel tests',
  confirmedOn: '2020-01-01',
};

const template = (draft: Draft) => pick(draft.chart.templates, 0);
const account = (draft: Draft, code: string) => {
  const found = template(draft).accounts.find((item) => item.code === code);
  if (!found) throw new Error(`fixture has no account ${code}`);
  return found;
};
const taxCode = (draft: Draft, code: string) => {
  const found = draft.tax.codes.find((item) => item.code === code);
  if (!found) throw new Error(`fixture has no tax code ${code}`);
  return found;
};

describe('country codes and capability keys', () => {
  it('knows the registered countries', () => {
    expect(COUNTRY_CODES).toEqual(['CM', 'AE']);
    expect(isCountryCode('CM')).toBe(true);
    expect(isCountryCode('cm')).toBe(false);
    expect(isCountryCode('FR')).toBe(false);
    expect(isCountryCode(undefined)).toBe(false);
  });

  it('has no capability twice, and each is a dotted name', () => {
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
    for (const key of CAPABILITY_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
    expect(isCapabilityKey('payroll.wps')).toBe(true);
    expect(isCapabilityKey('payroll.unknown')).toBe(false);
  });

  // contracts cannot import the kernel, so it holds capability names as
  // strings. This is the check that those strings are real capabilities.
  it('covers every capability a feature flag in contracts depends on', () => {
    const unknown = Object.values(FEATURES)
      .map((feature) => feature.capability)
      .filter((capability) => !isCapabilityKey(capability));
    expect(unknown).toEqual([]);
  });
});

describe('system roles', () => {
  it('are dotted names, each with a description', () => {
    for (const [role, description] of Object.entries(SYSTEM_ROLES)) {
      expect(role).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
      expect(description.trim().length).toBeGreaterThan(0);
    }
  });

  it('recognises a registered role and nothing else', () => {
    expect(isSystemRole('ar.trade')).toBe(true);
    expect(isSystemRole('customer_advances')).toBe(true);
    expect(isSystemRole('ar.other')).toBe(false);
    expect(isSystemRole('toString')).toBe(false);
    expect(isSystemRole(undefined)).toBe(false);
  });
});

describe('product availability', () => {
  const pack = createFixturePack();

  it('treats a product the pack does not mention as unavailable', () => {
    expect(productAvailability(pack, 'sales')).toBe('AVAILABLE');
    expect(productAvailability(pack, 'inventory')).toBe('BETA');
    expect(productAvailability(pack, 'payroll')).toBe('UNAVAILABLE');
    expect(productAvailability(pack, 'crm')).toBe('UNAVAILABLE');
  });

  it('offers AVAILABLE and BETA products only', () => {
    expect(PRODUCT_KEYS.filter((key) => isProductOffered(pack, key))).toEqual([
      'accounting',
      'sales',
      'inventory',
      'pos',
    ]);
  });

  it('answers whether the country has a capability', () => {
    expect(hasCapability(pack, 'payments.mobile_money')).toBe(true);
    expect(hasCapability(pack, 'payroll.wps')).toBe(false);
  });
});

describe('findPackIssues', () => {
  it('finds nothing wrong with the fixture pack', () => {
    expect(findPackIssues(createFixturePack())).toEqual([]);
  });

  it.each<[string, (draft: Draft) => void, PackArea, string]>([
    // identity
    [
      'an unregistered country',
      (d) => {
        (d as { code: string }).code = 'ZZ';
      },
      'identity',
      '"ZZ" is not a registered country',
    ],
    [
      'a name missing a language',
      (d) => {
        d.name = noText;
      },
      'identity',
      'name needs non-empty',
    ],
    // currencies
    [
      'no functional currency',
      (d) => {
        d.currencies = { functional: [], minorUnits: {} };
      },
      'currencies',
      'needs at least one functional currency',
    ],
    [
      'a malformed currency code',
      (d) => {
        d.currencies = { functional: ['xaf'], minorUnits: { xaf: 0 } };
      },
      'currencies',
      '"xaf" is not a currency code',
    ],
    [
      'minor units that disagree with ISO 4217',
      (d) => {
        d.currencies.minorUnits = { XAF: 2 };
      },
      'currencies',
      'minorUnits for XAF is 2, but ISO 4217 says 0',
    ],
    [
      'minor units missing for a currency',
      (d) => {
        d.currencies.minorUnits = {};
      },
      'currencies',
      'minorUnits has no entry for XAF',
    ],
    [
      'minor units for a currency that is not used',
      (d) => {
        d.currencies.minorUnits = { XAF: 0, AED: 2 };
      },
      'currencies',
      'minorUnits lists AED, which is not used',
    ],
    [
      'a currency listed twice',
      (d) => {
        d.currencies.functional = ['XAF', 'XAF'];
      },
      'currencies',
      '"XAF" is listed twice',
    ],
    // locales
    [
      'no locale',
      (d) => {
        d.locales = [];
      },
      'locales',
      'needs at least one locale',
    ],
    [
      "another country's locale",
      (d) => {
        d.locales = ['en-AE'];
      },
      'locales',
      '"en-AE" must be a supported language and this country',
    ],
    [
      'a language the app does not have',
      (d) => {
        d.locales = ['de-CM'];
      },
      'locales',
      '"de-CM" must be a supported language',
    ],
    [
      'a bare language',
      (d) => {
        d.locales = ['fr'];
      },
      'locales',
      '"fr" must be a supported language',
    ],
    // fiscal
    [
      'a month that does not exist',
      (d) => {
        d.fiscal.defaultYearStartMonth = 13;
      },
      'fiscal',
      'defaultYearStartMonth must be 1 to 12',
    ],
    [
      'a fractional month',
      (d) => {
        d.fiscal.defaultYearStartMonth = 1.5;
      },
      'fiscal',
      'defaultYearStartMonth must be 1 to 12',
    ],
    [
      'a numbering rule listed twice',
      (d) => {
        d.fiscal.legalNumbering.push(pick(d.fiscal.legalNumbering, 0));
      },
      'fiscal',
      'numbering rule for "sales.invoice" is listed twice',
    ],
    [
      'a numbering rule without a source',
      (d) => {
        pick(d.fiscal.legalNumbering, 0).source = { reference: '' };
      },
      'fiscal',
      'numbering rule sales.invoice: source note has no reference',
    ],
    // business
    [
      'no legal form',
      (d) => {
        d.business.legalForms = [];
      },
      'business',
      'needs at least one legal form',
    ],
    [
      'a legal form key in the wrong shape',
      (d) => {
        pick(d.business.legalForms, 0).key = 'Sole Trader';
      },
      'business',
      'legal form "Sole Trader" is not a valid key',
    ],
    [
      'a legal form missing a language',
      (d) => {
        pick(d.business.legalForms, 0).name = noText;
      },
      'business',
      'legal form "sole_trader" needs "en" and "fr" names',
    ],
    [
      'a registration field listed twice',
      (d) => {
        d.business.registrationFields.push(
          pick(d.business.registrationFields, 0),
        );
      },
      'business',
      'registration field "tax_id" is listed twice',
    ],
    [
      'a select field without options',
      (d) => {
        pick(d.business.registrationFields, 1).options = [];
      },
      'business',
      'registration field "region" is a select with no options',
    ],
    [
      'a text field with options',
      (d) => {
        pick(d.business.registrationFields, 0).options = [
          { key: 'a', label: text('A') },
        ];
      },
      'business',
      'registration field "tax_id" is a text field and cannot have options',
    ],
    [
      'a missing tax id validator',
      (d) => {
        (d.business as { taxIdValidator?: unknown }).taxIdValidator = undefined;
      },
      'business',
      'taxIdValidator is missing',
    ],
    // chart
    [
      'no chart template',
      (d) => {
        d.chart.templates = [];
      },
      'chart',
      'needs at least one chart template',
    ],
    [
      'a template with no accounts',
      (d) => {
        template(d).accounts = [];
      },
      'chart',
      'template "fixture.standard" has no accounts',
    ],
    [
      'an account code used twice',
      (d) => {
        account(d, '70').code = '57';
      },
      'chart',
      'account code "57" is used twice',
    ],
    [
      'a code that breaks the pack pattern',
      (d) => {
        account(d, '70').code = '07';
      },
      'chart',
      'account "07": code does not match the pack\'s pattern',
    ],
    [
      'an account type that does not exist',
      (d) => {
        (account(d, '70') as { type: string }).type = 'REVENUE';
      },
      'chart',
      'account "70": type is not valid',
    ],
    [
      'a parent that is not in the template',
      (d) => {
        account(d, '411').parentCode = '49';
      },
      'chart',
      'account "411": parent "49" not found',
    ],
    [
      'an account that is its own parent',
      (d) => {
        account(d, '70').parentCode = '70';
      },
      'chart',
      'account "70": parent "70" not found',
    ],
    [
      'a child whose type differs from its parent',
      (d) => {
        account(d, '411').type = 'LIABILITY';
      },
      'chart',
      'account "411": type differs from its parent\'s',
    ],
    [
      'parents that form a loop',
      (d) => {
        account(d, '41').parentCode = '411';
      },
      'chart',
      'its parents form a loop or are too deep',
    ],
    [
      'a role on two accounts',
      (d) => {
        account(d, '70').systemRole = 'cash.main';
      },
      'chart',
      'role "cash.main" is on more than one account',
    ],
    [
      'a role on an account that has sub-accounts',
      (d) => {
        account(d, '44').systemRole = 'tax.control';
      },
      'chart',
      'account "44" holds a role but has sub-accounts',
    ],
    [
      'a role that is not in the shared list',
      (d) => {
        account(d, '57').systemRole = 'cash.petty';
      },
      'chart',
      'account "57": "cash.petty" is not a registered system role',
    ],
    [
      'a branch policy that does not exist',
      (d) => {
        (account(d, '57') as { branchPolicy: string }).branchPolicy = 'SHARED';
      },
      'chart',
      'account "57": branchPolicy is not valid',
    ],
    [
      'a required role that no account holds',
      (d) => {
        d.chart.requiredRoles = { core: ['ar.trade', 'ap.trade'] };
      },
      'chart',
      'requiredRoles.core: no account holds "ap.trade" in every template',
    ],
    [
      'a role held in one template but not in another',
      (d) => {
        d.chart.templates.push({
          ...template(d),
          key: 'fixture.small',
          accounts: template(d).accounts.filter((item) => item.code !== '70'),
        });
      },
      'chart',
      'requiredRoles.sales: no account holds "income.sales.goods" in every template',
    ],
    [
      'required roles for something that is not a product',
      (d) => {
        (d.chart.requiredRoles as Record<string, string[]>)['billing'] = [];
      },
      'chart',
      'requiredRoles names "billing", which is not a product',
    ],
    [
      'no core roles',
      (d) => {
        d.chart.requiredRoles = { sales: ['income.sales.goods'] };
      },
      'chart',
      'requiredRoles.core is empty',
    ],
    // posting rules
    [
      'no posting rule',
      (d) => {
        d.postingRules.rules = [];
      },
      'postingRules',
      'needs at least one rule',
    ],
    [
      'a rule listed twice',
      (d) => {
        d.postingRules.rules.push(pick(d.postingRules.rules, 0));
      },
      'postingRules',
      'is listed twice',
    ],
    [
      'a rule for a role no account holds',
      (d) => {
        pick(d.postingRules.rules, 1).role = 'income.services';
      },
      'postingRules',
      'no account holds "income.services" in every template',
    ],
    [
      'a rule whose event is not a topic',
      (d) => {
        pick(d.postingRules.rules, 0).eventType = 'invoice';
      },
      'postingRules',
      'eventType is not a topic',
    ],
    [
      'a rule with a side that does not exist',
      (d) => {
        (pick(d.postingRules.rules, 0) as { side: string }).side = 'left';
      },
      'postingRules',
      'side must be debit or credit',
    ],
    [
      'a rule with an unknown dimension',
      (d) => {
        (pick(d.postingRules.rules, 0) as { dimensions: string[] }).dimensions =
          ['region'];
      },
      'postingRules',
      '"region" is unknown',
    ],
    // tax
    [
      'no tax code',
      (d) => {
        d.tax.codes = [];
      },
      'tax',
      'needs at least one tax code',
    ],
    [
      'a tax code in the wrong shape',
      (d) => {
        taxCode(d, 'EXEMPT').code = 'exempt';
      },
      'tax',
      'tax code "exempt" is not a valid key',
    ],
    [
      'a tax code listed twice',
      (d) => {
        d.tax.codes.push(taxCode(d, 'EXEMPT'));
      },
      'tax',
      'tax code "EXEMPT" is listed twice',
    ],
    [
      'an exempt code with a rate',
      (d) => {
        taxCode(d, 'EXEMPT').components = taxCode(d, 'STD').components;
      },
      'tax',
      'tax code EXEMPT: an exempt code has no components',
    ],
    [
      'a standard code with no component',
      (d) => {
        taxCode(d, 'STD').components = [];
      },
      'tax',
      'tax code STD needs at least one component',
    ],
    [
      'a zero-rated code with a rate above zero',
      (d) => {
        taxCode(d, 'ZERO').components = taxCode(d, 'STD').components;
      },
      'tax',
      'a zero-rated code has a rate of "0"',
    ],
    [
      'a rate written as a percentage',
      (d) => {
        pick(taxCode(d, 'STD').components, 0).rate = createRateTable('pct', [
          { effectiveFrom: '2010-01-01', value: '10', source: confirmed },
        ]);
      },
      'tax',
      'a rate must be a decimal string from "0" to "1"',
    ],
    [
      'a negative rate',
      (d) => {
        pick(taxCode(d, 'STD').components, 0).rate = createRateTable('neg', [
          { effectiveFrom: '2010-01-01', value: '-0.05', source: confirmed },
        ]);
      },
      'tax',
      'a rate must be a decimal string from "0" to "1"',
    ],
    [
      'a rate that is a JS number',
      (d) => {
        pick(taxCode(d, 'STD').components, 0).rate = createRateTable('num', [
          {
            effectiveFrom: '2010-01-01',
            value: 0.1 as unknown as string,
            source: confirmed,
          },
        ]);
      },
      'tax',
      'a rate must be a decimal string from "0" to "1"',
    ],
    [
      'a component posting to a role no account holds',
      (d) => {
        pick(taxCode(d, 'STD').components, 0).outputRole = 'vat.output.other';
      },
      'tax',
      'no account holds "vat.output.other" in every template',
    ],
    [
      'a component with no role at all',
      (d) => {
        const component = pick(taxCode(d, 'STD').components, 0);
        component.outputRole = undefined;
        component.inputRole = undefined;
      },
      'tax',
      'has neither an output nor an input role',
    ],
    [
      'two components with the same key',
      (d) => {
        pick(taxCode(d, 'DUO').components, 1).key = 'vat';
      },
      'tax',
      'tax code DUO component "vat" is listed twice',
    ],
    [
      'a default sale code that does not exist',
      (d) => {
        d.tax.defaultSaleCode = 'VAT';
      },
      'tax',
      'defaultSaleCode is not one of the codes',
    ],
    [
      'a default purchase code that does not exist',
      (d) => {
        d.tax.defaultPurchaseCode = 'VAT';
      },
      'tax',
      'defaultPurchaseCode is not one of the codes',
    ],
    [
      'a not-liable code that does not exist',
      (d) => {
        d.tax.notLiableCode = 'NONE';
      },
      'tax',
      'notLiableCode is not one of the codes',
    ],
    [
      'a not-liable code that charges tax',
      (d) => {
        d.tax.notLiableCode = 'STD';
      },
      'tax',
      'notLiableCode must be an out-of-scope or exempt code',
    ],
    [
      'no rule for who is liable',
      (d) => {
        (d.tax as { isLiable?: unknown }).isLiable = undefined;
      },
      'tax',
      'isLiable is missing',
    ],
    [
      'a rounding mode that does not exist',
      (d) => {
        (d.tax.rounding as { mode: string }).mode = 'NEAREST';
      },
      'tax',
      'rounding.mode is not valid',
    ],
    [
      'a rounding rule without a source',
      (d) => {
        d.tax.rounding.source = { reference: '' };
      },
      'tax',
      'rounding: source note has no reference',
    ],
    [
      'an advance rule without a source',
      (d) => {
        d.tax.advances.source = { reference: '' };
      },
      'tax',
      'advances: source note has no reference',
    ],
    // capabilities
    [
      'a capability that is not registered',
      (d) => {
        (d.capabilities as string[]).push('payments.barter');
      },
      'capabilities',
      '"payments.barter" is not a capability key',
    ],
    [
      'a capability listed twice',
      (d) => {
        d.capabilities.push('payments.mobile_money');
      },
      'capabilities',
      '"payments.mobile_money" is listed twice',
    ],
    [
      'the payroll capability without a payroll engine',
      (d) => {
        d.capabilities.push('payroll.engine');
      },
      'capabilities',
      'payroll.engine is listed exactly when the pack has a payroll engine',
    ],
    [
      'a payroll engine without the payroll capability',
      (d) => {
        d.payroll = { key: 'fixture.payroll' };
      },
      'capabilities',
      'payroll.engine is listed exactly when the pack has a payroll engine',
    ],
    // reports
    [
      'a report listed twice',
      (d) => {
        d.reports.push(pick(d.reports, 0));
      },
      'reports',
      'report "fixture.vat_return" is listed twice',
    ],
    [
      'a report needing a capability the pack lacks',
      (d) => {
        pick(d.reports, 0).capability = 'reports.syscohada';
      },
      'reports',
      'needs "reports.syscohada", which the pack does not list',
    ],
    // payments
    [
      'no payment method',
      (d) => {
        d.payments = [];
        d.capabilities = [];
      },
      'payments',
      'needs at least one payment method',
    ],
    [
      'a payment kind that does not exist',
      (d) => {
        (pick(d.payments, 0) as { kind: string }).kind = 'barter';
      },
      'payments',
      'method "cash": kind is not valid',
    ],
    [
      'a mobile money method without the capability',
      (d) => {
        d.capabilities = [];
      },
      'payments',
      'payments.mobile_money is listed exactly when a mobile money method exists',
    ],
    [
      'the mobile money capability without a method',
      (d) => {
        d.payments = [pick(d.payments, 0)];
      },
      'payments',
      'payments.mobile_money is listed exactly when a mobile money method exists',
    ],
    // products
    [
      'something that is not a product',
      (d) => {
        (d.products as Record<string, string>)['billing'] = 'AVAILABLE';
      },
      'products',
      '"billing" is not a product key',
    ],
    [
      'an availability that does not exist',
      (d) => {
        (d.products as Record<string, string>)['sales'] = 'SOON';
      },
      'products',
      'sales: availability is not valid',
    ],
    [
      'a product offered without one it requires',
      (d) => {
        d.products.inventory = 'UNAVAILABLE';
      },
      'products',
      'pos is offered but needs inventory, which is not',
    ],
    [
      'a product offered without any of its alternatives',
      (d) => {
        d.products = { accounting: 'AVAILABLE', tax: 'AVAILABLE' };
      },
      'products',
      'tax is offered but needs sales or purchases, which is not',
    ],
    [
      'no product offered at all',
      (d) => {
        d.products = { sales: 'UNAVAILABLE' };
      },
      'products',
      'no product is offered',
    ],
  ])('reports %s', (_name, change, area, expected) => {
    const issues = findPackIssues(brokenPack(change));
    const inArea = issues
      .filter((issue) => issue.area === area)
      .map((issue) => issue.message);
    expect(inArea.join('\n')).toContain(expected);
  });

  it('has a breaking example for every area', () => {
    // Guards the table above: PACK_AREAS and the table grow together.
    expect([...PACK_AREAS].sort()).toEqual(
      [
        'business',
        'capabilities',
        'chart',
        'currencies',
        'fiscal',
        'identity',
        'locales',
        'payments',
        'postingRules',
        'products',
        'reports',
        'tax',
      ].sort(),
    );
  });
});

describe('findPackManifestIssues', () => {
  it('accepts a manifest the pack can carry', () => {
    expect(
      findPackManifestIssues(createFixturePack(), [fixtureManifest()]),
    ).toEqual([]);
  });

  it('reports an offered product whose required capability is missing', () => {
    expect(
      findPackManifestIssues(createFixturePack(), [
        fixtureManifest({ requiresCapabilities: ['einvoicing.fta'] }),
      ]),
    ).toEqual([
      {
        area: 'capabilities',
        message: 'sales is offered but requires "einvoicing.fta"',
      },
    ]);
  });

  it('does not mind an optional capability the country lacks', () => {
    expect(
      findPackManifestIssues(createFixturePack(), [
        fixtureManifest({ optionalCapabilities: ['einvoicing.fta'] }),
      ]),
    ).toEqual([]);
  });

  it('reports a role the product posts to that no template has', () => {
    expect(
      findPackManifestIssues(createFixturePack(), [
        fixtureManifest({ requiredSystemRoles: ['income.services'] }),
      ]),
    ).toEqual([
      {
        area: 'chart',
        message: 'sales posts to "income.services", which no template has',
      },
    ]);
  });

  it("reports a role missing from the pack's list for that product", () => {
    expect(
      findPackManifestIssues(createFixturePack(), [
        fixtureManifest({ requiredSystemRoles: ['cash.main'] }),
      ]),
    ).toEqual([
      {
        area: 'chart',
        message: 'requiredRoles.sales does not list "cash.main"',
      },
    ]);
  });

  it('ignores a product the pack does not offer', () => {
    expect(
      findPackManifestIssues(createFixturePack(), [
        fixtureManifest({
          key: 'payroll',
          requiresCapabilities: ['payroll.engine'],
          requiredSystemRoles: ['payroll.payable'],
        }),
      ]),
    ).toEqual([]);
  });
});

describe('findUnconfirmedValues', () => {
  it('is empty when an accountant has confirmed every value', () => {
    expect(findUnconfirmedValues(createFixturePack())).toEqual([]);
  });

  it('lists each value still waiting for confirmation', () => {
    const pack = brokenPack((d) => {
      d.tax.rounding.source = unconfirmed;
      d.tax.advances.source = unconfirmed;
      pick(d.fiscal.legalNumbering, 0).source = unconfirmed;
      pick(taxCode(d, 'STD').components, 0).rate = createRateTable('std', [
        { effectiveFrom: '2010-01-01', value: '0.08', source: confirmed },
        { effectiveFrom: '2020-01-01', value: '0.10', source: unconfirmed },
      ]);
    });
    expect(findPackIssues(pack)).toEqual([]);
    expect(findUnconfirmedValues(pack).map((item) => item.where)).toEqual([
      'numbering sales.invoice',
      'tax STD / vat from 2020-01-01',
      'tax rounding',
      'tax on advances',
    ]);
  });
});
