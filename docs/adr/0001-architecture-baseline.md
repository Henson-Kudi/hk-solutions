# ADR 0001: Architecture baseline

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson

## Context

hk-solutions is a multi-tenant accounting and business management platform for small and medium
businesses, starting with Cameroon and the UAE. The detailed implementation plan is kept out of the
repository, so the decisions that shape the code need a committed home. This record is that home.

Each decision has a number (D1, D2, …). The numbers are stable: a later ADR that changes one of them
says which number it supersedes, and this file is not rewritten.

Sections 1 to 6 are the decisions locked before any code was written. Section 7 holds the decisions
made while bootstrapping the workspace in phase 0, including the places where we departed from the
original plan.

## Decision

### 1. Product and tenancy

| #   | Area          | Decision                                                                                                                                                                                                          |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Product model | Subscriptions are per product. A business enables any set of products that satisfies the product dependency graph. The price comes from a price book per country: a base fee, a fee per product and usage tiers.  |
| D2  | Markets       | Cameroon (`CM`) and the UAE (`AE`) first. Anything country-specific lives in a country pack. Product code never branches on a country code.                                                                       |
| D3  | Hosting       | A multi-tenant SaaS that we operate. A deployment serves one region, and a business is homed in one region.                                                                                                       |
| D4  | Tenancy       | Account (the subscriber) → Business (a legal entity with country, currency, chart of accounts and fiscal year) → Branch (a location) → Warehouse. One user login works across every business the user belongs to. |
| D5  | i18n          | English and French from day one, Arabic added with UAE compliance work. Every user-facing string goes through i18n, and the UI is RTL-safe from the start.                                                        |

### 2. Service topology and code structure

| #   | Area          | Decision                                                                                                                                                                                                                                                                                       |
| --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6  | Topology      | A gateway, a core service, and one NestJS service per product. Every service deploys and scales on its own.                                                                                                                                                                                    |
| D7  | Shared logic  | Each product and each core area is split into `domain` (pure TypeScript), `application` (use cases and ports) and adapters (Postgres, SQLite, HTTP, Nest, UI). The API, the desktop app and the mobile app run the same `domain` and `application` code.                                       |
| D8  | Offline-first | Kept for these use cases only: POS, sales, pre-order payments, expenses, stock counts and contacts, on desktop and mobile. Clients sync commands, not rows, and the server re-runs the same use case idempotently. Ledger posting, payroll runs, tax returns and period close are online only. |
| D9  | Events        | A transactional outbox in every service, delivered over BullMQ on Redis. Every consumer has an inbox, so a duplicate delivery is a no-op.                                                                                                                                                      |
| D10 | Internal auth | The gateway verifies the user and mints a 60-second ES256 user token carrying user, tenant, business, branch and permissions. Service-to-service calls carry a signed service token. mTLS is deferred.                                                                                         |
| D11 | Frontends     | React 19 with Vite for the web app. The same renderer runs on desktop inside Electron. React Native (Expo) for mobile. Next.js for the marketing site and the storefront.                                                                                                                      |

### 3. Data

| #   | Area        | Decision                                                                                                                                                                                                               |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D12 | Database    | One PostgreSQL database per region deployment, with one schema and one login role per service. No cross-schema joins or reads, ever, so any schema can move to its own database later.                                 |
| D13 | Row scoping | `tenant_id` and `business_id` on every business table, plus `branch_id` where the row belongs to a branch. Access goes through scoped repositories, with PostgreSQL row-level security as a second layer from day one. |
| D14 | ORM         | Drizzle ORM: Postgres on the server, SQLite on clients (better-sqlite3 on desktop, expo-sqlite on mobile). Repositories sit behind ports, and every adapter passes the same conformance suite.                         |
| D15 | Migrations  | One migration stream per schema, run as a one-shot migrator job and never at service start. Every migration is expand-then-contract.                                                                                   |
| D16 | Audit       | A hash-chained audit log owned by core. Every create, update, delete, approval and login is recorded.                                                                                                                  |

### 4. Accounting

| #   | Area              | Decision                                                                                                                                                                                                                         |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D17 | Ledger            | Double-entry, owned by core. Journals are immutable: a correction is a reversal plus a new entry. Products never write to the ledger. They emit events, and core's posting engine posts from them using posting rules.           |
| D18 | Accounting basis  | The ledger is always accrual. Each business chooses accrual or cash basis for reporting. Cash-basis reports are derived from payment allocations.                                                                                |
| D19 | Chart of accounts | One chart per business, created at onboarding from the country template, an import, or a minimal template. Any depth of sub-accounts. Posting only to leaf accounts. Branches inherit the chart by each account's branch policy. |
| D20 | Country data      | Tax rates, payroll rates, thresholds and statutory account codes are effective-dated seed data in the country pack, never constants in code. Every value carries a source note, and an accountant confirms it before go-live.    |

### 5. Money safety

| #   | Area        | Decision                                                                                                                                                                                                               |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D21 | Money       | Never JS numbers. Decimal strings at boundaries, `decimal.js` inside. Amounts are stored as `numeric(20,4)` beside a currency code and rounded to the currency's minor unit at document level (XAF 0 decimals, AED 2). |
| D22 | Idempotency | Every POST, PUT, PATCH and DELETE requires an `Idempotency-Key` and executes once. A repeat replays the stored result. An offline command reuses its client command id as the key.                                     |

### 6. Stack and tooling

| #   | Area    | Decision                                                                                                                                               |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D23 | Backend | Node 24 LTS, NestJS 12, Nx with `@nx/nest`, `@nx/js`, `@nx/vite`, `@nx/next` and `@nx/expo`, and pnpm. NestJS 12 replaces the planned 11, see D25.     |
| D24 | Tooling | Nx module boundaries on tags, dependency-cruiser in CI, lockstep versioning (one version of each dependency for the whole repo), conventional commits. |

### 7. Decisions made in phase 0

| #   | Area                 | Decision                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D25 | NestJS version       | NestJS 12, not 11. The codebase is new, so starting on the current major avoids an upgrade before the first release. Only `@nestjs/schematics` is installed so far. The runtime packages arrive with the first Nest lib.                                                                                                                                       |
| D26 | Workspace style      | Nx integrated style: one root `package.json`, one lockfile, a `project.json` per project, and one `tsconfig.base.json` path per lib. Libs are imported as `@hk/<group>/<name>` or `@hk/<group>/<name>/<layer>`. The package-based style was rejected because names with several slashes, such as `@hk/products/sales/domain`, are not legal npm package names. |
| D27 | Toolchain versions   | As installed at phase 0: Nx 24.1, pnpm 12, TypeScript 6.0, ESLint 10 (flat config), Jest 30, Vitest 5, Vite 8, Next 16.4, React 19, Expo 56 with React Native 0.85. Nx is upgraded only through `nx migrate`, so Dependabot ignores it.                                                                                                                        |
| D28 | Boundary enforcement | Two tools, on every PR. ESLint decides which project may import which, from tags. The tag vocabulary and rules live in `tools/eslint/boundaries.mjs`, and a project with no tags cannot import anything. dependency-cruiser checks file paths (cycles, deep imports, framework or Node code in pure layers, cross-schema access) in `.dependency-cruiser.cjs`. |
| D29 | Rules are tested     | `pnpm verify:boundaries` plants each kind of violation in throwaway fixture projects and fails unless the expected rule rejects it. It runs in CI, so a boundary rule cannot be weakened silently.                                                                                                                                                             |
| D30 | Protection of `main` | A repository ruleset kept as code in `.github/rulesets/main.json`: pull request required, the single check `pr-checks` required, linear history (squash or rebase merges), no force-push, no deletion. Required approvals are 0, see the deviations below. Review still happens: CODEOWNERS requests Henson on every PR.                                       |
| D31 | CI supply chain      | GitHub Actions are pinned by commit SHA and updated by Dependabot. The workflow token is read-only. gitleaks scans the full history on every PR, on top of GitHub secret scanning and push protection.                                                                                                                                                         |
| D32 | Public repository    | The repository is public and stays public. Everything pushed is treated as published: no plan documents, no `.env` files, no real provider keys, sandboxes and fakes only. The code is not open source: `package.json` declares `UNLICENSED`.                                                                                                                  |
| D33 | Local infrastructure | Docker Compose in `deploy/compose` runs Postgres 17 and Redis 7. Both bind to `127.0.0.1` only, on host ports 54320 and 63790 by default so they never collide with a database already installed on the developer's machine. Redis runs with `noeviction` because BullMQ must never lose a job to eviction.                                                    |

### Deviations from the original plan

| Topic              | Planned                     | Decided               | Why                                                                                                                                                                                   |
| ------------------ | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS             | 11                          | 12 (D25)              | New codebase, so start on the current major.                                                                                                                                          |
| Required approvals | 1 (Henson)                  | 0 (D30)               | PRs are opened from Henson's own account, and GitHub does not let an author approve their own PR. Requiring 1 would block every merge. Revisit when a second reviewer account exists. |
| Compose host ports | Postgres and Redis defaults | 54320 and 63790 (D33) | Port 5432 is commonly taken by a local Postgres. Both ports can be overridden in `deploy/compose/.env`.                                                                               |

## Consequences

- **More moving parts early.** A gateway, a core service and a service per product is more to run
  than a monolith. All of them run in one Compose stack locally, and the schema-per-service split
  (D12) is what keeps a later physical separation cheap.
- **Pure layers cost some convenience.** `domain` and `application` code cannot use Node, Nest,
  Drizzle or React (D7). Anything from the outside world arrives through a port. In return the same
  rules run on the server, in Electron and in Hermes, which is what makes offline work (D8) honest.
- **Products wait for core to post.** Because products never write to the ledger (D17), a document
  and its journal are committed in two transactions linked by an event. Screens must handle the
  short window where the journal is not posted yet.
- **Every write needs a key.** D22 means clients generate and store idempotency keys, and handlers
  that are exempt must say why.
- **Rates are data.** D20 means a rate change is a data release with a source note, not a code
  change, and nothing ships to a country before an accountant has confirmed its values.
- **No second approver yet.** With D30 at 0 approvals, the required check and Henson's own review
  are the gate. The paths that need line-by-line review are listed in `CLAUDE.md` and in
  `.github/CODEOWNERS`.

## Not decided yet

- Hosting provider and regions, including where Cameroon data lives and whether the UAE needs its
  own region from day one.
- When to add mTLS between services (D10).
- The product brand name and the final npm scope. `@hk/` is the working scope.
- Card acquirers for each market.
