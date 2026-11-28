import {
  TAX_ERRORS,
  type TaxCalculation,
  type TaxCodeDef,
  type TaxComponentAmount,
  type TaxEngine,
  type TaxLineResult,
  type TaxRequest,
  type TaxRounding,
} from '@hk/country-packs/kernel';
import {
  Decimal,
  DomainError,
  Money,
  err,
  ok,
  type Result,
} from '@hk/platform/universal';
import { SOURCES } from '../sources';
import { CM_TAX_CODES } from './codes';

/**
 * The Cameroon VAT calculation.
 *
 * For each line:
 *
 *   1. The total tax is the net amount times the sum of the component rates
 *      (19.25% for the standard code), rounded half up to the franc.
 *   2. Each component except the last is its own rate times the net amount,
 *      rounded the same way.
 *   3. The last component is the total minus the others.
 *
 * Step 3 is why the customer is always charged exactly 19.25% rounded once:
 * rounding VAT and surcharge separately and adding them could differ from
 * that by a franc. The surcharge absorbs the difference.
 *
 * Tax is rounded per line, and a document's tax is the sum of its lines.
 * Both choices are unconfirmed (SOURCES.vatRounding).
 */

export const CM_TAX_ROUNDING: TaxRounding = {
  level: 'line',
  mode: 'HALF_UP',
  source: SOURCES.vatRounding,
};

const unknownCode = (): DomainError =>
  new DomainError(TAX_ERRORS.CODE_UNKNOWN, 'The tax code is not known.');

const mixedCurrencies = (): DomainError =>
  new DomainError(
    TAX_ERRORS.CURRENCY_MIXED,
    'All lines of one calculation must be in the same currency.',
  );

const calculateLine = (
  code: TaxCodeDef,
  request: TaxRequest,
  line: TaxRequest['lines'][number],
): Result<TaxLineResult> => {
  const { mode } = CM_TAX_ROUNDING;
  const rates: string[] = [];
  for (const component of code.components) {
    const rate = component.rate.valueAt(request.date);
    if (!rate.ok) return rate;
    rates.push(rate.value);
  }

  const tax = line.net.times(Decimal.sum(rates)).roundToMinorUnit(mode);
  const components: TaxComponentAmount[] = [];
  let allocated = Money.zero(line.net.currency);
  code.components.forEach((component, index) => {
    const rate = rates[index] ?? '0';
    const isLast = index === code.components.length - 1;
    const amount = isLast
      ? tax.minus(allocated)
      : line.net.times(rate).roundToMinorUnit(mode);
    allocated = allocated.plus(amount);
    const role =
      request.direction === 'sale' ? component.outputRole : component.inputRole;
    components.push({ key: component.key, rate, amount, role });
  });

  return ok({
    id: line.id,
    taxCode: code.code,
    net: line.net,
    components,
    tax,
    gross: line.net.plus(tax),
  });
};

/**
 * Builds the engine over a set of codes. The pack uses CM_TAX_CODES; tests
 * pass their own to exercise a rate change.
 */
export const createCmTaxEngine = (
  codes: readonly TaxCodeDef[] = CM_TAX_CODES,
): TaxEngine => {
  const byCode = new Map(codes.map((code) => [code.code, code]));

  const calculate = (request: TaxRequest): Result<TaxCalculation> => {
    const [first] = request.lines;
    // XAF only names the currency of an empty result. A request with lines
    // is calculated in the currency of its lines, whatever that is.
    const currency = first?.net.currency ?? 'XAF';
    if (request.lines.some((line) => line.net.currency !== currency)) {
      return err(mixedCurrencies());
    }

    const lines: TaxLineResult[] = [];
    for (const line of request.lines) {
      const code = byCode.get(line.taxCode);
      if (!code) return err(unknownCode());
      const result = calculateLine(code, request, line);
      if (!result.ok) return result;
      lines.push(result.value);
    }

    return ok({
      lines,
      totalNet: Money.sum(
        currency,
        lines.map((line) => line.net),
      ),
      totalTax: Money.sum(
        currency,
        lines.map((line) => line.tax),
      ),
      totalGross: Money.sum(
        currency,
        lines.map((line) => line.gross),
      ),
    });
  };

  return {
    codes,
    defaultSaleCode: 'TVA_STD',
    defaultPurchaseCode: 'TVA_STD',
    rounding: CM_TAX_ROUNDING,
    advances: { taxDueOnReceipt: true, source: SOURCES.vatOnAdvances },
    calculate,
  };
};
