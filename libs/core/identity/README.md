# core/identity

Who a person is, and how they prove it. Decisions and their reasons: `docs/adr/0016` (accounts)
and `docs/adr/0017` (sessions).

Identity is delivered in five parts (plan row 3.2). Parts 1 and 2 are here: **accounts** and
**sessions**. Passkeys, access (roles, memberships, invites) and shared devices follow.

| Lib           | Runs on              | What it holds                                                           |
| ------------- | -------------------- | ----------------------------------------------------------------------- |
| `domain`      | API, desktop, mobile | Identifiers, the password policy, one-time code rules, the user         |
| `application` | API, desktop, mobile | Ports, the account use cases, in-memory adapters, conformance suites    |
| `infra-pg`    | API only             | Tables, PostgreSQL repositories, Argon2id and HMAC from Node's `crypto` |

## Using it

```ts
const accounts = createAccounts({
  users: new PgUserRepository(tables),
  otps: new PgOtpRepository(tables),
  sessions: new PgSessionRepository(tables),
  passwordAttempts: new PgPasswordAttemptsRepository(tables),
  unitOfWork: createPgIdentityUnitOfWork(database),
  passwordHasher: createArgon2idPasswordHasher(),
  otpCodec: createHmacOtpCodec(secretFromConfiguration),
  messenger,
  clock,
  newId,
  appName,
});

const { userId, codeSent } = await accounts.signUp({ name, phone, email, password });
await accounts.verifyCode({ identifier: phone, code });
```

Account use cases: `signUp`, `verifyCode`, `resendCode`, `requestPasswordReset`, `resetPassword`,
`changePassword`.

`createSessions` takes the same options plus `tokenCodec: createNodeTokenCodec()`. Session use
cases: `signInWithPassword`, `requestSignInCode`, `signInWithCode`, `refresh`, `authenticate`,
`signOut`, `signOutEverywhere`, `listSessions`.

```ts
const tokens = await sessions.signInWithPassword({ identifier: phone, password });
const who = await sessions.authenticate({ accessToken: tokens.accessToken });
const next = await sessions.refresh({ refreshToken: tokens.refreshToken });
```

None of the use cases runs offline.

## Rules worth knowing before changing anything

- **The identity tables are global**, not tenant-scoped: a person can belong to several businesses.
  They are listed in `IDENTITY_GLOBAL_TABLES`. Do not add a table to that list to quiet the tenancy
  check.
- **A wrong code is counted in a transaction that commits**, and the error is raised after it. Do
  not move the `throw` inside the unit of work. The same holds for ending a session on reuse of a
  refresh token, and for counting a password attempt.
- **A password attempt is counted before the password is checked.** Do not reorder them.
- **Tokens are returned once and never stored.** Only their SHA-256 is.
- **Nothing here may put a phone number, an email, a code or a password in an error or a log.**
  Use `maskIdentifier`.
- **Codes and passwords are never stored.** Codes are stored as a keyed hash, passwords as Argon2id.
- A new adapter for a repository must pass its conformance suite: `userRepositoryConformance`,
  `otpRepositoryConformance`, `sessionRepositoryConformance`, `passwordAttemptsConformance`.

## Testing

`insecureTestPasswordHasher`, `createTestOtpCodec` and `createTestTokenCodec` are instant
stand-ins for tests only.
`createInMemoryIdentityStore` gives repositories with a unit of work that rolls back on failure,
like a database. The `infra-pg` tests need PostgreSQL (`pnpm infra:up`).
