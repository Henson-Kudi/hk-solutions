import { DomainError } from './domain-error';
import { err, ok, type Result } from './result';

/** An ISO 4217 alphabetic code such as "XAF" or "AED". */
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

const CODE = /^[A-Z]{3}$/;

/**
 * Minor units (decimal places) per currency. Source: ISO 4217 list one.
 * Every currency not listed here has 2. This is a property of the currency
 * itself, not of a country's rules, so it lives here and not in a country pack.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

const DEFAULT_MINOR_UNITS = 2;

export const parseCurrencyCode = (input: string): Result<CurrencyCode> =>
  typeof input === 'string' && CODE.test(input)
    ? ok(input as CurrencyCode)
    : err(
        new DomainError(
          'CURRENCY_CODE_INVALID',
          'Currency code must be three upper-case letters (ISO 4217).',
        ),
      );

/** Throws a DomainError on an invalid code. */
export const currencyCode = (input: string): CurrencyCode => {
  const parsed = parseCurrencyCode(input);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
};

/** Decimal places of the currency's smallest unit: XAF 0, AED 2, KWD 3. */
export const minorUnitsOf = (currency: CurrencyCode): number =>
  MINOR_UNITS[currency] ?? DEFAULT_MINOR_UNITS;
