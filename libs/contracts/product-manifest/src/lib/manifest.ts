import { parseLocalizedText, type LocalizedText } from '@hk/platform/universal';
import {
  PRODUCT_DEPENDENCIES,
  isProductKey,
  optionsOf,
  sameRequirement,
  type ProductDependencies,
  type ProductKey,
  type ProductRequirement,
} from './products';

/**
 * What a product declares about itself. One per product, in
 * libs/products/<key>/manifest.ts, written by the product generator.
 *
 * The gateway builds its routes from manifests, core decides which scopes a
 * service token may carry from `coreScopes`, and CI checks that every topic a
 * product consumes is produced by someone.
 */
export interface ProductManifest {
  key: ProductKey;
  displayName: LocalizedText;
  /** Must equal this product's entry in PRODUCT_DEPENDENCIES. */
  requiresProducts: readonly ProductRequirement[];
  /** Country capabilities that must all exist for the product to be offered: "payroll.engine". */
  requiresCapabilities: readonly string[];
  /** Capabilities that light up extra features when the country has them: "payroll.wps". */
  optionalCapabilities: readonly string[];
  /** What this product's service may ask core to do, as service-token scopes: "contacts:read". */
  coreScopes: readonly string[];
  /** Route prefixes the gateway forwards to this product's service: "/sales". */
  publicRoutes: readonly string[];
  /** Event topics this product handles: "inventory.stock.consumed". */
  consumes: readonly string[];
  /** Event topics this product emits. Each starts with the product key: "sales.invoice.issued". */
  produces: readonly string[];
  /** Permissions this product defines: "invoices:issue". */
  permissions: readonly string[];
  /** The PostgreSQL schema the product owns, or null when it owns none. Equals the key. */
  schema: string | null;
  /** Chart-of-accounts system roles the product posts to: "receivables.control". */
  requiredSystemRoles: readonly string[];
  /** What is counted for usage pricing: "users", "warehouses". */
  meters: readonly string[];
}

export interface ManifestIssue {
  /** The field the issue is about. */
  field: keyof ProductManifest;
  message: string;
}

const CAPABILITY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SCOPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*:[a-z][a-z0-9_-]*$/;
const PERMISSION = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;
const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
const ROUTE = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const DOTTED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const duplicates = (values: readonly string[]): string[] => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

/**
 * Everything wrong with a manifest. An empty list means it is valid.
 *
 * Each product has a test that expects an empty list for its own manifest,
 * so an invalid manifest fails CI in the PR that introduces it.
 */
export const findManifestIssues = (
  manifest: ProductManifest,
  dependencies: ProductDependencies = PRODUCT_DEPENDENCIES,
): ManifestIssue[] => {
  const issues: ManifestIssue[] = [];
  const report = (field: keyof ProductManifest, message: string): void => {
    issues.push({ field, message });
  };
  const checkList = (
    field: keyof ProductManifest,
    values: readonly string[],
    pattern: RegExp,
    shape: string,
  ): void => {
    for (const value of values) {
      if (typeof value !== 'string' || !pattern.test(value)) {
        report(field, `"${String(value)}" is not of the form ${shape}`);
      }
    }
    for (const value of duplicates(values)) {
      report(field, `"${value}" is listed twice`);
    }
  };

  if (!isProductKey(manifest.key)) {
    report('key', `"${String(manifest.key)}" is not a product key`);
    return issues;
  }
  const { key } = manifest;

  if (!parseLocalizedText(manifest.displayName).ok) {
    report('displayName', 'needs non-empty "en" and "fr" text');
  }

  // The catalog is the source of truth for dependencies. A manifest repeats
  // its own entry, and may not disagree with it.
  const expected = dependencies[key];
  const declared = manifest.requiresProducts;
  for (const requirement of declared) {
    const options = optionsOf(requirement);
    if (options.length === 0 || !options.every(isProductKey)) {
      report('requiresProducts', 'names something that is not a product key');
    } else if (options.includes(key)) {
      report('requiresProducts', 'a product cannot require itself');
    }
  }
  const agrees =
    declared.length === expected.length &&
    expected.every((requirement) =>
      declared.some((candidate) => sameRequirement(candidate, requirement)),
    );
  if (!agrees) {
    report(
      'requiresProducts',
      "does not match this product's entry in PRODUCT_DEPENDENCIES",
    );
  }

  checkList(
    'requiresCapabilities',
    manifest.requiresCapabilities,
    CAPABILITY,
    'area.name',
  );
  checkList(
    'optionalCapabilities',
    manifest.optionalCapabilities,
    CAPABILITY,
    'area.name',
  );
  for (const capability of manifest.optionalCapabilities) {
    if (manifest.requiresCapabilities.includes(capability)) {
      report(
        'optionalCapabilities',
        `"${capability}" is also required, so it cannot be optional`,
      );
    }
  }

  checkList('coreScopes', manifest.coreScopes, SCOPE, 'resource:action');
  checkList('publicRoutes', manifest.publicRoutes, ROUTE, '/path');
  checkList('permissions', manifest.permissions, PERMISSION, 'resource:action');
  checkList(
    'requiredSystemRoles',
    manifest.requiredSystemRoles,
    DOTTED,
    'a dotted name',
  );
  checkList('meters', manifest.meters, DOTTED, 'a dotted name');

  checkList('consumes', manifest.consumes, TOPIC, 'producer.entity.event');
  checkList('produces', manifest.produces, TOPIC, 'producer.entity.event');
  for (const topic of manifest.produces) {
    if (typeof topic === 'string' && !topic.startsWith(`${key}.`)) {
      report('produces', `"${topic}" must start with "${key}."`);
    }
  }
  for (const topic of manifest.consumes) {
    if (typeof topic === 'string' && topic.startsWith(`${key}.`)) {
      report('consumes', `"${topic}" is the product's own event`);
    }
  }

  if (manifest.schema !== null && manifest.schema !== key) {
    report('schema', `must be "${key}" or null`);
  }

  return issues;
};

/** A topic some manifest consumes that no manifest produces. */
export interface OrphanTopic {
  topic: string;
  consumer: ProductKey;
}

/**
 * Topics that are consumed but produced by nobody, across all manifests.
 * Topics that core produces are passed in, since core has no manifest.
 */
export const findOrphanTopics = (
  manifests: readonly ProductManifest[],
  coreTopics: readonly string[] = [],
): OrphanTopic[] => {
  const produced = new Set<string>(coreTopics);
  for (const manifest of manifests) {
    manifest.produces.forEach((topic) => produced.add(topic));
  }
  const orphans: OrphanTopic[] = [];
  for (const manifest of manifests) {
    for (const topic of manifest.consumes) {
      if (!produced.has(topic)) {
        orphans.push({ topic, consumer: manifest.key });
      }
    }
  }
  return orphans;
};

/**
 * The scopes each product's service may put in a service token, by product
 * key. This is the input of createServiceScopeRegistry in
 * @hk/platform/internal-auth.
 */
export const scopeDeclarations = (
  manifests: readonly ProductManifest[],
): Record<string, readonly string[]> =>
  Object.fromEntries(
    manifests.map((manifest) => [manifest.key, manifest.coreScopes]),
  );
