#!/bin/bash

# Script to handle the complete publishing process
# 1. Configures git for GitHub Actions
# 2. Builds packages
# 3. Resolves workspace:* dependencies to real versions
# 4. Works out which packages still need publishing, publishes those, and
#    verifies them against the registry

set -e

echo "Starting publish process..."

# Configure git for GitHub Actions
echo "Configuring git..."
git config user.name github-actions
git config user.email github-actions@github.com

# Build packages
echo "Building packages..."
pnpm build:packages

echo "Fixing workspace dependencies..."
# Call the fix-workspace-deps.sh script
./scripts/fix-workspace-deps.sh

# Which packages this run publishes is decided here, from the registry, rather
# than by the trigger that started the run.
#
# A package whose built version is already on npm has nothing to do — and the
# reason why does not matter: a previous attempt may have published it, this
# release may not have touched it, or someone may have pushed it by hand. All
# three want the same answer, so asking the registry covers all three at once
# and makes a re-run idempotent by construction.
#
# This is also what lets a whole release be one run. Publishing used to be one
# run per package, triggered by the per-package GitHub releases `nx release`
# cuts, because a run that published *everything* raced the others to PUT the
# same versions: one won each version and the rest took a 403 for publishing
# over something already there. That is what reddened two of three runs on the
# 0.1.0-beta.3 release. Selecting on the registry removes the race instead of
# sharding around it — there is one run, and it publishes whatever is missing.
echo
echo "Deciding what needs publishing..."

TO_PUBLISH=()   # nx project names, for --projects
INTENDED=()     # name@version, for the verification pass below

for manifest in packages/*/dist/package.json; do
  [ -f "$manifest" ] || continue

  name=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).name")
  version=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "  ⏭️  $name@$version is already on the registry"
  else
    echo "  📦 $name@$version needs publishing"
    TO_PUBLISH+=("$name")
    INTENDED+=("$name@$version")
  fi
done

if [ ${#TO_PUBLISH[@]} -eq 0 ]; then
  echo
  echo "✅ Every built package is already on the registry — nothing to publish."
  exit 0
fi

# `--projects` takes nx project names; each package's project.json names it
# after the package, so the names collected above are already the right ones.
PROJECTS=$(IFS=,; echo "${TO_PUBLISH[*]}")
echo
echo "Publishing: $PROJECTS"

PUBLISH_LOG=$(mktemp)
trap 'rm -f "$PUBLISH_LOG"' EXIT

set +e
npx nx release publish --verbose --projects="$PROJECTS" 2>&1 | tee "$PUBLISH_LOG"
PUBLISH_EXIT=${PIPESTATUS[0]}
set -e

# The registry is the source of truth for whether this worked, not the exit
# code — because npm cannot tell you which kind of failure you had.
#
# It answers "you cannot publish over 0.1.0-beta.3" and "you have no rights
# here" with the same E403, so no amount of grepping the log separates a
# harmless re-run from a broken token. The previous version of this check tried:
# it tolerated "cannot publish over" unless the log also matched E401/E403/EOTP
# — and npm's already-published error *is* an E403, so the tolerant branch was
# unreachable and every re-run reported failure.
#
# Asking the registry whether the versions we meant to publish are actually
# there answers the question the exit code was only ever standing in for, and
# makes a re-run idempotent for the right reason rather than by pattern-matching
# on prose npm is free to reword.
echo
echo "Verifying against the registry..."

# Only the versions this run set out to publish. Anything that was already
# there was never this run's responsibility and is not evidence either way.
MISSING=()
for spec in "${INTENDED[@]}"; do
  if npm view "$spec" version >/dev/null 2>&1; then
    echo "  ✅ $spec is on the registry"
  else
    echo "  ❌ $spec is NOT on the registry"
    MISSING+=("$spec")
  fi
done

if [ ${#MISSING[@]} -eq 0 ]; then
  if [ "$PUBLISH_EXIT" -ne 0 ]; then
    echo
    echo "⚠️  nx exited $PUBLISH_EXIT, but every version this run was responsible for"
    echo "   is on the registry — most likely it was already published. Treating as success."
  fi
  echo "✅ Publish process completed successfully!"
  exit 0
fi

echo
echo "❌ Publish failed — these versions did not reach the registry:"
printf '   - %s\n' "${MISSING[@]}"

if grep -qiE "EOTP|one-time password" "$PUBLISH_LOG"; then
  echo
  echo "   npm rejected the publish because your account requires a one-time"
  echo "   password for write actions. A CI token cannot supply one."
  echo "   Fix: make NPM_TOKEN a classic *Automation* token — it is the token"
  echo "   type that bypasses the 2FA-for-writes requirement."
  echo "   https://www.npmjs.com/settings/~/tokens"
fi

exit "${PUBLISH_EXIT:-1}"
