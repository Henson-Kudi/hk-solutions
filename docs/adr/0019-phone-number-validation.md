# ADR 0019: Phone numbers are checked against their country's numbering

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0015 (messaging ports). This adds to its rule for phone numbers; the rest of
  ADR 0015 stands.

## Context

ADR 0015 said a phone number is E.164 with no default country, and `parsePhoneNumber` checked only
that: a plus sign and 8 to 15 digits. So `+237999999999` was accepted, although no Cameroon number
starts with 9. A one-time code sent to such a number reaches nobody and is still paid for, and the
person waits for a message that cannot arrive.

Henson asked for a phone number library to make the check robust.

## Decision

`parsePhoneNumber` now also requires that the number is one its country could have issued: a
country code that exists, the right length for that country, and leading digits that country
uses. The check is made with `libphonenumber-js` (MIT licence, no dependencies of its own), the
JavaScript port of Google's phone number library.

What stays as ADR 0015 decided:

- The number must start with `+` and its country code. There is still **no default country**.
- The result is the E.164 form.
- No number appears in an error.

### The small data set, not the full one

The library ships its country data in two sizes.

| Data set      | Knows                                                          | Size   |
| ------------- | -------------------------------------------------------------- | ------ |
| Small ("min") | Country codes, lengths, the leading digits of national numbers | 84 KB  |
| Full ("max")  | The above, and each kind of number and operator range          | 156 KB |

The small one is used.

- **The full one goes stale in the harmful direction.** When an operator opens a new range, the
  full data refuses real customers until the library is upgraded. Country codes, lengths and
  leading digits change rarely; operator ranges change often.
- It is smaller, and this code ships in the mobile app.

The cost: a number with valid leading digits in a range no operator has been given yet is
accepted. That was true of every number before this change.

### The check runs in the pure layer

`core/comms/domain` runs on the API, the desktop app and the phone, so a number is refused on the
device before a request is made. The library is plain JavaScript. The Hermes compile step
(ADR 0002) bundles it and passes.

### No country is singled out

The same check applies to every country. `core/comms` does not look at which country a number
belongs to; a rule such as "only Cameroon and UAE numbers" would belong to a country pack and is
not wanted (ADR 0016: phone numbers of any country).

## Consequences

- A new runtime dependency, pinned to an exact version. **Upgrading it is part of keeping
  sign-up working**: a country that changes its numbering plan (as Cameroon did in 2014, going
  from 8 to 9 digits) is refused until the library knows. Upgrades should be routine, and run the
  comms tests.
- Numbers that were accepted before and are refused now: wrong length for their country, leading
  digits their country does not use, country codes that do not exist. No stored data is affected:
  nothing has been deployed.
- Invented numbers in tests must now be plausible. The existing ones (`+2376000000NN`,
  `+9715000000NN`) are.
- The shape check that was there before (a plus sign and digits only) is kept in front of the
  library. A control showed the library check already refuses everything it refuses; it stays so
  that nothing but a plus sign and digits is ever handed to a third-party parser.
