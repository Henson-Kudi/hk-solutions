# @hk/contracts/permissions

The permission registry: every resource, the product it belongs to, and what can be done to it.

```ts
invoices: { product: 'sales', actions: ['view', 'create', 'update', 'issue', 'void', 'export'] },
```

A permission is written `resource:action`. `Permission` is a type built from the registry, so
`'invoices:issue'` compiles and `'invoices:delete'` does not.

## Adding permissions

A product adds its resources to `RESOURCES` in the PR that builds it, and lists the same
permissions in its manifest. `findManifestPermissionIssues(manifest)` checks that the two agree: no
unknown permission, none that belongs to another product, none forgotten.

## What a user actually holds

```ts
const permissions = effectivePermissions(grantedByRoles, enabledProducts);
```

This drops anything that is not a real permission, and anything that belongs to a product the
business does not have. So not even the owner holds a Payroll permission without Payroll. Core
permissions are never dropped. The gateway calls it when it mints a user token.

## Also here

- `isPermission(value)`, `findUnknownPermissions(list)`: for validating a role before it is saved.
- `productOf(permission)`, `permissionsOf(product)`.

The `@RequirePermission` decorator in `@hk/platform/internal-auth` takes plain strings, because
platform libs may not import contracts. Write its argument as a `Permission`:

```ts
const ISSUE: Permission = 'invoices:issue';

@RequirePermission(ISSUE)
```
