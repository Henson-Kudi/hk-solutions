# Architecture decision records

An ADR records one decision that shapes the code: what was decided, why, and what it costs. Read
these before proposing a change to how the repo is structured.

| ADR                                             | Title                                                              | Status   |
| ----------------------------------------------- | ------------------------------------------------------------------ | -------- |
| [0001](./0001-architecture-baseline.md)         | Architecture baseline                                              | Accepted |
| [0002](./0002-hermes-compatible-test-target.md) | What "Hermes-compatible test target" means                         | Accepted |
| [0003](./0003-platform-kernel-libraries.md)     | Platform kernel libraries, and what NestJS 12 being ESM-only means | Accepted |

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
