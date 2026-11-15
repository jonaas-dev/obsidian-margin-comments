#!/bin/sh
# The release gate: CI never runs the E2E suite, so a release is verified here (docs/e2e.md).
set -e
lock=/tmp/obsidian-e2e.lock
mkdir "$lock" 2>/dev/null || { echo "release-gate: another Obsidian run holds $lock" >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
