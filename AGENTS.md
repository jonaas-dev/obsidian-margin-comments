# AGENTS.md — obsidian-margin-comments

Project-specific instructions for agents working on this repository.

## Language

**Everything in this repository is in English, with no exceptions**: source code,
identifiers, code comments, docstrings, CSS classes, file names, README, issues, pull
request titles and bodies, and **commit messages**.

Commit messages follow Conventional Commits, written in English: `feat: add threaded
replies`, never `feat: añadir respuestas en hilo`. This history gets published in full
at 1.0, where a bilingual log is noise for every reader.

## Workflow

- Work on a branch and open a pull request; do not commit directly to `main`, and never
  push to `main` a commit that has not been through a pull request.
- Keep pull requests small when possible, ideally under 400 lines.
- Run the pre-commit hook (`sh ops/install-hooks.sh`) and the project's linting
  before committing.
- **Merge by pushing the reviewed head to `main` as a fast-forward**:
  `git push origin <sha>:main`, once the branch is rebased onto `main` and CI is green
  on that exact commit. GitHub marks the pull request merged when its head lands on
  `main`. Never use GitHub's merge button or `gh pr merge`, in any mode: measured here,
  a squash merge put the profile name in as author (#213, #219) and a rebase merge as
  committer (#223). See [Committer identity](#committer-identity).

## What this is

An Obsidian plugin that adds inline comments to notes without ever modifying the
Markdown files. Comment data lives in JSON sidecars under `.margin-comments/` at the
vault root.

## Hard constraints

- **Never write to the user's `.md` files.** Comments are sidecar-only.
- **`.margin-comments/` is a dotfolder**, therefore invisible to the Obsidian Vault API.
  Use `app.vault.adapter` (`read`/`write`/`exists`/`list`/`mkdir`) with `normalizePath()`
  for every path. `vault.create`, `vault.getAbstractFileByPath` and `vault.on('modify')`
  will not see it.
- **Mobile must work** (`isDesktopOnly: false`), so no Node built-ins: no `require('crypto')`,
  no `fs`, no `path`. Hashing is a synchronous non-cryptographic function implemented in
  plain TypeScript.
- Register every event with `registerEvent()` and every interval with `registerInterval()`;
  tear everything down in `onunload()`.
- No `console.log` left in shipped code.

## Comments

A comment only survives if it explains the **why**, not the **what**. Keep the reason
for a non-obvious decision, a workaround, or a measured behaviour; remove comments
that paraphrase the code, decorative separators, and commented-out code.

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

## Committer identity

The published history must not contain the author's real name. Commits should be authored as `jonaas-dev` with a GitHub noreply address.

GitHub's merge buttons write the resulting commit themselves, and they use the account's public profile name as author or committer. That name re-enters history unless:

- the GitHub profile name is set to `jonaas-dev`; or
- merges are done by fast-forwarding the reviewed branch to `main` (no merge commit authored by GitHub).

If the real name appears in `main` again, rewrite it before the repository becomes public (`git filter-branch` or `git filter-repo`), and reset every local clone and open branch.

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
| "applies it to the open note without a reload" | Counted gutter markers after a settings toggle. Clicking in the tab stirs the workspace, `active-leaf-change` fires and the markers are redrawn by something other than the setting — so it passed against a tab whose commit never refreshed. |

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

`tests/e2e/` drives a real Obsidian over the remote debugging port. Everything below has
already cost an afternoon.

**The vault symlinks this repo in as the plugin.** So `data.json` is written to the repo
root and outlives the throwaway vault: a setting one test chose was still there on the
next run, and the suite started against state no fresh install would have. It showed up
as 16 unrelated failures. `createTempVault` now deletes it; do not reintroduce state that
lives outside the vault.

**Whoever holds port 9333 is who you drive.** `connectOverCDP` attaches to any process
listening there, and Obsidian keeps listening for a moment after it is killed. A launch
started in that moment attaches to an instance with no window left, and fails in
`beforeAll` with `Cannot read properties of undefined (reading 'waitForLoadState')`.
One such failure took the next 42 files down the same way within a second each (#242),
and it made Obsidian 1.7.7 look incompatible in #198. So `launchObsidian` waits for the
port to be free before it spawns, waits for a window after it attaches, and every path
that kills Obsidian waits for it to exit. A run whose files fail in well under a second
each is not testing the plugin: look for a second Obsidian on the port.

**Obsidian's settings modal never attaches here either.** `app.setting.open()` runs and
`app.setting.openTabById()` accepts the id, the tab's `containerEl` exists and reports
`isConnected`, and no `.modal` ever reaches the DOM. `tests/e2e/settings-tab.test.ts`
therefore renders the tab into its own container — which is what the tab is responsible
for; the chrome around it is not. Give that container `position:fixed;inset:0` and a
z-index: laid out at zero size the settings render correctly and Playwright still refuses
to click them, which surfaces as a 30-second timeout, not as an invisible element.

While there: **every Obsidian dropdown is built twice**, the live one plus a hidden
`is-measuring` clone it sizes the first from. An unqualified `locator("select")` inside a
`.setting-item` fails strict mode rather than picking the wrong one; take `.first()`.

**Obsidian's `Menu` never attaches here.** The click handler runs, the instance is
constructed, and `dom.isConnected` stays `false` after both `showAtMouseEvent` and
`showAtPosition` — with the window visible, focused, and `requestAnimationFrame` firing.
That is why sort and scope are native `<select class="dropdown">` controls: a control that
cannot be proved to open is not a control. Check this again before reaching for `Menu`.

**Open notes in the active leaf**, `getLeaf(false)`, not a new tab. A second tab leaves the
first note's editor in the DOM but hidden, and `.cm-editor` selectors go on matching it —
which surfaces as a 30-second timeout, not as a wrong element. Wait on
`.workspace-leaf.mod-active .cm-editor`.

**The harness holds DOM focus only inside one synchronous block.** It is not just
textareas: `element.focus()` sticks while the `page.evaluate` that called it is still
running, and after any `await` — or between two evaluates — `document.activeElement` is
back on `<body>`, whatever the plugin did. Pressing Tab moves nothing at all. So a keydown
never reaches a composer or reply field (click the button instead; `keyIntent` is where the
Enter/Escape decision is tested), a tab traversal cannot be simulated, and "the composer
takes focus when it opens" cannot be asserted here. What *can* be asserted is what makes
the keyboard work: that the controls are focusable elements in DOM order, that the ones
without text carry a label, and — read synchronously — that focus goes back where it came
from. `tests/e2e/accessibility.test.ts` is built on that split.

**Collapsing a sidebar that holds the active leaf focuses the note.** That focus is Obsidian
desktop's, not the plugin's, and a phone does not give it. The first touch-case test for #157
read focus in the editor after a jump from the panel and failed against the fix as it had
against `main`: the panel was the active leaf, the plugin collapsed its sidebar, and Obsidian
focused the note. When a test measures focus the plugin gives or withholds, make the note the
active leaf first (`setActiveLeaf(leaf, { focus: false })`), and run the test against the fix
as well as against `main` — one that fails on both is measuring something else.

**`:focus-visible` needs a keyboard press first.** It asks whether the last interaction was
a keyboard one, and a suite that has only clicked will compute no focus ring at all from a
perfectly good stylesheet. One `page.keyboard.press("Tab")` sets the modality; it does not
matter that focus does not move.

Notices stack: a `.notice` from an earlier assertion may still be on screen, so match
`.last()`.

**The suite runs `main.js`, not the TypeScript.** Run `npm run build` before an E2E run
or you are testing the previous version. This matters most when deliberately breaking
code to check a test bites: `npm run build` starts with `tsc --noEmit`, so a patch that
leaves an import or a constant unused fails the build, the old bundle stays in place, and
the run reports whatever the *previous* patch did. The tell is a negative that fails a
test unrelated to what you broke — that is a stale bundle, not a surprising coupling.
Consume the symbol (`void thing;`) so the build still compiles, and check the build
succeeded before believing the result.

**A minified bundle has no names to grep.** The production build mangles identifiers, so
`grep watchPlacement main.js` answers 0 on a bundle that contains the function, and a wait
loop keyed on that name never ended. To check that a build carries a change, search for a
string literal the change introduced (`--keyboard-height`, a class name), never for a function.

**CodeMirror hides the whole gutter from assistive technology.** `.cm-gutters` carries
`aria-hidden="true"`, because it is chrome duplicating content the editor already exposes. So
nothing inside a gutter marker reaches the accessibility tree — measured with `role="img"` and
an `aria-label` on it, the tree held no node for it at all. Do not spend an afternoon adding
roles there. A `title` is what a pointer user gets; the panel is the surface a screen reader
reads.

**A CSS transition makes `getComputedStyle` time-dependent.** Reading a colour a frame or two
after changing the variable it comes from returns the *interpolated* value, so a correct
stylesheet reads back as whatever it is halfway to. Wait past the transition, or the assertion
measures the clock.

**Obsidian's own element styles outrank a lone plugin class.** `button:not(.clickable-icon)`
is specificity 0,1,1 and sets colour, background, border and padding — so styling a
`<button>` of ours through a single class silently loses. It surfaced as the theme test
finding the quote in the theme's button colour instead of muted, with the accent rule down
its left edge gone too. Scope through an ancestor (`.inline-comment-card .inline-comment-quote`).

## Obsidian on Android

**The keyboard does not shrink `visualViewport`.** Obsidian's Android app keeps the WebView at
full height, publishes the keyboard as `--keyboard-height` on `<html>`, and shrinks
`.app-container` to what is left. Measured on a Pixel 8 with Gboard up: `innerHeight` and
`visualViewport.height` both 915, `--keyboard-height: 336.38px`, `.app-container` ending at 579.
No resize event fires. A sheet placed against the visual viewport alone opened behind the
keyboard (#159): read the variable as well, and watch the root element's `style` for it.

**The navigation bar hides by sliding, not by disappearing.** `body` gets `is-hidden-nav` and
`.mobile-navbar` animates `transform` below the screen while staying displayed, so measured when
the class changes it has not moved yet. Wait for its `transitionend` (#160).

**Boot the emulator with `-gpu host`.** Its default software renderer (`swangle` + `lavapipe`)
paints stale tiles into WebView scrollers: fragments of other cards drawn over the panel header,
which no phone shows. That was filed as a plugin bug (#134), and two fixes were tried against it
before the same repro came out clean on `main` under the host GPU. Gboard never drew its full
keyboard under the software renderer either, so keyboard overlap could not be seen there at all.
Before filing a rendering fault found on the emulator, check `gles_mode_selected` in its log.

## Obsidian surface the API does not declare

The plugin relies on a few things Obsidian ships but neither types nor documents. Each is
reached defensively, so a change in Obsidian costs one feature rather than the plugin. When an
Obsidian update breaks something, start here.

| Surface | Used by | If it changes |
| --- | --- | --- |
| `MarkdownView.editor.cm`, the CodeMirror `EditorView` | the `add-comment` command and the per-pane refresh in `main.ts` | The command does nothing, and that pane draws no gutter markers or highlights. The panel still works. |
| `app.hotkeyManager.getHotkeys` / `getDefaultHotkeys` | `addCommentBinding` in `main.ts` | The panel's empty state names the command instead of its key (#122). |
| `--keyboard-height` on `<html>` (Android) | `keyboardHeight` in `editor/bottom-sheet.ts` | Sheets open behind the on-screen keyboard (#159). |
| `.mobile-navbar`, and its `transitionend` when `body` toggles `is-hidden-nav` | `reservedBottom` and `watchPlacement` in `editor/bottom-sheet.ts` | Sheets overlap the navigation bar, or leave a gap where it was (#160). |

**`obsidian` is pinned to an exact version.** Its types are what the compiler checks the plugin
against; with `latest`, a fresh install could change them under the build.

## Minimum Obsidian version

`minAppVersion` names the oldest Obsidian the full E2E suite passes on: 1.13.4, measured in #198.
Obsidian updates the app itself, so a user below it is asked to update instead of getting a plugin
that half works. Older releases fail on behaviour, not on crashes:

| Obsidian | What fails |
| --- | --- |
| 1.11.7, 1.12.7 | Focus does not return where it came from when the composer is dismissed. |
| 1.8.10 | The above, and the gutter marker ignores the theme's colour (#85). |
| 1.7.7 | Focus, and a note open in a second pane shows no markers until clicked (#83). |
| 1.6.7 | Both, and a commented code block is not marked in reading mode (#141). |
| 1.5.x | Cannot be driven at all: Playwright fails to attach to its Electron 28. |

**To measure it again**, point the harness at another build with `OBSIDIAN_APP`, the binary inside
`Obsidian.app/Contents/MacOS/`. Installers are the `.dmg` assets on `obsidianmd/obsidian-releases`.
Bisect with the files that fail, then run the full suite on the candidate. Before trusting a run
that fails, run the same command on the current release and watch it pass: a narrowed run that
failed everywhere would look exactly like a version boundary.

## Markdown rendering in cards

`MarkdownRenderer.render(app, md, el, sourcePath, component)` — both arguments after
`el` were measured here, because both look inert from outside.

**`sourcePath` decides what a link means, and the DOM does not say so.** An unresolved
`[[nowhere-at-all]]` renders with exactly the classes a resolved link gets — no
`is-unresolved` — so a link cannot prove which note the renderer resolved against. An
**embed** can: it pulls the target's text into the card. Obsidian resolves a linkpath by
exact path from the vault root first, then by preferring the source note's own folder,
then by falling back to whichever match it indexed first. So a test that means to catch a
wrong `sourcePath` needs two notes of the same basename, **neither at the vault root**,
with the decoy created first — otherwise the wrong path resolves to the right file and
the test passes against a renderer given no path at all. That is exactly what the first
version of `markdown-cards.test.ts` did.

**`component` is where child components are registered, one per embed.** Plain Markdown
registers nothing, so a leak test written over a `**bold**` body measures zero either
way. The panel repaints on every filter, sort, scope and settings change, so the card
lifecycle owner is a `Component` created per paint and removed on the next one — hanging
it off the view leaks one component per embed per repaint, alive until the panel closes.
Measured before and after: 8 repaints took the view's component tree from 5 to 13.

## The editor path is O(comments x document)

Measured, because the issue that asked for this assumed otherwise.

Every redraw resolves each open comment against the note, and `matchAnchor`
searches the document for each one — so the pass is O(comments x document) and
always was. Two things were wrong with it, and only one of them was a
complexity problem:

- **The gutter and the highlights each ran their own pass.** Every comment was
  matched twice per redraw. `resolveMarkers` returns both halves from one walk.
- **Line numbers were counted by walking the note from the top, per comment.**
  A constant factor, not a complexity class: 68 ms against 19 ms for 200
  comments on 10,000 lines, and 529 ms against 220 ms at 500 on 50,000. The gap
  *narrows* as the case grows, because matchAnchor comes to dominate — so the
  usual escape of enlarging the case until the signal is unmistakable does not
  work here, and no timing test can separate the two on a shared runner. What
  guards it instead is a count: `matchAnchor` must be called once per open
  comment, asserted with a delegating mock in `tests/unit/marker-pass.test.ts`.

Building decorations only for `view.visibleRanges` would not have helped: the
DecorationSet is cheap to build, the matching is not, and highlights live in a
StateField precisely so a commented line scrolling back into view does not
depend on a rebuild that happened while it was off-screen.

**What actually makes typing cheap is the debounce**, because the expensive
redraw is the panel's: it repaints every card, renders each body through
MarkdownRenderer, and runs the fuzzy stage for anything the edit unanchored
(62 ms intact, 105 ms after an edit, 255 ms with the anchors wrecked, at 200
comments). Only `editor-change` is debounced. Every other caller is a single
deliberate act, and delaying those would show as lag after a click.

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
comments twice unless the second move waits for the first, as `moveComments` does by
holding both notes' queues.

`vault.on('delete')` also fires per descendant, but **innermost first**, with the
folder last:

```
delete: notes/a.md
delete: notes/deep
delete: notes/deep/b.md
delete: notes
```

So the delete handler needs no folder cascade: a folder holds no comments of its
own, and if those per-file events ever stopped, the sidecars would stay behind and
show as a "not found" note in the all-notes view — visible rather than lost, which
is the opposite of what a missed rename does.

`vault.on('create')` fires when a note is restored from the trash, and for every
file while Obsidian indexes a vault at startup. The startup flood is harmless to
`followCreate` — nothing is held at that point — but do not put anything expensive
behind it.

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

Both kinds of file carry a format `version` (`FORMAT_VERSION` in `storage.ts`). A sidecar
is `{ version, filePath, comments }`; `_index.json` is `{ version, notes }`, where `notes`
maps each commented note to `{ hash, threads, open }`.
- **No version:** the file predates versions, and is rewritten with one on its next change.
- **A higher version than this plugin knows:** the file is read but never written. The
  note's comments are shown read-only, and every change to them throws `NewerFormatError`;
  a newer index is rebuilt in memory.
- **Changing the format:** bump `FORMAT_VERSION` and migrate explicitly, with a test for
  every version still read.

The index is a derived cache — rebuildable from the sidecars, and rebuilt when it is
missing, corrupt, or written by a version that stored a bare hash. The counts are what lets the all-notes view draw every row
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


