/**
 * The products a business can subscribe to, and what each one needs.
 *
 * This file is the single source of truth for the product dependency graph.
 * The plan builder, onboarding, the gateway's entitlement check and the
 * product switcher all read it from here. Each product's own manifest must
 * agree with it (validateManifest checks that), so this lib never has to
 * import a product.
 *
 * `core` is not in this list. It is always on and is not sold separately.
 */
export const PRODUCT_KEYS = [
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
  'multi_business',
] as const;

export type ProductKey = (typeof PRODUCT_KEYS)[number];

/** The always-on base every product builds on. Owns resources and permissions like a product does. */
export const CORE = 'core';

export type ProductOrCore = ProductKey | typeof CORE;

export const isProductKey = (value: unknown): value is ProductKey =>
  typeof value === 'string' &&
  (PRODUCT_KEYS as readonly string[]).includes(value);

/**
 * One thing a product needs: either a specific product, or any one of a
 * group. Tax, for example, needs "sales or purchases".
 */
export type ProductRequirement =
  | ProductKey
  | { readonly anyOf: readonly ProductKey[] };

export type ProductDependencies = Readonly<
  Record<ProductKey, readonly ProductRequirement[]>
>;

/**
 * What each product requires. A product listed here with an empty list needs
 * only core.
 */
export const PRODUCT_DEPENDENCIES: ProductDependencies = {
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
};

/** The products a requirement can be satisfied by. */
export const optionsOf = (
  requirement: ProductRequirement,
): readonly ProductKey[] =>
  typeof requirement === 'string' ? [requirement] : requirement.anyOf;

/** True when the two requirements mean the same thing, whatever the order inside an anyOf. */
export const sameRequirement = (
  a: ProductRequirement,
  b: ProductRequirement,
): boolean =>
  (typeof a === 'string') === (typeof b === 'string') &&
  [...optionsOf(a)].sort().join('|') === [...optionsOf(b)].sort().join('|');
