/**
 * The "no country literals" rule (implementation plan, section 9).
 *
 * Product code never branches on a country. It asks the country pack, or
 * checks a capability with features.isOn. Writing 'CM' or 'AE' in code is the
 * first step of such a branch, so the literals are rejected everywhere except
 * the places listed in COUNTRY_LITERAL_EXEMPT_FILES.
 *
 * COUNTRY_CODES must equal the list in
 * libs/country-packs/kernel/src/lib/country.ts. ESLint cannot import
 * TypeScript, so the list is repeated here and `pnpm verify:boundaries` fails
 * when the two differ. The country-pack generator appends to both.
 */
export const COUNTRY_CODES = ['CM', 'AE'];

const anyCode = `/^(${COUNTRY_CODES.join('|')})$/`;

const message =
  "Country code literal. Code outside libs/country-packs never names a country: take the business's country as data and ask its pack (PackRegistry), or check a capability with features.isOn.";

/** Entries for no-restricted-syntax. */
export const countryLiteralSelectors = [
  { selector: `Literal[value=${anyCode}]`, message },
  {
    selector: `TemplateLiteral[expressions.length=0] > TemplateElement[value.raw=${anyCode}]`,
    message,
  },
];

/**
 * Where a country code may be written:
 *   - the packs themselves;
 *   - seed data, which is rows and not logic;
 *   - tests, which have to say which country a fixture business is in.
 */
export const COUNTRY_LITERAL_EXEMPT_FILES = [
  'libs/country-packs/**',
  '**/seeds/**',
  '**/*.seed.{ts,js,mjs,cjs}',
  '**/*.{spec,test}.{ts,tsx,js,jsx}',
  '**/*-e2e/**',
  'e2e/**',
];
