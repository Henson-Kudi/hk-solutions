import type { ProductKey, ProductOrCore } from '@hk/contracts/product-manifest';
import type {
  LocalizedText,
  Money,
  Result,
  RoundingMode,
} from '@hk/platform/universal';
import type { CapabilityKey } from './capabilities';
import type { CountryCode } from './country';
import type { RateTable, SourceNote } from './effective-dated';

/**
 * A country pack: everything that depends on the country a business is in.
 *
 * Product code asks the pack and never checks a country code. Adding a
 * country means writing a pack that implements this interface and passes the
 * conformance suite; no product changes.
 *
 * A pack is plain data plus a few pure functions. It has no database, no
 * network and no clock, so the same pack runs on the server, in the browser
 * and on a phone.
 */
export interface CountryPack {
  readonly code: CountryCode;
  readonly name: LocalizedText;
  readonly currencies: PackCurrencies;
  /** BCP 47 tags, the default first: "fr-CM", "en-CM". */
  readonly locales: readonly string[];
  readonly fiscal: PackFiscal;
  readonly business: PackBusiness;
  readonly chart: PackChart;
  readonly postingRules: PostingRuleSetSeed;
  readonly tax: TaxEngine;
  readonly payroll?: PayrollEngine;
  readonly eInvoicing?: EInvoicingAdapter;
  readonly reports: readonly StatutoryReportDef[];
  readonly payments: readonly PaymentMethodDef[];
  /** What this country supports. */
  readonly capabilities: readonly CapabilityKey[];
  /** Which products are offered here. A product not listed is UNAVAILABLE. */
  readonly products: Partial<Readonly<Record<ProductKey, ProductAvailability>>>;
}

// ── Currencies, locales, fiscal year ────────────────────────────────────────

export interface PackCurrencies {
  /** Currencies a business here may keep its books in, the default first. */
  readonly functional: readonly string[];
  /** Decimal places per functional currency: XAF 0, AED 2. */
  readonly minorUnits: Readonly<Record<string, number>>;
}

export interface PackFiscal {
  /** 1 for January to 12 for December. */
  readonly defaultYearStartMonth: number;
  readonly legalNumbering: readonly LegalNumberingRule[];
}

/** A document type the law requires to be numbered in an unbroken sequence. */
export interface LegalNumberingRule {
  /** "sales.invoice", "sales.credit_note". */
  readonly documentType: string;
  /** No gaps allowed: the server assigns the number inside the document's transaction. */
  readonly gapFree: boolean;
  /** Whether the sequence starts again each fiscal year. */
  readonly resets: 'never' | 'fiscal_year';
  readonly source: SourceNote;
}

// ── Business identity ───────────────────────────────────────────────────────

export interface PackBusiness {
  readonly legalForms: readonly LegalForm[];
  /** Extra fields onboarding asks for here: NIU and RCCM, or TRN and emirate. */
  readonly registrationFields: readonly FieldDef[];
  /**
   * Checks a tax registration number and returns it in canonical form
   * (trimmed, no spaces). Errors never quote the number: it is an ID number
   * and must not reach logs.
   */
  taxIdValidator(value: string): Result<string>;
}

export interface LegalForm {
  /** Stable key stored on the business: "sarl", "llc". */
  readonly key: string;
  readonly name: LocalizedText;
}

export interface FieldDef {
  /** Stable key the value is stored under: "niu", "trn", "emirate". */
  readonly key: string;
  readonly label: LocalizedText;
  readonly required: boolean;
  readonly kind: 'text' | 'select';
  /** The choices of a select field. */
  readonly options?: readonly FieldOption[];
  /** True for ID numbers: the value is redacted in logs and masked in the UI. */
  readonly sensitive?: boolean;
  /** Returns the canonical value. Errors never quote the input. */
  validate?(value: string): Result<string>;
}

export interface FieldOption {
  readonly key: string;
  readonly label: LocalizedText;
}

// ── Chart of accounts ───────────────────────────────────────────────────────

export const ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'INCOME',
  'EXPENSE',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const BRANCH_POLICIES = [
  'INHERIT',
  'BRANCH_EXTENDABLE',
  'BRANCH_RESTRICTED',
  'HIDDEN_IN_BRANCHES',
] as const;

export type BranchPolicy = (typeof BRANCH_POLICIES)[number];

/**
 * A stable name for what an account is for: "ar.trade", "vat.output".
 * Posting rules name roles, never account codes, so a business can renumber
 * its chart without breaking postings. The names a pack may use are in
 * SYSTEM_ROLES (system-roles.ts).
 */
export type SystemRole = string;

export interface PackChart {
  /** At least one. The first is the default offered at onboarding. */
  readonly templates: readonly ChartTemplate[];
  /**
   * The roles that must be mapped to an account before a product can be
   * switched on. `core` lists the roles every business needs.
   */
  readonly requiredRoles: Partial<
    Readonly<Record<ProductOrCore, readonly SystemRole[]>>
  >;
  /** A pattern every account code must match, where the framework imposes one. */
  readonly codePattern?: RegExp;
}

export interface ChartTemplate {
  /** "syscohada.normal", "ifrs.standard". */
  readonly key: string;
  readonly name: LocalizedText;
  /** The accounting framework: "SYSCOHADA", "IFRS". */
  readonly framework: string;
  readonly accounts: readonly ChartTemplateAccount[];
}

export interface ChartTemplateAccount {
  readonly code: string;
  readonly name: LocalizedText;
  readonly type: AccountType;
  /** Pack-defined: "BANK", "CASH", "AR", "VAT_OUTPUT". */
  readonly subtype: string;
  /** For statutory reports: the SYSCOHADA class, for example. */
  readonly frameworkClass?: string;
  /** Code of the parent account in the same template. Absent for a top-level account. */
  readonly parentCode?: string;
  readonly systemRole?: SystemRole;
  /** System and control accounts: code and role cannot change. */
  readonly locked?: boolean;
  /** Defaults to INHERIT. */
  readonly branchPolicy?: BranchPolicy;
  /** Restricts the account to one currency. */
  readonly currency?: string;
}

// ── Posting rules ───────────────────────────────────────────────────────────

export const POSTING_DIMENSIONS = [
  'branch',
  'department',
  'project',
  'cost_center',
  'warehouse',
  'contact',
] as const;

export type PostingDimension = (typeof POSTING_DIMENSIONS)[number];

/**
 * One line of a posting rule set: when this kind of line arrives in this
 * event, post it to the account holding this role, on this side.
 */
export interface PostingRuleSeed {
  /** The event topic: "sales.invoice.issued". */
  readonly eventType: string;
  /** The kind of line inside the event's journal intent: "line.revenue". */
  readonly lineKind: string;
  readonly role: SystemRole;
  readonly side: 'debit' | 'credit';
  /** Dimensions copied from the intent line onto the journal line. */
  readonly dimensions?: readonly PostingDimension[];
}

/** The rules a new business starts with. A business may override them later. */
export interface PostingRuleSetSeed {
  readonly rules: readonly PostingRuleSeed[];
}

// ── Tax ─────────────────────────────────────────────────────────────────────

export const TAX_TREATMENTS = [
  'standard',
  'reduced',
  'zero_rated',
  'exempt',
  'out_of_scope',
  'reverse_charge',
  'withholding',
] as const;

export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/** Treatments under which the customer is charged no tax. */
export const UNTAXED_TREATMENTS: readonly TaxTreatment[] = [
  'zero_rated',
  'exempt',
  'out_of_scope',
];

/**
 * One part of a tax. Most taxes have one component. Cameroon's VAT has two,
 * the tax itself and a surcharge calculated on it, each posted to its own
 * account.
 */
export interface TaxComponentDef {
  /** Unique within the tax code: "tva", "cac". */
  readonly key: string;
  readonly name: LocalizedText;
  /** The rate as a decimal fraction string ("0.05" is 5%), by date. */
  readonly rate: RateTable<string>;
  /** The role credited when the business charges this tax on a sale. */
  readonly outputRole?: SystemRole;
  /** The role debited when the business pays this tax on a purchase. */
  readonly inputRole?: SystemRole;
}

export interface TaxCodeDef {
  /** Stable code stored on document lines: "VAT_STD". */
  readonly code: string;
  readonly name: LocalizedText;
  readonly treatment: TaxTreatment;
  /** Empty for exempt and out-of-scope codes. */
  readonly components: readonly TaxComponentDef[];
}

export interface TaxRounding {
  /** Round each line's tax, or round once on the document total. */
  readonly level: 'line' | 'document';
  readonly mode: RoundingMode;
  readonly source: SourceNote;
}

/** Whether tax is due when an advance payment is received, before the supply. */
export interface AdvanceRule {
  readonly taxDueOnReceipt: boolean;
  readonly source: SourceNote;
}

export interface TaxRequestLine {
  /** The caller's own id for the line, echoed in the result. */
  readonly id: string;
  /** The amount before tax. */
  readonly net: Money;
  readonly taxCode: string;
}

export interface TaxRequest {
  /** The tax point, "YYYY-MM-DD". Rates are looked up for this day. */
  readonly date: string;
  readonly direction: 'sale' | 'purchase';
  readonly lines: readonly TaxRequestLine[];
}

export interface TaxComponentAmount {
  readonly key: string;
  /** The rate that was applied, as a decimal fraction string. */
  readonly rate: string;
  readonly amount: Money;
  /** The role to post to for this direction, when the component has one. */
  readonly role?: SystemRole;
  /**
   * Set only on a reverse charge purchase: the output role. The buyer
   * accounts for the tax itself, so the same amount is debited to `role`
   * (input tax) and credited to `counterRole` (output tax).
   */
  readonly counterRole?: SystemRole;
}

export interface TaxLineResult {
  readonly id: string;
  readonly taxCode: string;
  readonly net: Money;
  readonly components: readonly TaxComponentAmount[];
  /** The sum of the components. */
  readonly tax: Money;
  /**
   * What changes hands for this line: net plus the tax the seller charges.
   *
   * Under reverse charge the seller charges no tax. On the sale the
   * components are zero. On the purchase the components are the tax the buyer
   * accounts for itself, and `gross` is still the net, because that is what
   * the supplier is paid.
   */
  readonly gross: Money;
}

export interface TaxCalculation {
  readonly lines: readonly TaxLineResult[];
  readonly totalNet: Money;
  readonly totalTax: Money;
  readonly totalGross: Money;
}

export const TAX_ERRORS = {
  /** The request names a tax code the pack does not have. */
  CODE_UNKNOWN: 'TAX_CODE_UNKNOWN',
  /** The lines are not all in one currency. */
  CURRENCY_MIXED: 'TAX_CURRENCY_MIXED',
} as const;

export interface TaxEngine {
  readonly codes: readonly TaxCodeDef[];
  /** The code proposed for a new sale line. */
  readonly defaultSaleCode: string;
  /** The code proposed for a new purchase line. */
  readonly defaultPurchaseCode: string;
  /**
   * The code for the sales of a business that is not liable for the tax.
   * Its treatment is out of scope or exempt, so it charges nothing.
   */
  readonly notLiableCode: string;
  /**
   * Whether a business charges this tax on its sales and recovers it on its
   * purchases, given its answers to the pack's registration fields (keyed by
   * field key). In many countries a small business is outside the tax
   * altogether. Products ask this; they never test a regime or a threshold
   * themselves. Unknown or missing answers mean not liable.
   */
  isLiable(registration: Readonly<Record<string, string>>): boolean;
  readonly rounding: TaxRounding;
  readonly advances: AdvanceRule;
  /**
   * Works out the tax on a set of lines in one currency.
   *
   * An unknown code is TAX_CODE_UNKNOWN, mixed currencies are
   * TAX_CURRENCY_MIXED, and a date no rate covers is RATE_NOT_IN_EFFECT.
   * Every amount in the result is in the currency's minor units.
   */
  calculate(request: TaxRequest): Result<TaxCalculation>;
}

// ── Payroll and e-invoicing ─────────────────────────────────────────────────

/**
 * A country's payroll rules. The shape is fixed by the payroll rows of the
 * plan (phase 8); until then a pack that has an engine only names it.
 */
export interface PayrollEngine {
  /** "cm.payroll", "ae.payroll". */
  readonly key: string;
}

/** A country's e-invoicing scheme. The shape is fixed in phase 9. */
export interface EInvoicingAdapter {
  /** "ae.fta.pint". */
  readonly key: string;
}

// ── Reports and payments ────────────────────────────────────────────────────

export interface StatutoryReportDef {
  /** "syscohada.bilan", "ae.vat201". */
  readonly key: string;
  readonly name: LocalizedText;
  readonly kind: 'financial_statement' | 'tax_return' | 'export';
  /** The capability the report belongs to, when it is not always offered. */
  readonly capability?: CapabilityKey;
}

export const PAYMENT_METHOD_KINDS = [
  'cash',
  'mobile_money',
  'card',
  'bank_transfer',
  'cheque',
] as const;

export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface PaymentMethodDef {
  /** "cash", "mtn_momo", "orange_money", "card". */
  readonly key: string;
  readonly name: LocalizedText;
  readonly kind: PaymentMethodKind;
}

// ── Product availability ────────────────────────────────────────────────────

export const PRODUCT_AVAILABILITIES = [
  'AVAILABLE',
  'BETA',
  'UNAVAILABLE',
] as const;

export type ProductAvailability = (typeof PRODUCT_AVAILABILITIES)[number];

/** A product the pack does not mention is not offered in that country. */
export const productAvailability = (
  pack: Pick<CountryPack, 'products'>,
  product: ProductKey,
): ProductAvailability => pack.products[product] ?? 'UNAVAILABLE';

/** Whether the plan builder, onboarding and the product switcher show the product. */
export const isProductOffered = (
  pack: Pick<CountryPack, 'products'>,
  product: ProductKey,
): boolean => productAvailability(pack, product) !== 'UNAVAILABLE';

export const hasCapability = (
  pack: Pick<CountryPack, 'capabilities'>,
  capability: CapabilityKey,
): boolean => pack.capabilities.includes(capability);
