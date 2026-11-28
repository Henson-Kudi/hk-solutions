# hk-solutions — rules for Claude Code

Plan of record: docs/plan/implementation-plan.md (local only, gitignored; never commit docs/plan/). Functional reference: HK-Soln/biztrack-cm (read its docs for flows and edge cases; never copy its code).

Decisions and their reasons: docs/adr/ (start with 0001-architecture-baseline.md). Where an ADR and the plan differ, the ADR wins.

## Never
- Never import Nest, Drizzle, React, node:* or fs/crypto in a `domain` or `application` lib. Those layers run on the API, desktop and mobile.
- Never import scope:core from a product, or another product's libs. Products use @hk/contracts/* and events.
- Never read or write another service's schema. No cross-schema joins.
- Never write to the ledger from a product. Products emit journal intents in events; core's posting engine posts.
- Never reference an account by code in posting logic. Use systemRole.
- Never branch on a country code outside libs/country-packs. Ask the pack, or check a capability via features.isOn.
- Never hardcode a tax rate, payroll rate or threshold. They are effective-dated pack data with a source note.
- Never use JS numbers for money. Decimal strings at boundaries, decimal.js inside, Money from @hk/platform/universal.
- Never add @Global(). Never deep-import a lib; use its src/index.ts.
- Never run server migrations on service start. Never write DROP or RENAME without the contract-migration label.
- Never call a payment provider inside a DB transaction. Never import a provider SDK outside its libs/core/payments-* adapter.
- Never log with a template literal or concatenation, and never log tokens, OTPs, ID numbers, phone numbers or request bodies.
- Never weaken a test to make it pass. A failing ledger or money-path test is a stop-and-ask.
- Never commit docs/plan/, .env files or real provider keys. Sandboxes and fakes only.

## Always
- Every business table uses tenantColumns (tenant_id, business_id, version) plus branch_id where branch-owned, has an RLS policy, and is accessed through ScopedRepository.
- Every POST/PUT/PATCH/DELETE handler carries @Idempotent(...) or @IdempotencyExempt(reason). Internal calls use keys `${product}:${aggregate}:${id}:${step}`. Provider calls record an intent first; a timeout is UNKNOWN, never FAILED.
- Every cross-service state change writes an outbox row in the same transaction; every consumer records the event in its inbox in the same transaction.
- Every use case declares `offline: true|false`. Offline use cases have a test that runs them on in-memory/SQLite and on Postgres adapters with identical results.
- Every repository port has a conformance suite; each adapter (infra-pg, infra-sqlite, fakes) passes it.
- Every user-facing string goes through i18n (en, fr; ar later). UI is RTL-safe.
- Ledger and money-path (⚑) work: failure-path tests merge in their own PR before the code.
- One plan row per branch: feat/p<phase>-<short-name>. Conventional commits.
- New products and countries via generators: nx g @hk/tools:product <name>, nx g @hk/tools:country-pack <code>.
- A PR that changes a decision recorded in docs/adr/ adds a new ADR that supersedes it. Accepted ADRs are not edited.
- Before opening a PR: pnpm format:check && pnpm lint:root && nx affected -t lint typecheck test build && npx depcruise apps libs --config .dependency-cruiser.cjs

## Commands
- docker compose -f deploy/compose/docker-compose.yml up -d      local Postgres, Redis, fake providers
- pnpm infra:up / pnpm infra:down                                same stack, waits until healthy (Postgres on 127.0.0.1:54320, Redis on 127.0.0.1:63790)
- pnpm verify:boundaries                                         self-test of the boundary rules; run after editing eslint.config.mjs, tools/eslint or .dependency-cruiser.cjs
- nx run migrator:serve -- --services core,sales                run migrations
- nx g @hk/tools:product <name>                                  new product
- nx run-many -t test --projects=tag:runtime:universal,tag:scope:contracts,tag:scope:country-pack,tag:layer:domain,tag:layer:application --configuration=hermes   universal-runtime tests
- HK_TEST_REDIS_URL=redis://127.0.0.1:63790 HK_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54320/hk nx affected -t test   also runs the tests that need a real Redis or Postgres (after pnpm infra:up); CI always does
- pnpm test:hermes                                              the line above plus a compile with the real Hermes compiler (docs/adr/0002)
- nx run e2e:e2e

## Review
- Paths under libs/core/{ledger,accounts,payments*,billing,entitlements}, libs/platform/{db,idempotency,outbox,inbox,internal-auth}, libs/country-packs/*/{tax,payroll}, and any migrations/ need Henson's line-by-line review. Say so in the PR body.
