# AGENTS.md — obsidian-inline-comments

Project-specific instructions. The cross-repo rules in `~/Repos/AGENTS.md` also apply
(branch + PR, Conventional Commits in Spanish, PRs under 400 lines, pre-commit linting,
WHY-only comments).

## Language

**Everything in this repository is in English, with no exceptions**: source code,
identifiers, code comments, docstrings, CSS classes, file names, README, issues, pull
request titles and bodies, and **commit messages**.

Commit messages follow Conventional Commits, written in English: `feat: add threaded
replies`, never `feat: añadir respuestas en hilo`. This overrides the Spanish-subject
convention in `~/Repos/AGENTS.md` — that rule assumes a private repo, and this history
gets published in full at 1.0, where a bilingual log is noise for every reader.

## What this is

An Obsidian plugin that adds inline comments to notes without ever modifying the
Markdown files. Comment data lives in JSON sidecars under `.inline-comments/` at the
vault root.

## Hard constraints

- **Never write to the user's `.md` files.** Comments are sidecar-only.
- **`.inline-comments/` is a dotfolder**, therefore invisible to the Obsidian Vault API.
  Use `app.vault.adapter` (`read`/`write`/`exists`/`list`/`mkdir`) with `normalizePath()`
  for every path. `vault.create`, `vault.getAbstractFileByPath` and `vault.on('modify')`
  will not see it.
- **Mobile must work** (`isDesktopOnly: false`), so no Node built-ins: no `require('crypto')`,
  no `fs`, no `path`. Hashing is a synchronous non-cryptographic function implemented in
  plain TypeScript.
- Register every event with `registerEvent()` and every interval with `registerInterval()`;
  tear everything down in `onunload()`.
- No `console.log` left in shipped code.

## Pre-commit hooks

Run `sh ops/install-hooks.sh` once after cloning — `core.hooksPath` is local config
and does not travel with the repo, so a fresh clone has no protection until you do.

The hook blocks three things, because this repo goes public at 1.0 carrying its whole
history and a leak there is permanent:

1. **Wrong committer identity** — commits must be authored under the GitHub noreply
   address, never a real inbox. Override for a fork with
   `git config hooks.expectedEmail <address>`.
2. **Secrets** — env/key files being added, and added lines matching known credential
   patterns.
3. **Personal data** — home directory paths, personal email addresses, local hostnames.
   The likely source is docs or screenshots written against a real vault.

Only added lines in the staged diff are scanned, so the hook stays fast. Escape a
confirmed false positive by appending `# pragma: allowlist secret` or
`# pragma: allowlist personal` to the line. `--no-verify` exists but defeats the point.

Once the toolchain lands (#1), extend `.githooks/pre-commit` with lint and typecheck.

## Proving a check works

**A check is not verified until you have watched it fail on bad input.** Confirming it
passes on good input proves nothing: a check that always passes also passes.

This is not a general principle someone wrote down here for tidiness. Three of the
checks in this repo's own verification setup shipped green and inert, and every one was
caught only by feeding it something that should have failed:

| What it looked like | What it did |
|---------------------|-------------|
| `except CalledProcessError: return 0` | Any git failure meant the leak scan reported success without scanning |
| `x=$(cmd \| filter \|\| true)` | Actions runs `bash -e` without `pipefail`, so a failing `cmd` was indistinguishable from a clean result |
| `git diff A..B` | Compares two tips, not the merge base: lines `main` deleted read as additions by the branch |
| Ignored CLI argument | `--range` was silently dropped and the scan fell back to an empty index, exiting 0 |

The shape they share: **the failure path produces the same output as success.** When
writing or reviewing a guard, ask what it does when its own machinery breaks — not when
the code it inspects is bad, but when git errors, an argument is wrong, or a pipe stage
dies. If that answer is "passes", it is decorative.

So, for every check added here:

1. Run it against input that must fail. Watch it fail.
2. Run it against input that must pass. Watch it pass.
3. Break the check's own dependency — bad range, missing file, wrong argument — and
   confirm it reports an error rather than success.

Record the negative case in the commit message or the test, so the next person does not
have to rediscover that it bites.

Two of this repo's own tests passed while proving nothing, and both were caught only
by breaking the code they covered:

| What it looked like | What it did |
|---------------------|-------------|
| "keeps the section open after resolving" | Asserted the section was still expanded, not that its cards were current. It passed against a build that never re-read the note. |
| "stores the scope in data.json" | Read the file after a filter had been clicked. Every setter saves the whole settings object, so the value was there whoever wrote it — the test passed against a plugin that never saved the scope. |

Both share the shape above: **the failure path produces the same output as success.** For
persisted state, read the file before anything else can write it; for a redraw, assert on
data that only a fresh read could produce.

Both CI gates have been through this, in #42, each isolated:

| Input | Result |
|-------|--------|
| Fake home path + fake email in the diff | Scan failed with correct `file:line` over the three-dot range |
| Non-noreply author address, clean diff | Identity guard failed, naming the address |

Isolating them was not pedantry. The first run tripped the scan, and because job steps
stop at the first failure the identity guard was reported as `skipped` — a single
combined test would have looked like proof of both while proving one. Both commits used
`--no-verify`, which is the bypass these jobs exist to cover.

## The E2E harness

`tests/e2e/` drives a real Obsidian over the remote debugging port. Four things about it
have already cost an afternoon each.

**The vault symlinks this repo in as the plugin.** So `data.json` is written to the repo
root and outlives the throwaway vault: a setting one test chose was still there on the
next run, and the suite started against state no fresh install would have. It showed up
as 16 unrelated failures. `createTempVault` now deletes it; do not reintroduce state that
lives outside the vault.

**Obsidian's `Menu` never attaches here.** The click handler runs, the instance is
constructed, and `dom.isConnected` stays `false` after both `showAtMouseEvent` and
`showAtPosition` — with the window visible, focused, and `requestAnimationFrame` firing.
That is why sort and scope are native `<select class="dropdown">` controls: a control that
cannot be proved to open is not a control. Check this again before reaching for `Menu`.

**Open notes in the active leaf**, `getLeaf(false)`, not a new tab. A second tab leaves the
first note's editor in the DOM but hidden, and `.cm-editor` selectors go on matching it —
which surfaces as a 30-second timeout, not as a wrong element. Wait on
`.workspace-leaf.mod-active .cm-editor`.

**The harness cannot hold focus in a textarea**, so a keydown never reaches a composer or
reply field. Click the button instead; `keyIntent` is where the Enter/Escape decision is
tested.

Notices stack: a `.notice` from an earlier assertion may still be on screen, so match
`.last()`.

## Vault events

`vault.on('rename')` fires for a renamed **folder and for every descendant**,
folders included, outermost first — measured, not assumed, because the opposite
was assumed first and the folder-cascade test passed against code that did not
cascade. Renaming `notes` to `archive` emits:

```
notes -> archive
notes/a.md -> archive/a.md
notes/deep -> archive/deep
notes/deep/b.md -> archive/deep/b.md
```

Two consequences. The per-file events alone would move every sidecar today, so a
test over a folder rename proves nothing about folder handling; the unit tests on
`movedPath` are what cover it. And the same note arrives twice, from overlapping
async handlers that each read the index before they write — which lands its
comments twice unless rename handling is serialised, as it is in `followRename`.

## Architecture

```
src/
├── main.ts          entry point, plugin registration
├── types.ts         Comment, TextAnchor, PluginSettings
├── storage.ts       sidecar CRUD over vault.adapter
├── anchor.ts        content-based anchoring (hash → context → fuzzy → orphaned)
├── editor/          CodeMirror 6 extensions (gutter, highlights, floating editor)
├── ui/              sidebar panel, comment cards, modals
├── settings.ts      settings tab
└── utils.ts         hashing, relative dates, ids
```

## Data model

Replies are **flat**: a reply is a `Comment` whose `parentId` points at the thread root.
Roots have `parentId: null`. Never nest deeper than one level — the tree is derived at
runtime, never persisted.

`resolved` is meaningful only on a root: resolving a root resolves its thread, and replies
carry no state of their own. Anything counting open threads therefore counts roots.

`_index.json` maps each commented note to `{ hash, threads, open }`. It is a derived cache
— rebuildable from the sidecars, and rebuilt when it is missing, corrupt, or written by a
version that stored a bare hash. The counts are what lets the all-notes view draw every row
without opening a single sidecar, so keep them in step with every write, and never make the
vault view read a sidecar it was not asked to open.

Panel state that has to survive a restart — filter, sort order, scope — lives in
`data.json` alongside the settings, validated on load rather than trusted.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild watch |
| `npm run build` | production build |
| `npm test` | vitest, unit only |
| `npm run test:e2e` | vitest against a real Obsidian; needs the app installed |
| `npm run lint` | eslint over src and tests |
| `npx tsc --noEmit` | type check |

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

## Task tracking

Work items live in the GitHub Project, not in this repo. The design document is kept
outside the repo and is not published.
