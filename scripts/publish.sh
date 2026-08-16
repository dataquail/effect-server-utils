#!/bin/bash

# Script to handle the complete publishing process
# 1. Configures git for GitHub Actions
# 2. Builds packages
# 3. Resolves workspace:* dependencies to real versions
# 4. Publishes packages

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

# Publish. A re-run over versions that are already on the registry is the one
# failure worth tolerating — it makes re-running the workflow idempotent. Every
# other failure has to fail the job.
#
# The previous version of this script swallowed the exit code unconditionally
# and printed "completed successfully" regardless, so an EOTP (npm 2FA) failure
# published nothing while the workflow went green. A release pipeline that
# reports success without publishing is worse than one that fails.
echo "Publishing packages..."
PUBLISH_LOG=$(mktemp)
trap 'rm -f "$PUBLISH_LOG"' EXIT

set +e
npx nx release publish --verbose 2>&1 | tee "$PUBLISH_LOG"
PUBLISH_EXIT=${PIPESTATUS[0]}
set -e

if [ "$PUBLISH_EXIT" -eq 0 ]; then
  echo "✅ Publish process completed successfully!"
  exit 0
fi

# Distinguish "already published" from a genuine failure.
if grep -qiE "cannot publish over|previously published|EPUBLISHCONFLICT" "$PUBLISH_LOG"; then
  if grep -qiE "EOTP|one-time password|ENEEDAUTH|E401|E403|ERR_PNPM" "$PUBLISH_LOG"; then
    echo "❌ Publish failed: some versions were already published, but other packages failed for a different reason."
    exit "$PUBLISH_EXIT"
  fi
  echo "⚠️  Nothing new to publish — these versions are already on the registry. Treating as success."
  exit 0
fi

echo "❌ Publish failed with exit code $PUBLISH_EXIT."
if grep -qiE "EOTP|one-time password" "$PUBLISH_LOG"; then
  echo
  echo "   npm rejected the publish because your account requires a one-time"
  echo "   password for write actions. A CI token cannot supply one."
  echo "   Fix: make NPM_TOKEN a classic *Automation* token — it is the token"
  echo "   type that bypasses the 2FA-for-writes requirement."
  echo "   https://www.npmjs.com/settings/~/tokens"
fi
exit "$PUBLISH_EXIT"
