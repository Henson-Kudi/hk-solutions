import {
  ALL_PERMISSIONS,
  RESOURCES,
  isPermission,
  type Permission,
} from './permissions';
import {
  OWNER_ROLE_KEY,
  RESOURCES_WITH_ROLE_DEFAULTS,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_NAMES,
  defaultPermissionsOf,
  isSystemRoleKey,
  type SystemRoleKey,
} from './system-roles';

const has = (role: SystemRoleKey, permission: Permission): boolean =>
  defaultPermissionsOf(role).includes(permission);

describe('system roles', () => {
  it('are the roles the plan names, plus the external accountant', () => {
    expect(SYSTEM_ROLE_KEYS).toEqual([
      'owner',
      'manager',
      'accountant',
      'cashier',
      'storekeeper',
      'hr_officer',
      'viewer',
      'external_accountant',
    ]);
    expect(Object.keys(SYSTEM_ROLE_NAMES).sort()).toEqual(
      [...SYSTEM_ROLE_KEYS].sort(),
    );
    expect(OWNER_ROLE_KEY).toBe('owner');
  });

  it('recognises a system role key and nothing else', () => {
    expect(isSystemRoleKey('cashier')).toBe(true);
    for (const value of ['Cashier', 'admin', '', null, undefined, 3]) {
      expect(isSystemRoleKey(value)).toBe(false);
    }
  });

  it('has made a decision about every resource in the registry', () => {
    // A product PR that adds a resource must say which roles get it.
    expect([...RESOURCES_WITH_ROLE_DEFAULTS].sort()).toEqual(
      Object.keys(RESOURCES).sort(),
    );
  });

  it.each(SYSTEM_ROLE_KEYS)(
    'gives %s only real permissions, each once',
    (role) => {
      const permissions = defaultPermissionsOf(role);
      expect(permissions.every(isPermission)).toBe(true);
      expect(new Set(permissions).size).toBe(permissions.length);
    },
  );

  it('gives the owner every permission', () => {
    expect(defaultPermissionsOf('owner')).toEqual([...ALL_PERMISSIONS]);
  });

  it('gives nobody but the owner control of who has access', () => {
    const control: Permission[] = [
      'members:invite',
      'members:update',
      'members:remove',
      'roles:manage',
    ];
    for (const role of SYSTEM_ROLE_KEYS) {
      for (const permission of control) {
        expect(has(role, permission)).toBe(role === 'owner');
      }
    }
  });

  it('gives nobody but the owner the closing or reopening of a period', () => {
    for (const role of SYSTEM_ROLE_KEYS) {
      expect(has(role, 'periods:close')).toBe(role === 'owner');
      expect(has(role, 'periods:reopen')).toBe(role === 'owner');
    }
  });

  it('keeps voids, refunds, price overrides and stock adjustments from the cashier', () => {
    for (const permission of [
      'invoices:void',
      'pos_sessions:refund',
      'pos_sessions:override_price',
      'stock:adjust',
      'preorders:cancel',
      'preorders:forfeit',
    ] as const) {
      expect(has('cashier', permission)).toBe(false);
      expect(has('manager', permission)).toBe(true);
    }
    expect(has('cashier', 'invoices:issue')).toBe(true);
    expect(has('cashier', 'pos_sessions:open')).toBe(true);
  });

  it('lets the storekeeper move and count stock, not adjust it', () => {
    expect(defaultPermissionsOf('storekeeper')).toEqual([
      'stock:view',
      'stock:transfer',
      'stock:count',
    ]);
  });

  it('lets the HR officer prepare payroll, not approve or pay it', () => {
    expect(has('hr_officer', 'payroll_runs:prepare')).toBe(true);
    expect(has('hr_officer', 'payroll_runs:approve')).toBe(false);
    expect(has('hr_officer', 'payroll_runs:pay')).toBe(false);
  });

  it('lets the viewer look and change nothing', () => {
    const permissions = defaultPermissionsOf('viewer');
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.every((item) => item.endsWith(':view'))).toBe(true);
  });

  it('limits the external accountant to the books and exports', () => {
    const permissions = defaultPermissionsOf('external_accountant');
    const resources = new Set(permissions.map((item) => item.split(':')[0]));
    expect([...resources].sort()).toEqual([
      'accounts',
      'invoices',
      'journals',
      'payroll_runs',
      'periods',
    ]);
    expect(has('external_accountant', 'journals:reverse')).toBe(false);
    expect(has('external_accountant', 'invoices:create')).toBe(false);
  });

  it('does not let the accountant approve their own journals', () => {
    expect(has('accountant', 'journals:create')).toBe(true);
    expect(has('accountant', 'journals:approve')).toBe(false);
  });

  it('returns a fresh list each time', () => {
    const first = defaultPermissionsOf('owner');
    first.length = 0;
    expect(defaultPermissionsOf('owner').length).toBe(ALL_PERMISSIONS.length);
  });
});
