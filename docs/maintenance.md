# Maintenance: hooks, identity, dependencies, git

Detail behind the hook, identity, dependency and git rules in [AGENTS.md](../AGENTS.md).

## Pre-commit hooks

Run `sh ops/install-hooks.sh` once after cloning — `core.hooksPath` is local config
and does not travel with the repo, so a fresh clone has no protection until you do.
The maintainer runs `sh ops/install-hooks.sh --maintainer` instead.

The hook blocks three things, because this repo goes public at 1.0 carrying its whole
history and a leak there is permanent:

1. **Wrong committer identity** — the maintainer's commits must be authored as
   `jonaas-dev` under the GitHub noreply address, never a real name or inbox. The check
   runs whenever `hooks.maintainer` is set, whatever `user.name` says: deciding from
   `user.name` let through the real name and inbox a machine's global config supplies
   (#251). Override for a fork with `git config hooks.expectedName <login>` and
   `git config hooks.expectedEmail <address>`.
2. **Secrets** — env/key files being added, and added lines matching known credential
   patterns.
3. **Personal data** — home directory paths, personal email addresses, local hostnames.
   The likely source is docs or screenshots written against a real vault.

When the change touches `docs/decisions/` or `AGENTS.md`, it also runs the maintainer's
decision-record check (`decisions_check.py` from `$JONAS_SKILLS`, default
`~/Repos/jonas-skills`); where that clone is absent it prints that it skipped and goes on.

Only added lines in the staged diff are scanned, so the hook stays fast. Escape a
confirmed false positive by appending `# pragma: allowlist secret` or
`# pragma: allowlist personal` to the line. `--no-verify` exists but defeats the point.

Once the toolchain lands (#1), extend `.githooks/pre-commit` with lint and typecheck.

## Committer identity

The published history must not contain the author's real name. Commits should be authored as `jonaas-dev` with a GitHub noreply address.

GitHub's merge buttons write the resulting commit themselves, and they use the account's public profile name as author or committer. That name re-enters history unless:

- the GitHub profile name is set to `jonaas-dev`; or
- merges are done by fast-forwarding the reviewed branch to `main` (no merge commit authored by GitHub).

CI enforces the same rule in `ops/check-identity.py`, keyed on who opened the pull request a
commit belongs to rather than on the commit's own identity: every commit in the maintainer's pull
requests is checked, and on a push to `main` every commit that no outside contributor's pull
request carries. Outside contributors keep whatever identity GitHub has on file. The cases, the
#251 one included, run as `tests/unit/identity-guards.test.ts`.

If the real name appears in `main` again, rewrite it before the repository becomes public (`git filter-branch` or `git filter-repo`), and reset every local clone and open branch.

## Dependency audit overrides

The plugin ships one bundled `main.js` and has **no runtime dependencies**, so every advisory
`npm audit` reports comes from the build toolchain. That makes `--omit=dev` worthless as a
relief valve: it would report 0 always and the gate would measure nothing. The `overrides` in
`package.json` pin the fixed versions instead, so `--audit-level=moderate` keeps biting:

| Override | Why it cannot be a plain update |
| --- | --- |
| `eslint-plugin-obsidianmd > obsidian: $obsidian` | The lint plugin pins its own `obsidian@1.12.3`, whose `@codemirror` peers clash with the ones `obsidian@1.14.4` needs, so `npm ci` failed outright (#377). Pointing it at the project's own `obsidian` also lints against the API the plugin is built with. Drop it once the lint plugin stops pinning an older one. |
| `minimatch: ^11.0.1` | GHSA-g3hv-75wg-m249 covers every `minimatch` below 11.0.1 and the eslint toolchain still asks for 3, 8, 9 and 10, so only a global override closes it (it also replaces the old `minimatch > brace-expansion` one: 11 needs `brace-expansion@^5.0.12` itself). Majors 9+ export `{ minimatch, Minimatch }` with no `default`: callers going through `__importDefault` (`eslint-plugin-import`'s glob options, `json-schema-validator/no-invalid`) would throw a `TypeError`. Neither path runs with this config (lint covers `.ts` only, `import/no-extraneous-dependencies` keeps its boolean defaults), and the failure is loud. Drop it once eslint resolves `minimatch@>=11.0.1` on its own. |
| `source-map-js: ^1.2.2` | No direct dependent asks for it; the override is the only lever. |

**Review these when `obsidian` or the eslint toolchain is next bumped** (set 2026-10-06, #282; reviewed 2026-10-23 and 2026-11-02, when `obsidian` 1.14.4 resolved `moment` 2.31.0 on its own and its override went):
drop an override as soon as the dependency resolves to a fixed version on its own. Leaving a
stale override is how a real advisory gets pinned shut.

## Destructive git operations

Two ways work has already been lost in this repo. Both are silent.

**Never rewrite a branch's base while a pull request is open against it.** GitHub
detaches the PR: its head freezes at a commit that no longer exists, `mergeable` stays
null forever, and once closed it cannot be reopened — the API refuses with
`state cannot be changed. The <branch> branch was force-pushed or recreated`. The
commits survive on the branch; the PR, its review threads and its CI history do not
come back. This cost PR #40, which had to be replaced by #41.

Fix history *before* opening the PR. If one is already open and the rewrite cannot
wait, expect to close it and open a replacement, linking the two so the review stays
findable.

A rewrite also invalidates green CI on that branch — the checks ran against the old
commits. Before merging anything that was rebased or force-pushed, confirm the run's
`head_sha` is what you are about to merge:

```sh
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion) (\(.head_sha[0:7]))"'
```

**`git reset --hard` discards uncommitted changes to tracked files**, including edits
made minutes earlier for a different purpose than the reset. This happened twice here,
both times cleaning up after a throwaway experiment, and both times it silently reverted
a real fix that had not been committed yet — once caught only because the test that
followed exercised the reverted code. Commit or stash before resetting, and when a reset
follows an experiment, check `git status` first to see what else is riding along.
