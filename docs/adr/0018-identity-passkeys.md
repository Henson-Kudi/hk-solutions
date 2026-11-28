# ADR 0018: Passkeys

- **Status:** Accepted
- **Date:** 2026-11-28
- **Decided by:** Henson
- **Relates to:** ADR 0014 (`layer:infra-node`), ADR 0016 (identity accounts; this is part 3 of
  the five parts it lists), ADR 0017 (sessions)

## Context

The plan put passkeys in phase 9, for UAE businesses, with single sign-on. Henson moved them into
plan row 3.2 for every country (ADR 0016).

A passkey is a key pair. The person's device keeps the private key and signs a random challenge
from the server, after checking the person with a fingerprint, a face or a PIN. The server keeps
only the public key. There is nothing on the server worth stealing, and nothing the person can be
tricked into typing on a fake site: the device will not sign for a site other than the one the
passkey was made for. The standard is WebAuthn.

## Decision

### A library checks the cryptography, behind a port

Checking a WebAuthn response means parsing binary formats (CBOR, COSE keys, authenticator data)
and verifying signatures in several algorithms. That is exactly the kind of code that should not
be written twice. `@simplewebauthn/server` (MIT licence) does it.

- The pure layers define a port, `PasskeyVerifier`, and never import the library.
- A new lib, `core/identity/infra-webauthn` (tagged `layer:infra-node`), implements the port with
  the library. It is the only place that imports it.
- The use cases are tested with a fake verifier. The real one is tested against a software
  authenticator written for the tests, which makes real ES256 keys and real signatures, so forged,
  replayed and misdirected responses are tried against the real library.

The alternative, our own implementation, would avoid a dependency and its transitive packages
(ASN.1 and X.509 parsers used for attestation formats we do not ask for). It was not chosen: the
risk of a subtle mistake in our own parser is far greater than the risk of a maintained library.

### What we ask of a device

- **A discoverable passkey** (`residentKey: required`). The person signs in without typing who
  they are; the passkey says whose it is.
- **User verification, every time** (`userVerification: required`). A passkey is the only factor
  at sign-in, so the device must check the person, not merely be touched.
- **No attestation.** Attestation tells the server which make of device holds the key. No rule of
  ours depends on that, and asking costs the person an extra consent screen.
- **Three signature algorithms:** EdDSA, ES256 and RS256. The list is fixed in our code so that a
  library upgrade cannot widen it unnoticed.

### What we insist on when checking

- The response answers a challenge the server issued, and that challenge is used **once**. It is
  removed from storage before the response is checked, in a transaction that commits, so a failed
  check cannot be retried against the same challenge and a captured response cannot be sent twice.
- A challenge lives five minutes, and is tied to its purpose: a registration challenge belongs to
  the signed-in user who asked for it, and cannot be used to sign in, or by anyone else.
- The response comes from one of the configured origins, for our site, with a valid signature.
- **The use count never goes back.** Some devices count their uses. For those, a count that does
  not rise means the private key has been copied, and the sign-in is refused. Devices that always
  report zero (most synced passkeys) are accepted. The row is locked while the count is judged, so
  two responses with the same count cannot both pass.
- When the device says whose passkey it is, that must agree with what was stored.

Every refusal is the same error, `IDENTITY_PASSKEY_INVALID`, whatever the reason.

### Starting a sign-in reveals nothing

`beginSignIn` takes no phone number or email, so its answer is the same for everyone. There is no
way to use it to find out which accounts exist or have passkeys.

### Limits and housekeeping

- At most ten passkeys for a person. The limit is checked when a registration starts and again
  when it finishes.
- A credential can be registered once, to one account. A unique index enforces it.
- Removing a passkey does not end sessions it started; "sign out everywhere" does that. A person
  cannot lock themselves out by removing passkeys: a code to their verified phone number or email
  still signs them in.
- A passkey sign-in starts an ordinary session (ADR 0017) with method `passkey`.

### Configuration is checked at start-up

The verifier is given the site's `rpId`, its name and the origins a response may come from. It
refuses to start with an `rpId` that is not a bare domain, an origin that is not https (except
localhost), or an origin outside the `rpId`. A mistake here would otherwise show up as every
passkey failing, or worse, as responses from the wrong place being accepted.

## Consequences

- **The `rpId` is a one-way decision.** A passkey is bound to it. Changing the domain later means
  every passkey must be registered again. It must be chosen before the first real user registers
  one, and it should be the registrable domain (for example `hk.example`, not `app.hk.example`) so
  that every subdomain can use the same passkeys.
- **Mobile apps need a published association file** to use passkeys for the site's domain:
  `/.well-known/assetlinks.json` for Android and `/.well-known/apple-app-site-association` for
  iOS. That belongs to the apps and the web host (phase 4 and later), not to this lib.
- A new runtime dependency, `@simplewebauthn/server`, pinned to an exact version. Upgrades are
  deliberate and run the verifier's tests.
- Two more global identity tables: `passkeys` and `passkey_challenges`, listed in
  `IDENTITY_GLOBAL_TABLES` (ADR 0016). They need Henson's line-by-line review. The `sessions`
  method check now allows `passkey`.
- The session starter moved to its own module so that every way of signing in shares it.

## Open

- **Asking a passkey holder for more.** Nothing yet makes a sensitive action (changing a phone
  number, removing a passkey) require a fresh proof. That is "step-up" authentication and applies
  to every method, so it is not passkey-specific. To decide with the access part.
- **Cleanup** of challenges nobody answered: a job in row 3.11. An index on their expiry is there
  for it.
- **A fake sign-in challenge is stored for every caller.** Per-IP rate limiting at the gateway
  (plan section 13.1) is what bounds that.
