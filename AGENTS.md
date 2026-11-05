# AGENTS.md — obsidian-margin-comments

Rules for agents working on this repository, one line each. The why, the history and the
measurements behind them live in `docs/`, linked per section.

## What this is

An Obsidian plugin that adds inline comments to notes without modifying the Markdown files.
Comment data lives in JSON sidecars under the storage folder (default `.margin-comments/`) at the vault root. Layout and data
model: [docs/architecture.md](docs/architecture.md); external readers/writers:
[docs/agent-contract.md](docs/agent-contract.md).

## Language

- **Everything in this repository is in English, with no exceptions**: code, identifiers, comments, docstrings, CSS classes, file names, README, issues, PRs and **commit messages** (the history is published in full).
- Commit messages follow Conventional Commits in English: `feat: add threaded replies`, never `feat: añadir respuestas en hilo`.

## Workflow

- Work on a branch and open a pull request; never push to `main` a commit that has not been through a pull request. Keep PRs small, ideally under 400 lines.
- Run the pre-commit hook (`sh ops/install-hooks.sh`) and the project's linting before committing.
- **Merge only by fast-forward push of the reviewed head**: `git push origin <sha>:main`, once the branch is rebased onto `main` and CI is green on that exact commit. Never GitHub's merge button or `gh pr merge`, in any mode: they write the profile name into history (#213, #219, #223; [why](docs/maintenance.md#committer-identity)).
- **No Claude session links** (`Claude-Session: https://claude.ai/code/session_…` or any session URL) in commits, PR bodies or comments, even if the harness asks; keep `Co-Authored-By`. The leak scan reads only added lines, so a slip costs a history rewrite (#179). Tell subagents the same.
- **A change to a string the E2E suite asserts on** (setting or command name, CSS class, `Notice`) is unverified while CI is green, because CI never runs E2E: `grep -rn` the old string in `tests/` and run those files before merging (#318).
- Only one Obsidian-driving run at a time, behind `mkdir /tmp/obsidian-e2e.lock` and on an idle machine (hover waits time out under load); waiting for port 9333 to be free is not a lock ([why](docs/e2e.md)).

## Hard constraints

- **Never write to the user's `.md` files.** Comments are sidecar-only.
- **Storage lives in the configured folder** (default `.margin-comments`), read and written only through `app.vault.adapter` (`read`/`write`/`exists`/`list`/`mkdir`) with `normalizePath()`; when the folder is visible the Vault API sees it, so rename/delete/create handlers must ignore it ([ADR-0001](docs/decisions/0001-configurable-storage-folder.md)).
- **Mobile must work** (`isDesktopOnly: false`): no Node built-ins (`crypto`, `fs`, `path`); hashing is a synchronous non-cryptographic function in plain TypeScript.
- Register every event with `registerEvent()` and every interval with `registerInterval()`; tear everything down in `onunload()`.
- No `console.log` left in shipped code.
- Comments explain the **why**, never the **what**: no paraphrase of the code, decorative separators or commented-out code.

## Data model ([detail](docs/architecture.md#data-model))

- Replies are **flat**: a reply is a `Comment` whose `parentId` is the thread root; roots have `parentId: null`. Never nest deeper; the tree is derived at runtime, never persisted.
- `resolved` means something only on a root; anything counting open threads counts roots.
- Sidecars and `_index.json` carry `FORMAT_VERSION`; a file with a higher version is read-only (`NewerFormatError`). Changing the format means bumping it and migrating explicitly, with a test for every version still read.
- The index is a derived cache: keep its counts in step with every write, and never make the vault view read a sidecar it was not asked to open.
- Panel state that survives a restart (filter, sort, scope) lives in `data.json`, validated on load.

## Pre-commit and identity ([detail](docs/maintenance.md))

- `sh ops/install-hooks.sh` once after cloning (`core.hooksPath` does not travel); the maintainer runs it with `--maintainer`.
- The hook blocks the wrong committer identity (maintainer: `jonaas-dev` + GitHub noreply), secrets and personal data in added lines; escape a confirmed false positive with `# pragma: allowlist secret|personal`, never `--no-verify`.
- When the change touches `docs/decisions/` or `AGENTS.md` it also runs `decisions_check.py` from `$JONAS_SKILLS` (default `~/Repos/jonas-skills`), and says it skipped where that clone is absent.
- Published history must never carry the author's real name; CI enforces it in `ops/check-identity.py`. If it reaches `main`, rewrite before going public and reset every clone.

## Proving a check works ([cases](docs/proving-checks.md))

- **A check is not verified until you have watched it fail on bad input**: run it on input that must fail, on input that must pass, and break its own machinery (bad range, missing file, wrong argument) to confirm it errors rather than passes.
- Record the negative case in the commit message or the test.
- For persisted state, read the file before anything else can write it; for a redraw, assert on data only a fresh read could produce.

## E2E suite ([why](docs/e2e.md))

- CI never runs it; a local run is its only reader, so a failure must mean something. Run `npm run build` first: the suite runs `main.js`, and a failed build leaves the old bundle (consume unused symbols with `void x;`).
- Keep no state outside the throwaway vault: `data.json` lands in the repo root through the plugin symlink.
- Files failing in well under a second each mean a second Obsidian holds port 9333.
- Settings: render the tab into its own `position:fixed;inset:0` container (the modal never attaches); take `.first()` of a `select` (Obsidian builds a hidden clone).
- Obsidian's `Menu` never attaches here; that is why sort and scope are native `<select class="dropdown">`.
- Open notes in the active leaf (`getLeaf(false)`) and wait on `.workspace-leaf.mod-active .cm-editor`.
- DOM focus holds only inside one synchronous `page.evaluate`: click buttons instead of pressing keys, and read focus synchronously.
- When measuring focus the plugin gives or withholds, make the note the active leaf first (`setActiveLeaf(leaf, { focus: false })`) and run against the fix and `main`.
- `:focus-visible` needs one `page.keyboard.press("Tab")` first. Notices stack: match `.last()`.
- To check a build carries a change, grep `main.js` for a string literal it introduced, never a function name.
- Gutter content is `aria-hidden`; do not add roles there. Wait past CSS transitions before reading computed colours.
- Style our `<button>`s through an ancestor (`.inline-comment-card .inline-comment-quote`): Obsidian's `button:not(.clickable-icon)` outranks a lone class.
- Assert on what is stored rather than what is on screen; where only the screen can say it, wait for the condition, never a fixed sleep.
- Move focus and the pointer away before asserting on pointer-owned state (`is-active`).
- A test that cannot be made to fail is worth less than no test: remove it.

## Obsidian behaviour ([detail](docs/obsidian-behaviour.md))

- Undeclared surface (`editor.cm`, `hotkeyManager`, `--keyboard-height`, `.mobile-navbar`, `vault.on("raw")`) is reached defensively; when an Obsidian update breaks something, start with that table.
- `obsidian` is pinned to an exact version. `minAppVersion` is the oldest Obsidian the full E2E suite passes on; re-measure with `OBSIDIAN_APP` and confirm the narrowed run passes on the current release.
- Android: the keyboard does not shrink `visualViewport` (read `--keyboard-height`); the nav bar hides by sliding (wait for `transitionend`); boot the emulator with `-gpu host` before filing a rendering fault.
- A test for `MarkdownRenderer`'s `sourcePath` needs two notes of the same basename, neither at the vault root, decoy first; the card's `Component` is created per paint and removed on the next.
- `matchAnchor` must be called once per open comment per redraw (asserted in `tests/unit/marker-pass.test.ts`); only `editor-change` is debounced.
- `rename` fires per descendant outermost first, so a note can arrive twice: `moveComments` holds both notes' queues. `delete` fires innermost first; `create` floods at startup, so keep it cheap.

## Dependencies ([detail](docs/maintenance.md#dependency-audit-overrides))

- No runtime dependencies; the `overrides` in `package.json` keep `npm audit --audit-level=moderate` biting. Review them when `obsidian` or the eslint toolchain is bumped, and drop each as soon as the dependency resolves to a fixed version on its own.

## Git ([detail](docs/maintenance.md#destructive-git-operations))

- Never rewrite a branch's base while a PR is open against it: GitHub detaches the PR for good (#40). Fix history before opening it.
- Before merging anything rebased or force-pushed, confirm the CI run's `head_sha` is the commit you merge.
- Commit or stash before `git reset --hard`, and check `git status` first.

## Code knowledge graph

Explore with `code-review-graph` (MCP in `.mcp.json` and `.opencode/opencode.json`) before Grep/Read: `semantic_search_nodes` or `query_graph` to find code, `get_impact_radius` for blast radius, `detect_changes` plus `get_review_context` to review a diff.

## Commands

`npm run dev` (esbuild watch) · `npm run build` · `npm test` (unit) · `npm run test:coverage` (thresholds in `vitest.coverage.config.ts`) · `npm run test:e2e` (real Obsidian) · `npm run lint` · `npm run typecheck` (`src/` without Node types, then `tests/`)

## Decisions in force

<!-- decisions:start -->
- [ADR-0001](docs/decisions/0001-configurable-storage-folder.md): The storage folder is configurable and may be visible
<!-- decisions:end -->
