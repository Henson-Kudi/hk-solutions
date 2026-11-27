import { CORE, type ProductKey, type ProductOrCore } from './products';

/**
 * Feature flags.
 *
 * A feature is on for a business when three things are all true:
 *
 *   capability   the business's country supports it (from the country pack)
 *   entitlement  the business has the product the feature belongs to
 *   setting      the business has not switched it off
 *
 * The UI and the API both ask through one function, features.isOn, so a
 * screen and its endpoint can never disagree. Code never checks a country
 * code to decide this.
 */

export interface FeatureDefinition {
  /** The product the feature belongs to. `core` features need no entitlement. */
  product: ProductOrCore;
  /** The country capability it needs. Usually the same as the feature key. */
  capability: string;
  /** Whether it is on when the business has no setting for it. Defaults to true. */
  defaultOn?: boolean;
}

/**
 * The features that depend on country, product or setting. The key is what
 * code passes to features.isOn.
 */
export const FEATURES = {
  'payments.mobile_money': {
    product: CORE,
    capability: 'payments.mobile_money',
  },
  'payroll.wps': { product: 'payroll', capability: 'payroll.wps' },
  'payroll.cnps': { product: 'payroll', capability: 'payroll.cnps' },
  'tax.corporate_tax': { product: 'tax', capability: 'tax.corporate_tax' },
  'einvoicing.fta': { product: 'tax', capability: 'einvoicing.fta' },
  'reports.syscohada': {
    product: 'accounting',
    capability: 'reports.syscohada',
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** What is known about one business, as far as features are concerned. */
export interface BusinessFeatureContext {
  /** The capabilities of the business's country pack. */
  capabilities: readonly string[];
  /** Products the business can use now: entitlements that are TRIAL or ACTIVE. */
  enabledProducts: readonly ProductKey[];
  /** The business's own switches, by feature key. Absent means "use the default". */
  settings?: Readonly<Record<string, boolean>>;
}

export interface FeatureExplanation {
  on: boolean;
  /** False for a key that is not in the registry. */
  known: boolean;
  capability: boolean;
  entitlement: boolean;
  setting: boolean;
}

export interface Features<Key extends string> {
  isOn(context: BusinessFeatureContext, feature: Key): boolean;
  /** Why a feature is on or off. For support screens and tests. */
  explain(context: BusinessFeatureContext, feature: Key): FeatureExplanation;
}

export const createFeatures = <Key extends string>(
  definitions: Readonly<Record<Key, FeatureDefinition>>,
): Features<Key> => {
  const explain = (
    context: BusinessFeatureContext,
    feature: Key,
  ): FeatureExplanation => {
    const definition = Object.prototype.hasOwnProperty.call(
      definitions,
      feature,
    )
      ? definitions[feature]
      : undefined;
    if (!definition) {
      // An unknown feature is off. Failing closed beats guessing.
      return {
        on: false,
        known: false,
        capability: false,
        entitlement: false,
        setting: false,
      };
    }
    const capability = context.capabilities.includes(definition.capability);
    const entitlement =
      definition.product === CORE ||
      context.enabledProducts.includes(definition.product);
    const setting = context.settings?.[feature] ?? definition.defaultOn ?? true;
    return {
      on: capability && entitlement && setting,
      known: true,
      capability,
      entitlement,
      setting,
    };
  };
  return {
    isOn: (context, feature) => explain(context, feature).on,
    explain,
  };
};

/** `features.isOn(businessContext, 'payroll.wps')` */
export const features: Features<FeatureKey> = createFeatures(FEATURES);
