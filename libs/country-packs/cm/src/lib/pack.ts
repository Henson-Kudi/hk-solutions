import type { CountryPack } from '@hk/country-packs/kernel';
import { localizedText } from '@hk/platform/universal';
import { CM_BUSINESS } from './business';
import { CM_CHART } from './chart';
import { CM_POSTING_RULES } from './posting-rules';
import { SOURCES } from './sources';
import { createCmTaxEngine } from './tax/engine';

/**
 * The Cameroon country pack.
 *
 * Every tax value, account and ID format in it is unconfirmed until an
 * accountant in Cameroon has reviewed it: see docs/country-packs/cm.md.
 */
export const cmPack: CountryPack = {
  code: 'CM',
  name: localizedText('Cameroon', 'Cameroun'),
  currencies: { functional: ['XAF'], minorUnits: { XAF: 0 } },
  // French first: it is the language of most tax and accounting documents.
  locales: ['fr-CM', 'en-CM'],
  fiscal: {
    // The OHADA accounting year is the calendar year.
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
  business: CM_BUSINESS,
  chart: CM_CHART,
  postingRules: CM_POSTING_RULES,
  tax: createCmTaxEngine(),
  // No payroll engine yet: CNPS, IRPP and the other payroll rules are plan row 8.2.
  reports: [
    {
      key: 'syscohada.bilan',
      name: localizedText('Balance sheet (SYSCOHADA)', 'Bilan (SYSCOHADA)'),
      kind: 'financial_statement',
      capability: 'reports.syscohada',
    },
    {
      key: 'syscohada.compte_de_resultat',
      name: localizedText(
        'Income statement (SYSCOHADA)',
        'Compte de résultat (SYSCOHADA)',
      ),
      kind: 'financial_statement',
      capability: 'reports.syscohada',
    },
    {
      key: 'syscohada.tft',
      name: localizedText(
        'Cash flow statement (SYSCOHADA)',
        'Tableau des flux de trésorerie (SYSCOHADA)',
      ),
      kind: 'financial_statement',
      capability: 'reports.syscohada',
    },
    {
      key: 'syscohada.notes',
      name: localizedText(
        'Notes to the accounts (SYSCOHADA)',
        'Notes annexes (SYSCOHADA)',
      ),
      kind: 'financial_statement',
      capability: 'reports.syscohada',
    },
    {
      key: 'cm.vat_return',
      name: localizedText('VAT return', 'Déclaration de TVA'),
      kind: 'tax_return',
    },
    {
      key: 'cm.dsf',
      name: localizedText(
        'Annual tax and statistics return (DSF) support',
        'Déclaration statistique et fiscale (DSF) : états de support',
      ),
      kind: 'export',
    },
  ],
  payments: [
    { key: 'cash', name: localizedText('Cash', 'Espèces'), kind: 'cash' },
    {
      key: 'mtn_momo',
      name: localizedText('MTN Mobile Money', 'MTN Mobile Money'),
      kind: 'mobile_money',
    },
    {
      key: 'orange_money',
      name: localizedText('Orange Money', 'Orange Money'),
      kind: 'mobile_money',
    },
    {
      key: 'card',
      name: localizedText('Bank card', 'Carte bancaire'),
      kind: 'card',
    },
  ],
  capabilities: ['payments.mobile_money', 'reports.syscohada'],
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
