# core/identity

Who a person is, and how they prove it. Decisions and their reasons: `docs/adr/0016` (accounts),
`docs/adr/0017` (sessions) and `docs/adr/0018` (passkeys).

Identity is delivered in five parts (plan row 3.2). Parts 1 to 3 are here: **accounts**,
**sessions** and **passkeys**. Access (roles, memberships, invites) and shared devices follow.

| Lib              | Runs on              | What it holds                                                           |
| ---------------- | -------------------- | ----------------------------------------------------------------------- |
| `domain`         | API, desktop, mobile | Identifiers, the password policy, one-time code rules, the user         |
| `application`    | API, desktop, mobile | Ports, the account use cases, in-memory adapters, conformance suites    |
| `infra-pg`       | API only             | Tables, PostgreSQL repositories, Argon2id and HMAC from Node's `crypto` |
| `infra-webauthn` | API only             | The real passkey verifier, on `@simplewebauthn/server`                  |

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

`createPasskeys` takes `passkeys`, `passkeyChallenges` and a `verifier`:

```ts
const verifier = createWebAuthnVerifier({
  rpId: 'hk.example', // cannot be changed later: see ADR 0018
  rpName: appName,
  origins: ['https://app.hk.example'],
});

const start = await passkeys.beginSignIn();
// The client passes start.options to the device and sends back its response.
const tokens = await passkeys.finishSignIn({ challengeId: start.challengeId, response });
```

Passkey use cases: `beginRegistration`, `finishRegistration`, `beginSignIn`, `finishSignIn`,
`listPasskeys`, `renamePasskey`, `removePasskey`.

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
- **A passkey challenge is taken out of storage before the response is checked**, in a transaction
  that commits. Do not check first and remove after.
- **Only `infra-webauthn` imports the WebAuthn library.** Everything else goes through the
  `PasskeyVerifier` port.
- **Nothing here may put a phone number, an email, a code or a password in an error or a log.**
  Use `maskIdentifier`.
- **Codes and passwords are never stored.** Codes are stored as a keyed hash, passwords as Argon2id.
- A new adapter for a repository must pass its conformance suite: `userRepositoryConformance`,
  `otpRepositoryConformance`, `sessionRepositoryConformance`, `passwordAttemptsConformance`,
  `passkeyRepositoryConformance`, `passkeyChallengeConformance`.

## Testing

`insecureTestPasswordHasher`, `createTestOtpCodec`, `createTestTokenCodec`,
`createFakePasskeyVerifier` and `FakePasskeyDevice` are stand-ins for tests only. The real
verifier is tested with `VirtualAuthenticator`, a software authenticator that makes real
signatures; it lives in `infra-webauthn` and is not exported.
`createInMemoryIdentityStore` gives repositories with a unit of work that rolls back on failure,
like a database. The `infra-pg` tests need PostgreSQL (`pnpm infra:up`).
