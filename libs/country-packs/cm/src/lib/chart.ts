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
 * Chart of accounts templates for Cameroon: SYSCOHADA révisé.
 *
 * Two templates:
 *   - "syscohada.normal": the système normal, with the common accounts of
 *     classes 1 to 8;
 *   - "syscohada.smt": the système minimal de trésorerie for very small
 *     entities, a shorter list.
 *
 * Class 9 (commitments and cost accounting) is left out: nothing posts to it.
 *
 * Account numbers and French names were checked on 2026-11-28 against the
 * "Liste des comptes" of the Acte uniforme relatif au droit comptable et à
 * l'information financière (Journal Officiel OHADA, 15 February 2017, pages
 * 216 to 266), and for a few accounts against the account's own section
 * (pages 271 to 536). Every account here is in the handbook under this
 * number and name. English names are our own translations.
 *
 * STILL UNCONFIRMED: which account holds each role, and what belongs in the
 * SMT list. Those are judgements an accountant makes
 * (docs/country-packs/cm.md).
 *
 * The plan of accounts has more levels than this template uses. 4441 and
 * 4449 have no parent here because their parent, 444, would mix a liability
 * and an asset.
 *
 * A SYSCOHADA class mixes account types: class 4 holds receivables and
 * payables. A parent and its sub-accounts must share a type, so where a
 * two-digit account would mix them (40, 41, 44) the template starts at the
 * three-digit account.
 */

interface Extra {
  parent?: string;
  role?: RegisteredSystemRole;
  locked?: boolean;
  branchPolicy?: BranchPolicy;
  currency?: string;
}

const account = (
  code: string,
  fr: string,
  en: string,
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
  ...(extra.role === undefined && !extra.locked ? {} : { locked: true }),
  ...(extra.branchPolicy === undefined
    ? {}
    : { branchPolicy: extra.branchPolicy }),
  ...(extra.currency === undefined ? {} : { currency: extra.currency }),
});

const HIDDEN: BranchPolicy = 'HIDDEN_IN_BRANCHES';
const EXTENDABLE: BranchPolicy = 'BRANCH_EXTENDABLE';

// prettier-ignore
const NORMAL_ACCOUNTS: readonly ChartTemplateAccount[] = [
  // Class 1: equity and long-term liabilities
  account('10', 'Capital', 'Capital', 'EQUITY', 'CAPITAL', { branchPolicy: HIDDEN }),
  account('101', 'Capital social', 'Share capital', 'EQUITY', 'CAPITAL', { parent: '10', branchPolicy: HIDDEN }),
  account('103', 'Capital personnel', "Owner's capital", 'EQUITY', 'CAPITAL', { parent: '10', branchPolicy: HIDDEN }),
  account('104', "Compte de l'exploitant", "Owner's account", 'EQUITY', 'CAPITAL', { parent: '10', branchPolicy: HIDDEN }),
  account('11', 'Réserves', 'Reserves', 'EQUITY', 'RESERVES', { branchPolicy: HIDDEN }),
  account('111', 'Réserve légale', 'Legal reserve', 'EQUITY', 'RESERVES', { parent: '11', branchPolicy: HIDDEN }),
  account('12', 'Report à nouveau', 'Retained earnings', 'EQUITY', 'RETAINED_EARNINGS', { branchPolicy: HIDDEN }),
  account('121', 'Report à nouveau créditeur', 'Retained earnings (credit)', 'EQUITY', 'RETAINED_EARNINGS', { parent: '12', role: 'equity.retained_earnings', branchPolicy: HIDDEN }),
  account('129', 'Report à nouveau débiteur', 'Accumulated losses (debit)', 'EQUITY', 'RETAINED_EARNINGS', { parent: '12', branchPolicy: HIDDEN }),
  account('13', "Résultat net de l'exercice", 'Net result for the year', 'EQUITY', 'CURRENT_RESULT', { branchPolicy: HIDDEN }),
  account('131', 'Résultat net : bénéfice', 'Net result: profit', 'EQUITY', 'CURRENT_RESULT', { parent: '13', role: 'equity.current_year_result', branchPolicy: HIDDEN }),
  account('139', 'Résultat net : perte', 'Net result: loss', 'EQUITY', 'CURRENT_RESULT', { parent: '13', branchPolicy: HIDDEN }),
  account('16', 'Emprunts et dettes assimilées', 'Borrowings and similar debts', 'LIABILITY', 'BORROWINGS'),
  account('162', 'Emprunts et dettes auprès des établissements de crédit', 'Bank borrowings', 'LIABILITY', 'BORROWINGS', { parent: '16' }),
  account('18', 'Dettes liées à des participations et comptes de liaison des établissements et sociétés en participation', 'Related-party debts and branch current accounts', 'LIABILITY', 'INTER_BRANCH', { branchPolicy: HIDDEN }),
  account('185', 'Comptes permanents non bloqués des établissements et succursales', 'Branch current accounts', 'LIABILITY', 'INTER_BRANCH', { parent: '18', role: 'inter_branch.clearing', branchPolicy: HIDDEN }),

  // Class 2: fixed assets
  account('24', 'Matériel, mobilier et actifs biologiques', 'Equipment, furniture and biological assets', 'ASSET', 'FIXED_ASSET'),
  account('244', 'Matériel et mobilier', 'Equipment and furniture', 'ASSET', 'FIXED_ASSET', { parent: '24' }),
  account('245', 'Matériel de transport', 'Vehicles', 'ASSET', 'FIXED_ASSET', { parent: '24' }),
  account('28', 'Amortissements', 'Accumulated depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION'),
  account('284', 'Amortissements du matériel', 'Accumulated depreciation of equipment', 'ASSET', 'ACCUMULATED_DEPRECIATION', { parent: '28' }),

  // Class 3: stock
  account('31', 'Marchandises', 'Goods for resale', 'ASSET', 'INVENTORY'),
  account('311', 'Marchandises A', 'Goods for resale A', 'ASSET', 'INVENTORY', { parent: '31', role: 'inventory.goods' }),

  // Class 4: third parties
  account('401', 'Fournisseurs, dettes en compte', 'Trade payables', 'LIABILITY', 'AP', { role: 'ap.trade' }),
  account('409', 'Fournisseurs débiteurs', 'Suppliers with debit balances', 'ASSET', 'SUPPLIER_ADVANCES'),
  account('4091', 'Fournisseurs, avances et acomptes versés', 'Advances paid to suppliers', 'ASSET', 'SUPPLIER_ADVANCES', { parent: '409', role: 'supplier_advances' }),
  account('411', 'Clients', 'Trade receivables', 'ASSET', 'AR', { role: 'ar.trade' }),
  account('419', 'Clients créditeurs', 'Customers with credit balances', 'LIABILITY', 'CUSTOMER_ADVANCES'),
  account('4191', 'Clients, avances et acomptes reçus', 'Advances received from customers', 'LIABILITY', 'CUSTOMER_ADVANCES', { parent: '419', role: 'customer_advances' }),
  account('422', 'Personnel, rémunérations dues', 'Salaries payable', 'LIABILITY', 'PAYROLL'),
  account('431', 'Sécurité sociale', 'Social security (CNPS)', 'LIABILITY', 'PAYROLL', { branchPolicy: HIDDEN }),
  account('441', 'État, impôt sur les bénéfices', 'Income tax payable', 'LIABILITY', 'TAX', { branchPolicy: HIDDEN }),
  account('443', 'État, TVA facturée', 'VAT charged', 'LIABILITY', 'VAT_OUTPUT', { branchPolicy: HIDDEN }),
  account('4431', 'TVA facturée sur ventes', 'VAT charged on sales', 'LIABILITY', 'VAT_OUTPUT', { parent: '443', role: 'vat.output', branchPolicy: HIDDEN }),
  account('4432', 'TVA facturée sur prestations de services', 'VAT charged on services', 'LIABILITY', 'VAT_OUTPUT', { parent: '443', branchPolicy: HIDDEN }),
  account('4441', 'État, TVA due', 'VAT payable', 'LIABILITY', 'VAT_PAYABLE', { role: 'vat.payable', branchPolicy: HIDDEN }),
  account('4449', 'État, crédit de TVA à reporter', 'VAT credit carried forward', 'ASSET', 'VAT_CREDIT', { role: 'vat.credit', branchPolicy: HIDDEN }),
  account('445', 'État, TVA récupérable', 'Recoverable VAT', 'ASSET', 'VAT_INPUT', { branchPolicy: HIDDEN }),
  account('4451', 'TVA récupérable sur immobilisations', 'Recoverable VAT on fixed assets', 'ASSET', 'VAT_INPUT', { parent: '445', branchPolicy: HIDDEN }),
  account('4452', 'TVA récupérable sur achats', 'Recoverable VAT on purchases', 'ASSET', 'VAT_INPUT', { parent: '445', role: 'vat.input', branchPolicy: HIDDEN }),
  account('4453', 'TVA récupérable sur transport', 'Recoverable VAT on transport', 'ASSET', 'VAT_INPUT', { parent: '445', branchPolicy: HIDDEN }),
  account('4454', 'TVA récupérable sur services extérieurs et autres charges', 'Recoverable VAT on services and other expenses', 'ASSET', 'VAT_INPUT', { parent: '445', branchPolicy: HIDDEN }),
  account('447', 'État, impôts retenus à la source', 'Taxes withheld at source', 'LIABILITY', 'TAX', { branchPolicy: HIDDEN }),
  account('476', "Charges constatées d'avance", 'Prepaid expenses', 'ASSET', 'PREPAYMENTS'),
  account('477', "Produits constatés d'avance", 'Deferred income', 'LIABILITY', 'DEFERRED_INCOME'),

  // Class 5: cash and bank
  account('52', 'Banques', 'Banks', 'ASSET', 'BANK', { branchPolicy: EXTENDABLE }),
  account('521', 'Banques locales', 'Local banks', 'ASSET', 'BANK', { parent: '52', role: 'bank.main' }),
  account('55', 'Instruments de monnaie électronique', 'Electronic money', 'ASSET', 'MOBILE_MONEY', { branchPolicy: EXTENDABLE }),
  account('552', 'Monnaie électronique : téléphone portable', 'Mobile money wallets', 'ASSET', 'MOBILE_MONEY', { parent: '55', role: 'mobile_money.main' }),
  account('57', 'Caisse', 'Cash', 'ASSET', 'CASH', { branchPolicy: EXTENDABLE }),
  account('571', 'Caisse siège social', 'Cash, head office', 'ASSET', 'CASH', { parent: '57', role: 'cash.main', currency: 'XAF' }),
  account('585', 'Virements de fonds', 'Funds in transit', 'ASSET', 'TRANSFERS'),

  // Class 6: expenses
  account('60', 'Achats et variations de stocks', 'Purchases and changes in stock', 'EXPENSE', 'PURCHASES'),
  account('601', 'Achats de marchandises', 'Purchases of goods for resale', 'EXPENSE', 'PURCHASES', { parent: '60', role: 'expense.purchases.goods' }),
  account('603', 'Variations des stocks de biens achetés', 'Change in stock of purchased goods', 'EXPENSE', 'COGS', { parent: '60' }),
  account('6031', 'Variations des stocks de marchandises', 'Change in stock of goods for resale', 'EXPENSE', 'COGS', { parent: '603', role: 'expense.cogs' }),
  account('605', 'Autres achats', 'Other purchases', 'EXPENSE', 'PURCHASES', { parent: '60' }),
  account('61', 'Transports', 'Transport', 'EXPENSE', 'OPERATING'),
  account('612', 'Transports sur ventes', 'Transport on sales', 'EXPENSE', 'OPERATING', { parent: '61' }),
  account('62', 'Services extérieurs', 'External services', 'EXPENSE', 'OPERATING'),
  account('622', 'Locations, charges locatives', 'Rent and rental charges', 'EXPENSE', 'OPERATING', { parent: '62' }),
  account('63', 'Autres services extérieurs', 'Other external services', 'EXPENSE', 'OPERATING'),
  account('631', 'Frais bancaires', 'Bank charges', 'EXPENSE', 'OPERATING', { parent: '63' }),
  account('6317', 'Frais sur instruments monnaie électronique', 'Electronic money fees', 'EXPENSE', 'OPERATING', { parent: '631' }),
  account('6318', 'Autres frais bancaires', 'Other bank charges', 'EXPENSE', 'OPERATING', { parent: '631' }),
  account('64', 'Impôts et taxes', 'Taxes and duties', 'EXPENSE', 'TAXES'),
  account('641', 'Impôts et taxes directs', 'Direct taxes and duties', 'EXPENSE', 'TAXES', { parent: '64' }),
  account('65', 'Autres charges', 'Other expenses', 'EXPENSE', 'OPERATING'),
  account('656', 'Perte de change sur créances et dettes commerciales', 'Exchange losses on trade receivables and payables', 'EXPENSE', 'OPERATING', { parent: '65', role: 'fx.loss.trade' }),
  account('658', 'Charges diverses', 'Sundry expenses', 'EXPENSE', 'OPERATING', { parent: '65' }),
  account('6588', 'Autres charges diverses', 'Other sundry expenses', 'EXPENSE', 'OPERATING', { parent: '658', role: 'rounding.difference' }),
  account('66', 'Charges de personnel', 'Staff costs', 'EXPENSE', 'PAYROLL'),
  account('661', 'Rémunérations directes versées au personnel national', 'Salaries paid to national staff', 'EXPENSE', 'PAYROLL', { parent: '66' }),
  account('664', 'Charges sociales', 'Social charges', 'EXPENSE', 'PAYROLL', { parent: '66' }),
  account('67', 'Frais financiers et charges assimilées', 'Financial expenses', 'EXPENSE', 'FINANCIAL'),
  account('671', 'Intérêts des emprunts', 'Interest on borrowings', 'EXPENSE', 'FINANCIAL', { parent: '67' }),
  account('673', 'Escomptes accordés', 'Discounts allowed', 'EXPENSE', 'FINANCIAL', { parent: '67', role: 'expense.discounts_allowed' }),
  account('676', 'Pertes de change financières', 'Financial exchange losses', 'EXPENSE', 'FINANCIAL', { parent: '67', role: 'fx.loss.financial' }),
  account('68', 'Dotations aux amortissements', 'Depreciation', 'EXPENSE', 'DEPRECIATION'),
  account('681', "Dotations aux amortissements d'exploitation", 'Operating depreciation', 'EXPENSE', 'DEPRECIATION', { parent: '68' }),

  // Class 7: income
  account('70', 'Ventes', 'Sales', 'INCOME', 'SALES'),
  account('701', 'Ventes de marchandises', 'Sales of goods', 'INCOME', 'SALES', { parent: '70', role: 'income.sales.goods' }),
  account('706', 'Services vendus', 'Services sold', 'INCOME', 'SALES', { parent: '70', role: 'income.sales.services' }),
  account('707', 'Produits accessoires', 'Ancillary income', 'INCOME', 'SALES', { parent: '70' }),
  account('75', 'Autres produits', 'Other income', 'INCOME', 'OTHER_INCOME'),
  account('756', 'Gains de change sur créances et dettes commerciales', 'Exchange gains on trade receivables and payables', 'INCOME', 'OTHER_INCOME', { parent: '75', role: 'fx.gain.trade' }),
  account('758', 'Produits divers', 'Sundry income', 'INCOME', 'OTHER_INCOME', { parent: '75' }),
  account('7588', 'Autres produits divers', 'Other sundry income', 'INCOME', 'OTHER_INCOME', { parent: '758', role: 'income.other.forfeited_deposits' }),
  account('77', 'Revenus financiers et produits assimilés', 'Financial income', 'INCOME', 'FINANCIAL'),
  account('773', 'Escomptes obtenus', 'Discounts received', 'INCOME', 'FINANCIAL', { parent: '77', role: 'income.discounts_received' }),
  account('776', 'Gains de change financiers', 'Financial exchange gains', 'INCOME', 'FINANCIAL', { parent: '77', role: 'fx.gain.financial' }),

  // Class 8: income tax
  account('89', 'Impôts sur le résultat', 'Income tax', 'EXPENSE', 'INCOME_TAX', { branchPolicy: HIDDEN }),
  account('891', "Impôts sur les bénéfices de l'exercice", 'Income tax for the year', 'EXPENSE', 'INCOME_TAX', { parent: '89', branchPolicy: HIDDEN }),
];

/**
 * Accounts of the normal chart left out of the SMT template.
 *
 * The handbook prescribes no list of accounts for the SMT. It asks for a
 * cash journal, a few registers and three short statements (pages 1074 to
 * 1083). This template is therefore our own construction: the normal chart
 * without what a sole trader on SMT has no use for.
 *
 *   - Kept, because the SMT statements have a line for them: borrowings
 *     (16), equipment and its depreciation (24, 28, 68), taxes (64), interest
 *     (671), the owner's capital and account (103, 104).
 *   - Kept, because a product posts to them: every account holding a role,
 *     including the VAT accounts, which the SMT statements do not show.
 *   - Left out: share capital and reserves (a company's, not a sole
 *     trader's), income tax on company profits, and detail accounts.
 */
const NOT_IN_SMT: ReadonlySet<string> = new Set([
  '101',
  '11',
  '111',
  '4432',
  '4451',
  '4453',
  '4454',
  '447',
  '476',
  '477',
  '585',
  '605',
  '61',
  '612',
  '707',
  '89',
  '891',
]);

export const SYSCOHADA_NORMAL: ChartTemplate = {
  key: 'syscohada.normal',
  name: localizedText('SYSCOHADA: normal system', 'SYSCOHADA : système normal'),
  framework: 'SYSCOHADA',
  accounts: NORMAL_ACCOUNTS,
};

export const SYSCOHADA_SMT: ChartTemplate = {
  key: 'syscohada.smt',
  name: localizedText(
    'SYSCOHADA: minimal cash system (SMT)',
    'SYSCOHADA : système minimal de trésorerie (SMT)',
  ),
  framework: 'SYSCOHADA',
  accounts: NORMAL_ACCOUNTS.filter((item) => !NOT_IN_SMT.has(item.code)),
};

export const CM_CHART: PackChart = {
  templates: [SYSCOHADA_NORMAL, SYSCOHADA_SMT],
  // A SYSCOHADA code starts with its class digit and has at least two digits.
  codePattern: /^[1-9]\d+$/,
  requiredRoles: {
    core: [
      'cash.main',
      'bank.main',
      'mobile_money.main',
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
      'expense.discounts_allowed',
      'vat.output',
    ],
    purchases: [
      'ap.trade',
      'supplier_advances',
      'expense.purchases.goods',
      'income.discounts_received',
      'vat.input',
    ],
    inventory: ['inventory.goods', 'expense.cogs'],
    tax: ['vat.payable', 'vat.credit'],
  },
};
