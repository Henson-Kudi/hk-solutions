# @hk/platform/internal-auth

How a service knows who is calling it: short-lived signed tokens, from the gateway for users and
from one service to another.

Changes here need Henson's line-by-line review.

## The two tokens

|           | User token                                          | Service token                               |
| --------- | --------------------------------------------------- | ------------------------------------------- |
| Minted by | the gateway, after it checked the session           | the calling service                         |
| Says      | this user, in this business, with these permissions | this service is calling, to do these things |
| `aud`     | the one service it is for                           | the service being called                    |
| Lives     | 60 seconds                                          | 60 seconds                                  |

Both are signed with **ES256 only**. Each service has its own key pair; others hold its public key.

## Receiving calls

```ts
// main.ts
const verifier = createTokenVerifier({
  audience: 'sales',
  trustedIssuers: { gateway: [gatewayPublicJwk], pos: [posPublicJwk] },
  scopes: createServiceScopeRegistry({ pos: ['sales.sales:create'] }),
});
app.use(requestContext());
app.use(internalAuth({ verifier, logger }));

// app.module.ts
providers: [{ provide: APP_GUARD, useClass: InternalAuthGuard }];
```

```ts
@Post('invoices/:id/issue')
@RequirePermission('invoices:issue') // a user who holds it
issue(@CurrentPrincipal() principal: UserPrincipal) {}

@Get('internal/contacts')
@RequireScope('contacts:read') // another service whose token carries it
contacts() {}

@Get('health/live')
@Public() // no token needed
live() {}
```

- **Deny by default.** A route that is not `@Public()` needs a valid token: 401 without one.
- **A user request runs in the tenant context of its token.** `internalAuth()` starts it, so
  `withTenantTransaction` and every repository are scoped to the user's business with no ids passed
  around. The caller is also on every log line.
- **403** when the token is valid but the caller is the wrong kind, or lacks a permission or scope.

## Making calls

```ts
const signer = createTokenSigner({ issuer: 'sales', privateJwk: config.SIGNING_KEY });

const core = createHttpClient({
  baseUrl: config.CORE_URL,
  name: 'core-api',
  headers: serviceTokenHeaders(signer, { audience: 'core', scopes: ['contacts:read'] }),
});
```

A fresh token is signed for every call.

## What is refused

| Check                                                      | Why                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| No token, or not a JWT                                     |                                                                            |
| Any algorithm but ES256, including HS256 and `none`        | Stops algorithm-confusion attacks.                                         |
| Issuer not trusted, or key id not among that issuer's      | The key is chosen by the claimed issuer: sales cannot sign as the gateway. |
| Bad signature                                              | Any change to the token after signing.                                     |
| `aud` is another service                                   | A token for sales cannot be replayed against core.                         |
| Expired, issued in the future, or valid for over 5 minutes | Short life is what replaces a revocation list.                             |
| A user token not minted by the gateway                     | A service cannot make itself a user.                                       |
| A scope the caller's manifest does not declare             | A service cannot widen its own access by writing a scope into its token.   |

**The caller is always told the same thing: 401.** Which check failed is in the log
(`internal token rejected`, with a `reason`), never in the response. Tokens are never logged.

## Keys

`generateEs256KeyPair(kid)` makes a pair. The private JWK is a secret and comes from configuration.
To rotate a key, add the new public key to `trustedIssuers` everywhere, switch the signer, then
remove the old one: a verifier accepts any of an issuer's listed keys.
