# @hk/country-packs/ae

The United Arab Emirates country pack. It implements `CountryPack` from
`@hk/country-packs/kernel` and passes the pack conformance suite.

**Nothing in it is confirmed by a tax adviser yet.** The questions for them, and the VAT test
vectors, are in `docs/country-packs/ae.md`. `findUnconfirmedValues(aePack)` lists what is waiting.

## Using it

Only the place that starts an app imports this lib:

```ts
import { aePack } from '@hk/country-packs/ae';

const packs = createPackRegistry([cmPack, aePack]);
```

Everything else is handed the registry and asks it by the business's country.

## What it holds

| File            | Holds                                                           |
| --------------- | --------------------------------------------------------------- |
| `pack.ts`       | `aePack`: AED, fiscal year, payment methods, products, reports  |
| `chart.ts`      | A four-digit IFRS-style chart, and the roles each product needs |
| `tax/codes.ts`  | VAT codes and their dated rates                                 |
| `tax/engine.ts` | The VAT calculation, reverse charge, and who is liable          |
| `business.ts`   | Legal forms, the TRN validator, emirates, registration fields   |
| `sources.ts`    | Where each value comes from, and whether the source was read    |

The posting rules are the kernel's standard set (`standardPostingRules`).

## VAT

One rate, 5%, since 1 January 2018. Tax is rounded per line to the nearest fils, halves up.

```ts
aePack.tax.calculate({
  date: '2026-01-15',
  direction: 'sale',
  lines: [{ id: '1', net: Money.of('1234.56', 'AED'), taxCode: 'VAT_STD' }],
});
// VAT 61.73, gross 1296.29
```

## Reverse charge

`VAT_RC` is for a purchase from a supplier outside the UAE who charges no VAT. The buyer accounts
for the 5% itself.

```ts
// direction: 'purchase', net 1000 AED, taxCode: 'VAT_RC'
// tax 50, gross 1000: the supplier is paid the net
// component: { amount: 50, role: 'vat.input', counterRole: 'vat.output' }
```

The same 50 is posted to input VAT and to output VAT. On a sale with `VAT_RC` the seller charges
nothing.

## Not every business charges VAT

Only a business registered for VAT does. Registration is mandatory above AED 375,000 of taxable
supplies a year and voluntary from AED 187,500.

```ts
aePack.tax.isLiable({ vat_status: 'registered' }); // true
aePack.tax.isLiable({ vat_status: 'not_registered' }); // false
```

The pack asks whether the business is registered. It does not decide whether it should be.

## The chart is ours

The UAE prescribes no chart of accounts, so this one is our own construction and is on the
adviser's checklist as a whole.

## Review

`src/lib/tax/` is on the list of paths that need Henson's line-by-line review.
