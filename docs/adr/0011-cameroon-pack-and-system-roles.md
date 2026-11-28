# ADR 0011: The Cameroon pack, and a shared list of system roles

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0010 (country pack kernel), which this adds to; ADR 0001 D2 (markets)

## Context

`libs/country-packs/cm` is the first real pack. Writing it raised choices the kernel had left
open: what the role names are, how a tax with two components is rounded in a currency with no
minor unit, and how values nobody has confirmed are carried.

## Decision

### System roles are a shared list in the kernel

ADR 0010 left `SystemRole` as any dotted string. Two packs would then each invent names, and a
product that posts to `ar.trade` would find it in one country and not the other.

`SYSTEM_ROLES` in the kernel is now the list of role names, each with a description.
`findPackIssues` rejects an account whose role is not on it. A role is added in the PR that first
needs it. A pack need not hold every role: only the ones its `requiredRoles`, posting rules and
tax components name.

The type `SystemRole` stays `string`, because product manifests in contracts hold role names as
strings and contracts cannot import the kernel. `RegisteredSystemRole` is the typed union, used
where a pack writes roles down.

### Everything in the Cameroon pack is unconfirmed, and says so

No source note in the pack has `confirmedBy`. `findUnconfirmedValues(cmPack)` lists every dated
value, and a test pins that list so a confirmation is a visible change. The rates and their start
date come from the tax authority's public leaflet and secondary sources; article numbers were not
checked against the text of the law.

`docs/country-packs/cm.md` is the checklist an accountant reviews: 24 questions and the VAT test
vectors. The plan's "done when" for this row has two halves. "Conformance suite green" holds.
"Tax test vectors reviewed by an accountant" does **not** hold yet and cannot be met by code; the
row is complete as software and open as a review.

Things one source reported that are not in the pack: a reduced rate of 10% for social housing
from 2026, and withholding regimes. They are questions on the checklist.

### VAT is charged once at the combined rate, and the surcharge takes the rounding

The standard rate is TVA 17.5% plus a communal surcharge (CAC) of 10% of the TVA. The pack stores
the surcharge as its share of the net amount (1.75%), because every rate in a pack is a fraction
of the net; a test checks the two tables agree in every period.

Per line: total = net × 19.25% rounded half up to the franc; TVA = net × 17.5% rounded the same
way; CAC = total − TVA. Rounding the two separately and adding them can differ from 19.25% of the
net by a franc, and the customer's total is the number that must be right.

Tax is rounded per line. Both choices are on the accountant's checklist, and both are one-line
changes behind the test vectors.

### The chart was checked against the SYSCOHADA handbook

Every account number and French name was compared with the "Liste des comptes" of the Acte
uniforme relatif au droit comptable et à l'information financière (Journal Officiel OHADA, 15
February 2017, pages 216 to 266). All are in the handbook under the number and name used. The
handbook is not in the repository: it is a copyrighted document and the repository is public.

The check changed the design in one place. SYSCOHADA reports exchange differences on customer
and supplier balances in operating result (656, 756) and those on cash and borrowings in
financial result (676, 776). One "exchange gain" role could not serve both, so the shared list
has four: `fx.gain.trade`, `fx.loss.trade`, `fx.gain.financial`, `fx.loss.financial`. A country
whose framework does not make the distinction still gives each its own account.

What the handbook does not settle is which account each purpose should use. Losses are the
clearest case: the pack maps the year's result to 131 and retained earnings to 121, and the
handbook puts a loss in 139 and losses carried forward in 129. One role per account cannot
express "profit here, loss there". The year-end close (phase 5) has to decide, and the
question is on the checklist.

### Both chart templates hold every role

ADR 0010 requires every role to be held in every template. The handbook prescribes no list of
accounts for the SMT: it asks for a cash journal, registers and three short statements. The SMT
template is therefore the pack's own construction, the normal chart without share capital,
reserves, company income tax and some detail accounts. It keeps the accounts the SMT statements
have lines for, and every role-holding account, including VAT accounts the SMT statements do not
show.

SYSCOHADA classes mix account types (class 4 holds receivables and payables), and a parent and
its sub-accounts must share a type. Where a two-digit account would mix them, the template starts
at the three-digit account.

### Posting rule seeds are provisional

The seeds use event topics and line kinds the plan describes (sections 8.5 and 10.3). The
products that emit them arrive in phase 5 and will settle the names. The seeds are enough to
validate the pack and to show the shape.

## Consequences

- **A new role is a kernel change.** That is the point: every pack sees it.
- **The UAE pack (row 2.3) must hold the same roles** for the products it offers, under its own
  account numbers.
- **Payroll is `UNAVAILABLE` in Cameroon** until the payroll engine exists (row 8.2).
- **The ID validators check shape only.** The NIU and RCCM formats come from secondary sources.
  A real number in an unexpected format would be rejected at onboarding; the checklist asks.
- **Pack settings defaults are not modelled.** The plan gives pre-orders "enabled by default in
  CM"; that belongs with the sales settings in phase 5.
- **Go-live needs the checklist closed.** Nothing in CI enforces it yet. A release check that
  fails while `findUnconfirmedValues` is non-empty for a live country belongs with the release
  pipeline.
