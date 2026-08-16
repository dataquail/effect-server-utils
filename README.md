# Effect Server Utils

Server-side building blocks for [Effect](https://effect.website), published as two independent packages.

| Package                                        | What it does                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@effect-server-utils/cqrs`](packages/cqrs)   | Typed command and query buses, an event bus whose subscriptions choose their consistency model, a unit-of-work port, and process managers                           |
| [`@effect-server-utils/authz`](packages/authz) | Declarative per-route authorization: policy checks registered against `(resource, action)` pairs, per-request resource resolution, and composable check combinators |

📖 **[Documentation](https://dataquail.github.io/effect-server-utils)**

```sh
pnpm add @effect-server-utils/cqrs effect
pnpm add @effect-server-utils/authz effect
```

`effect` is an exact peer dependency (`4.0.0-beta.94`) — Effect 4 betas are not compatible with one
another, so both packages pin the one they were built against.

## Repository layout

```
packages/
  authz/     @effect-server-utils/authz
  cqrs/      @effect-server-utils/cqrs
website/     Astro + Starlight documentation site (GitHub Pages)
scripts/     release tooling and the local oxlint rule plugin
```

This is an [Nx](https://nx.dev) workspace using pnpm workspaces. The two packages are versioned and
published independently.

## Development

```sh
pnpm install

pnpm run build:packages   # tsc -> esm + dts, babel -> cjs, build-utils -> dist/
pnpm run test:packages    # vitest, per package
pnpm run check:all        # tsc -b, src and tests
pnpm lint                 # oxlint, type-aware
pnpm run check:effect     # Effect language-service diagnostics

pnpm run precommit        # lint + test + check across the workspace

pnpm run dev:website      # docs site at localhost:4321
pnpm run build:website
```

Per-project targets run through Nx:

```sh
pnpm exec nx build @effect-server-utils/cqrs
pnpm exec nx test @effect-server-utils/authz
pnpm exec nx affected -t test
```

## How a package is built

Each package follows the Effect build convention rather than a bundler:

1. `tsc -b tsconfig.build.json` → `build/esm` + `build/dts`
2. `babel --plugins annotate-pure-calls` → tree-shaking annotations, in place
3. `babel --plugins @babel/transform-modules-commonjs` → `build/cjs`
4. `build-utils pack-v2` → `dist/`, the publish root, with a generated `exports` map giving every
   top-level module its own subpath

`dist/` is what `nx release publish` pushes to npm.

## Releasing

Versioning is driven by [conventional commits](https://www.conventionalcommits.org) and the two packages
are released independently. Pushing to `main` runs lint, test and typecheck, then `nx release`, which
versions each package that changed, tags it, and opens a GitHub release. Publishing to npm happens when
that release is created.

See [RELEASE.md](RELEASE.md).

## Contributing

Commits must follow conventional-commit format — `nx release` derives version bumps from them and
commitlint enforces it on every commit and in CI.

## License

MIT
