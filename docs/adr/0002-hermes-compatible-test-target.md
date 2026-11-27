# ADR 0002: What "Hermes-compatible test target" means

- **Status:** Accepted
- **Date:** 2026-11-27
- **Decided by:** Henson
- **Relates to:** ADR 0001 D7 (shared logic), D8 (offline-first), D28 and D29 (boundary enforcement)

## Context

`domain`, `application`, `platform/universal`, contracts and country-pack code runs on the server
and also inside the mobile app, where the JavaScript engine is Hermes. Hermes has no Node built-in
modules, lacks several globals Node provides (`Buffer`, `crypto`, `structuredClone`, …) and rejects
some newer syntax. Code that passes its tests on Node can therefore still break on a phone.

The plan asks for the tests of this code to run "on Node and on a Hermes-compatible target". Running
them on the Hermes engine itself is not practical today: npm distributes the Hermes compiler
(`hermesc`, a dependency of React Native) for Windows, Linux and macOS, but no Hermes runtime that
could execute a test suite.

## Decision

The Hermes-compatible target is three checks that together cover what an engine run would catch.

| Layer                | What it does                                                                                                                                                                                          | Where                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1. Lint              | Pure code may not import a Node built-in or a framework, and may not use the globals `Buffer`, `process`, `__dirname` or `__filename`.                                                                | `eslint.config.mjs`, `.dependency-cruiser.cjs`     |
| 2. Simulated runtime | The lib's tests run again under a Jest configuration named `hermes`. Globals that React Native on Hermes does not provide are deleted, and a Node built-in throws when workspace code imports it.     | `tools/jest/`, each lib's `jest.hermes.config.cts` |
| 3. Real compiler     | Each pure lib is bundled with its npm dependencies, without any syntax rewriting, and compiled to bytecode by `hermesc`. Syntax Hermes cannot parse fails here, including syntax inside a dependency. | `tools/scripts/hermes-compile.mjs`                 |

- `pnpm test:hermes` runs layers 2 and 3, and CI runs it on every PR.
- A lib opts in to layer 2 with a `jest.hermes.config.cts` and a `hermes` configuration on its
  `test` target. Layer 3 picks up every project tagged `runtime:universal`, `layer:domain` or
  `layer:application` by itself.
- Tests named `*.hermes.spec.ts` run only under layer 2. `platform/universal` has one that asserts
  the simulated environment really is stripped, so the target cannot silently become a second Node
  run.
- Each pure lib sets `"types": []` in its `tsconfig.lib.json`, so a Node-only global does not even
  type-check.

Two related fixes to boundary enforcement ship with this decision:

- Rule blocks in the root ESLint config that name workspace paths now set `basePath`. Without it
  their globs matched nothing when a lib was linted through its own `eslint.config.mjs`, so the
  pure-code import bans were not applied to generated libs.
- The boundary self-test (D29) gives its fixture projects their own `eslint.config.mjs`, which is
  how that gap went unnoticed before.

## Consequences

- **This is not a run on Hermes.** Layer 2 executes on V8. A difference in engine behaviour, as
  opposed to a missing API or unsupported syntax, would not be caught. Known areas to watch are
  `Intl` (used by `toLocalDate`), date parsing and regular-expression features.
- **The gap closes with the mobile app.** When `apps/mobile` exists, the universal and domain suites
  run on a device or emulator in CI. That is the point to supersede this ADR.
- **The simulated environment is stricter than Hermes on purpose.** Anything whose support differs
  between React Native versions is treated as missing, so pure code does not depend on it.
- **`process` is still visible in layer 2**, because Jest itself needs it inside the test context.
  Only the lint rule keeps pure code away from it.
- **Layer 3 depends on React Native's packaging.** `hermesc` is found through `react-native`'s
  dependency on `hermes-compiler`. A React Native upgrade that moves it breaks the script loudly,
  not silently.
- **Ids on mobile need an injected random source.** Hermes has no `crypto.getRandomValues`, and
  `platform/universal` deliberately has no `Math.random` fallback.
