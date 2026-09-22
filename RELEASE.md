# Release Process

The three packages in this repository are versioned and published **independently**: a change confined to
`@effect-server-utils/cqrs` bumps and releases only that package.

## Prerequisites

Repository secrets:

| Secret                                           | Used for                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `NPM_TOKEN`                                      | publishing to npm, with provenance                                             |
| `VERSION_BUMPER_APPID` / `VERSION_BUMPER_SECRET` | a GitHub App token, so release commits and tags can push to a protected `main` |
| `NX_CLOUD_ACCESS_TOKEN`                          | optional, remote task cache                                                    |

You also need publish rights on the `@effect-server-utils` npm scope.

## The normal path

1. **Merge a conventional commit to `main`.**

   `feat:` → minor, `fix:` → patch, `feat!:` or a `BREAKING CHANGE:` footer → major. Nx maps each commit
   to the projects it touched, which is what makes independent versioning work.

2. **`.github/workflows/on-push.yml` runs.** Lint, test and typecheck on affected projects, then:

   ```sh
   pnpm exec nx run-many -t build --projects='packages/*'
   npx nx release --skip-publish
   ```

   That versions each changed package, commits `chore: updated version [no ci]`, tags it as
   `@effect-server-utils/<pkg>@<version>`, and creates a GitHub release per package.

3. **The same run then calls `.github/workflows/publish.yml` once**, executing `scripts/publish.sh`:
   build → resolve any `workspace:*` dependencies to real versions → publish → verify.

   The whole release is one run. `publish.yml` is _not_ triggered by release creation: `nx release`
   cuts one GitHub release per package, so that trigger fanned a single release out into one run per
   package, and both failures this pipeline has had were consequences of that fan-out — three runs
   racing to publish the same versions, and three runs racing to deploy the same docs. `on-push.yml`
   calls the publish workflow once instead, after every release has been cut.

   Which packages get published is therefore decided inside `scripts/publish.sh`, not by the trigger:
   it publishes every package whose freshly built version is **not already on the registry**. That
   makes the step idempotent, lets one run publish any subset, and turns a re-run after a partial
   failure into a no-op for the parts that succeeded. A push that released nothing publishes nothing
   and exits clean.

4. **The docs site deploys last**, gated on the publish having reached the registry, so the site never
   describes a version you cannot install.

Packages are published from `packages/<name>/dist`, the publish root `build-utils pack-v2` produces.
Since the packages are new to the registry, `nx-release-publish` sets `access: public` in
`nx.json` — `build-utils` regenerates `dist/package.json` from a fixed schema and drops
`publishConfig.access`, so relying on the source manifest alone would fail the first publish of a scoped
package.

## Dry runs

```sh
# what would be versioned, and to what
pnpm exec nx release --dry-run

# the very first release, with no prior tags to derive from
pnpm exec nx release --first-release --dry-run
```

## Publishing manually

Only if the workflow is unavailable:

```sh
pnpm install --frozen-lockfile
pnpm run build:packages
./scripts/publish.sh
```

`NODE_AUTH_TOKEN` must be set, and `NPM_CONFIG_PROVENANCE=true` if you want the provenance statement
(`.npmrc` sets `provenance=true`, which only takes effect in a trusted CI environment).

## Testing a publish locally

An Nx-managed Verdaccio registry is wired up:

```sh
pnpm exec nx local-registry     # http://localhost:4873
npm publish packages/cqrs/dist --registry http://localhost:4873
```

## Versioning policy

Standard semver, with one wrinkle: `effect` is an **exact** peer dependency on a beta.

Moving to a newer `effect` beta is a coordinated change to all three packages and is treated as a breaking
change, because a consumer cannot resolve two different betas in one dependency tree. Dependabot is
configured not to open PRs for `effect` or `@effect/vitest` for that reason.

## After a release

- Confirm the GitHub release notes read sensibly — they are generated from the conventional commits.
- The docs redeploy themselves: **Publish** calls the **Deploy Documentation** workflow once the
  packages are on the registry, which builds `website/` and publishes it to GitHub Pages at
  <https://dataquail.github.io/effect-server-utils>. There is one publish run per release, so there is
  one docs deploy — the `pages` concurrency group is now only guarding a manual dispatch racing a
  release.
- **Deploy Documentation** still takes a `workflow_dispatch`, for redeploying a docs-only change that
  did not go out with a release.
