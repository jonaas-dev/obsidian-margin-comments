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

**Known gap**: the CI leak and identity jobs have only been exercised locally. Neither
has been observed failing inside a real pull request.

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

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild watch |
| `npm run build` | production build |
| `npm test` | vitest |
| `npx tsc --noEmit` | type check |

## Task tracking

Work items live in the GitHub Project, not in this repo. The design document is kept
outside the repo and is not published.
