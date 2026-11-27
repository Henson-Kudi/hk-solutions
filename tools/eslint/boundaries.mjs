/**
 * Module boundary rules (implementation plan, section 5.2).
 *
 * Every project carries tags in its project.json. A project with no tag that
 * matches a rule below cannot import any other project, so an untagged lib
 * fails lint the first time it is used.
 *
 * Tag vocabulary
 * --------------
 *   scope:platform       libs/platform/*            kernel, no business rules
 *   scope:contracts      libs/contracts/*           DTOs, events, manifests
 *   scope:country-pack   libs/country-packs/*
 *   scope:core           libs/core/**, apps/core, apps/core-worker
 *   scope:product        libs/products/**, apps/<product>
 *   scope:client         libs/client/*
 *   scope:tools          tools/*
 *
 *   runtime:universal    platform libs that run on node, browser and Hermes
 *   pack:kernel          libs/country-packs/kernel
 *   client:local-db      libs/client/local-db
 *
 *   layer:domain | layer:application | layer:infra-pg | layer:infra-sqlite
 *   layer:nest | layer:ui            the split inside a product or core lib
 *
 *   product:<key>        every lib and app of one product
 *   type:app             anything under apps/
 *   type:port            a core lib that defines a provider port (core/payments)
 *   type:adapter         a provider adapter (core/payments-mtn, ...)
 *   app:<name>           gateway, migrator, core, <product>, web, desktop, ...
 *
 * How the rules combine: every rule whose source tag a project carries must be
 * satisfied. "onlyDependOnLibsWithTags" passes when the imported project has
 * at least one of the listed tags.
 *
 * The product generator (nx g @hk/tools:product) appends to PRODUCTS. Do not
 * add per-product rules by hand anywhere else.
 */

/** Product keys from plan section 11.1. One isolation rule is generated per key. */
export const PRODUCTS = [
  'accounting',
  'sales',
  'purchases',
  'tax',
  'banking',
  'inventory',
  'pos',
  'storefront',
  'hr',
  'payroll',
  'assets',
  'projects',
  'crm',
  'budgeting',
];

/** Reserved for tools/scripts/verify-boundaries.mjs. Never used by real code. */
export const FIXTURE_PRODUCTS = ['zzfix-a', 'zzfix-b'];

/** Frontend apps that run shared libs on the client. */
export const CLIENT_APPS = [
  'web',
  'desktop',
  'mobile',
  'admin-web',
  'marketing',
  'storefront-web',
];

const allProducts = [...PRODUCTS, ...FIXTURE_PRODUCTS];

const scopeRules = [
  {
    sourceTag: 'scope:platform',
    onlyDependOnLibsWithTags: ['scope:platform'],
  },
  {
    // A universal platform lib may only use other universal platform libs.
    allSourceTags: ['scope:platform', 'runtime:universal'],
    onlyDependOnLibsWithTags: ['runtime:universal'],
  },
  {
    sourceTag: 'scope:contracts',
    onlyDependOnLibsWithTags: ['scope:contracts', 'runtime:universal'],
  },
  {
    // A pack may use the kernel, never another country's pack.
    sourceTag: 'scope:country-pack',
    onlyDependOnLibsWithTags: [
      'pack:kernel',
      'scope:contracts',
      'runtime:universal',
    ],
  },
  {
    // scope:client is listed only so core's ui and infra-sqlite layers can
    // reach libs/client; the layer rules below stop every other layer.
    sourceTag: 'scope:core',
    onlyDependOnLibsWithTags: [
      'scope:core',
      'scope:contracts',
      'scope:platform',
      'scope:country-pack',
      'scope:client',
    ],
  },
  {
    // Products never import core code. They use @hk/contracts/* and events.
    sourceTag: 'scope:product',
    onlyDependOnLibsWithTags: [
      'scope:product',
      'scope:contracts',
      'scope:platform',
      'scope:country-pack',
      'scope:client',
    ],
  },
  {
    sourceTag: 'scope:client',
    onlyDependOnLibsWithTags: [
      'scope:client',
      'scope:contracts',
      'runtime:universal',
      'layer:application',
      'layer:domain',
    ],
  },
  {
    sourceTag: 'scope:tools',
    onlyDependOnLibsWithTags: ['scope:tools'],
  },
];

const layerRules = [
  {
    sourceTag: 'layer:domain',
    onlyDependOnLibsWithTags: [
      'layer:domain',
      'runtime:universal',
      'pack:kernel',
      'scope:contracts',
    ],
  },
  {
    sourceTag: 'layer:application',
    onlyDependOnLibsWithTags: [
      'layer:application',
      'layer:domain',
      'runtime:universal',
      'pack:kernel',
      'scope:contracts',
    ],
  },
  {
    sourceTag: 'layer:infra-pg',
    onlyDependOnLibsWithTags: [
      'layer:infra-pg',
      'layer:application',
      'layer:domain',
      'scope:platform',
    ],
  },
  {
    // Runs on desktop and mobile, so no node-only platform libs.
    sourceTag: 'layer:infra-sqlite',
    onlyDependOnLibsWithTags: [
      'layer:infra-sqlite',
      'layer:application',
      'layer:domain',
      'client:local-db',
      'runtime:universal',
    ],
  },
  {
    sourceTag: 'layer:nest',
    onlyDependOnLibsWithTags: [
      'layer:nest',
      'layer:application',
      'layer:domain',
      'layer:infra-pg',
      'scope:platform',
      'scope:contracts',
    ],
  },
  {
    // UI may read domain display rules, never use cases or adapters.
    sourceTag: 'layer:ui',
    onlyDependOnLibsWithTags: [
      'layer:ui',
      'layer:domain',
      'scope:client',
      'scope:contracts',
      'runtime:universal',
    ],
  },
];

const adapterRules = [
  {
    sourceTag: 'type:adapter',
    onlyDependOnLibsWithTags: [
      'type:port',
      'scope:platform',
      'scope:contracts',
    ],
    notDependOnLibsWithTags: ['type:adapter'],
  },
];

const serverAppTargets = [
  'scope:contracts',
  'scope:platform',
  'scope:country-pack',
];

const appRules = [
  {
    allSourceTags: ['type:app', 'scope:core'],
    onlyDependOnLibsWithTags: ['scope:core', ...serverAppTargets],
  },
  {
    allSourceTags: ['type:app', 'scope:product'],
    onlyDependOnLibsWithTags: ['scope:product', ...serverAppTargets],
  },
  {
    sourceTag: 'app:gateway',
    onlyDependOnLibsWithTags: ['scope:contracts', 'scope:platform'],
  },
  {
    // The migrator only loads each service's migrations.
    sourceTag: 'app:migrator',
    onlyDependOnLibsWithTags: ['layer:infra-pg', 'scope:platform'],
  },
  ...CLIENT_APPS.map((app) => ({
    sourceTag: `app:${app}`,
    onlyDependOnLibsWithTags: [
      'scope:client',
      'scope:contracts',
      'scope:country-pack',
      'runtime:universal',
      'layer:ui',
      'layer:application',
      'layer:domain',
      'layer:infra-sqlite',
    ],
    notDependOnLibsWithTags: ['layer:infra-pg', 'layer:nest'],
  })),
];

/** A product's libs and app never import another product's libs. */
const productIsolationRules = allProducts.map((product) => ({
  sourceTag: `product:${product}`,
  notDependOnLibsWithTags: allProducts
    .filter((other) => other !== product)
    .map((other) => `product:${other}`),
}));

export const depConstraints = [
  ...scopeRules,
  ...layerRules,
  ...adapterRules,
  ...appRules,
  ...productIsolationRules,
];
