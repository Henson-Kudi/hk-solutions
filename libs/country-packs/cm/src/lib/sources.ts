import type { SourceNote } from '@hk/country-packs/kernel';

/**
 * Where the Cameroon pack's values come from.
 *
 * NONE OF THESE IS CONFIRMED. No note carries `confirmedBy`, so
 * findUnconfirmedValues(cmPack) lists every one of them. An accountant in
 * Cameroon confirms each value before go-live (plan open item 1), and the
 * questions for them are in docs/country-packs/cm.md.
 *
 * The references name the law as it is commonly cited. The article numbers
 * were not checked against the text of the Code Général des Impôts.
 */

const DGI_VAT_LEAFLET =
  'https://www.impots.cm/sites/default/files/documents/ok%20DEPLIANT%20TVA%20et%20DA.pdf';

export const SOURCES = {
  vatStandardRate: {
    reference:
      'Code Général des Impôts, art. 142: taux général de la TVA 17,5 %. DGI, dépliant "TVA et droits d\'accises". Date of entry into force to confirm.',
    url: DGI_VAT_LEAFLET,
  },
  vatCommunalSurcharge: {
    reference:
      'Centimes additionnels communaux: 10 % du montant de la TVA, soit 1,75 % de la base (taux global 19,25 %). DGI, dépliant "TVA et droits d\'accises". Date of entry into force to confirm.',
    url: DGI_VAT_LEAFLET,
  },
  vatZeroRate: {
    reference:
      'Code Général des Impôts, art. 142: taux zéro applicable aux exportations. DGI, dépliant "TVA et droits d\'accises".',
    url: DGI_VAT_LEAFLET,
  },
  vatRounding: {
    reference:
      'No published rule found. The XAF has no minor unit; the pack rounds the 19,25 % total half up to the franc and gives the surcharge the remainder. To confirm with the accountant.',
  },
  vatOnAdvances: {
    reference:
      "Code Général des Impôts, art. 133 et 134 (fait générateur et exigibilité): la TVA est exigible à l'encaissement des acomptes et avances. Article text not checked.",
  },
  invoiceNumbering: {
    reference:
      'Code Général des Impôts, mentions obligatoires des factures: numérotation dans une série continue. Whether the series restarts each year is to confirm.',
  },
} as const satisfies Record<string, SourceNote>;
