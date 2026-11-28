import { standardPostingRules } from './posting-rule-seeds';
import { isSystemRole } from './system-roles';

const journal = (taxOnAdvances: boolean, eventType: string) =>
  standardPostingRules({ taxOnAdvances })
    .rules.filter((rule) => rule.eventType === eventType)
    .map((rule) => `${rule.side} ${rule.role} (${rule.lineKind})`);

describe('standard posting rules', () => {
  it('posts a sales invoice: receivable against revenue, tax, transport and rebates', () => {
    expect(journal(true, 'sales.invoice.issued')).toEqual([
      'debit ar.trade (line.receivable)',
      'credit income.sales.goods (line.revenue.goods)',
      'credit income.sales.services (line.revenue.services)',
      'credit vat.output (line.tax)',
      'credit income.sales.freight (line.freight)',
      'debit income.sales.rebates (line.rebate)',
      'debit customer_advances (line.advance_applied)',
      'credit ar.trade (line.advance_settled)',
    ]);
  });

  it('posts a supplier bill: purchases, tax and costs against the payable', () => {
    expect(journal(true, 'purchases.bill.recorded')).toEqual([
      'debit expense.purchases.goods (line.purchase.goods)',
      'debit vat.input (line.tax)',
      'debit expense.purchases.freight (line.freight)',
      'credit expense.purchases.rebates (line.rebate)',
      'credit ap.trade (line.payable)',
    ]);
  });

  it('posts tax on a pre-order payment where tax is due on receipt', () => {
    expect(journal(true, 'sales.preorder.payment_received')).toEqual([
      'credit customer_advances (line.advance)',
      'debit customer_advances (line.advance_tax)',
      'credit vat.output (line.tax)',
    ]);
  });

  it('posts no tax on a pre-order payment where it is not', () => {
    expect(journal(false, 'sales.preorder.payment_received')).toEqual([
      'credit customer_advances (line.advance)',
    ]);
  });

  it('changes nothing else between the two', () => {
    const withTax = standardPostingRules({ taxOnAdvances: true }).rules;
    const without = standardPostingRules({ taxOnAdvances: false }).rules;
    expect(withTax.length - without.length).toBe(2);
    for (const event of [
      'sales.invoice.issued',
      'sales.preorder.forfeited',
      'purchases.bill.recorded',
    ]) {
      expect(journal(false, event)).toEqual(journal(true, event));
    }
  });

  it('posts a forfeited deposit to other income', () => {
    expect(journal(true, 'sales.preorder.forfeited')).toEqual([
      'debit customer_advances (line.advance)',
      'credit income.other.forfeited_deposits (line.forfeit)',
    ]);
  });

  it('names only registered roles, carries the branch, and has no rule twice', () => {
    const { rules } = standardPostingRules({ taxOnAdvances: true });
    const keys = rules.map(
      (rule) => `${rule.eventType} ${rule.lineKind} ${rule.side} ${rule.role}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    for (const rule of rules) {
      expect(isSystemRole(rule.role)).toBe(true);
      expect(rule.dimensions).toContain('branch');
    }
  });

  it('gives each caller its own list', () => {
    const first = standardPostingRules({ taxOnAdvances: true });
    const second = standardPostingRules({ taxOnAdvances: true });
    expect(first.rules).not.toBe(second.rules);
    expect(first.rules).toEqual(second.rules);
  });
});
