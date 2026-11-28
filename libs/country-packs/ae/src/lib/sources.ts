import type { SourceNote } from '@hk/country-packs/kernel';

/**
 * Where the UAE pack's values come from.
 *
 * Two kinds of reference, and each note says which it is:
 *
 *   READ      read on 2026-11-28 in the Executive Regulation of Federal
 *             Decree-Law No. 8 of 2017 on Value Added Tax (Cabinet Decision
 *             No. 52 of 2017 and its amendments, consolidated text published
 *             by the Ministry of Finance, unofficial English translation,
 *             from tax.gov.ae).
 *   NOT READ  the Decree-Law itself could not be fetched. These notes name
 *             the article other sources give, and say it was not read.
 *
 * NONE IS CONFIRMED BY AN ACCOUNTANT. No note carries `confirmedBy`, so
 * findUnconfirmedValues(aePack) lists every one. A tax adviser in the UAE
 * confirms each value before go-live (plan open item 1); the questions are in
 * docs/country-packs/ae.md.
 */

const REGULATION =
  'Executive Regulation of Federal Decree-Law No. 8 of 2017 (Cabinet Decision No. 52 of 2017 and its amendments)';
const LEGISLATION = 'https://tax.gov.ae/en/legislation.aspx';

export const SOURCES = {
  vatStandardRate: {
    reference: `NOT READ: Federal Decree-Law No. 8 of 2017 on Value Added Tax, art. 3, standard rate 5%. READ: ${REGULATION}, art. 1 defines the standard rate as "the Tax rate specified in Article 3 of the Decree-Law", and the Regulation is effective from 1 January 2018.`,
    url: LEGISLATION,
  },
  vatZeroRate: {
    reference: `READ: ${REGULATION}, arts. 31 to 41 (zero-rating of exported services and of certain supplies). The rate itself is 0%.`,
    url: LEGISLATION,
  },
  vatReverseCharge: {
    reference: `READ: ${REGULATION}, art. 48 (4) a: the recipient accounts for tax "at the rate which would be applicable if the supply ... was made by a Taxable Person within the State". NOT READ: Decree-Law art. 48.`,
    url: LEGISLATION,
  },
  vatRounding: {
    reference: `READ: ${REGULATION}, art. 61: where tax "is calculated to a fraction of a Fils, the Taxable Person is permitted to round the amount to the nearest Fils on a mathematical rounding". Rounding on each line item is from a secondary report of FTA Public Clarification VATP006 (2018), not read.`,
    url: LEGISLATION,
  },
  vatOnAdvances: {
    reference:
      'NOT READ: Federal Decree-Law No. 8 of 2017, arts. 25 and 26 (date of supply: the earliest of the supply, the tax invoice, or the receipt of payment). Stated in the implementation plan and in secondary sources.',
    url: LEGISLATION,
  },
  vatRegistration: {
    reference: `READ: ${REGULATION}, art. 7 (1): mandatory registration threshold AED 375,000; art. 8 (1): voluntary registration threshold AED 187,500.`,
    url: LEGISLATION,
  },
  invoiceNumbering: {
    reference: `READ: ${REGULATION}, art. 59 (1) d: "a sequential Tax Invoice number or a unique number which enables identification of the Tax Invoice and the order of the Tax Invoice in any sequence of invoices". Gap-free numbering is stricter than the text requires; it is the pack's cautious default.`,
    url: LEGISLATION,
  },
} as const satisfies Record<string, SourceNote>;
