import {
  ALL_PERMISSIONS,
  type Permission,
  type ResourceKey,
} from './permissions';

/**
 * The built-in roles every business starts with, and what each may do by
 * default.
 *
 * They live beside the permission registry on purpose: the PR that adds a
 * product's resources to the registry also decides, here, which built-in
 * roles get them. A test fails when a resource is in the registry and no
 * decision about it has been made here.
 *
 * These are DEFAULTS. A business can change what its own copy of a role may
 * do, except for the owner, who always holds everything.
 */
export const SYSTEM_ROLE_KEYS = [
  'owner',
  'manager',
  'accountant',
  'cashier',
  'storekeeper',
  'hr_officer',
  'viewer',
  'external_accountant',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const OWNER_ROLE_KEY: SystemRoleKey = 'owner';

export const isSystemRoleKey = (value: unknown): value is SystemRoleKey =>
  typeof value === 'string' &&
  (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);

/** The name of each built-in role, in English. Clients translate by key. */
export const SYSTEM_ROLE_NAMES: Record<SystemRoleKey, string> = {
  owner: 'Owner',
  manager: 'Manager',
  accountant: 'Accountant',
  cashier: 'Cashier',
  storekeeper: 'Storekeeper',
  hr_officer: 'HR Officer',
  viewer: 'Viewer',
  external_accountant: 'External accountant',
};

/** The actions of one resource, as a type. */
type ActionsOf<Resource extends ResourceKey> =
  Extract<Permission, `${Resource}:${string}`> extends `${Resource}:${infer A}`
    ? A
    : never;

/**
 * For each resource, the actions each role gets. A role left out of a
 * resource gets nothing on it. The owner is not listed: the owner holds
 * every permission, including ones added later.
 *
 * The thinking behind the defaults:
 * - Manager: runs the business day to day. Everything except closing or
 *   reopening an accounting period and managing who has access.
 * - Accountant: the books. Sees operations, does not perform them.
 * - Cashier: sells and takes money. Cannot void, refund, change a price or
 *   adjust stock; those need a manager.
 * - Storekeeper: moves and counts stock. Adjusting it needs a manager.
 * - HR Officer: prepares payroll. Approving and paying need a manager.
 * - Viewer: looks, and changes nothing.
 * - External accountant: an outside firm. The books and exports only.
 */
const GRANTS: {
  [Resource in ResourceKey]: Partial<
    Record<
      Exclude<SystemRoleKey, 'owner'>,
      readonly ActionsOf<Resource>[] | 'all'
    >
  >;
} = {
  accounts: {
    manager: 'all',
    accountant: 'all',
    viewer: ['view'],
    external_accountant: ['view'],
  },
  journals: {
    manager: ['view', 'create', 'reverse', 'approve'],
    accountant: ['view', 'create', 'reverse'],
    viewer: ['view'],
    external_accountant: ['view', 'create'],
  },
  periods: {
    manager: ['view', 'soft_close'],
    accountant: ['view', 'soft_close'],
    viewer: ['view'],
    external_accountant: ['view'],
  },
  invoices: {
    manager: 'all',
    accountant: ['view', 'export'],
    cashier: ['view', 'create', 'issue'],
    viewer: ['view'],
    external_accountant: ['view', 'export'],
  },
  preorders: {
    manager: 'all',
    accountant: ['view'],
    cashier: ['view', 'create', 'take_payment', 'collect'],
    viewer: ['view'],
  },
  stock: {
    manager: 'all',
    accountant: ['view'],
    cashier: ['view'],
    storekeeper: ['view', 'transfer', 'count'],
    viewer: ['view'],
  },
  pos_sessions: {
    manager: 'all',
    cashier: ['open', 'close', 'cash_in_out'],
  },
  payroll_runs: {
    manager: 'all',
    accountant: ['view', 'export'],
    hr_officer: ['view', 'prepare', 'export'],
    external_accountant: ['view', 'export'],
  },
  members: {
    manager: ['view'],
    hr_officer: ['view'],
  },
  roles: {
    manager: ['view'],
  },
};

/**
 * The permissions a built-in role has by default. The owner gets every
 * permission in the registry.
 */
export const defaultPermissionsOf = (role: SystemRoleKey): Permission[] => {
  if (role === OWNER_ROLE_KEY) return [...ALL_PERMISSIONS];
  return (Object.keys(GRANTS) as ResourceKey[]).flatMap((resource) => {
    const granted = (
      GRANTS[resource] as Partial<
        Record<SystemRoleKey, readonly string[] | 'all'>
      >
    )[role];
    if (granted === undefined) return [];
    return ALL_PERMISSIONS.filter(
      (permission) =>
        permission.startsWith(`${resource}:`) &&
        (granted === 'all' ||
          granted.includes(permission.slice(resource.length + 1))),
    );
  });
};

/** The resources a decision has been made about. For the test that checks none is missing. */
export const RESOURCES_WITH_ROLE_DEFAULTS: readonly string[] =
  Object.keys(GRANTS);
