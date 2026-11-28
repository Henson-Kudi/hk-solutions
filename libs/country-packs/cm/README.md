# @hk/country-packs/cm

The Cameroon country pack. It implements `CountryPack` from `@hk/country-packs/kernel` and passes
the pack conformance suite.

**Nothing in it is confirmed by an accountant yet.** The questions for them, and the VAT test
vectors, are in `docs/country-packs/cm.md`. `findUnconfirmedValues(cmPack)` lists what is waiting.

## Using it

Only the place that starts an app imports this lib:

```ts
import { cmPack } from '@hk/country-packs/cm';

const packs = createPackRegistry([cmPack, aePack]);
```

Everything else is handed the registry and asks it by the business's country. Product code never
imports a pack and never writes a country code.

## What it holds

| File               | Holds                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| `pack.ts`          | `cmPack`: XAF, fr/en, fiscal year, payment methods, products, reports      |
| `chart.ts`         | SYSCOHADA charts: système normal and SMT, and the roles each product needs |
| `tax/codes.ts`     | VAT codes and their dated rates                                            |
| `tax/engine.ts`    | The VAT calculation                                                        |
| `business.ts`      | Legal forms, NIU and RCCM validators, registration fields                  |
| `posting-rules.ts` | The posting rules a new business starts with                               |
| `sources.ts`       | Where each value comes from                                                |

## VAT

The standard rate is two components: TVA at 17.5% and the communal surcharge (CAC) at 10% of the
TVA, which is 1.75% of the net amount. 19.25% in all.

For each line, the total is 19.25% of the net rounded half up to the franc, the TVA is 17.5%
rounded the same way, and the CAC is the rest. The customer is always charged 19.25% rounded
once.

```ts
cmPack.tax.calculate({
  date: '2026-01-15',
  direction: 'sale',
  lines: [{ id: '1', net: Money.of('1000', 'XAF'), taxCode: 'TVA_STD' }],
});
// TVA 175, CAC 18, tax 193, gross 1193
```

## Not every business charges VAT

Only a business on the régime réel is subject to VAT (Code Général des Impôts 2026, art. 132). A
business under 50 million F CFA of turnover is on the impôt général synthétique and charges none.

```ts
cmPack.tax.isLiable({ tax_regime: 'real' }); // true
cmPack.tax.isLiable({ tax_regime: 'igs' }); // false
cmPack.tax.notLiableCode; // 'TVA_OUT_OF_SCOPE': the code its sales use
```

Product code asks the pack this question. It never tests the regime itself.

## Changing a rate

Never edit a rate in place. Add an entry to the rate table with the day the new rate starts and
its source, and end the old entry the day before. Documents dated earlier keep the old rate.
The surcharge is stored as its share of the net amount, so a change of the TVA rate needs a new
entry in both tables; a test checks they agree.

## Review

`src/lib/tax/` is on the list of paths that need Henson's line-by-line review.
