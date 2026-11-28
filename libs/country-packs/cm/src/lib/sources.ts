import type { SourceNote } from '@hk/country-packs/kernel';

/**
 * Where the Cameroon pack's values come from.
 *
 * The references below were read in the Code Général des Impôts, édition
 * 2026, published by the Direction Générale des Impôts (French and English
 * versions), on 2026-11-28. The article numbers and the rules quoted are as
 * printed there.
 *
 * NONE IS CONFIRMED BY AN ACCOUNTANT. No note carries `confirmedBy`, so
 * findUnconfirmedValues(cmPack) lists every one of them. Reading the law is
 * not the same as applying it correctly: an accountant in Cameroon confirms
 * each value before go-live (plan open item 1), and the questions for them
 * are in docs/country-packs/cm.md.
 *
 * What the 2026 edition does not tell us is when each rate began. The pack
 * takes 2005-01-01 from a secondary source; that date is a question on the
 * checklist.
 */

const CGI = 'Code Général des Impôts, édition 2026 (DGI)';

export const SOURCES = {
  vatStandardRate: {
    reference: `${CGI}, art. 142 (1) a: taux général 17,5 %. Start date not verified.`,
  },
  vatCommunalSurcharge: {
    reference: `${CGI}, art. C 83 (1): centimes additionnels communaux, 10 % du principal de la TVA, soit 1,75 % de la base; art. 142 (2). Start date not verified.`,
  },
  vatZeroRate: {
    reference: `${CGI}, art. 142 (1) a et (4): taux zéro, exportations de produits taxables. Start date not verified.`,
  },
  vatRounding: {
    reference: `${CGI}, art. 141: la base imposable est arrondie au millier de F CFA inférieur. The pack does NOT apply this to invoice lines: it rounds the tax half up to the franc and gives the surcharge the remainder. Whether art. 141 applies to each invoice or only to the monthly return is to confirm.`,
  },
  vatOnAdvances: {
    reference: `${CGI}, art. 134 (1) a et b: en cas de versement d'un acompte, la taxe devient exigible au moment de son encaissement, à concurrence du montant encaissé.`,
  },
  vatLiability: {
    reference: `${CGI}, art. 132: seules sont soumises à la TVA les personnes imposables selon le régime réel; art. 93 quater: seuils du régime réel et de l'impôt général synthétique.`,
  },
  taxRegimes: {
    reference: `${CGI}, art. 93 ter et 93 quater.`,
  },
  invoiceNumbering: {
    reference: `${CGI}, art. 150 (5) lists what an invoice must show and does not mention numbering. Gap-free numbering in a series that never restarts is the pack's own cautious default, to confirm.`,
  },
} as const satisfies Record<string, SourceNote>;
