# @hk/country-packs/kernel

What a country pack is, and the tools every pack is built with. Pure TypeScript that runs on the
server, in the browser and on mobile.

A **country pack** holds everything that depends on the country a business is in: currency, chart
of accounts, tax codes and rates, ID formats, payment methods, and which products are offered.
Product code asks the pack. It never checks a country code.

## Using a pack

Whoever starts the app builds the registry, because the kernel cannot import the packs:

```ts
const packs = createPackRegistry([cmPack, aePack]); // throws if a pack is invalid
```

Code that needs a pack takes the business's country as data:

```ts
const pack = packs.find(business.country); // Result: COUNTRY_NOT_SUPPORTED when there is none
const tax = pack.value.tax.calculate({ date, direction: 'sale', lines });
```

- **Never write `'CM'` or `'AE'` outside `libs/country-packs`.** A lint rule rejects the literals
  everywhere else, except in seed files and tests.
- To switch a feature on or off by country, check a capability with `features.isOn` from
  `@hk/contracts/product-manifest`. `CAPABILITY_KEYS` here is the list of capabilities.

## Rates are dated, and say where they come from

A rate or a threshold is never a constant. It is a row in a `RateTable`:

```ts
const standardRate = createRateTable('vat.standard', [{ effectiveFrom: '2018-01-01', value: '0.05', source: { reference: 'Law …, Art. …' } }]);

standardRate.valueAt('2026-03-01'); // ok('0.05')
standardRate.valueAt('2017-06-01'); // err RATE_NOT_IN_EFFECT: never a guess
```

- Dates are `YYYY-MM-DD` strings. Rates are decimal strings (`'0.05'` is 5%), never JS numbers.
- An entry lasts until the next one starts, or until its own `effectiveTo`.
- `source.confirmedBy` and `source.confirmedOn` record that an accountant has confirmed the value.
  `findUnconfirmedValues(pack)` lists what is still waiting; it must be empty before go-live.

## Writing a pack

A pack implements `CountryPack` and passes the conformance suite. Its test file is:

```ts
const subject: PackConformanceSubject = {
  pack: cmPack,
  asOf: '2026-01-15', // a day on which every rate in the pack is in force
  samples: { validTaxIds: ['…'], invalidTaxIds: ['…'] }, // invented, never real numbers
  manifests, // every product manifest, once products exist
};

describe('cm pack conformance', () => {
  for (const testCase of countryPackConformance) {
    it(testCase.name, () => testCase.run(subject));
  }
});
```

The suite checks that the pack is well formed (`findPackIssues`), that it can carry the products
it offers, that its tax id validator never quotes the number it rejects, and that its tax engine's
amounts add up. **It cannot check that a rate is the right rate.** Each pack adds test vectors for
that, and an accountant reviews them.

## What is in here

| File                 | Holds                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `country.ts`         | `COUNTRY_CODES`, `CountryCode`                                                |
| `capabilities.ts`    | `CAPABILITY_KEYS`, `CapabilityKey`                                            |
| `effective-dated.ts` | `RateTable`, `SourceNote`, `createRateTable`                                  |
| `country-pack.ts`    | `CountryPack` and the types of its parts: chart, posting rules, tax, payments |
| `validation.ts`      | `findPackIssues`, `findPackManifestIssues`, `findUnconfirmedValues`           |
| `registry.ts`        | `createPackRegistry`                                                          |
| `conformance.ts`     | `countryPackConformance`                                                      |

## Not here yet

`PayrollEngine` and `EInvoicingAdapter` are placeholders with a key only. Their shapes are fixed
by the payroll rows (phase 8) and the e-invoicing rows (phase 9). Decisions and their reasons are
in `docs/adr/0010-country-pack-kernel.md`.
