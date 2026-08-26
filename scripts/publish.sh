#!/bin/bash

# Script to handle the complete publishing process
# 1. Configures git for GitHub Actions
# 2. Builds packages
# 3. Resolves workspace:* dependencies to real versions
# 4. Publishes the package this run is for, and verifies it against the registry

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

# `nx release` cuts one GitHub release per package and this workflow runs on
# each of them, so publishing every package from every run means N runs racing
# to PUT the same N versions. One wins each version and the rest get a 403 for
# publishing over something that is now already there — which is what happened
# on the 0.1.0-beta.3 release, where two of three runs went red over a set of
# packages that had all published perfectly well.
#
# Scoping each run to the package its own release named is what makes them
# independent. `PACKAGE_NAME` comes from the release tag; absent it (a manual
# dispatch) publish everything, which is the only case where that is wanted.
PROJECT_ARGS=()
if [ -n "${PACKAGE_NAME:-}" ]; then
  echo "Publishing ${PACKAGE_NAME}, the package this release is for..."
  PROJECT_ARGS=(--projects="$PACKAGE_NAME")
else
  echo "No release tag in the environment — publishing every package..."
fi

PUBLISH_LOG=$(mktemp)
trap 'rm -f "$PUBLISH_LOG"' EXIT

set +e
npx nx release publish --verbose "${PROJECT_ARGS[@]}" 2>&1 | tee "$PUBLISH_LOG"
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

MISSING=()
for manifest in packages/*/dist/package.json; do
  [ -f "$manifest" ] || continue
  name=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).name")
  version=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")

  # Only the package this run was responsible for.
  if [ -n "${PACKAGE_NAME:-}" ] && [ "$name" != "$PACKAGE_NAME" ]; then
    continue
  fi

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "  ✅ $name@$version is on the registry"
  else
    echo "  ❌ $name@$version is NOT on the registry"
    MISSING+=("$name@$version")
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
