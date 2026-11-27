# ADR 0007: Internal authentication tokens

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D10 (internal auth), D13 (row scoping); ADR 0004 (tenant isolation)

## Context

ADR 0001 D10 says the gateway mints a 60-second ES256 user token, and service-to-service calls carry
a signed service token. `libs/platform/internal-auth` implements both. This record fixes what a
token contains, what makes one invalid, and how a verified token becomes the tenant context that
ADR 0004 depends on.

## Decision

### Token format

Both tokens are JWTs signed with ES256, with `iss`, `aud`, `sub`, `iat`, `exp`, `jti` and a `kid`
header.

| Claim       | User token                     | Service token            |
| ----------- | ------------------------------ | ------------------------ |
| `token_use` | `user`                         | `service`                |
| `iss`       | `gateway`                      | the calling service      |
| `sub`       | the user id                    | the calling service      |
| `aud`       | the service the token is for   | the service being called |
| other       | `tid`, `bid`, `brid?`, `perms` | `scopes`                 |

We use the `jose` library. Signing and verifying are not written by hand.

### Verification order

1. The header's `alg` must be exactly `ES256`. Anything else is refused before a key is looked up.
2. The key is looked up under the issuer the token claims, by `kid`. An unknown issuer or key id is
   refused. A service's key can therefore only sign as that service.
3. Signature, audience, expiry and the required claims, through `jose` with `algorithms: ['ES256']`.
4. `iat` may not be in the future, and `exp - iat` may not exceed 5 minutes.
5. By kind: a user token must come from an issuer allowed to mint them (the gateway only), with
   UUID ids. A service token must have `sub` equal to `iss`, and every scope must be declared for
   that issuer in the `ServiceScopeRegistry`.

A verifier with no registry refuses any service token that carries a scope.

### One answer for every failure

Every refused token is a 401 with code `UNAUTHENTICATED` and the same text. The reason is logged
(`internal token rejected`, with a `reason` field) and never returned. Tokens are never logged.

### From token to tenant context

Authentication is split in two, for the same reason as the request id (ADR 0003):

- **`internalAuth()` middleware** verifies the token and runs the rest of the request inside
  `runWithTenantContext` (for a user) and a log context. It never refuses a request.
- **`InternalAuthGuard`** decides. It denies by default: 401 unless the route is `@Public()` or a
  principal was established. `@RequirePermission` admits users who hold every listed permission,
  `@RequireScope` admits services whose token carries every listed scope, and each answers 403 to
  the other kind.

The guard fails closed with a 500 if the middleware is not installed.

### Outbound calls

`serviceTokenHeaders(signer, { audience, scopes })` gives `@hk/platform/http` a fresh token per
call. For this the HTTP client's `headers` option may now be async. If the headers cannot be built,
the request is not sent.

## Consequences

- **The tenant context comes from a signature, not from a header a client can set.** That is what
  lets ADR 0004's isolation rest on it.
- **No revocation.** A token is valid until it expires, at most 60 seconds as minted and never more
  than 5 minutes as accepted. Revoking a session takes effect when the gateway stops minting.
- **No replay protection within the lifetime.** A captured token can be reused against the same
  service for up to 60 seconds. `jti` is carried for audit, not checked. Idempotency keys limit the
  damage for writes, and network policy keeps services unreachable from outside.
- **Permissions are a snapshot.** They are resolved by the gateway when the token is minted and are
  at most 60 seconds old.
- **Clocks must agree to within 5 seconds.** A service whose clock drifts further refuses valid
  tokens.
- **Public keys are configuration.** Every service lists the keys of the issuers it trusts. Rotation
  is: add the new key everywhere, switch the signer, remove the old key. There is no JWKS endpoint
  yet; one may be added when the number of services makes static configuration a burden.
- **`@RequirePermission` checks strings.** The permission registry and its types arrive with
  `contracts/permissions` (row 1.7). Until then nothing checks that a permission name exists.
- **Branch limits are not enforced here.** The token carries the branch, and the tenant context
  exposes it. Restricting a user to their branches is the job of the use cases and of the gateway's
  membership check.
- **`jose` 6 is ESM-only**, like NestJS 12, so this lib's tests run with the Jest flag described in
  ADR 0003.
- **mTLS is still deferred.** `TokenVerifier` is the interface a transport-level identity would sit
  behind.
