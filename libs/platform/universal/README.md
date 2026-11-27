# @hk/platform/universal

The bottom of the dependency graph. Everything here runs unchanged on the API (Node), in the browser,
in Electron and in React Native (Hermes), so it uses no Node built-in, no framework and no platform
global. Its only dependency is `decimal.js`.

| Export                                                                | What it is for                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `Decimal`                                                             | Exact decimal arithmetic. Built from strings or bigints, never from JS numbers. |
| `Money`, `parseMoney`                                                 | A `Decimal` amount plus a currency. Refuses to mix currencies.                  |
| `currencyCode`, `minorUnitsOf`                                        | ISO 4217 codes and their decimal places (XAF 0, AED 2).                         |
| `Result`, `ok`, `err`, …                                              | The return type for operations that can fail for a business reason.             |
| `DomainError`                                                         | A business-rule failure with a stable `code` that doubles as the i18n key.      |
| `Clock`, `systemClock`, `FixedClock`                                  | The only way pure code learns the time.                                         |
| `createUuidV7Generator`, `uuidv7`, `isUuid`, `isUuidV7`, `uuidV7Time` | Time-ordered ids that a device can create offline.                              |
| `LocalizedText`, `localize`                                           | Business data stored in English and French (Arabic optional).                   |
| `LocalDate`, `addDays`, `addMonths`, `toLocalDate`, …                 | Calendar dates without a time zone: posting dates, due dates, effective dates.  |

## Rules of use

**Money never touches a JS number.** Amounts arrive and leave as decimal strings:

```ts
const net = Money.of('1000', 'XAF');
const vat = net.times('0.1925'); // 192.5 XAF, exact, not rounded
const total = net.plus(vat).roundToMinorUnit(); // 1192 XAF (banker's rounding)
JSON.stringify(total); // {"amount":"1192","currency":"XAF"}
```

- Arithmetic never rounds. Round in two places only: a document line with `roundToLine()` (4
  decimals, the scale of `numeric(20,4)` columns) and a document total with `roundToMinorUnit()`.
- The default rounding mode is `HALF_EVEN`. A country pack that needs another passes it in.
- `roundToMinorUnitWithDifference()` also returns what the rounding added or removed, for the
  rounding-difference account.
- `allocate(ratios)` splits an amount so the parts add back up exactly. Use it for payment
  allocation and for spreading a discount or a tax across lines.
- Operators on a `Decimal` (`a + b`, `a < b`) throw at runtime. Use `plus`, `compare` and friends.

**Parse at the boundary, trust inside.** Each type has two ways in. `Decimal.parse`, `parseMoney`,
`parseLocalDate`, `parseCurrencyCode` and `parseLocalizedText` return a `Result` for input you must
validate. `Decimal.from`, `Money.of`, `localDate` and `currencyCode` throw a `DomainError`, for
values the code already trusts.

**Ids need a random source on mobile.** Hermes has no `crypto.getRandomValues`, so `uuidv7()` throws
there by design. The mobile app builds its generator once, with a source such as `expo-crypto`:

```ts
const nextId = createUuidV7Generator({ random: getRandomValues });
```

There is no `Math.random` fallback: ids created offline on many devices must not collide.

**Dates are strings.** A `LocalDate` is `YYYY-MM-DD`. It sorts as text and never shifts across time
zones. Use `toLocalDate(clock.now(), 'Africa/Douala')` to get a business's "today".

## Tests

```sh
pnpm nx test platform-universal                          # on Node
pnpm nx test platform-universal --configuration=hermes   # without Node's globals and modules
pnpm test:hermes                                         # the line above for all universal libs, plus a real Hermes compile
```

The `hermes` configuration is a simulation on Node's engine, described in
[ADR 0002](../../../docs/adr/0002-hermes-compatible-test-target.md).
