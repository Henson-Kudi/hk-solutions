import type {
  PostingDimension,
  PostingRuleSeed,
  PostingRuleSetSeed,
  RegisteredSystemRole,
} from '@hk/country-packs/kernel';

/**
 * The posting rules a new Cameroon business starts with.
 *
 * A rule says: when an event of this type carries a line of this kind, post
 * it to the account holding this role, on this side. The posting engine in
 * core applies them; a business can override a rule later.
 *
 * PROVISIONAL. The events and line kinds below are the ones the plan
 * describes (sections 8.5 and 10.3). The products that emit them are built in
 * phase 5, and their PRs settle the exact topics and line kinds. Until then
 * these rules show the shape and let the pack be validated.
 */

const ANALYTIC: readonly PostingDimension[] = [
  'branch',
  'department',
  'project',
  'cost_center',
];
const THIRD_PARTY: readonly PostingDimension[] = ['branch', 'contact'];
const BRANCH: readonly PostingDimension[] = ['branch'];

const rule = (
  eventType: string,
  lineKind: string,
  side: PostingRuleSeed['side'],
  role: RegisteredSystemRole,
  dimensions: readonly PostingDimension[],
): PostingRuleSeed => ({ eventType, lineKind, side, role, dimensions });

export const CM_POSTING_RULES: PostingRuleSetSeed = {
  rules: [
    // A sales invoice: Dr receivable, Cr revenue, Cr VAT.
    rule(
      'sales.invoice.issued',
      'line.receivable',
      'debit',
      'ar.trade',
      THIRD_PARTY,
    ),
    rule(
      'sales.invoice.issued',
      'line.revenue.goods',
      'credit',
      'income.sales.goods',
      ANALYTIC,
    ),
    rule(
      'sales.invoice.issued',
      'line.revenue.services',
      'credit',
      'income.sales.services',
      ANALYTIC,
    ),
    rule('sales.invoice.issued', 'line.tax', 'credit', 'vat.output', BRANCH),
    // Transport and delivery charged to the customer on the invoice.
    rule(
      'sales.invoice.issued',
      'line.freight',
      'credit',
      'income.sales.freight',
      ANALYTIC,
    ),
    // A rebate not tied to one line, shown on the invoice or on a credit note.
    rule(
      'sales.invoice.issued',
      'line.rebate',
      'debit',
      'income.sales.rebates',
      ANALYTIC,
    ),
    // Advances applied to the invoice at collection: Dr advances, Cr receivable.
    rule(
      'sales.invoice.issued',
      'line.advance_applied',
      'debit',
      'customer_advances',
      THIRD_PARTY,
    ),
    rule(
      'sales.invoice.issued',
      'line.advance_settled',
      'credit',
      'ar.trade',
      THIRD_PARTY,
    ),

    // A part-payment on a pre-order: Cr advances. VAT is due on receipt, so
    // the VAT share moves out of advances: Dr advances, Cr VAT.
    rule(
      'sales.preorder.payment_received',
      'line.advance',
      'credit',
      'customer_advances',
      THIRD_PARTY,
    ),
    rule(
      'sales.preorder.payment_received',
      'line.advance_tax',
      'debit',
      'customer_advances',
      THIRD_PARTY,
    ),
    rule(
      'sales.preorder.payment_received',
      'line.tax',
      'credit',
      'vat.output',
      BRANCH,
    ),
    // A forfeited deposit: Dr advances, Cr other income.
    rule(
      'sales.preorder.forfeited',
      'line.advance',
      'debit',
      'customer_advances',
      THIRD_PARTY,
    ),
    rule(
      'sales.preorder.forfeited',
      'line.forfeit',
      'credit',
      'income.other.forfeited_deposits',
      ANALYTIC,
    ),

    // A supplier bill: Dr purchases, Dr recoverable VAT, Cr payable.
    rule(
      'purchases.bill.recorded',
      'line.purchase.goods',
      'debit',
      'expense.purchases.goods',
      ANALYTIC,
    ),
    rule('purchases.bill.recorded', 'line.tax', 'debit', 'vat.input', BRANCH),
    // Transport, customs and insurance the supplier charged on the bill.
    rule(
      'purchases.bill.recorded',
      'line.freight',
      'debit',
      'expense.purchases.freight',
      ANALYTIC,
    ),
    rule(
      'purchases.bill.recorded',
      'line.rebate',
      'credit',
      'expense.purchases.rebates',
      ANALYTIC,
    ),
    rule(
      'purchases.bill.recorded',
      'line.payable',
      'credit',
      'ap.trade',
      THIRD_PARTY,
    ),
  ],
};
