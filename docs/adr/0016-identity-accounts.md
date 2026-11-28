# ADR 0016: Identity accounts, one-time codes and passwords

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0003 (tenancy and row-level security), ADR 0013 (how core libs are laid
  out), ADR 0015 (messaging ports)

## Context

Plan row 3.2 is `core/identity`: "users, phone or email, OTP, password, sessions with rotation and
reuse detection, roles, invites, device PIN". It is done when BizTrack's authentication flows work
end to end.

Two things changed the row before any code was written.

- **Passkeys move into this row.** The plan had them in phase 9 with single sign-on. Henson decided
  on 2026-11-28 that identity includes passkeys from the start, in every country. Single sign-on
  stays in phase 9.
- **BizTrack's own documents disagree with each other** on several numbers (code length and
  lifetime, lockout, token lifetimes). They are a description of flows, not a specification, so
  each contradiction needed a choice.

## Decision

### The row is delivered as five pull requests

Identity is the most security-sensitive code before the ledger, and a single pull request for all
of it could not be reviewed properly.

1. **Accounts** (this one): users, phone and email identifiers, passwords, one-time codes, sign-up
   and verification, password reset and change.
2. **Sessions:** sign-in by password or code, access and refresh tokens, rotation, reuse detection,
   sign-out, lockout.
3. **Passkeys:** WebAuthn registration and sign-in.
4. **Access:** roles, memberships with branch scope, invites, choosing a business.
5. **Shared devices:** the device PIN, and the end-to-end test of BizTrack's flows that closes the
   row.

### A user is a person, not part of a business

`users`, `user_identifiers` and `otp_challenges` have no tenant columns and no row-level security
policy. One person can belong to several businesses and signs in once for all of them, so the
person cannot live inside any one tenant. This is a deliberate, named exception to "every business
table uses tenantColumns": the three tables are listed in `IDENTITY_GLOBAL_TABLES`, the tenancy
check is run with exactly that list as its exemptions, and a test proves the check flags each table
when it is not listed. The repositories run in a system transaction and refuse to run without one.

Memberships (part 4) are tenant-scoped. They, not the user row, decide which businesses a person
may enter.

### A phone number or an email is reserved by proving it, not by typing it

Each phone number and each email has at most one holder in the whole system (the primary key of
`user_identifiers`). An account is `pending` until one identifier is verified, and cannot sign in
before that.

If someone signs up with an identifier that nobody has verified:

- an abandoned `pending` account that holds it is removed;
- a live account that added it without verifying it loses it.

Without this, anyone could block a stranger's phone number or email by typing it into the sign-up
form. A verified identifier is never taken away this way.

### One-time codes

| Rule           | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Length         | 6 digits                                                      |
| Lifetime       | 10 minutes                                                    |
| Wrong attempts | 5, then the code is dead                                      |
| Use            | once; a new code kills the earlier ones                       |
| Resend         | at most 3 codes in 10 minutes, at least 60 seconds apart      |
| Stored as      | HMAC-SHA-256 under a server secret, bound to user and purpose |
| Purposes       | verify an identifier, sign in, reset a password               |

- **Stored keyed, not plainly hashed.** Six digits are a million possibilities; a plain hash is
  reversed instantly. With a key held outside the database, a copy of the table reveals nothing.
- **Bound to its purpose.** The hash covers the user, the identifier and the purpose, so a
  verification code cannot reset a password.
- **The wrong-attempt count is committed before the error is raised.** Raising the error inside the
  transaction would roll the count back and allow unlimited guessing. The use case returns the
  verdict from the unit of work and throws afterwards. The in-memory unit of work rolls back on
  failure like a database, so this is tested on both.
- **Attempts are judged one at a time.** `findLive` locks the row (`FOR UPDATE`). A test sends ten
  wrong guesses at once and requires exactly four "wrong", one "too many" and five "expired".
- **A code is sent outside the transaction**, phone first, by the person's preferred channel and
  then the other (`sendFirst` with `onUnknown: 'continue'`, ADR 0015). If no channel accepts it,
  the code is deleted so it does not count against the resend limit.
- **The resend limit also bounds abuse of sign-up**: it is counted per identifier, and code rows
  outlive a discarded sign-up, so repeated sign-ups cannot be used to flood a phone with messages.

The resend limits are ours; BizTrack's documents give none.

### Passwords

- **Optional.** An account may use codes (and later passkeys) only.
- **8 to 128 characters, with an upper-case letter, a lower-case letter and a digit**, not a
  well-known password, and not built from the person's name, phone number or email.
- **Argon2id**, from Node's own `crypto` module (no third-party library), at OWASP's recommended
  minimum: 19 MiB, 2 passes, 1 lane. The stored value is a standard PHC string that carries its
  parameters, so they can be raised later. Verification refuses parameters above a ceiling, so a
  corrupted hash cannot make the server spend a gigabyte.
- Hashing happens outside the database transaction: it is slow on purpose.

### What an answer may reveal

- **Sign-up says "already registered".** The alternative is to pretend and send a message, which
  makes the form confusing for the many honest people who forgot they have an account. It was
  proposed to Henson with the other choices below; it applies to sign-up only.
- **Everything else is generic.** Resending a code and starting a password reset answer the same
  way whether or not the account exists, and send nothing when it does not. Verifying a code for an
  unknown identifier answers like an expired code.
- **No phone number, email, code or password appears in an error.** Destinations are returned
  masked (`+237•••••001`). Every code message is marked sensitive (ADR 0015).

### Where BizTrack's documents disagreed or were silent

BizTrack's documents give different values in different places for the code's length and lifetime,
among others. Rather than pick one document over another, each value was chosen on its merits and
put to Henson as a list on 2026-11-28: 6-digit codes valid for 10 minutes with 5 attempts; codes
stored as a keyed hash; Argon2id for passwords; phone numbers of any country in E.164; a password
optional at sign-up; the resend limits above. The values in this ADR are the ones to rely on.

The choices for later parts (lockout after 10 wrong passwords for 1 hour, 15-minute access tokens,
30-day rotating refresh tokens, 6-digit device PIN) are recorded in their own ADRs when built.

## Consequences

- No migration files and no HTTP layer yet: both arrive with `apps/migrator` and the Nest layer in
  row 3.11, as for audit and files (ADR 0013). The table definitions are final in intent and need
  Henson's line-by-line review.
- The one-time code secret is a new piece of service configuration (at least 32 bytes). Changing it
  invalidates the codes in flight, nothing else.
- The message wording for codes lives in `core/identity/application` in English and French until
  the shared catalog exists (phase 4). Arabic users get English until Arabic is written by a
  speaker. WhatsApp needs three approved templates: `otp_verification`, `otp_login`,
  `otp_password_reset`.
- Not done here, and owed: re-hashing a password with stronger parameters at sign-in (part 2);
  audit events for account actions, which happen outside any business and so do not fit the
  per-business audit chain (decided in part 2, with sessions); a job that removes old code rows
  and long-abandoned pending accounts (row 3.11); changing or adding an identifier on an existing
  account.
