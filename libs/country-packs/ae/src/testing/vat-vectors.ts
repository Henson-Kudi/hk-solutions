/**
 * UAE VAT test vectors, for a tax adviser to review.
 *
 * Each row is a net amount in AED and the tax the pack must charge on it
 * under the standard code (5%).
 *
 * How each was worked out, by hand:
 *   tax = net x 5%, rounded to the nearest fils (two decimals), halves up.
 *
 * STATUS: NOT YET REVIEWED. The same table is in docs/country-packs/ae.md.
 */
export interface VatVector {
  net: string;
  tax: string;
  /** The working, for the reviewer. */
  note: string;
}

export const STANDARD_VAT_VECTORS: readonly VatVector[] = [
  { net: '0', tax: '0', note: 'nothing to tax' },
  { net: '0.09', tax: '0', note: '0.0045 rounds down to 0.00' },
  { net: '0.10', tax: '0.01', note: '0.005 rounds half up to 0.01' },
  { net: '0.30', tax: '0.02', note: '0.015 rounds half up to 0.02' },
  { net: '0.50', tax: '0.03', note: '0.025 rounds half up to 0.03' },
  { net: '1.10', tax: '0.06', note: '0.055 rounds half up to 0.06' },
  { net: '19.90', tax: '1', note: '0.995 rounds half up to 1.00' },
  { net: '33.33', tax: '1.67', note: '1.6665 rounds up to 1.67' },
  { net: '99.99', tax: '5', note: '4.9995 rounds up to 5.00' },
  { net: '100', tax: '5', note: 'exact' },
  { net: '1234.56', tax: '61.73', note: '61.728 rounds up to 61.73' },
  { net: '10000', tax: '500', note: 'exact' },
  {
    net: '-19.90',
    tax: '-1',
    note: 'a credit note mirrors the invoice: -0.995 rounds away from zero',
  },
];
