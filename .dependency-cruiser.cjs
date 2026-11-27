/**
 * Path-based architecture rules (implementation plan, section 5.2).
 *
 * ESLint (tools/eslint/boundaries.mjs) checks which project may import which
 * project, using tags. This file checks what tags cannot see: cycles, deep
 * imports, and what a folder is allowed to resolve to on disk.
 *
 * Run: npx depcruise apps libs --config .dependency-cruiser.cjs
 *
 * `$1` in a "to" rule refers to the first capture group of the "from" path.
 */

/** Frameworks that pure code (domain, application, universal, contracts, packs) may never resolve. */
const FRAMEWORKS = [
  '@nestjs/',
  'drizzle-orm',
  'drizzle-kit',
  'react',
  'react-dom',
  'react-native',
  'expo',
  'next',
  'pg',
  'better-sqlite3',
  'ioredis',
  'bullmq',
];

/** Payment provider SDKs. Add a provider's package here when its adapter lib is created. */
const VENDOR_SDKS = ['stripe', '@stripe/'];

const PURE_PATHS = [
  '^libs/.+/(domain|application)/',
  '^libs/platform/universal/',
  '^libs/contracts/',
  '^libs/country-packs/',
];

/** Matches a package whether it resolved into node_modules or could not be resolved at all. */
const packages = (names) =>
  `(^|node_modules/)(${names
    .map((name) => (name.endsWith('/') ? name : `${name}(/|$)`))
    .join('|')})`;

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle means two modules cannot be understood or tested apart.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment:
        'The import does not resolve. Usually a deep import into a lib (only @hk/<group>/<name> exists) or a package missing from package.json.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-deep-imports',
      severity: 'error',
      comment:
        "Only a lib's src/index.ts is public. Import @hk/<group>/<name>, not a file inside another lib.",
      from: { path: '^(libs/.+?)/src/' },
      to: {
        path: '^libs/.+/src/',
        pathNot: ['^$1/src/', '/src/index\\.ts$'],
      },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'domain, application, universal, contracts and country-pack code runs on the API, desktop and mobile. No Nest, Drizzle, React or other framework.',
      from: { path: PURE_PATHS },
      to: { path: packages(FRAMEWORKS) },
    },
    {
      name: 'domain-no-node-builtins',
      severity: 'error',
      comment:
        'Pure code may not use node:*, fs, crypto or any Node built-in. Use the ids and hash helpers from @hk/platform/universal.',
      from: { path: PURE_PATHS },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'vendor-sdk-only-in-adapter',
      severity: 'error',
      comment:
        'A payment provider SDK may only be imported inside its libs/core/payments-* adapter.',
      from: { pathNot: '^libs/core/payments-[^/]+/' },
      to: { path: packages(VENDOR_SDKS) },
    },
    {
      name: 'no-other-schema',
      severity: 'error',
      comment:
        "A product's infra-pg may not import another product's or core's table definitions. Call the owning service's API or keep a projection built from events.",
      from: { path: '^libs/products/([^/]+)/infra-pg/' },
      to: {
        path: '^libs/(products|core)/.+/infra-pg/',
        pathNot: '^libs/products/$1/',
      },
    },
    {
      name: 'core-no-product-schema',
      severity: 'error',
      comment: "Core's infra-pg may not import a product's table definitions.",
      from: { path: '^libs/core/.+/infra-pg/' },
      to: { path: '^libs/products/.+/infra-pg/' },
    },
    {
      name: 'product-not-to-core',
      severity: 'error',
      comment:
        'Products never import core code. Use @hk/contracts/core-api and events.',
      from: {
        path: '^(libs/products|apps/(?!core|core-worker|gateway|migrator)[^/]+)/',
      },
      to: { path: '^libs/core/' },
    },
    {
      name: 'core-not-to-product',
      severity: 'error',
      comment: 'Core never imports product code. Dependencies point down only.',
      from: { path: '^(libs/core|apps/core|apps/core-worker)/' },
      to: { path: '^libs/products/' },
    },
    {
      name: 'no-cross-product',
      severity: 'error',
      comment:
        "A product never imports another product's libs. Use @hk/contracts/product-apis or events.",
      from: { path: '^libs/products/([^/]+)/' },
      to: { path: '^libs/products/', pathNot: '^libs/products/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(dist|out-tsc|\\.next|\\.expo|node_modules/\\.cache)/',
    },
    // Type-only imports count: a domain file importing a Nest type is still coupled to Nest.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: [
        '.ts',
        '.tsx',
        '.mts',
        '.cts',
        '.js',
        '.jsx',
        '.mjs',
        '.cjs',
        '.json',
      ],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
