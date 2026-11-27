import {
  CORE,
  type ProductKey,
  type ProductOrCore,
} from '@hk/contracts/product-manifest';

/**
 * The permission registry: every resource, the product it belongs to, and
 * what can be done to it. A permission is written "resource:action", for
 * example "invoices:issue".
 *
 * Roles are sets of these. The gateway puts the permissions a user holds in
 * the business into the user token, and handlers ask for them with
 * @RequirePermission.
 */
export interface ResourceDef {
  product: ProductOrCore;
  actions: readonly string[];
}

/**
 * Each product adds its resources here in the PR that builds it. A resource
 * belongs to exactly one product.
 */
export const RESOURCES = {
  accounts: { product: CORE, actions: ['view', 'create', 'update', 'archive'] },
  journals: {
    product: 'accounting',
    actions: ['view', 'create', 'reverse', 'approve'],
  },
  periods: {
    product: 'accounting',
    actions: ['view', 'soft_close', 'close', 'reopen'],
  },
  invoices: {
    product: 'sales',
    actions: ['view', 'create', 'update', 'issue', 'void', 'export'],
  },
  preorders: {
    product: 'sales',
    actions: ['view', 'create', 'take_payment', 'collect', 'cancel', 'forfeit'],
  },
  stock: {
    product: 'inventory',
    actions: ['view', 'adjust', 'transfer', 'count', 'approve'],
  },
  pos_sessions: {
    product: 'pos',
    actions: ['open', 'close', 'cash_in_out', 'refund', 'override_price'],
  },
  payroll_runs: {
    product: 'payroll',
    actions: ['view', 'prepare', 'approve', 'pay', 'export'],
  },
} as const satisfies Record<string, ResourceDef>;

export type ResourceKey = keyof typeof RESOURCES;

/** Every valid permission, as a type: "invoices:issue" compiles, "invoices:delete" does not. */
export type Permission = {
  [Resource in ResourceKey]: `${Resource}:${(typeof RESOURCES)[Resource]['actions'][number]}`;
}[ResourceKey];

export const ALL_PERMISSIONS: readonly Permission[] = (
  Object.keys(RESOURCES) as ResourceKey[]
).flatMap((resource) =>
  RESOURCES[resource].actions.map(
    (action) => `${resource}:${action}` as Permission,
  ),
);

const known = new Set<string>(ALL_PERMISSIONS);

export const isPermission = (value: unknown): value is Permission =>
  typeof value === 'string' && known.has(value);

/** The product a permission belongs to. */
export const productOf = (permission: Permission): ProductOrCore =>
  RESOURCES[permission.slice(0, permission.indexOf(':')) as ResourceKey]
    .product;

/** Every permission of one product, or of core. */
export const permissionsOf = (product: ProductOrCore): Permission[] =>
  ALL_PERMISSIONS.filter((permission) => productOf(permission) === product);

/**
 * The permissions a user may actually hold: the ones their roles grant,
 * minus anything that is not a real permission, minus anything that belongs
 * to a product the business does not have.
 *
 * So not even the owner holds a Payroll permission without Payroll, and a
 * permission that was removed from the registry stops working at once. Core
 * permissions are never dropped.
 */
export const effectivePermissions = (
  granted: readonly string[],
  enabledProducts: readonly ProductKey[],
): Permission[] => {
  const enabled = new Set<ProductOrCore>([CORE, ...enabledProducts]);
  return [...new Set(granted)]
    .filter(isPermission)
    .filter((permission) => enabled.has(productOf(permission)));
};

/** Strings that are not in the registry. For validating a role before it is saved. */
export const findUnknownPermissions = (
  permissions: readonly string[],
): string[] => permissions.filter((permission) => !isPermission(permission));

/**
 * What is wrong with the permissions a product manifest lists: each must be
 * in the registry, and must belong to that product. An empty list means the
 * manifest and the registry agree.
 */
export const findManifestPermissionIssues = (manifest: {
  key: ProductKey;
  permissions: readonly string[];
}): string[] => {
  const issues: string[] = [];
  for (const permission of manifest.permissions) {
    if (!isPermission(permission)) {
      issues.push(`"${permission}" is not in the permission registry`);
    } else if (productOf(permission) !== manifest.key) {
      issues.push(
        `"${permission}" belongs to ${productOf(permission)}, not to ${manifest.key}`,
      );
    }
  }
  for (const permission of permissionsOf(manifest.key)) {
    if (!manifest.permissions.includes(permission)) {
      issues.push(`"${permission}" is in the registry but not in the manifest`);
    }
  }
  return issues;
};
