# REVIEW.md

What reviewers (human or `pr-reviewer`) check in this repo on top of `AGENTS.md`. Add a rule when the
same review comment shows up twice; delete it when a linter or a test starts enforcing it.

## Rules

- New behaviour comes with a test that fails without the change.
- No secrets, tokens or personal paths in code, fixtures or logs.
- Comments explain the WHY; no commented-out code.

## Risk paths

A PR that touches any of these globs is `Risk: high`: it is reviewed as usual but never auto-merged
(`git-flow-helper` leaves the merge to a human). gitignore-like globs: `**` crosses directories, a glob
without `/` matches the file name anywhere.

- `.github/workflows/**`
- `.githooks/**`
- `.claude/hooks/**`
- `.env*`
- `**/migrations/**`
