#!/usr/bin/env sh
# Point git at the versioned hooks. Run once after cloning — core.hooksPath is
# local config, so it does not travel with the repo.
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo "✓ core.hooksPath -> .githooks"
git config user.email >/dev/null 2>&1 || {
    echo "⚠ user.email is unset — the hook will reject commits until you set it."
    exit 0
}
echo "✓ committer identity: $(git config user.email)"
