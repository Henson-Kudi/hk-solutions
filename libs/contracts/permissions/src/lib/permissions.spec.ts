import { PRODUCT_KEYS, isProductKey } from '@hk/contracts/product-manifest';
import {
  ALL_PERMISSIONS,
  RESOURCES,
  effectivePermissions,
  findManifestPermissionIssues,
  findUnknownPermissions,
  isPermission,
  permissionsOf,
  productOf,
  type Permission,
} from './permissions';

describe('the permission registry', () => {
  it('gives every resource a real product and at least one action', () => {
    for (const [resource, definition] of Object.entries(RESOURCES)) {
      expect(resource).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(
        definition.product === 'core' || isProductKey(definition.product),
      ).toBe(true);
      expect(definition.actions.length).toBeGreaterThan(0);
      expect(new Set(definition.actions).size).toBe(definition.actions.length);
      for (const action of definition.actions) {
        expect(action).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('lists every permission once, as resource:action', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    expect(ALL_PERMISSIONS).toContain('invoices:issue');
    expect(ALL_PERMISSIONS).toContain('pos_sessions:cash_in_out');
    const total = Object.values(RESOURCES).reduce(
      (sum, definition) => sum + definition.actions.length,
      0,
    );
    expect(ALL_PERMISSIONS).toHaveLength(total);
  });

  it('types a permission, so a wrong one does not compile', () => {
    const good: Permission = 'invoices:issue';
    // @ts-expect-error "delete" is not an action of invoices
    const bad: Permission = 'invoices:delete';
    expect(isPermission(good)).toBe(true);
    expect(isPermission(bad)).toBe(false);
  });

  it.each([
    'invoices',
    'invoices:',
    ':issue',
    'Invoices:issue',
    'invoices:issue ',
    'stock:issue',
    '',
    42,
    null,
  ])('does not recognise %p', (value) => {
    expect(isPermission(value)).toBe(false);
  });
});

describe('productOf and permissionsOf', () => {
  it('know which product a permission belongs to', () => {
    expect(productOf('invoices:issue')).toBe('sales');
    expect(productOf('accounts:view')).toBe('core');
    expect(productOf('pos_sessions:open')).toBe('pos');
  });

  it('list the permissions of one product', () => {
    expect(permissionsOf('pos')).toEqual([
      'pos_sessions:open',
      'pos_sessions:close',
      'pos_sessions:cash_in_out',
      'pos_sessions:refund',
      'pos_sessions:override_price',
    ]);
    expect(permissionsOf('core')).toEqual([
      'accounts:view',
      'accounts:create',
      'accounts:update',
      'accounts:archive',
    ]);
    expect(permissionsOf('crm')).toEqual([]);
  });

  it('together cover every permission exactly once', () => {
    const collected = ['core' as const, ...PRODUCT_KEYS].flatMap(permissionsOf);
    expect([...collected].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
});

describe('effectivePermissions', () => {
  const ownerGrants = [...ALL_PERMISSIONS];

  it('drops the permissions of products the business does not have', () => {
    const effective = effectivePermissions(ownerGrants, ['sales']);
    expect(effective).toContain('invoices:issue');
    expect(effective).toContain('accounts:view');
    expect(
      effective.some((permission) => permission.startsWith('payroll_runs:')),
    ).toBe(false);
    expect(
      effective.some((permission) => permission.startsWith('pos_sessions:')),
    ).toBe(false);
  });

  it('never gives the owner a Payroll permission without Payroll', () => {
    expect(effectivePermissions(['payroll_runs:pay'], ['sales', 'hr'])).toEqual(
      [],
    );
    expect(
      effectivePermissions(['payroll_runs:pay'], ['hr', 'payroll']),
    ).toEqual(['payroll_runs:pay']);
  });

  it('always keeps core permissions, even with no products', () => {
    expect(
      effectivePermissions(['accounts:view', 'invoices:view'], []),
    ).toEqual(['accounts:view']);
  });

  it('drops anything that is not a real permission', () => {
    expect(
      effectivePermissions(
        ['invoices:issue', 'invoices:delete', '*', 'invoices:*', 'admin'],
        ['sales'],
      ),
    ).toEqual(['invoices:issue']);
  });

  it('removes duplicates and grants nothing that was not granted', () => {
    expect(
      effectivePermissions(
        ['invoices:view', 'invoices:view'],
        ['sales', 'pos'],
      ),
    ).toEqual(['invoices:view']);
    expect(effectivePermissions([], [...PRODUCT_KEYS])).toEqual([]);
  });
});

describe('findUnknownPermissions', () => {
  it('lists what is not in the registry', () => {
    expect(
      findUnknownPermissions([
        'invoices:issue',
        'invoices:delete',
        'reports:view',
      ]),
    ).toEqual(['invoices:delete', 'reports:view']);
    expect(findUnknownPermissions(['stock:count'])).toEqual([]);
  });
});

describe('findManifestPermissionIssues', () => {
  it("accepts a manifest that lists exactly its product's permissions", () => {
    expect(
      findManifestPermissionIssues({
        key: 'pos',
        permissions: permissionsOf('pos'),
      }),
    ).toEqual([]);
    expect(
      findManifestPermissionIssues({ key: 'crm', permissions: [] }),
    ).toEqual([]);
  });

  it('reports a permission that does not exist', () => {
    expect(
      findManifestPermissionIssues({
        key: 'pos',
        permissions: [...permissionsOf('pos'), 'pos_sessions:delete'],
      }),
    ).toEqual(['"pos_sessions:delete" is not in the permission registry']);
  });

  it("reports another product's permission", () => {
    expect(
      findManifestPermissionIssues({
        key: 'pos',
        permissions: [...permissionsOf('pos'), 'invoices:issue'],
      }),
    ).toEqual(['"invoices:issue" belongs to sales, not to pos']);
  });

  it('reports a registry permission the manifest forgot', () => {
    expect(
      findManifestPermissionIssues({
        key: 'pos',
        permissions: permissionsOf('pos').filter(
          (permission) => permission !== 'pos_sessions:refund',
        ),
      }),
    ).toEqual([
      '"pos_sessions:refund" is in the registry but not in the manifest',
    ]);
  });
});
