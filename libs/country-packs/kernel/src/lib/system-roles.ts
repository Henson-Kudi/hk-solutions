/**
 * System roles: stable names for what an account is for.
 *
 * Posting rules and products name a role ("ar.trade"), never an account
 * code. Each country's chart says which of its accounts holds the role: 411
 * in a SYSCOHADA chart, 1210 in an IFRS one. So the same product code posts
 * correctly in every country.
 *
 * That only works if every pack uses the same names, so they are listed here
 * and a pack may not invent one. A role is added in the PR that first needs
 * it. Not every pack holds every role: a country without mobile money has no
 * account for "mobile_money.main".
 */
export const SYSTEM_ROLES = {
  // Receivables and payables
  'ar.trade': 'Amounts customers owe for invoices',
  'ap.trade': 'Amounts owed to suppliers for bills',
  customer_advances: 'Money received from customers before the sale',
  supplier_advances: 'Money paid to suppliers before the purchase',

  // Money
  'cash.main': 'Cash in hand',
  'bank.main': 'Bank accounts',
  'mobile_money.main': 'Mobile money wallets',

  // VAT
  'vat.output': 'VAT charged to customers',
  'vat.input': 'VAT paid to suppliers that can be recovered',
  'vat.payable': 'VAT owed to the tax authority after a return',
  'vat.credit': 'VAT credit carried forward after a return',

  // Income
  'income.sales.goods': 'Sales of goods',
  'income.sales.services': 'Sales of services',
  'income.other.forfeited_deposits': 'Customer deposits kept after a forfeit',
  'income.discounts_received': 'Settlement discounts from suppliers',

  // Expenses and stock
  'expense.purchases.goods': 'Purchases of goods for resale',
  'expense.cogs': 'Cost of the goods that were sold',
  'expense.discounts_allowed': 'Settlement discounts given to customers',
  'inventory.goods': 'Goods held for resale',

  // Adjustments
  // Exchange differences are split, because some frameworks (SYSCOHADA)
  // report those on customer and supplier balances in operating result
  // and those on cash and borrowings in financial result.
  'fx.gain.trade': 'Exchange gains on customer and supplier balances',
  'fx.loss.trade': 'Exchange losses on customer and supplier balances',
  'fx.gain.financial': 'Exchange gains on cash, bank and borrowings',
  'fx.loss.financial': 'Exchange losses on cash, bank and borrowings',
  'rounding.difference': 'Differences left by rounding to the currency',
  'inter_branch.clearing': 'Transfers between branches of one business',

  // Equity
  'equity.retained_earnings': 'Results of earlier years carried forward',
  'equity.current_year_result': 'Result of the year being closed',
} as const;

export type RegisteredSystemRole = keyof typeof SYSTEM_ROLES;

export const isSystemRole = (value: unknown): value is RegisteredSystemRole =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(SYSTEM_ROLES, value);
