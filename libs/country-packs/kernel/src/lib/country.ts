/**
 * The countries that have a pack. ISO 3166-1 alpha-2 codes.
 *
 * This list and libs/country-packs are the only places a country code is
 * written down. Everywhere else a lint rule rejects the literals, because
 * code that says `if (country === 'CM')` is a rule that belongs in a pack.
 *
 * The country-pack generator appends to this list. The lint rule's own list
 * (tools/eslint/country-literals.mjs) must match it; `pnpm verify:boundaries`
 * fails when the two differ.
 */
export const COUNTRY_CODES = ['CM', 'AE'] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

export const isCountryCode = (value: unknown): value is CountryCode =>
  typeof value === 'string' &&
  (COUNTRY_CODES as readonly string[]).includes(value);
