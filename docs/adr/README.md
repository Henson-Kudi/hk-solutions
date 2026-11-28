# Architecture decision records

An ADR records one decision that shapes the code: what was decided, why, and what it costs. Read
these before proposing a change to how the repo is structured.

| ADR                                                                | Title                                                              | Status                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------- |
| [0001](./0001-architecture-baseline.md)                            | Architecture baseline                                              | Accepted                  |
| [0002](./0002-hermes-compatible-test-target.md)                    | What "Hermes-compatible test target" means                         | Accepted                  |
| [0003](./0003-platform-kernel-libraries.md)                        | Platform kernel libraries, and what NestJS 12 being ESM-only means | Partly superseded by 0008 |
| [0004](./0004-tenant-isolation-in-postgres.md)                     | How tenant isolation is enforced in PostgreSQL                     | Accepted                  |
| [0005](./0005-idempotency-outbox-inbox.md)                         | Idempotency, outbox and inbox                                      | Accepted                  |
| [0006](./0006-idempotency-over-http.md)                            | Idempotency over HTTP, route coverage and key cleanup              | Accepted                  |
| [0007](./0007-internal-auth-tokens.md)                             | Internal authentication tokens                                     | Accepted                  |
| [0008](./0008-redaction-and-test-support.md)                       | Redaction, and how test support is split                           | Accepted                  |
| [0009](./0009-contracts.md)                                        | Contracts: products, permissions, events and sync                  | Accepted                  |
| [0010](./0010-country-pack-kernel.md)                              | The country pack kernel                                            | Accepted                  |
| [0011](./0011-cameroon-pack-and-system-roles.md)                   | The Cameroon pack, and a shared list of system roles               | Accepted                  |
| [0012](./0012-uae-pack-reverse-charge-and-shared-posting-rules.md) | The UAE pack, reverse charge, and shared posting rules             | Accepted                  |

## Adding one

- Add an ADR when a PR changes or adds to a decision in an existing ADR, or makes a choice that a
  future contributor would otherwise have to guess the reason for (a new framework, a new
  cross-service pattern, a new rule in `CLAUDE.md`).
- Name it `NNNN-short-title.md` with the next free number, and add a row to the table above.
- Use the same headings as 0001: Context, Decision, Consequences.
- An accepted ADR is not edited, apart from typos. To change a decision, write a new ADR that names
  what it supersedes, for example "supersedes 0001 D25", and set the old ADR's status to
  "Partly superseded by NNNN".
- The ADR ships in the same PR as the change it describes.
