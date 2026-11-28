/**
 * Capabilities: named things a country can provide.
 *
 * A pack lists the capabilities its country has. A product manifest lists the
 * ones it requires (the product is not offered without them) and the ones it
 * can use (extra features light up). A feature flag then combines capability,
 * entitlement and setting in `features.isOn` from
 * @hk/contracts/product-manifest.
 *
 * A capability is added here in the PR that adds the first pack providing it.
 */
export const CAPABILITY_KEYS = [
  'payments.mobile_money',
  'payroll.engine',
  'payroll.wps',
  'payroll.cnps',
  'tax.corporate_tax',
  'einvoicing.fta',
  'reports.syscohada',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const isCapabilityKey = (value: unknown): value is CapabilityKey =>
  typeof value === 'string' &&
  (CAPABILITY_KEYS as readonly string[]).includes(value);
