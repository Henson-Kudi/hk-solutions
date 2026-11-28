import {
  CORE,
  PRODUCT_DEPENDENCIES,
  isProductKey,
  optionsOf,
  type ProductManifest,
} from '@hk/contracts/product-manifest';
import {
  Decimal,
  LOCALES,
  minorUnitsOf,
  parseCurrencyCode,
  parseLocalizedText,
} from '@hk/platform/universal';
import { isCapabilityKey } from './capabilities';
import { isCountryCode } from './country';
import {
  ACCOUNT_TYPES,
  BRANCH_POLICIES,
  PAYMENT_METHOD_KINDS,
  POSTING_DIMENSIONS,
  PRODUCT_AVAILABILITIES,
  TAX_TREATMENTS,
  isProductOffered,
  type ChartTemplate,
  type CountryPack,
  type FieldDef,
  type TaxCodeDef,
} from './country-pack';
import { isSystemRole } from './system-roles';
import {
  findRateTableIssues,
  findSourceNoteIssues,
  isConfirmed,
  type SourceNote,
} from './effective-dated';

/** The parts of a pack. Each has its own conformance case. */
export const PACK_AREAS = [
  'identity',
  'currencies',
  'locales',
  'fiscal',
  'business',
  'chart',
  'postingRules',
  'tax',
  'reports',
  'payments',
  'capabilities',
  'products',
] as const;

export type PackArea = (typeof PACK_AREAS)[number];

export interface PackIssue {
  area: PackArea;
  message: string;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
const TAX_CODE = /^[A-Z][A-Z0-9_]*$/;
const ROUNDING_MODES = ['HALF_EVEN', 'HALF_UP', 'UP', 'DOWN'];
const ROUNDING_LEVELS = ['line', 'document'];
const MAX_CHART_DEPTH = 12;

const isFilled = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const duplicates = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

const isText = (value: unknown): boolean => parseLocalizedText(value).ok;

const includes = (list: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && list.includes(value);

/** The role names an account in every template of the pack holds. */
const rolesInEveryTemplate = (
  templates: readonly ChartTemplate[],
): Set<string> => {
  const [first, ...rest] = templates.map(
    (template) =>
      new Set(
        template.accounts
          .map((account) => account.systemRole)
          .filter((role): role is string => typeof role === 'string'),
      ),
  );
  if (!first) return new Set();
  return new Set([...first].filter((role) => rest.every((s) => s.has(role))));
};

/**
 * Everything structurally wrong with a pack. An empty list means the pack is
 * well formed.
 *
 * This checks shape and internal consistency: keys, references between
 * parts, dates, sources. It does not check that the values are right; an
 * accountant does that, and the conformance suite checks behaviour.
 */
export const findPackIssues = (pack: CountryPack): PackIssue[] => {
  const issues: PackIssue[] = [];
  const report = (area: PackArea, message: string): void => {
    issues.push({ area, message });
  };
  const checkKeys = (
    area: PackArea,
    what: string,
    keys: readonly string[],
    pattern: RegExp,
  ): void => {
    for (const key of keys) {
      if (typeof key !== 'string' || !pattern.test(key)) {
        report(area, `${what} "${String(key)}" is not a valid key`);
      }
    }
    for (const key of duplicates(keys)) {
      report(area, `${what} "${key}" is listed twice`);
    }
  };
  const checkSource = (
    area: PackArea,
    what: string,
    source: SourceNote,
  ): void => {
    for (const issue of findSourceNoteIssues(source)) {
      report(area, `${what}: ${issue}`);
    }
  };

  // ── identity ──
  if (!isCountryCode(pack.code)) {
    report('identity', `"${String(pack.code)}" is not a registered country`);
  }
  if (!isText(pack.name)) {
    report('identity', 'name needs non-empty "en" and "fr" text');
  }

  // ── currencies ──
  const functional = pack.currencies?.functional ?? [];
  if (functional.length === 0) {
    report('currencies', 'needs at least one functional currency');
  }
  for (const currency of duplicates(functional)) {
    report('currencies', `"${currency}" is listed twice`);
  }
  for (const currency of functional) {
    const parsed = parseCurrencyCode(currency);
    if (!parsed.ok) {
      report('currencies', `"${String(currency)}" is not a currency code`);
      continue;
    }
    const declared = pack.currencies.minorUnits?.[currency];
    if (declared === undefined) {
      report('currencies', `minorUnits has no entry for ${currency}`);
    } else if (declared !== minorUnitsOf(parsed.value)) {
      report(
        'currencies',
        `minorUnits for ${currency} is ${String(declared)}, but ISO 4217 says ${minorUnitsOf(parsed.value)}`,
      );
    }
  }
  for (const currency of Object.keys(pack.currencies?.minorUnits ?? {})) {
    if (!functional.includes(currency)) {
      report('currencies', `minorUnits lists ${currency}, which is not used`);
    }
  }

  // ── locales ──
  const locales = pack.locales ?? [];
  if (locales.length === 0) {
    report('locales', 'needs at least one locale');
  }
  for (const locale of duplicates(locales)) {
    report('locales', `"${locale}" is listed twice`);
  }
  for (const locale of locales) {
    const [language, region, ...rest] = String(locale).split('-');
    if (
      rest.length > 0 ||
      !includes(LOCALES, language) ||
      region !== pack.code
    ) {
      report(
        'locales',
        `"${String(locale)}" must be a supported language and this country, like "en-${String(pack.code)}"`,
      );
    }
  }

  // ── fiscal ──
  const month = pack.fiscal?.defaultYearStartMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    report('fiscal', 'defaultYearStartMonth must be 1 to 12');
  }
  const numbering = pack.fiscal?.legalNumbering ?? [];
  checkKeys(
    'fiscal',
    'numbering rule for',
    numbering.map((rule) => rule.documentType),
    DOTTED,
  );
  for (const rule of numbering) {
    if (typeof rule.gapFree !== 'boolean') {
      report('fiscal', `${rule.documentType}: gapFree must be true or false`);
    }
    if (!includes(['never', 'fiscal_year'], rule.resets)) {
      report('fiscal', `${rule.documentType}: resets is not valid`);
    }
    checkSource('fiscal', `numbering rule ${rule.documentType}`, rule.source);
  }

  // ── business ──
  const legalForms = pack.business?.legalForms ?? [];
  if (legalForms.length === 0) {
    report('business', 'needs at least one legal form');
  }
  checkKeys(
    'business',
    'legal form',
    legalForms.map((form) => form.key),
    KEY,
  );
  for (const form of legalForms) {
    if (!isText(form.name)) {
      report('business', `legal form "${form.key}" needs "en" and "fr" names`);
    }
  }
  const fields: readonly FieldDef[] = pack.business?.registrationFields ?? [];
  checkKeys(
    'business',
    'registration field',
    fields.map((field) => field.key),
    KEY,
  );
  for (const field of fields) {
    const where = `registration field "${field.key}"`;
    if (!isText(field.label)) {
      report('business', `${where} needs "en" and "fr" labels`);
    }
    if (typeof field.required !== 'boolean') {
      report('business', `${where}: required must be true or false`);
    }
    if (field.kind === 'select') {
      const options = field.options ?? [];
      if (options.length === 0) {
        report('business', `${where} is a select with no options`);
      }
      checkKeys(
        'business',
        `${where} option`,
        options.map((option) => option.key),
        KEY,
      );
      for (const option of options) {
        if (!isText(option.label)) {
          report(
            'business',
            `${where} option "${option.key}" needs "en" and "fr" labels`,
          );
        }
      }
    } else if (field.kind === 'text') {
      if (field.options !== undefined) {
        report('business', `${where} is a text field and cannot have options`);
      }
    } else {
      report('business', `${where}: kind is not valid`);
    }
  }
  if (typeof pack.business?.taxIdValidator !== 'function') {
    report('business', 'taxIdValidator is missing');
  }

  // ── chart ──
  const templates = pack.chart?.templates ?? [];
  if (templates.length === 0) {
    report('chart', 'needs at least one chart template');
  }
  checkKeys(
    'chart',
    'template',
    templates.map((template) => template.key),
    DOTTED,
  );
  for (const template of templates) {
    const where = `template "${template.key}"`;
    if (!isText(template.name)) {
      report('chart', `${where} needs "en" and "fr" names`);
    }
    if (!isFilled(template.framework)) {
      report('chart', `${where} has no framework`);
    }
    const accounts = template.accounts ?? [];
    if (accounts.length === 0) {
      report('chart', `${where} has no accounts`);
    }
    const byCode = new Map(accounts.map((account) => [account.code, account]));
    const parentCodes = new Set(
      accounts.map((account) => account.parentCode).filter(isFilled),
    );
    for (const code of duplicates(accounts.map((account) => account.code))) {
      report('chart', `${where}: account code "${code}" is used twice`);
    }
    for (const role of duplicates(
      accounts.map((account) => account.systemRole).filter(isFilled),
    )) {
      report('chart', `${where}: role "${role}" is on more than one account`);
    }
    for (const account of accounts) {
      const which = `${where} account "${String(account.code)}"`;
      if (!isFilled(account.code)) {
        report('chart', `${where} has an account with no code`);
        continue;
      }
      if (
        pack.chart.codePattern &&
        !pack.chart.codePattern.test(account.code)
      ) {
        report('chart', `${which}: code does not match the pack's pattern`);
      }
      if (!isText(account.name)) {
        report('chart', `${which} needs "en" and "fr" names`);
      }
      if (!includes(ACCOUNT_TYPES, account.type)) {
        report('chart', `${which}: type is not valid`);
      }
      if (!isFilled(account.subtype)) {
        report('chart', `${which} has no subtype`);
      }
      if (
        account.branchPolicy !== undefined &&
        !includes(BRANCH_POLICIES, account.branchPolicy)
      ) {
        report('chart', `${which}: branchPolicy is not valid`);
      }
      if (
        account.currency !== undefined &&
        !parseCurrencyCode(account.currency).ok
      ) {
        report('chart', `${which}: currency is not a currency code`);
      }
      if (account.systemRole !== undefined) {
        // Every pack uses the same role names, or a product could not post
        // in every country.
        if (!isSystemRole(account.systemRole)) {
          report(
            'chart',
            `${which}: "${String(account.systemRole)}" is not a registered system role`,
          );
        }
        // Posting rules post to the account holding a role, and only a leaf
        // can be posted to.
        if (parentCodes.has(account.code)) {
          report('chart', `${which} holds a role but has sub-accounts`);
        }
      }
      if (account.parentCode !== undefined) {
        const parent = byCode.get(account.parentCode);
        if (!parent || account.parentCode === account.code) {
          report('chart', `${which}: parent "${account.parentCode}" not found`);
        } else if (parent.type !== account.type) {
          report('chart', `${which}: type differs from its parent's`);
        }
      }
      // Walk up to the top; a loop never gets there.
      let current = account;
      let depth = 0;
      while (current.parentCode !== undefined && depth <= MAX_CHART_DEPTH) {
        const parent = byCode.get(current.parentCode);
        if (!parent || parent === current) break;
        current = parent;
        depth += 1;
      }
      if (depth > MAX_CHART_DEPTH) {
        report('chart', `${which}: its parents form a loop or are too deep`);
      }
    }
  }
  const availableRoles = rolesInEveryTemplate(templates);
  const requiredRoles = pack.chart?.requiredRoles ?? {};
  for (const [owner, roles] of Object.entries(requiredRoles)) {
    if (owner !== CORE && !isProductKey(owner)) {
      report('chart', `requiredRoles names "${owner}", which is not a product`);
      continue;
    }
    for (const role of duplicates(roles ?? [])) {
      report('chart', `requiredRoles.${owner}: "${role}" is listed twice`);
    }
    for (const role of roles ?? []) {
      if (!availableRoles.has(role)) {
        report(
          'chart',
          `requiredRoles.${owner}: no account holds "${String(role)}" in every template`,
        );
      }
    }
  }
  if (!requiredRoles[CORE] || requiredRoles[CORE].length === 0) {
    report('chart', 'requiredRoles.core is empty');
  }

  // ── posting rules ──
  const rules = pack.postingRules?.rules ?? [];
  if (rules.length === 0) {
    report('postingRules', 'needs at least one rule');
  }
  for (const key of duplicates(
    rules.map(
      (rule) => `${rule.eventType} ${rule.lineKind} ${rule.side} ${rule.role}`,
    ),
  )) {
    report('postingRules', `rule "${key}" is listed twice`);
  }
  for (const rule of rules) {
    const where = `rule ${String(rule.eventType)} / ${String(rule.lineKind)}`;
    if (!TOPIC.test(String(rule.eventType))) {
      report('postingRules', `${where}: eventType is not a topic`);
    }
    if (!DOTTED.test(String(rule.lineKind))) {
      report('postingRules', `${where}: lineKind is not a dotted name`);
    }
    if (!includes(['debit', 'credit'], rule.side)) {
      report('postingRules', `${where}: side must be debit or credit`);
    }
    if (!availableRoles.has(rule.role)) {
      report(
        'postingRules',
        `${where}: no account holds "${String(rule.role)}" in every template`,
      );
    }
    const dimensions = rule.dimensions ?? [];
    for (const dimension of dimensions) {
      if (!includes(POSTING_DIMENSIONS, dimension)) {
        report('postingRules', `${where}: "${String(dimension)}" is unknown`);
      }
    }
    for (const dimension of duplicates(dimensions)) {
      report('postingRules', `${where}: "${dimension}" is listed twice`);
    }
  }

  // ── tax ──
  const codes: readonly TaxCodeDef[] = pack.tax?.codes ?? [];
  if (codes.length === 0) {
    report('tax', 'needs at least one tax code');
  }
  checkKeys(
    'tax',
    'tax code',
    codes.map((code) => code.code),
    TAX_CODE,
  );
  for (const code of codes) {
    const where = `tax code ${code.code}`;
    if (!isText(code.name)) {
      report('tax', `${where} needs "en" and "fr" names`);
    }
    if (!includes(TAX_TREATMENTS, code.treatment)) {
      report('tax', `${where}: treatment is not valid`);
    }
    const components = code.components ?? [];
    const untaxed =
      code.treatment === 'exempt' || code.treatment === 'out_of_scope';
    if (untaxed && components.length > 0) {
      report('tax', `${where}: an ${code.treatment} code has no components`);
    }
    if (!untaxed && components.length === 0) {
      report('tax', `${where} needs at least one component`);
    }
    checkKeys(
      'tax',
      `${where} component`,
      components.map((component) => component.key),
      KEY,
    );
    for (const component of components) {
      const which = `${where} component "${component.key}"`;
      if (!isText(component.name)) {
        report('tax', `${which} needs "en" and "fr" names`);
      }
      const entries = component.rate?.entries ?? [];
      for (const issue of findRateTableIssues(entries)) {
        report('tax', `${which} rate: ${issue}`);
      }
      for (const entry of entries) {
        const rate =
          typeof entry.value === 'string' ? Decimal.parse(entry.value) : null;
        if (
          !rate?.ok ||
          rate.value.isNegative() ||
          rate.value.greaterThan('1')
        ) {
          report(
            'tax',
            `${which}: a rate must be a decimal string from "0" to "1"`,
          );
        } else if (code.treatment === 'zero_rated' && !rate.value.isZero()) {
          report('tax', `${which}: a zero-rated code has a rate of "0"`);
        }
      }
      if (
        code.treatment === 'reverse_charge' &&
        (component.outputRole === undefined ||
          component.inputRole === undefined)
      ) {
        // The buyer posts the same amount to both.
        report(
          'tax',
          `${which}: a reverse charge component needs an output and an input role`,
        );
      }
      if (
        component.outputRole === undefined &&
        component.inputRole === undefined
      ) {
        report('tax', `${which} has neither an output nor an input role`);
      }
      for (const role of [component.outputRole, component.inputRole]) {
        if (role !== undefined && !availableRoles.has(role)) {
          report(
            'tax',
            `${which}: no account holds "${String(role)}" in every template`,
          );
        }
      }
    }
  }
  const codeNames = codes.map((code) => code.code);
  if (!codeNames.includes(pack.tax?.defaultSaleCode)) {
    report('tax', 'defaultSaleCode is not one of the codes');
  }
  if (!codeNames.includes(pack.tax?.defaultPurchaseCode)) {
    report('tax', 'defaultPurchaseCode is not one of the codes');
  }
  if (!includes(ROUNDING_LEVELS, pack.tax?.rounding?.level)) {
    report('tax', 'rounding.level must be line or document');
  }
  if (!includes(ROUNDING_MODES, pack.tax?.rounding?.mode)) {
    report('tax', 'rounding.mode is not valid');
  }
  checkSource('tax', 'rounding', pack.tax?.rounding?.source);
  if (typeof pack.tax?.advances?.taxDueOnReceipt !== 'boolean') {
    report('tax', 'advances.taxDueOnReceipt must be true or false');
  }
  checkSource('tax', 'advances', pack.tax?.advances?.source);
  const notLiable = codes.find((code) => code.code === pack.tax?.notLiableCode);
  if (!notLiable) {
    report('tax', 'notLiableCode is not one of the codes');
  } else if (
    notLiable.treatment !== 'out_of_scope' &&
    notLiable.treatment !== 'exempt'
  ) {
    report('tax', 'notLiableCode must be an out-of-scope or exempt code');
  }
  if (typeof pack.tax?.isLiable !== 'function') {
    report('tax', 'isLiable is missing');
  }
  if (typeof pack.tax?.calculate !== 'function') {
    report('tax', 'calculate is missing');
  }

  // ── capabilities ──
  const capabilities = pack.capabilities ?? [];
  for (const capability of capabilities) {
    if (!isCapabilityKey(capability)) {
      report('capabilities', `"${String(capability)}" is not a capability key`);
    }
  }
  for (const capability of duplicates(capabilities)) {
    report('capabilities', `"${capability}" is listed twice`);
  }
  // The payroll engine and its capability say the same thing, so they agree.
  if (
    (pack.payroll !== undefined) !==
    capabilities.includes('payroll.engine')
  ) {
    report(
      'capabilities',
      'payroll.engine is listed exactly when the pack has a payroll engine',
    );
  }
  if (pack.payroll !== undefined && !isFilled(pack.payroll.key)) {
    report('capabilities', 'the payroll engine has no key');
  }
  if (pack.eInvoicing !== undefined && !isFilled(pack.eInvoicing.key)) {
    report('capabilities', 'the e-invoicing adapter has no key');
  }

  // ── reports ──
  const reports = pack.reports ?? [];
  checkKeys(
    'reports',
    'report',
    reports.map((entry) => entry.key),
    DOTTED,
  );
  for (const entry of reports) {
    if (!isText(entry.name)) {
      report('reports', `report "${entry.key}" needs "en" and "fr" names`);
    }
    if (
      !includes(['financial_statement', 'tax_return', 'export'], entry.kind)
    ) {
      report('reports', `report "${entry.key}": kind is not valid`);
    }
    if (
      entry.capability !== undefined &&
      !capabilities.includes(entry.capability)
    ) {
      report(
        'reports',
        `report "${entry.key}" needs "${String(entry.capability)}", which the pack does not list`,
      );
    }
  }

  // ── payments ──
  const payments = pack.payments ?? [];
  if (payments.length === 0) {
    report('payments', 'needs at least one payment method');
  }
  checkKeys(
    'payments',
    'payment method',
    payments.map((method) => method.key),
    KEY,
  );
  for (const method of payments) {
    if (!isText(method.name)) {
      report('payments', `method "${method.key}" needs "en" and "fr" names`);
    }
    if (!includes(PAYMENT_METHOD_KINDS, method.kind)) {
      report('payments', `method "${method.key}": kind is not valid`);
    }
  }
  const hasMobileMoney = payments.some(
    (method) => method.kind === 'mobile_money',
  );
  if (hasMobileMoney !== capabilities.includes('payments.mobile_money')) {
    report(
      'payments',
      'payments.mobile_money is listed exactly when a mobile money method exists',
    );
  }

  // ── products ──
  const products = pack.products ?? {};
  for (const [product, availability] of Object.entries(products)) {
    if (!isProductKey(product)) {
      report('products', `"${product}" is not a product key`);
      continue;
    }
    if (!includes(PRODUCT_AVAILABILITIES, availability)) {
      report('products', `${product}: availability is not valid`);
      continue;
    }
    if (availability === 'UNAVAILABLE') continue;
    // A product cannot be offered where something it needs is not.
    for (const requirement of PRODUCT_DEPENDENCIES[product]) {
      const options = optionsOf(requirement);
      if (!options.some((option) => isProductOffered(pack, option))) {
        report(
          'products',
          `${product} is offered but needs ${options.join(' or ')}, which is not`,
        );
      }
    }
  }
  if (
    !Object.keys(products).some(
      (product) => isProductKey(product) && isProductOffered(pack, product),
    )
  ) {
    report('products', 'no product is offered');
  }

  return issues;
};

/**
 * Whether a pack can carry the given products: for each manifest of a product
 * the pack offers, the capabilities it requires and the roles it posts to.
 *
 * Each pack's test passes every product manifest through this, so a product
 * that needs something a country lacks fails CI until the pack adds it or
 * marks the product UNAVAILABLE.
 */
export const findPackManifestIssues = (
  pack: CountryPack,
  manifests: readonly ProductManifest[],
): PackIssue[] => {
  const issues: PackIssue[] = [];
  const roles = rolesInEveryTemplate(pack.chart.templates);
  for (const manifest of manifests) {
    if (!isProductOffered(pack, manifest.key)) continue;
    for (const capability of manifest.requiresCapabilities) {
      if (!(pack.capabilities as readonly string[]).includes(capability)) {
        issues.push({
          area: 'capabilities',
          message: `${manifest.key} is offered but requires "${capability}"`,
        });
      }
    }
    const declared = pack.chart.requiredRoles[manifest.key] ?? [];
    for (const role of manifest.requiredSystemRoles) {
      if (!roles.has(role)) {
        issues.push({
          area: 'chart',
          message: `${manifest.key} posts to "${role}", which no template has`,
        });
      } else if (!declared.includes(role)) {
        issues.push({
          area: 'chart',
          message: `requiredRoles.${manifest.key} does not list "${role}"`,
        });
      }
    }
  }
  return issues;
};

export interface UnconfirmedValue {
  /** Where the value is: "tax VAT_STD / vat from 2018-01-01". */
  where: string;
  reference: string;
}

/**
 * Every value in the pack that no accountant has confirmed yet. A pack ships
 * with this list non-empty during development; it must be empty before a
 * country goes live.
 */
export const findUnconfirmedValues = (
  pack: CountryPack,
): UnconfirmedValue[] => {
  const found: UnconfirmedValue[] = [];
  const check = (where: string, source: SourceNote): void => {
    if (!isConfirmed(source)) {
      found.push({ where, reference: source.reference });
    }
  };
  for (const rule of pack.fiscal.legalNumbering) {
    check(`numbering ${rule.documentType}`, rule.source);
  }
  for (const code of pack.tax.codes) {
    for (const component of code.components) {
      for (const entry of component.rate.entries) {
        check(
          `tax ${code.code} / ${component.key} from ${entry.effectiveFrom}`,
          entry.source,
        );
      }
    }
  }
  check('tax rounding', pack.tax.rounding.source);
  check('tax on advances', pack.tax.advances.source);
  return found;
};
