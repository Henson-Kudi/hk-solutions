# hk-solutions

Multi-tenant accounting and business management platform. Nx monorepo, pnpm, Node 24.

Working rules for contributors and for Claude Code are in [CLAUDE.md](./CLAUDE.md). The decisions
behind the architecture, and the reasons for them, are in [docs/adr](./docs/adr/README.md).

## Prerequisites

- Node 24 (`nvm use` reads `.nvmrc`)
- pnpm 12 (`corepack enable` picks the version pinned in `package.json`)
- Docker, for local Postgres 17 and Redis 7

## Getting started

```sh
pnpm install
pnpm infra:up                          # Postgres on 127.0.0.1:54320, Redis on 127.0.0.1:63790
pnpm nx graph                          # explore the project graph
pnpm nx run-many -t lint test build    # run everything
pnpm nx affected -t lint typecheck test build   # run only what a change touches
```

## Architecture rules

Dependencies point down only, and two tools enforce that on every PR:

- **ESLint** (`tools/eslint/boundaries.mjs`) decides which project may import which, from the tags in
  each `project.json`. The tag vocabulary is documented at the top of that file. A project with no
  tags cannot import anything.
- **dependency-cruiser** (`.dependency-cruiser.cjs`) checks file paths: no cycles, no deep imports
  into another lib, no framework or Node built-in in `domain` and `application` code, no reading
  another service's schema.

```sh
pnpm nx run-many -t lint     # tag rules
pnpm depcruise               # path rules
pnpm verify:boundaries       # self-test: plants each violation and checks it is rejected
pnpm test:hermes             # pure libs: tests without Node, then a real Hermes compile
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org). A husky hook checks the
message with commitlint and runs ESLint and Prettier on staged files.

## Pull requests

Every pull request runs `.github/workflows/pr-checks.yml`: formatting, commit messages, lint,
typecheck, test and build for affected projects, the dependency rules, the boundary self-test and a
secret scan. `main` only accepts squash or rebase merges with `pr-checks` green; the ruleset is in
`.github/rulesets/`.

## Layout

- `apps/` deployable services and frontends
- `libs/` shared libraries, imported as `@hk/<group>/<name>` through `tsconfig.base.json` paths
- `tools/` workspace generators and scripts
- `deploy/` Compose, Helm and bootstrap SQL
- `docs/adr/` architecture decision records

Projects are described by a `project.json` each (Nx integrated style). There are no pnpm workspace
packages: the repo has one root `package.json` and one lockfile.
