#!/bin/bash
# Pulls the tracked branch of business-bots; on a new commit runs deploy/on-update.sh.
# Runs every minute from bots-sync.timer.
set -euo pipefail

REPO_DIR=/opt/business-bots
BRANCH=$(cat /etc/bots/branch)

cd "$REPO_DIR"
git fetch --quiet origin "$BRANCH"
NEW=$(git rev-parse "origin/$BRANCH")
OLD=$(git rev-parse HEAD)
[ "$NEW" = "$OLD" ] && exit 0

echo "updating $OLD -> $NEW ($BRANCH)"
git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
git reset --quiet --hard "origin/$BRANCH"

if [ -x deploy/on-update.sh ]; then
  deploy/on-update.sh
fi
