# ADR 0010: The country pack kernel

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0001 D2 (markets), D28 (boundaries); ADR 0002 (Hermes target); ADR 0009
  (contracts, capabilities and feature flags)

## Context

Anything that depends on a country lives in a country pack, and product code never branches on a
country code. `libs/country-packs/kernel` defines what a pack is, before the first two packs are
written. This record fixes the choices made while writing it.

## Decision

### A pack is data and pure functions

`CountryPack` follows the interface in the plan. A pack has no database, network or clock, so the
same pack runs on the server, in the browser and on a phone. The kernel is checked on the Hermes
target like `platform/universal` and the contracts: `pnpm test:hermes` now covers projects tagged
`scope:country-pack`.

The plan names several types without defining them. The kernel defines them: chart templates,
posting rule seeds, tax codes with components, legal numbering rules, registration fields, payment
methods. `AccountType`, `BranchPolicy` and `SystemRole` are defined here and not in
`core/accounts`, because a pack cannot import core and core can import the kernel.

### Rates are effective-dated, with a source

`createRateTable` holds a value per date range, each with a `SourceNote`. Asking for a date no
entry covers is an error (`RATE_NOT_IN_EFFECT`), never the nearest value. An invalid table throws
when it is built, so a bad pack fails when it loads and not when an invoice is issued.

A source note may carry who confirmed the value and when. `findUnconfirmedValues` lists the values
nobody has confirmed. Packs will ship with that list non-empty during development; an empty list
is a go-live condition, not a merge condition.

### The tax engine is an interface, with rules every engine must obey

The kernel does not contain a tax calculation. `TaxEngine.calculate` is implemented by each pack,
because the rules differ: Cameroon's VAT is a tax plus a surcharge calculated on the tax, and the
UAE has reverse charge. What every engine must do is in the conformance suite: amounts in the
currency's minor units, line tax equal to the sum of its components, totals equal to the sums of
the lines, nothing charged on zero-rated, exempt and out-of-scope codes, the same answer for the
same request, and an error for an unknown code, for mixed currencies, and for a date before any
rate.

The suite cannot tell whether a rate is right. Test vectors in each pack do that, and an
accountant reviews them (plan rows 2.2 and 2.3).

### The registry is built by the app

The kernel cannot import the packs, since they import it. `createPackRegistry([...])` is called by
whoever starts the app. It validates every pack with `findPackIssues` and throws on an invalid or
duplicate one. `find(code)` returns `COUNTRY_NOT_SUPPORTED` for a country without a pack and does
not echo the code back.

### Capability keys live in the kernel

`CAPABILITY_KEYS` is the list ADR 0009 said belongs here. Contracts still holds capability names
as strings, because contracts cannot import the kernel. A kernel test checks that every capability
a feature flag depends on is a real key.

Two capabilities are tied to pack content so they cannot drift: `payroll.engine` is listed exactly
when the pack has a payroll engine, and `payments.mobile_money` exactly when it has a mobile money
payment method.

### A pack must be able to carry the products it offers

A product a pack does not mention is `UNAVAILABLE`. An offered product must have its dependencies
offered too. `findPackManifestIssues` checks each product manifest against the pack: required
capabilities, and the system roles it posts to. Every role a pack requires, a posting rule names
or a tax component posts to must be held by an account in **every** chart template of the pack,
and only by an account with no sub-accounts.

### Country literals are banned outside the packs

`no-restricted-syntax` rejects the string and template literals `'CM'` and `'AE'`. The exempt
places are `libs/country-packs/**`, seed files (`**/seeds/**`, `*.seed.ts`) and test files.

- **Tests are exempt, which the plan does not say.** A test has to state which country its
  fixture business is in. The rule exists to stop production code branching on a country.
- The rule's list of codes is in `tools/eslint/country-literals.mjs`, because ESLint cannot
  import TypeScript. `pnpm verify:boundaries` fails when it differs from the kernel's
  `COUNTRY_CODES`, and plants three violations to prove the rule fires.

## Consequences

- **Adding a country touches two lists**: the kernel's `COUNTRY_CODES` and the lint rule's. The
  country-pack generator will append to both; until it exists, the self-test catches a miss.
- **The rule matches whole literals only.** `'fr-CM'` is allowed. A country compared through a
  constant (`COUNTRIES.CM`) would not be caught, so the kernel exports no such constant.
- **A two-letter string that happens to be `'CM'` or `'AE'` for another reason is rejected.** It
  needs an `eslint-disable` line with a reason.
- **`PayrollEngine` and `EInvoicingAdapter` are placeholders** with a key only. Phases 8 and 9
  define them, which will change the kernel interface.
- **The tax request has no place-of-supply or customer type yet.** The UAE pack (row 2.3) needs
  them for reverse charge and will extend `TaxRequest` in its own PR.
- **Every chart template must hold every required role.** If a simplified chart genuinely lacks
  an account a product needs, that is a decision to revisit with the accountant, not a check to
  relax quietly.
- **The fixture pack in the kernel's tests uses invented values** under a registered country
  code. It says so at the top of the file.
