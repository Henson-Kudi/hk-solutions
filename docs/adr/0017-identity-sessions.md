# ADR 0017: Sessions, token rotation and password lockout

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0016 (identity accounts; this is part 2 of the five parts it lists)

## Context

Plan row 3.2 asks for "sessions with rotation and reuse detection". Section 13.1 of the plan says
the gateway "authenticates the session (opaque refresh token plus a short access token) through
core", and then mints its own 60-second signed token for the services behind it.

So core has one question to answer for each request: is this token live, and whose is it?

## Decision

### Both tokens are opaque, and only their hashes are stored

An access token and a refresh token are each 256 random bits behind a prefix (`hka_`, `hkr_`). The
server stores a SHA-256 of each and looks tokens up by hash.

The alternative was a signed access token (a JWT) that the gateway could check without asking
core. It was not chosen:

- A signed token stays valid until it expires. Signing out, a password reset or a suspension would
  take up to 15 minutes to bite. With opaque tokens they are immediate, and tests prove it.
- It needs signing keys, their rotation and their distribution. The gateway already has that
  machinery for the internal token; core does not need a second set.
- The cost is one lookup by a unique index for each request. If that ever matters, the gateway
  can cache an answer for a few seconds, which is a far smaller window than 15 minutes.

A plain SHA-256 is right for tokens although it was wrong for one-time codes (ADR 0016): a
six-digit code has a million possible values, a token has 2^256.

### Lifetimes

| What          | Lifetime                                              |
| ------------- | ----------------------------------------------------- |
| Access token  | 15 minutes                                            |
| Refresh token | 30 days, starting again each time the session is used |

A session that is used at least once every 30 days does not end by itself. There is no absolute
limit on a session's age yet; see "Open".

### Rotation, and what happens when a refresh token comes back

Using a refresh token replaces the pair. The old access token stops working at once, not at its
expiry.

A refresh token that was already used and is presented again means two parties hold it. The
session is ended (`reuse_detected`), which signs out both. Only that session ends, not the
person's others.

**One exception, for lost replies.** A phone on a weak network can send a refresh, lose the reply,
and send it again. Treating that as theft would sign people out at random. So a used refresh token
is accepted again when **both** hold: it was used less than 30 seconds ago, and the pair issued in
its place has never been used. The unused pair is killed and a new one is issued. If whoever
holds the killed pair later uses it, that is reuse, and the session ends.

This does give a thief who replays a stolen token within 30 seconds, before the owner's device
uses its new pair, a working pair. The owner's device then presents a killed token on its next
refresh, which ends the session for both. Without the exception the same theft is caught one step
sooner; the price would be honest users signed out by bad networks. The window is one constant
(`SESSION_RULES.retryGraceSeconds`) and can be set to zero.

The row lock on the pair and its session makes this exact under concurrency: a test sends one
refresh token five times at once and requires exactly one usable pair afterwards.

**Ending a session is committed before the error is returned.** As with wrong one-time codes
(ADR 0016), the unit of work returns what happened and the error is raised after it commits.

### Password lockout

Ten wrong passwords in a row lock **password** sign-in for that account for one hour. Wrong
passwords more than an hour old do not count, and a right password clears the count.

- **Each attempt is counted before the password is checked**, in its own committed transaction,
  under a lock on the user's id. Checking first and counting after would let a burst of parallel
  guesses all be checked before any was counted. A test sends 30 wrong passwords at once and
  requires exactly 10 checked and 20 refused.
- **Signing in with a code still works while locked.** Otherwise anyone could lock a person out of
  their account by typing wrong passwords at it. A password reset also lifts the lock.
- **The lock is visible** (`IDENTITY_ACCOUNT_LOCKED`, with the seconds left). That tells a caller
  the account exists, after ten attempts. Hiding it would mean telling the real owner "wrong
  password" for an hour while they type the right one. Sign-up already reveals existence
  (ADR 0016), so nothing new is given away.

### What sign-in reveals

A wrong password, an unknown identifier, an identifier the account has not verified and an
account with no password all get the same error, with the same wording. When there is no account
or no password, a decoy hash is checked anyway, so the answer takes as long as a real check.

Only after the password is proved right may the answer say more: a suspended account is told so.

A dead access or refresh token gets one error whatever the reason (unknown, expired, replaced,
signed out).

### Passwords and sessions

- A password **reset** ends every session of the user, in the same transaction that sets the
  password and uses up the code.
- A password **change** ends every session except the one that made the change.
- A stored hash made with weaker settings than today's is replaced at the next successful
  sign-in, the only moment the server holds the password (`PasswordHasher.needsRehash`).

### Suspension

Authenticating and refreshing both check that the user may still sign in. A suspended person is
cut off at once. Their tokens are not destroyed, so reinstating them needs no new sign-in.

## Consequences

- Three more global identity tables: `sessions`, `session_token_pairs`, `password_attempts`. They
  are listed in `IDENTITY_GLOBAL_TABLES` for the reason ADR 0016 gives, and the same test covers
  them. They need Henson's line-by-line review.
- A domain error has no "unauthenticated" kind. `IDENTITY_SESSION_INVALID` and
  `IDENTITY_CREDENTIALS_INVALID` must be mapped to HTTP 401 by the Nest layer in row 3.11.
- Clients must not run two refreshes of one session at the same time for long: the retry
  exception covers a repeat, not two devices sharing a token.
- `core/identity/application` gains a shared one-time code module (`otp-flow`), used by accounts
  and by sign-in. The use cases of ADR 0016 behave as before; its tests pass unchanged apart from
  the two new dependencies.

## Open

- **Audit of account actions.** ADR 0016 said this would be decided here. It is not: the audit
  chain (ADR 0013) is per business, and sign-ins and password changes happen outside any
  business. The `sessions` table already records each sign-in, its method and why it ended. A
  proper account-level audit chain is a change to `core/audit` and should be its own reviewed PR.
- **An absolute limit on session age** (for example 180 days whatever the use). Not asked for by
  the plan or by BizTrack's documents; easy to add as one rule.
- **Per-IP rate limiting** belongs to the gateway (plan section 13.1), not here. The lockout
  protects one account from guessing; it does not stop one address trying many accounts.
- **Cleanup** of ended sessions and old token pairs: a job in row 3.11.
