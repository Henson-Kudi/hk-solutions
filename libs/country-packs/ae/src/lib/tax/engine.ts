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
  DomainError,
  Money,
  err,
  ok,
  type Result,
} from '@hk/platform/universal';
import { SOURCES } from '../sources';
import { AE_TAX_CODES } from './codes';

/**
 * The UAE VAT calculation.
 *
 * For each line, the tax is the net amount times the rate, rounded to the
 * nearest fils (two decimals of a dirham), halves up. A document's tax is the
 * sum of its lines.
 *
 * Reverse charge (VAT_RC), used when a supplier outside the UAE charges no
 * VAT:
 *   - on a purchase, the buyer accounts for the 5% itself. It is posted as
 *     input tax and as output tax, and the supplier is paid the net only;
 *   - on a sale, the seller charges nothing and the customer accounts for it.
 *
 * Rounding to the fils is in the Executive Regulation (art. 61). Doing it per
 * line is unconfirmed (SOURCES.vatRounding).
 */

export const AE_TAX_ROUNDING: TaxRounding = {
  level: 'line',
  mode: 'HALF_UP',
  source: SOURCES.vatRounding,
};

/** The key of the registration field that says whether the business is VAT-registered. */
export const AE_VAT_STATUS_FIELD = 'vat_status';

/** The answer that means the business holds a VAT registration. */
export const AE_VAT_REGISTERED = 'registered';

/**
 * Only a business registered for VAT charges it and recovers it. Registration
 * is mandatory above AED 375,000 of taxable supplies a year and voluntary
 * from AED 187,500 (Executive Regulation, arts. 7 and 8). The pack does not
 * work out whether a business should be registered: it asks whether it is.
 */
export const isLiableForAeVat = (
  registration: Readonly<Record<string, string>>,
): boolean => registration[AE_VAT_STATUS_FIELD] === AE_VAT_REGISTERED;

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
  const isSale = request.direction === 'sale';
  const reverseCharge = code.treatment === 'reverse_charge';
  const components: TaxComponentAmount[] = [];

  for (const component of code.components) {
    const rate = component.rate.valueAt(request.date);
    if (!rate.ok) return rate;
    components.push({
      key: component.key,
      rate: rate.value,
      // Under reverse charge the seller charges nothing.
      amount:
        reverseCharge && isSale
          ? Money.zero(line.net.currency)
          : line.net.times(rate.value).roundToMinorUnit(AE_TAX_ROUNDING.mode),
      role: isSale ? component.outputRole : component.inputRole,
      // The buyer posts the same amount as output tax too.
      ...(reverseCharge && !isSale
        ? { counterRole: component.outputRole }
        : {}),
    });
  }

  const tax = Money.sum(
    line.net.currency,
    components.map((component) => component.amount),
  );
  return ok({
    id: line.id,
    taxCode: code.code,
    net: line.net,
    components,
    tax,
    // A reverse charge buyer pays the supplier the net only.
    gross: reverseCharge ? line.net : line.net.plus(tax),
  });
};

/**
 * Builds the engine over a set of codes. The pack uses AE_TAX_CODES; tests
 * pass their own to exercise a rate change.
 */
export const createAeTaxEngine = (
  codes: readonly TaxCodeDef[] = AE_TAX_CODES,
): TaxEngine => {
  const byCode = new Map(codes.map((code) => [code.code, code]));

  const calculate = (request: TaxRequest): Result<TaxCalculation> => {
    const [first] = request.lines;
    // AED only names the currency of an empty result. A request with lines
    // is calculated in the currency of its lines.
    const currency = first?.net.currency ?? 'AED';
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
    defaultSaleCode: 'VAT_STD',
    defaultPurchaseCode: 'VAT_STD',
    notLiableCode: 'VAT_OUT_OF_SCOPE',
    isLiable: isLiableForAeVat,
    rounding: AE_TAX_ROUNDING,
    advances: { taxDueOnReceipt: true, source: SOURCES.vatOnAdvances },
    calculate,
  };
};
