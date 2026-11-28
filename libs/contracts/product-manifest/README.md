# @hk/contracts/product-manifest

What products exist, what each one needs, and whether a feature is on for a business. Pure
TypeScript that runs on the server, in the browser and on mobile.

## The product catalog

`PRODUCT_KEYS` lists the fifteen products. `PRODUCT_DEPENDENCIES` says what each requires, either a
specific product or any one of a group:

```ts
pos: ['sales', 'inventory'],
tax: [{ anyOf: ['sales', 'purchases'] }],
```

**This file is the source of truth for the dependency graph.** Contracts cannot import product
libs, so the data lives here and each product's manifest must agree with it. `core` is always on
and is not a product.

## Questions about the graph

| Function                             | Answers                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `resolveSelection(selection)`        | What must be added to a selection, and which "any one of" choices only the user can make. |
| `findMissingRequirements(selection)` | Whether a business may hold exactly this set.                                             |
| `dependantsOf(product, selection)`   | What would break if this product were removed. Removal is refused while it is not empty.  |
| `findCycles()`                       | Dependency cycles. The real graph must have none; a test enforces it.                     |
| `dependencyOrder()`                  | The products, dependencies first. For running migrations in order.                        |

## Manifests

A `ProductManifest` is what a product declares about itself (`libs/products/<key>/manifest.ts`):
its requirements, capabilities, core scopes, routes, events, permissions, schema, system roles and
meters.

Every product has this test, so an invalid manifest fails CI in the PR that introduces it:

```ts
expect(findManifestIssues(manifest)).toEqual([]);
expect(findManifestPermissionIssues(manifest)).toEqual([]); // from @hk/contracts/permissions
```

Across all manifests, `findOrphanTopics(manifests, coreTopics)` lists topics that are consumed but
produced by nobody, and `scopeDeclarations(manifests)` is the input of the service scope registry
in `@hk/platform/internal-auth`.

## Feature flags

A feature is on when the country supports it, the business has the product, and the business has
not switched it off:

```ts
if (features.isOn(businessContext, 'payroll.wps')) {
  // …
}
```

- The UI and the API ask through this one function, so a screen and its endpoint cannot disagree.
- **Never check a country code** to decide a feature. Ask the pack for a capability, through this.
- `features.explain(context, key)` says which of the three conditions failed.
- A setting alone cannot switch a feature on, and an unknown feature is off.
