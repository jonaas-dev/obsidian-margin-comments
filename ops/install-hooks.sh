#!/usr/bin/env sh
# Point git at the versioned hooks. Run once after cloning — core.hooksPath is
# local config, so it does not travel with the repo.
#
# The maintainer runs it with --maintainer, which makes the hook check the committer
# identity on every commit, whatever user.name says (#251).
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "✓ core.hooksPath -> .githooks"
if [ "${1:-}" = "--maintainer" ]; then
    git config hooks.maintainer true
    echo "✓ hooks.maintainer -> true: every commit must carry the maintainer identity"
fi
git config user.email >/dev/null 2>&1 || {
    echo "⚠ user.email is unset — the hook will reject commits until you set it."
    exit 0
}
echo "✓ committer identity: $(git config user.email)"
