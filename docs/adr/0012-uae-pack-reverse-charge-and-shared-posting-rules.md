# ADR 0012: The UAE pack, reverse charge, and shared posting rules

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0010 (country pack kernel) and ADR 0011 (Cameroon pack, system roles), which
  this adds to

## Context

`libs/country-packs/ae` is the second pack. A second pack is where shared things show themselves:
anything written twice, and anything the first country did not need. Two came up: the starter
posting rules, and reverse charge.

## Decision

### The starter posting rules live in the kernel

Posting rules name roles, not accounts, so the rules for a sales invoice or a supplier bill are
the same in every country. Writing them once per pack would let the two drift. The kernel now
exports `standardPostingRules({ taxOnAdvances })`, and both packs use it. The one thing that
differs by country, whether tax is posted when an advance is received, is the option.

The Cameroon pack's rules moved without change: its tests, which pin every rule, passed
unmodified.

### Reverse charge is expressed in the tax result

Under reverse charge the seller charges no tax and the buyer accounts for it. The kernel's result
could not say that: `gross` meant net plus tax, and a component had one role.

- On a **purchase** with a reverse charge code, the components carry the tax the buyer accounts
  for, `gross` is the net (what the supplier is paid), and each component has a `counterRole`:
  the same amount is posted to the input role and to the output role.
- On a **sale**, the components are zero and `gross` is the net.

The conformance suite checks all of it, on each line as well as on the totals, and the validator
requires a reverse charge component to have both an output and an input role.

`TaxRequest` still has no place of supply or customer type. The user, or the product, picks the
code. Working out the treatment from where the customer is belongs with the sales and purchases
products.

### The UAE chart is our own

The UAE prescribes no chart of accounts; IFRS sets what statements show, not account numbers. The
pack's chart is a four-digit layout of 68 accounts, built to hold every role the products need
plus the UAE-specific accounts (end-of-service provision, WPS clearing, corporate tax). There is
one template. It is on the adviser's checklist as a whole.

### What was read, and what was not

Read: the Executive Regulation of the VAT Decree-Law, consolidated, as published by the Ministry
of Finance. It gives the registration thresholds (arts. 7, 8), reverse charge (art. 48), invoice
content and numbering (art. 59), and rounding to the fils (art. 61).

Not read: the Decree-Law itself, because the official legislation site refused the request. The
5% rate and the date-of-supply rule are in it. Each source note says READ or NOT READ, so nobody
mistakes one for the other.

### Liability is registration, not a threshold test

`isLiable` answers from the business's own statement that it is registered for VAT. The pack does
not test turnover against AED 375,000: whether a business should register is advice, and a wrong
automatic answer would either charge tax unlawfully or fail to charge it.

### Arabic waits

The plan lists `en` and `ar` for the UAE. The pack lists `en-AE` only. Every text needs English
and French today; adding `ar-AE` before Arabic text exists would promise a language the app
cannot show.

## Consequences

- **Nothing checks the two packs against each other.** A pack may not import another pack, so no
  test in either can build a registry with both. The first app that starts with both packs gets
  that test.
- **Per-line rounding may be wrong for e-invoicing.** One secondary source says the coming
  e-invoicing rules round at invoice level. `rounding.level` is data, and the engine would need
  the second mode.
- **Designated zones change no tax treatment yet.** The pack records the answer and does nothing
  with it.
- **`tax.corporate_tax` is listed as a capability** with nothing behind it yet. Corporate Tax is
  phase 9; the capability says the country has the tax, not that the software handles it.
- **Payroll is `UNAVAILABLE` in the UAE** until the payroll engine exists (row 8.2), and the pack
  has no e-invoicing adapter until phase 9.
- **The exchange difference split** (trade and financial) comes from SYSCOHADA. The UAE chart
  carries four accounts for it that IFRS does not require.
