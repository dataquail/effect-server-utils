# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Nx + pnpm monorepo publishing three Effect libraries:

- **`@effect-server-utils/cqrs`** (`packages/cqrs`) — typed command/query buses, an event bus whose
  subscriptions choose their consistency model, sagas, middleware.
- **`@effect-server-utils/unit-of-work`** (`packages/unit-of-work`) — the atomicity boundary over a
  host-supplied `TransactionDriver`, plus the `DeferralSink` that gives the CQRS event bus's
  `subscribeAfterCommit` a real commit to wait for.
- **`@effect-server-utils/authz`** (`packages/authz`) — per-route authorization over a
  declaration-merged config seam.

`unit-of-work` depends on `cqrs` (peer, `workspace:*`); nothing else depends on anything else.
`website/` is an Astro + Starlight docs site deployed to GitHub Pages.

## Commands

```bash
# Build (tsc -> esm+dts, babel -> cjs, build-utils pack-v2 -> dist/)
pnpm run build:packages
pnpm exec nx build @effect-server-utils/cqrs

# Test
pnpm run test:packages
pnpm exec nx test @effect-server-utils/authz

# Typecheck (tsc -b, src and tests)
pnpm run check:all
pnpm exec nx check @effect-server-utils/cqrs

# Lint — oxlint, type-aware. Warnings are tolerated; errors are not.
pnpm lint
pnpm run lint:fix

# Effect language-service diagnostics (separate from lint)
pnpm run check:effect

# Everything, as the pre-commit hook runs it
pnpm run precommit

# Docs site
pnpm run dev:website
pnpm run build:website
```

## Things that will bite you

**Never run `build-utils prepare-v2`.** It is the _codegen_ step and it overwrites `src/index.ts` with a
generated barrel. All three barrels here are hand-written, and their prose comments are load-bearing
documentation. The build uses `pack-v2` (the packaging step) only, and `effect.generateIndex` has been
removed from every `package.json` so nothing regenerates them.

**`effect.generateExports` must exclude `*.test.ts`.** Tests are co-located in `src/`, so without the
exclusion every test file becomes a published subpath export.

**`dist/` is post-processed by `scripts/prune-dist.mjs`** (each package's `build-prune` step, the last
thing `build` runs). It deletes the co-located `*.test.ts` that `pack-v2` copies into `dist/src/`, and
the one-`package.json` subpath proxy directory `pack-v2` writes per entrypoint — unreachable, since
`exports` is authoritative for every resolver a consumer of an exports-only `effect@4` can be on. `typesVersions` deliberately stays; the script's header comment
has the full reasoning. `pack-v2` has no flag for either, hence the post-pass rather than a pnpm patch.

**`effect` is an exact peer dependency** (`4.0.0-beta.94`) in every package, pinned again in the root
`pnpm.overrides`. Effect 4 betas are mutually incompatible; bumping it is a coordinated breaking change
to all three.

**`unit-of-work` peer-depends on `cqrs` as `workspace:*`.** `scripts/fix-workspace-deps.sh` rewrites
that to the real version in `dist/package.json` at publish time, so the published range is an exact
pin — which is what the `DeferralSink` coupling warrants while both are pre-1.0.

**`tsconfig.base.json` `paths` target `.ts`, not `.js`.** A `.js` target only resolves when the file is
already in the compiling program — true within a package, false across one. Before this the
cross-package import fell back to `any`, which also silently produced 171 `no-unsafe-*` lint errors.
The project reference in the importing package's `tsconfig.src.json` is what redirects the `.ts` to
the referenced project's declaration output. **`references` is not inherited through `extends`**, so
`tsconfig.build.json` repeats it.

**Imports use explicit `.js` extensions.** `moduleResolution` is `NodeNext` and the packages are ESM —
`import { x } from "./thing.js"` referring to `thing.ts` is correct, not a mistake to "fix".

**Test files import their own package by its published name** (`@effect-server-utils/cqrs`), resolved
through `tsconfig.base.json` `paths` and the `vitest.shared.ts` alias. Setting `TEST_DIST=1` repoints
that alias at the built output so the suite can run against what was actually packaged.

## Conventions

- **Prettier**: double quotes, `printWidth: 100`, semicolons. (Note this differs from most dataquail
  repos — it matches the upstream these packages were extracted from.)
- **oxlint**, not ESLint. Local rules live in `scripts/lint-rules/` and are loaded as an oxlint JS
  plugin under the `local/` prefix. The config extends `@effect/tsgo`'s recommended preset, which is
  where the `effecttsgo/*` rules come from.
- **Conventional commits** are enforced by commitlint and drive `nx release` version bumps.
- **Nx targets** are declared in each `project.json` and delegate to the package's own npm scripts, so
  `pnpm --filter … run build` and `nx build …` do the same thing. Each `package.json` sets
  `"nx": { "includedScripts": [] }` so Nx does not also infer targets from the scripts.

## Architecture notes

The source carries unusually dense commentary — most non-obvious decisions have a note explaining what
the alternative was and why it lost. Read it before changing behaviour; several properties that look
incidental are pinned by tests:

- Handlers run in the **dispatching fiber's** context, so a command dispatched inside a caller's
  transaction joins it rather than opening a second one.
- `cqrs` names no transaction. `EventBus.dispatch` hands its deferred surfaces to a `DeferralSink` if
  one is in context and runs them itself if none is, so the bus is fully usable with no unit of work
  installed — that seam is what lets the boundary live in its own package.
- Middleware **may not widen** a message's success or error channels — that constraint is what lets the
  bus have a seam without invalidating callers' `catchTag`s.
- The post-commit drain is **uninterruptible**, so reactions to already-durable work are not discarded
  by a shutdown.
- The sink buffers a **closed-over drain effect**, not the bare events, resolving the `EventBus` in the
  fiber that dispatched. A bus wired deeper than the boundary is therefore still the bus that gets
  drained — the previous shape looked one up at commit time and silently lost events when it found
  none.
- Wiring mistakes (`DuplicateDispatchTag`, `UnroutableTags`, `MissingHandler`) are **tagged defects**,
  so boot checks and tests can match the condition rather than a message string.

## Releasing

`nx release` with `projectsRelationship: "independent"`. Push to `main` → version + tag + GitHub
release; creating that release triggers the npm publish from `packages/*/dist`. See `RELEASE.md`.
