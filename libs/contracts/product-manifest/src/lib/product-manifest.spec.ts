import { createFeatures, features, FEATURES } from './features';
import {
  dependantsOf,
  dependencyOrder,
  findCycles,
  findMissingRequirements,
  resolveSelection,
} from './graph';
import {
  findManifestIssues,
  findOrphanTopics,
  scopeDeclarations,
  type ProductManifest,
} from './manifest';
import {
  PRODUCT_DEPENDENCIES,
  PRODUCT_KEYS,
  isProductKey,
  optionsOf,
  sameRequirement,
  type ProductDependencies,
  type ProductKey,
} from './products';

/** A graph where only the listed products have requirements. */
const graph = (
  overrides: Partial<ProductDependencies>,
): ProductDependencies => ({
  ...(Object.fromEntries(
    PRODUCT_KEYS.map((key) => [key, []]),
  ) as unknown as ProductDependencies),
  ...overrides,
});

describe('the product catalog', () => {
  it('lists every product once, and core is not one of them', () => {
    expect(new Set(PRODUCT_KEYS).size).toBe(PRODUCT_KEYS.length);
    expect(PRODUCT_KEYS).toHaveLength(15);
    expect(isProductKey('sales')).toBe(true);
    expect(isProductKey('core')).toBe(false);
    expect(isProductKey('Sales')).toBe(false);
    expect(isProductKey(undefined)).toBe(false);
  });

  it('has a dependency entry for every product, naming only real products', () => {
    expect(Object.keys(PRODUCT_DEPENDENCIES).sort()).toEqual(
      [...PRODUCT_KEYS].sort(),
    );
    for (const key of PRODUCT_KEYS) {
      for (const requirement of PRODUCT_DEPENDENCIES[key]) {
        const options = optionsOf(requirement);
        expect(options.length).toBeGreaterThan(0);
        expect(options.every(isProductKey)).toBe(true);
        expect(options).not.toContain(key);
      }
    }
  });

  it('matches the product table of the plan', () => {
    expect(PRODUCT_DEPENDENCIES).toEqual({
      accounting: [],
      sales: [],
      purchases: [],
      tax: [{ anyOf: ['sales', 'purchases'] }],
      banking: [],
      inventory: [{ anyOf: ['sales', 'purchases'] }],
      pos: ['sales', 'inventory'],
      storefront: ['sales', 'inventory'],
      hr: [],
      payroll: ['hr'],
      assets: ['accounting'],
      projects: [],
      crm: ['sales'],
      budgeting: ['accounting'],
      multi_business: ['accounting'],
    });
  });

  it('compares requirements whatever the order inside an anyOf', () => {
    expect(sameRequirement('sales', 'sales')).toBe(true);
    expect(sameRequirement('sales', 'purchases')).toBe(false);
    expect(
      sameRequirement(
        { anyOf: ['sales', 'purchases'] },
        { anyOf: ['purchases', 'sales'] },
      ),
    ).toBe(true);
    expect(sameRequirement('sales', { anyOf: ['sales'] })).toBe(false);
  });
});

describe('the dependency graph has no cycle', () => {
  it('for the real products', () => {
    expect(findCycles()).toEqual([]);
  });

  it('and a cycle is found when there is one', () => {
    expect(findCycles(graph({ sales: ['crm'], crm: ['sales'] }))).toEqual([
      ['sales', 'crm'],
    ]);
  });

  it('including a product that requires itself', () => {
    expect(findCycles(graph({ hr: ['hr'] }))).toEqual([['hr']]);
  });

  it('including a long cycle', () => {
    const cycles = findCycles(
      graph({ pos: ['inventory'], inventory: ['sales'], sales: ['pos'] }),
    );
    expect(cycles).toHaveLength(1);
    expect([...(cycles[0] as ProductKey[])].sort()).toEqual([
      'inventory',
      'pos',
      'sales',
    ]);
  });

  it('including a cycle that runs through an "any one of" requirement', () => {
    expect(
      findCycles(graph({ tax: [{ anyOf: ['banking', 'crm'] }], crm: ['tax'] })),
    ).toEqual([['tax', 'crm']]);
  });

  it('but a diamond is not a cycle', () => {
    expect(
      findCycles(graph({ pos: ['sales', 'inventory'], inventory: ['sales'] })),
    ).toEqual([]);
  });
});

describe('dependencyOrder', () => {
  it('puts every product after everything it can depend on', () => {
    const order = dependencyOrder();
    expect([...order].sort()).toEqual([...PRODUCT_KEYS].sort());
    for (const product of order) {
      for (const requirement of PRODUCT_DEPENDENCIES[product]) {
        for (const option of optionsOf(requirement)) {
          expect(order.indexOf(option)).toBeLessThan(order.indexOf(product));
        }
      }
    }
  });

  it('refuses a graph with a cycle', () => {
    expect(() =>
      dependencyOrder(graph({ sales: ['crm'], crm: ['sales'] })),
    ).toThrow(/cycle/);
  });
});

describe('findMissingRequirements', () => {
  it('accepts a selection that satisfies itself', () => {
    expect(findMissingRequirements([])).toEqual([]);
    expect(findMissingRequirements(['sales'])).toEqual([]);
    expect(findMissingRequirements(['sales', 'inventory', 'pos'])).toEqual([]);
    expect(findMissingRequirements(['purchases', 'tax'])).toEqual([]);
    expect(findMissingRequirements(['hr', 'payroll'])).toEqual([]);
  });

  it('reports each unmet requirement', () => {
    expect(findMissingRequirements(['pos'])).toEqual([
      { product: 'pos', requirement: 'sales' },
      { product: 'pos', requirement: 'inventory' },
    ]);
    expect(findMissingRequirements(['payroll'])).toEqual([
      { product: 'payroll', requirement: 'hr' },
    ]);
    expect(findMissingRequirements(['tax'])).toEqual([
      { product: 'tax', requirement: { anyOf: ['sales', 'purchases'] } },
    ]);
  });

  it('ignores a product listed twice', () => {
    expect(findMissingRequirements(['payroll', 'payroll', 'hr'])).toEqual([]);
  });
});

describe('resolveSelection', () => {
  it('adds what is required outright, and what that requires', () => {
    expect(resolveSelection(['payroll'])).toEqual({
      products: ['hr', 'payroll'],
      added: ['hr'],
      choices: [],
    });
    expect(resolveSelection(['pos'])).toEqual({
      products: ['sales', 'inventory', 'pos'],
      added: ['sales', 'inventory'],
      choices: [],
    });
  });

  it('leaves an "any one of" requirement to the user', () => {
    expect(resolveSelection(['tax'])).toEqual({
      products: ['tax'],
      added: [],
      choices: [
        { product: 'tax', requirement: { anyOf: ['sales', 'purchases'] } },
      ],
    });
  });

  it('does not ask when the choice is already settled, even indirectly', () => {
    expect(resolveSelection(['tax', 'purchases']).choices).toEqual([]);
    // pos brings sales, and sales settles inventory's "sales or purchases".
    expect(resolveSelection(['pos']).choices).toEqual([]);
  });

  it('adds nothing to a complete selection, and returns it in catalog order', () => {
    expect(resolveSelection(['pos', 'inventory', 'sales'])).toEqual({
      products: ['sales', 'inventory', 'pos'],
      added: [],
      choices: [],
    });
    expect(resolveSelection([])).toEqual({
      products: [],
      added: [],
      choices: [],
    });
  });

  it('always yields a selection with nothing missing but the choices', () => {
    for (const key of PRODUCT_KEYS) {
      const resolved = resolveSelection([key]);
      expect(findMissingRequirements(resolved.products)).toEqual(
        resolved.choices,
      );
    }
  });
});

describe('dependantsOf', () => {
  it('lists the products that need the one being removed', () => {
    expect(dependantsOf('hr', ['hr', 'payroll'])).toEqual(['payroll']);
    expect(
      dependantsOf('accounting', [
        'accounting',
        'assets',
        'budgeting',
        'sales',
      ]),
    ).toEqual(['assets', 'budgeting']);
  });

  it('follows the chain: removing sales also strands what needs inventory', () => {
    expect(
      dependantsOf('sales', ['sales', 'inventory', 'pos', 'storefront', 'crm']),
    ).toEqual(['inventory', 'pos', 'storefront', 'crm']);
  });

  it('does not count a product whose "any one of" is still met', () => {
    expect(
      dependantsOf('sales', ['sales', 'purchases', 'tax', 'inventory']),
    ).toEqual([]);
    expect(dependantsOf('purchases', ['purchases', 'tax'])).toEqual(['tax']);
  });

  it('is empty when nothing depends on the product, or it is not selected', () => {
    expect(dependantsOf('banking', ['banking', 'sales'])).toEqual([]);
    expect(dependantsOf('hr', ['sales'])).toEqual([]);
  });

  it('never lists the product itself', () => {
    expect(dependantsOf('pos', ['sales', 'inventory', 'pos'])).toEqual([]);
  });
});

describe('findManifestIssues', () => {
  const valid: ProductManifest = {
    key: 'pos',
    displayName: { en: 'Point of Sale', fr: 'Point de vente' },
    requiresProducts: ['sales', 'inventory'],
    requiresCapabilities: [],
    optionalCapabilities: ['payments.mobile_money'],
    coreScopes: ['contacts:read', 'ledger.postings:request'],
    publicRoutes: ['/pos'],
    consumes: ['sales.invoice.issued', 'core.journal.posted'],
    produces: ['pos.session.closed'],
    permissions: ['pos_sessions:open', 'pos_sessions:close'],
    schema: 'pos',
    requiredSystemRoles: ['cash.till'],
    meters: ['registers'],
  };
  const messages = (change: Partial<Record<keyof ProductManifest, unknown>>) =>
    findManifestIssues({ ...valid, ...change } as ProductManifest).map(
      (issue) => `${issue.field}: ${issue.message}`,
    );

  it('accepts a valid manifest', () => {
    expect(findManifestIssues(valid)).toEqual([]);
  });

  it('accepts requirements in another order, and an anyOf in another order', () => {
    expect(messages({ requiresProducts: ['inventory', 'sales'] })).toEqual([]);
    expect(
      findManifestIssues({
        ...valid,
        key: 'tax',
        requiresProducts: [{ anyOf: ['purchases', 'sales'] }],
        produces: ['tax.return.filed'],
        schema: 'tax',
      }),
    ).toEqual([]);
  });

  it('accepts a product without a schema', () => {
    expect(
      findManifestIssues({
        ...valid,
        key: 'multi_business',
        requiresProducts: ['accounting'],
        produces: [],
        schema: null,
      }),
    ).toEqual([]);
  });

  it('rejects an unknown key, and stops there', () => {
    expect(messages({ key: 'pointofsale' })).toEqual([
      'key: "pointofsale" is not a product key',
    ]);
  });

  it('rejects a display name without both languages', () => {
    expect(messages({ displayName: { en: 'Point of Sale', fr: '' } })).toEqual([
      'displayName: needs non-empty "en" and "fr" text',
    ]);
  });

  it.each([
    ['a missing requirement', ['sales']],
    ['an extra requirement', ['sales', 'inventory', 'hr']],
    ['a different requirement', ['sales', 'purchases']],
    [
      'an anyOf where the catalog has a plain requirement',
      [{ anyOf: ['sales', 'inventory'] }],
    ],
    ['no requirements', []],
  ])('rejects requiresProducts with %s', (_label, requiresProducts) => {
    expect(messages({ requiresProducts })).toContain(
      "requiresProducts: does not match this product's entry in PRODUCT_DEPENDENCIES",
    );
  });

  it('rejects a requirement on itself or on something that is not a product', () => {
    expect(messages({ requiresProducts: ['sales', 'pos'] })).toContain(
      'requiresProducts: a product cannot require itself',
    );
    expect(messages({ requiresProducts: ['sales', 'warehouse'] })).toContain(
      'requiresProducts: names something that is not a product key',
    );
    expect(
      messages({ requiresProducts: [{ anyOf: [] }, 'inventory'] }),
    ).toContain('requiresProducts: names something that is not a product key');
  });

  it.each([
    [
      'requiresCapabilities',
      ['mobile_money'],
      '"mobile_money" is not of the form area.name',
    ],
    [
      'optionalCapabilities',
      ['Payments.MoMo'],
      '"Payments.MoMo" is not of the form area.name',
    ],
    [
      'coreScopes',
      ['contacts'],
      '"contacts" is not of the form resource:action',
    ],
    ['coreScopes', ['*:*'], '"*:*" is not of the form resource:action'],
    ['publicRoutes', ['pos'], '"pos" is not of the form /path'],
    ['publicRoutes', ['/pos/:id'], '"/pos/:id" is not of the form /path'],
    [
      'permissions',
      ['pos_sessions'],
      '"pos_sessions" is not of the form resource:action',
    ],
    [
      'consumes',
      ['sales.issued'],
      '"sales.issued" is not of the form producer.entity.event',
    ],
    [
      'produces',
      ['pos.Session.closed'],
      '"pos.Session.closed" is not of the form producer.entity.event',
    ],
    [
      'requiredSystemRoles',
      ['Cash Till'],
      '"Cash Till" is not of the form a dotted name',
    ],
    ['meters', ['registers!'], '"registers!" is not of the form a dotted name'],
  ] as const)('rejects a malformed entry in %s', (field, value, message) => {
    expect(messages({ [field]: value })).toContain(`${field}: ${message}`);
  });

  it('rejects a duplicate in a list', () => {
    expect(
      messages({ permissions: ['pos_sessions:open', 'pos_sessions:open'] }),
    ).toEqual(['permissions: "pos_sessions:open" is listed twice']);
  });

  it('rejects a capability that is both required and optional', () => {
    expect(
      messages({
        requiresCapabilities: ['payments.mobile_money'],
        optionalCapabilities: ['payments.mobile_money'],
      }),
    ).toEqual([
      'optionalCapabilities: "payments.mobile_money" is also required, so it cannot be optional',
    ]);
  });

  it("rejects producing another product's topic, or consuming its own", () => {
    expect(messages({ produces: ['sales.invoice.issued'] })).toEqual([
      'produces: "sales.invoice.issued" must start with "pos."',
    ]);
    expect(messages({ consumes: ['pos.session.closed'] })).toEqual([
      'consumes: "pos.session.closed" is the product\'s own event',
    ]);
  });

  it('rejects a schema that is not the product key', () => {
    expect(messages({ schema: 'sales' })).toEqual([
      'schema: must be "pos" or null',
    ]);
  });

  it('reports every problem at once', () => {
    expect(
      messages({ schema: 'x', meters: ['a b'], publicRoutes: ['pos'] }),
    ).toHaveLength(3);
  });
});

describe('findOrphanTopics', () => {
  const manifest = (
    key: ProductKey,
    produces: string[],
    consumes: string[],
  ): ProductManifest =>
    ({
      key,
      produces,
      consumes,
      coreScopes: [`${key}_things:read`],
    }) as unknown as ProductManifest;

  it('is empty when every consumed topic has a producer', () => {
    expect(
      findOrphanTopics(
        [
          manifest('sales', ['sales.invoice.issued'], ['core.journal.posted']),
          manifest('inventory', [], ['sales.invoice.issued']),
        ],
        ['core.journal.posted'],
      ),
    ).toEqual([]);
  });

  it('lists a topic nobody produces, with its consumer', () => {
    expect(
      findOrphanTopics([
        manifest('sales', ['sales.invoice.issued'], ['core.journal.posted']),
        manifest(
          'inventory',
          [],
          ['sales.invoice.issued', 'sales.invoice.voided'],
        ),
      ]),
    ).toEqual([
      { topic: 'core.journal.posted', consumer: 'sales' },
      { topic: 'sales.invoice.voided', consumer: 'inventory' },
    ]);
  });

  it('turns manifests into scope declarations for the service scope registry', () => {
    expect(
      scopeDeclarations([manifest('sales', [], []), manifest('pos', [], [])]),
    ).toEqual({ sales: ['sales_things:read'], pos: ['pos_things:read'] });
  });
});

describe('features.isOn', () => {
  const cameroon = [
    'payments.mobile_money',
    'payroll.cnps',
    'reports.syscohada',
  ];
  const uae = ['payroll.wps', 'tax.corporate_tax', 'einvoicing.fta'];

  it('is on with the capability, the product and no setting against it', () => {
    expect(
      features.isOn(
        { capabilities: uae, enabledProducts: ['hr', 'payroll'] },
        'payroll.wps',
      ),
    ).toBe(true);
    expect(
      features.isOn(
        { capabilities: cameroon, enabledProducts: ['hr', 'payroll'] },
        'payroll.cnps',
      ),
    ).toBe(true);
  });

  it('is off where the country lacks the capability', () => {
    expect(
      features.isOn(
        { capabilities: cameroon, enabledProducts: ['hr', 'payroll'] },
        'payroll.wps',
      ),
    ).toBe(false);
  });

  it('is off without the product, whatever the country supports', () => {
    expect(
      features.isOn(
        { capabilities: uae, enabledProducts: ['sales'] },
        'payroll.wps',
      ),
    ).toBe(false);
  });

  it('is off when the business switched it off, and on again when switched on', () => {
    const context = {
      capabilities: uae,
      enabledProducts: ['tax' as const, 'sales' as const],
    };
    expect(
      features.isOn(
        { ...context, settings: { 'einvoicing.fta': false } },
        'einvoicing.fta',
      ),
    ).toBe(false);
    expect(
      features.isOn(
        { ...context, settings: { 'einvoicing.fta': true } },
        'einvoicing.fta',
      ),
    ).toBe(true);
    expect(features.isOn({ ...context, settings: {} }, 'einvoicing.fta')).toBe(
      true,
    );
  });

  it('needs no product for a core feature', () => {
    expect(
      features.isOn(
        { capabilities: cameroon, enabledProducts: [] },
        'payments.mobile_money',
      ),
    ).toBe(true);
    expect(
      features.isOn(
        { capabilities: uae, enabledProducts: [] },
        'payments.mobile_money',
      ),
    ).toBe(false);
  });

  it('cannot be switched on by a setting alone', () => {
    expect(
      features.isOn(
        {
          capabilities: cameroon,
          enabledProducts: [],
          settings: { 'payroll.wps': true },
        },
        'payroll.wps',
      ),
    ).toBe(false);
  });

  it('explains which of the three conditions failed', () => {
    expect(
      features.explain(
        { capabilities: uae, enabledProducts: ['sales'] },
        'payroll.wps',
      ),
    ).toEqual({
      on: false,
      known: true,
      capability: true,
      entitlement: false,
      setting: true,
    });
  });

  it('treats an unknown feature as off', () => {
    const anyKey = createFeatures<string>(FEATURES);
    const everything = {
      capabilities: [...cameroon, ...uae, 'toString', 'made.up'],
      enabledProducts: ['payroll' as const],
      settings: { 'made.up': true, toString: true },
    };
    for (const key of ['made.up', 'toString', 'constructor', '__proto__']) {
      expect(anyKey.isOn(everything, key)).toBe(false);
      expect(anyKey.explain(everything, key).known).toBe(false);
    }
  });

  it('respects a feature that is off unless switched on', () => {
    const optIn = createFeatures({
      'reports.beta': {
        product: 'accounting',
        capability: 'reports.beta',
        defaultOn: false,
      },
    });
    const context = {
      capabilities: ['reports.beta'],
      enabledProducts: ['accounting' as const],
    };
    expect(optIn.isOn(context, 'reports.beta')).toBe(false);
    expect(
      optIn.isOn(
        { ...context, settings: { 'reports.beta': true } },
        'reports.beta',
      ),
    ).toBe(true);
  });

  it('has a registry whose products and capabilities are well formed', () => {
    for (const [key, definition] of Object.entries(FEATURES)) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(definition.capability).toMatch(
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
      );
      expect(
        definition.product === 'core' || isProductKey(definition.product),
      ).toBe(true);
    }
  });
});
