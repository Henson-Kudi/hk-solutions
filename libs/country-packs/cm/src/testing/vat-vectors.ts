/**
 * Cameroon VAT test vectors, for an accountant to review.
 *
 * Each row is a net amount in XAF and the tax the pack must charge on it
 * under the standard code (TVA 17.5% + CAC 10% of the TVA = 19.25%).
 *
 * How each was worked out, by hand:
 *   total = net × 19.25%, rounded half up to the franc
 *   tva   = net × 17.5%, rounded half up to the franc
 *   cac   = total − tva
 *
 * STATUS: NOT YET REVIEWED. The same table is in docs/country-packs/cm.md
 * with the questions the rounding raises. When the accountant has reviewed
 * it, record who and when there.
 */
export interface VatVector {
  net: string;
  tva: string;
  cac: string;
  total: string;
  /** The working, for the reviewer. */
  note: string;
}

export const STANDARD_VAT_VECTORS: readonly VatVector[] = [
  { net: '0', tva: '0', cac: '0', total: '0', note: 'nothing to tax' },
  {
    net: '1',
    tva: '0',
    cac: '0',
    total: '0',
    note: '0.1925 rounds to 0; 0.175 rounds to 0',
  },
  {
    net: '2',
    tva: '0',
    cac: '0',
    total: '0',
    note: '0.385 rounds to 0; 0.35 rounds to 0',
  },
  {
    net: '3',
    tva: '1',
    cac: '0',
    total: '1',
    note: '0.5775 rounds to 1; 0.525 rounds to 1; nothing left for CAC',
  },
  {
    net: '100',
    tva: '18',
    cac: '1',
    total: '19',
    note: '19.25 rounds to 19; 17.5 rounds half up to 18; CAC is 1, not 1.75',
  },
  {
    net: '999',
    tva: '175',
    cac: '17',
    total: '192',
    note: '192.3075 rounds to 192; 174.825 rounds to 175',
  },
  {
    net: '1000',
    tva: '175',
    cac: '18',
    total: '193',
    note: '192.5 rounds half up to 193; 175 exactly; CAC is 18, not 17.5',
  },
  {
    net: '2600',
    tva: '455',
    cac: '46',
    total: '501',
    note: '500.5 rounds half up to 501; 455 exactly',
  },
  {
    net: '10000',
    tva: '1750',
    cac: '175',
    total: '1925',
    note: 'exact',
  },
  {
    net: '123456',
    tva: '21605',
    cac: '2160',
    total: '23765',
    note: '23765.28 rounds to 23765; 21604.8 rounds to 21605',
  },
  {
    net: '1000000',
    tva: '175000',
    cac: '17500',
    total: '192500',
    note: 'exact',
  },
  {
    net: '-1000',
    tva: '-175',
    cac: '-18',
    total: '-193',
    note: 'a credit note mirrors the invoice: -192.5 rounds away from zero to -193',
  },
];
