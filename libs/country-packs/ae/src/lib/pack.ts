import {
  standardPostingRules,
  type CountryPack,
} from '@hk/country-packs/kernel';
import { localizedText } from '@hk/platform/universal';
import { AE_BUSINESS } from './business';
import { AE_CHART } from './chart';
import { SOURCES } from './sources';
import { createAeTaxEngine } from './tax/engine';

const tax = createAeTaxEngine();

/**
 * The United Arab Emirates country pack.
 *
 * Every tax value, account and ID format in it is unconfirmed until a tax
 * adviser in the UAE has reviewed it: see docs/country-packs/ae.md.
 */
export const aePack: CountryPack = {
  code: 'AE',
  name: localizedText('United Arab Emirates', 'Émirats arabes unis'),
  currencies: { functional: ['AED'], minorUnits: { AED: 2 } },
  // Arabic (ar-AE, right to left) is added when the app has Arabic text.
  locales: ['en-AE'],
  fiscal: {
    defaultYearStartMonth: 1,
    legalNumbering: [
      {
        documentType: 'sales.invoice',
        gapFree: true,
        resets: 'never',
        source: SOURCES.invoiceNumbering,
      },
      {
        documentType: 'sales.credit_note',
        gapFree: true,
        resets: 'never',
        source: SOURCES.invoiceNumbering,
      },
    ],
  },
  business: AE_BUSINESS,
  chart: AE_CHART,
  // The standard rules. Tax is posted when an advance is received, because
  // the date of supply is the earliest of supply, invoice and payment.
  postingRules: standardPostingRules({
    taxOnAdvances: tax.advances.taxDueOnReceipt,
  }),
  tax,
  // No payroll engine yet (gratuity, GPSSA, WPS files are plan row 8.2), and
  // no e-invoicing adapter yet (phase 9).
  reports: [
    {
      key: 'ae.vat201',
      name: localizedText(
        'VAT return workpaper (VAT201)',
        'Feuille de travail de la déclaration de TVA (VAT201)',
      ),
      kind: 'tax_return',
    },
    {
      key: 'ae.corporate_tax',
      name: localizedText(
        'Corporate Tax workpaper',
        "Feuille de travail de l'impôt sur les sociétés",
      ),
      kind: 'tax_return',
      capability: 'tax.corporate_tax',
    },
    {
      key: 'ae.audit_file',
      name: localizedText('Audit file export', "Export du fichier d'audit"),
      kind: 'export',
    },
  ],
  payments: [
    { key: 'cash', name: localizedText('Cash', 'Espèces'), kind: 'cash' },
    {
      key: 'card',
      name: localizedText('Bank card', 'Carte bancaire'),
      kind: 'card',
    },
    {
      key: 'bank_transfer',
      name: localizedText('Bank transfer', 'Virement bancaire'),
      kind: 'bank_transfer',
    },
  ],
  capabilities: ['tax.corporate_tax'],
  products: {
    accounting: 'AVAILABLE',
    sales: 'AVAILABLE',
    purchases: 'AVAILABLE',
    tax: 'AVAILABLE',
    banking: 'AVAILABLE',
    inventory: 'AVAILABLE',
    pos: 'AVAILABLE',
    storefront: 'AVAILABLE',
    hr: 'AVAILABLE',
    // Needs a payroll engine, which this pack does not have yet (row 8.2).
    payroll: 'UNAVAILABLE',
    assets: 'AVAILABLE',
    projects: 'AVAILABLE',
    crm: 'AVAILABLE',
    budgeting: 'AVAILABLE',
    multi_business: 'AVAILABLE',
  },
};
