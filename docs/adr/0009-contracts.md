# ADR 0009: Contracts: products, permissions, events and sync

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D1 (product model), D8 (offline-first), D9 (events), D28 (boundaries);
  ADR 0002 (Hermes target); ADR 0005 (outbox); ADR 0007 (internal auth)

## Context

Services and clients need to agree on four things without importing each other's code: which
products exist and what they need, which permissions exist, what an event looks like, and what a
device sends when it syncs. `libs/contracts` holds those agreements. This record fixes the choices
made while writing them.

## Decision

### The dependency graph is data in contracts

The plan says the graph is "built from each manifest's `requiresProducts`". Manifests live in
product libs, and contracts may not import products. So `PRODUCT_DEPENDENCIES` in
`contracts/product-manifest` is the source of truth, and `findManifestIssues` requires each
manifest's `requiresProducts` to equal its entry there.

A requirement is a product key, or `{ anyOf: [...] }` for "any one of". Selection completion
(`resolveSelection`) adds outright requirements and returns "any one of" requirements as choices
for the user; it never picks one.

A test asserts the real graph has no cycle, and that the detector finds planted ones, including a
cycle that runs through an "any one of".

### Manifests are validated by a function each product calls

There are no manifests yet. `findManifestIssues` and, from `contracts/permissions`,
`findManifestPermissionIssues` return a list of problems, and each product's own test expects an
empty list. That is how "manifests validated in CI" holds once products exist, with no central
script that would have to load every product. The product generator writes that test.

### A feature is capability, entitlement and setting

`features.isOn(context, key)` is true only when the country pack has the capability, the business
has the product the feature belongs to, and the business has not switched it off. A setting alone
cannot switch a feature on, and an unknown key is off. Capability keys are checked for format only
here; their list belongs to `country-packs/kernel`.

### Permissions are a typed registry

`RESOURCES` maps each resource to one product and its actions, and `Permission` is the union of
`resource:action` strings derived from it. `effectivePermissions` drops permissions of products the
business does not have, which is what makes entitlements bite even for an owner.

The registry starts with the resources named in the plan. Each product adds its own in the PR that
builds it.

### Events are defined once, with a version

`defineEvent({ topic, version, schema })` gives the producer `create` and the consumer `parse`.
The version travels in the `hk-event-version` header, so the event keeps the shape the outbox
already stores (ADR 0005) and no column was added to a reviewed money-path table.

`create` throws on a payload its schema rejects. `parse` returns a `Result`, and its errors never
quote a payload value.

### Sync carries commands

`SyncCommand` is the plan's envelope. A push holds at most 100 commands, from one device and one
business, with no command twice. The command id is the idempotency key (ADR 0005, ADR 0006).

### Contracts are checked on the Hermes target

Contracts run on mobile. `pnpm test:hermes` now covers projects tagged `scope:contracts` as well as
`runtime:universal`, and the Hermes compile includes them. Zod, their one dependency, compiles
under Hermes.

## Consequences

- **Adding a product touches contracts.** Its key, its dependencies, its permissions and its event
  definitions are added here. That is deliberate: it is the one place every other service can see.
- **The dependency data can drift from the plan.** A test pins `PRODUCT_DEPENDENCIES` to the plan's
  table, so a change is a visible edit to that test.
- **`multi_business` is a product key without a service.** The module-boundary list of products in
  `tools/eslint/boundaries.mjs` has fourteen entries, one per service; the catalog has fifteen.
- **`@RequirePermission` is still untyped.** Platform libs may not import contracts, so the
  decorator takes strings. Handlers pass a constant typed as `Permission`.
- **An event's version is not in the payload or the topic.** A consumer that ignores the header
  and parses a payload by hand loses the check. Consumers go through `parse`.
- **Retention and late sync.** ADR 0006 noted that a write retried after the idempotency retention
  period runs again. Commands from a device that was offline for longer than that are the case to
  design for when the sync endpoint is built.
- **Not here:** the topic registry of concrete events, the sync engine, the sync endpoint and the
  conflict rules. They arrive with the products and with phase 4 and 6.
