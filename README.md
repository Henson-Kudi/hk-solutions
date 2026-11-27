# hk-solutions

Multi-tenant accounting and business management platform. Nx monorepo, pnpm, Node 24.

Working rules for contributors and for Claude Code are in [CLAUDE.md](./CLAUDE.md).

## Prerequisites

- Node 24 (`nvm use` reads `.nvmrc`)
- pnpm 12 (`corepack enable` picks the version pinned in `package.json`)
- Docker, for local Postgres and Redis (added in a later phase 0 PR)

## Getting started

```sh
pnpm install
pnpm nx graph                          # explore the project graph
pnpm nx run-many -t lint test build    # run everything
pnpm nx affected -t lint typecheck test build   # run only what a change touches
```

## Layout

- `apps/` deployable services and frontends
- `libs/` shared libraries, imported as `@hk/<group>/<name>` through `tsconfig.base.json` paths
- `tools/` workspace generators and scripts
- `deploy/` Compose, Helm and bootstrap SQL
- `docs/adr/` architecture decision records

Projects are described by a `project.json` each (Nx integrated style). There are no pnpm workspace
packages: the repo has one root `package.json` and one lockfile.
