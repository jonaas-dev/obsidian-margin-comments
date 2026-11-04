# Obsidian behaviour the plugin depends on

Measured behaviour, undeclared API and performance notes. [AGENTS.md](../AGENTS.md) keeps one line per rule.

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
| `vault.on("raw", path)`, which fires for files under dotfolders (measured on desktop 1.13.7; not measured on mobile, nor for a visible storage folder) | `followStorageChange` in `main.ts` | Comments another device syncs in appear only after a restart. None are lost: every change re-reads the sidecar and the index from disk first (#260). |
| `vault.on("rename" \| "delete" \| "create", file)` for files in a visible storage folder, which the Vault API sees once the folder is not a dotfolder | The handlers in `NoteEvents` (`vault-events.ts`) return early for paths inside the storage folder (`inStorageFolder`) | The handlers would treat a storage file as a note, so the ignore is what keeps comment files out of the note-move logic. |

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
