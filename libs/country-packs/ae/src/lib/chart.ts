import type {
  AccountType,
  BranchPolicy,
  ChartTemplate,
  ChartTemplateAccount,
  PackChart,
  RegisteredSystemRole,
} from '@hk/country-packs/kernel';
import { localizedText } from '@hk/platform/universal';

/**
 * Chart of accounts template for the UAE.
 *
 * THE UAE PRESCRIBES NO CHART OF ACCOUNTS. Businesses report under IFRS (or
 * IFRS for SMEs), which sets what the statements show, not account numbers.
 * This chart is therefore our own: a common four-digit layout,
 *
 *   1xxx assets   2xxx liabilities   3xxx equity   4xxx income   5xxx expenses
 *
 * with the accounts a small trading or service business needs, including the
 * UAE-specific ones: VAT, customer advances, the end-of-service benefits
 * provision and a WPS (wage protection system) clearing account.
 *
 * UNCONFIRMED. An accountant in the UAE reviews the list and which account
 * holds each role before go-live (docs/country-packs/ae.md).
 */

interface Extra {
  parent?: string;
  role?: RegisteredSystemRole;
  branchPolicy?: BranchPolicy;
  currency?: string;
}

const account = (
  code: string,
  en: string,
  fr: string,
  type: AccountType,
  subtype: string,
  extra: Extra = {},
): ChartTemplateAccount => ({
  code,
  name: localizedText(en, fr),
  type,
  subtype,
  frameworkClass: code.slice(0, 1),
  ...(extra.parent === undefined ? {} : { parentCode: extra.parent }),
  ...(extra.role === undefined ? {} : { systemRole: extra.role }),
  // An account a posting rule depends on cannot be renumbered or re-purposed.
  ...(extra.role === undefined ? {} : { locked: true }),
  ...(extra.branchPolicy === undefined
    ? {}
    : { branchPolicy: extra.branchPolicy }),
  ...(extra.currency === undefined ? {} : { currency: extra.currency }),
});

const HIDDEN: BranchPolicy = 'HIDDEN_IN_BRANCHES';
const EXTENDABLE: BranchPolicy = 'BRANCH_EXTENDABLE';

// prettier-ignore
const ACCOUNTS: readonly ChartTemplateAccount[] = [
  // 1xxx Assets
  account('1100', 'Cash on hand', 'Caisse', 'ASSET', 'CASH', { branchPolicy: EXTENDABLE }),
  account('1110', 'Main cash', 'Caisse principale', 'ASSET', 'CASH', { parent: '1100', role: 'cash.main', currency: 'AED' }),
  account('1200', 'Bank accounts', 'Comptes bancaires', 'ASSET', 'BANK', { branchPolicy: EXTENDABLE }),
  account('1210', 'Main bank account', 'Compte bancaire principal', 'ASSET', 'BANK', { parent: '1200', role: 'bank.main' }),
  account('1300', 'Receivables', 'Créances', 'ASSET', 'AR'),
  account('1310', 'Trade receivables', 'Créances clients', 'ASSET', 'AR', { parent: '1300', role: 'ar.trade' }),
  account('1320', 'Advances to suppliers', 'Avances aux fournisseurs', 'ASSET', 'SUPPLIER_ADVANCES', { parent: '1300', role: 'supplier_advances' }),
  account('1330', 'Prepaid expenses', "Charges constatées d'avance", 'ASSET', 'PREPAYMENTS', { parent: '1300' }),
  account('1400', 'Inventory', 'Stocks', 'ASSET', 'INVENTORY'),
  account('1410', 'Goods for resale', 'Marchandises', 'ASSET', 'INVENTORY', { parent: '1400', role: 'inventory.goods' }),
  account('1500', 'Tax assets', 'Créances fiscales', 'ASSET', 'TAX', { branchPolicy: HIDDEN }),
  account('1510', 'Input VAT recoverable', 'TVA déductible', 'ASSET', 'VAT_INPUT', { parent: '1500', role: 'vat.input', branchPolicy: HIDDEN }),
  account('1520', 'VAT refundable', 'Crédit de TVA', 'ASSET', 'VAT_CREDIT', { parent: '1500', role: 'vat.credit', branchPolicy: HIDDEN }),
  account('1600', 'Property and equipment', 'Immobilisations corporelles', 'ASSET', 'FIXED_ASSET'),
  account('1610', 'Equipment and furniture', 'Matériel et mobilier', 'ASSET', 'FIXED_ASSET', { parent: '1600' }),
  account('1620', 'Vehicles', 'Véhicules', 'ASSET', 'FIXED_ASSET', { parent: '1600' }),
  account('1690', 'Accumulated depreciation', 'Amortissements cumulés', 'ASSET', 'ACCUMULATED_DEPRECIATION', { parent: '1600' }),

  // 2xxx Liabilities
  account('2100', 'Payables', 'Dettes', 'LIABILITY', 'AP'),
  account('2110', 'Trade payables', 'Dettes fournisseurs', 'LIABILITY', 'AP', { parent: '2100', role: 'ap.trade' }),
  account('2120', 'Customer advances', 'Avances reçues des clients', 'LIABILITY', 'CUSTOMER_ADVANCES', { parent: '2100', role: 'customer_advances' }),
  account('2130', 'Accrued expenses', 'Charges à payer', 'LIABILITY', 'ACCRUALS', { parent: '2100' }),
  account('2200', 'Tax liabilities', 'Dettes fiscales', 'LIABILITY', 'TAX', { branchPolicy: HIDDEN }),
  account('2210', 'Output VAT', 'TVA collectée', 'LIABILITY', 'VAT_OUTPUT', { parent: '2200', role: 'vat.output', branchPolicy: HIDDEN }),
  account('2220', 'VAT payable to the FTA', "TVA à payer à l'administration fiscale", 'LIABILITY', 'VAT_PAYABLE', { parent: '2200', role: 'vat.payable', branchPolicy: HIDDEN }),
  account('2230', 'Corporate tax payable', 'Impôt sur les sociétés à payer', 'LIABILITY', 'TAX', { parent: '2200', branchPolicy: HIDDEN }),
  account('2300', 'Employee liabilities', 'Dettes envers le personnel', 'LIABILITY', 'PAYROLL'),
  account('2310', 'Salaries payable', 'Salaires à payer', 'LIABILITY', 'PAYROLL', { parent: '2300' }),
  account('2320', 'WPS clearing', 'Compte de compensation WPS', 'LIABILITY', 'PAYROLL', { parent: '2300' }),
  account('2330', 'End-of-service benefits provision', 'Provision pour indemnités de fin de service', 'LIABILITY', 'PAYROLL', { parent: '2300' }),
  account('2400', 'Borrowings', 'Emprunts', 'LIABILITY', 'BORROWINGS'),
  account('2410', 'Bank loans', 'Emprunts bancaires', 'LIABILITY', 'BORROWINGS', { parent: '2400' }),
  account('2900', 'Inter-branch accounts', 'Comptes inter-succursales', 'LIABILITY', 'INTER_BRANCH', { branchPolicy: HIDDEN }),
  account('2910', 'Inter-branch clearing', 'Compte de liaison inter-succursales', 'LIABILITY', 'INTER_BRANCH', { parent: '2900', role: 'inter_branch.clearing', branchPolicy: HIDDEN }),

  // 3xxx Equity
  account('3100', 'Share capital', 'Capital social', 'EQUITY', 'CAPITAL', { branchPolicy: HIDDEN }),
  account('3200', "Owner's current account", "Compte courant de l'exploitant", 'EQUITY', 'CAPITAL', { branchPolicy: HIDDEN }),
  account('3300', 'Statutory reserve', 'Réserve légale', 'EQUITY', 'RESERVES', { branchPolicy: HIDDEN }),
  account('3400', 'Retained earnings', 'Résultats non distribués', 'EQUITY', 'RETAINED_EARNINGS', { role: 'equity.retained_earnings', branchPolicy: HIDDEN }),
  account('3500', 'Result for the year', "Résultat de l'exercice", 'EQUITY', 'CURRENT_RESULT', { role: 'equity.current_year_result', branchPolicy: HIDDEN }),

  // 4xxx Income
  account('4100', 'Revenue', "Chiffre d'affaires", 'INCOME', 'SALES'),
  account('4110', 'Sales of goods', 'Ventes de marchandises', 'INCOME', 'SALES', { parent: '4100', role: 'income.sales.goods' }),
  account('4120', 'Sales of services', 'Prestations de services', 'INCOME', 'SALES', { parent: '4100', role: 'income.sales.services' }),
  account('4130', 'Delivery charged to customers', 'Frais de livraison facturés', 'INCOME', 'SALES', { parent: '4100', role: 'income.sales.freight' }),
  account('4190', 'Sales discounts and rebates', 'Remises et ristournes accordées', 'INCOME', 'SALES', { parent: '4100', role: 'income.sales.rebates' }),
  account('4200', 'Other income', 'Autres produits', 'INCOME', 'OTHER_INCOME'),
  account('4210', 'Settlement discounts received', 'Escomptes obtenus', 'INCOME', 'OTHER_INCOME', { parent: '4200', role: 'income.discounts_received' }),
  account('4220', 'Forfeited customer deposits', 'Acomptes clients conservés', 'INCOME', 'OTHER_INCOME', { parent: '4200', role: 'income.other.forfeited_deposits' }),
  account('4230', 'Exchange gains on trade balances', 'Gains de change sur créances et dettes commerciales', 'INCOME', 'OTHER_INCOME', { parent: '4200', role: 'fx.gain.trade' }),
  account('4240', 'Exchange gains on cash and loans', 'Gains de change financiers', 'INCOME', 'FINANCIAL', { parent: '4200', role: 'fx.gain.financial' }),

  // 5xxx Expenses
  account('5100', 'Cost of sales', 'Coût des ventes', 'EXPENSE', 'COGS'),
  account('5110', 'Cost of goods sold', 'Coût des marchandises vendues', 'EXPENSE', 'COGS', { parent: '5100', role: 'expense.cogs' }),
  account('5120', 'Purchases of goods', 'Achats de marchandises', 'EXPENSE', 'PURCHASES', { parent: '5100', role: 'expense.purchases.goods' }),
  account('5130', 'Freight, customs and other purchase costs', 'Frais sur achats (transport, douane)', 'EXPENSE', 'PURCHASES', { parent: '5100', role: 'expense.purchases.freight' }),
  account('5190', 'Purchase discounts and rebates', 'Remises et ristournes obtenues', 'EXPENSE', 'PURCHASES', { parent: '5100', role: 'expense.purchases.rebates' }),
  account('5200', 'Operating expenses', "Charges d'exploitation", 'EXPENSE', 'OPERATING'),
  account('5210', 'Salaries and wages', 'Salaires et traitements', 'EXPENSE', 'PAYROLL', { parent: '5200' }),
  account('5220', 'End-of-service benefits', 'Indemnités de fin de service', 'EXPENSE', 'PAYROLL', { parent: '5200' }),
  account('5230', 'Rent', 'Loyers', 'EXPENSE', 'OPERATING', { parent: '5200' }),
  account('5240', 'Delivery and transport on sales', 'Transport sur ventes', 'EXPENSE', 'OPERATING', { parent: '5200', role: 'expense.sales.transport' }),
  account('5250', 'Bank and payment charges', 'Frais bancaires et de paiement', 'EXPENSE', 'OPERATING', { parent: '5200' }),
  account('5260', 'Depreciation', 'Dotations aux amortissements', 'EXPENSE', 'DEPRECIATION', { parent: '5200' }),
  account('5290', 'Rounding differences', "Écarts d'arrondi", 'EXPENSE', 'OPERATING', { parent: '5200', role: 'rounding.difference' }),
  account('5300', 'Finance costs', 'Charges financières', 'EXPENSE', 'FINANCIAL'),
  account('5310', 'Interest expense', "Charges d'intérêts", 'EXPENSE', 'FINANCIAL', { parent: '5300' }),
  account('5320', 'Settlement discounts allowed', 'Escomptes accordés', 'EXPENSE', 'FINANCIAL', { parent: '5300', role: 'expense.discounts_allowed' }),
  account('5330', 'Exchange losses on trade balances', 'Pertes de change sur créances et dettes commerciales', 'EXPENSE', 'OPERATING', { parent: '5300', role: 'fx.loss.trade' }),
  account('5340', 'Exchange losses on cash and loans', 'Pertes de change financières', 'EXPENSE', 'FINANCIAL', { parent: '5300', role: 'fx.loss.financial' }),
  account('5400', 'Income tax', 'Impôt sur le résultat', 'EXPENSE', 'INCOME_TAX', { branchPolicy: HIDDEN }),
  account('5410', 'Corporate tax expense', 'Charge d’impôt sur les sociétés', 'EXPENSE', 'INCOME_TAX', { parent: '5400', branchPolicy: HIDDEN }),
];

export const IFRS_STANDARD: ChartTemplate = {
  key: 'ifrs.standard',
  name: localizedText(
    'Standard chart (IFRS)',
    'Plan comptable standard (IFRS)',
  ),
  framework: 'IFRS',
  accounts: ACCOUNTS,
};

export const AE_CHART: PackChart = {
  templates: [IFRS_STANDARD],
  // Four digits, the first being the class: 1 assets to 5 expenses.
  codePattern: /^[1-5]\d{3}$/,
  requiredRoles: {
    core: [
      'cash.main',
      'bank.main',
      'equity.retained_earnings',
      'equity.current_year_result',
      'fx.gain.trade',
      'fx.loss.trade',
      'fx.gain.financial',
      'fx.loss.financial',
      'rounding.difference',
      'inter_branch.clearing',
    ],
    sales: [
      'ar.trade',
      'customer_advances',
      'income.sales.goods',
      'income.sales.services',
      'income.other.forfeited_deposits',
      'income.sales.freight',
      'income.sales.rebates',
      'expense.sales.transport',
      'expense.discounts_allowed',
      'vat.output',
    ],
    purchases: [
      'ap.trade',
      'supplier_advances',
      'expense.purchases.goods',
      'expense.purchases.freight',
      'expense.purchases.rebates',
      'income.discounts_received',
      'vat.input',
    ],
    inventory: ['inventory.goods', 'expense.cogs'],
    tax: ['vat.payable', 'vat.credit'],
  },
};
