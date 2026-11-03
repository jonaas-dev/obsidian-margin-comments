# The E2E suite

How `tests/e2e/` drives a real Obsidian, what it cannot do, and how to assert in it. [AGENTS.md](../AGENTS.md) keeps one line per rule; this is the why.

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

## Asserting in the E2E suite

Three tests passed alone and failed in full-suite runs before this was written
down. All three waited a fixed number of milliseconds and then asserted on
something that appears and disappears on its own: a `Notice`, an `is-active`
class, a popover opened by a click that had to survive a plugin reload.

- **Assert on what is stored, not on what is on screen**, wherever both say the
  same thing. `stale-snapshot.test.ts` already does this and says why: a failure
  then prints what was stored, which is the thing the bug is about.
- **Where only the screen can say it**, wait for the condition instead of
  sleeping before it: `waitForSelector`, `waitForFunction`, or a locator with
  `hasText`. A slow run should be slow, not red.
- **Be careful with state the pointer owns.** `is-active` is set by focus and
  kept by hover, so an assertion on it measures where the mouse is as much as
  what the code did. Move focus and the pointer away first, or assert on
  something else.
- **A test that cannot be made to fail is worth less than no test.** Two were
  removed during #292 and #297 after being checked and found vacuous. A suite
  whose failures sometimes mean nothing is how #286 sat broken for three weeks.

The suite is deliberately out of CI, so a local run is its only reader. That is
the whole argument: a failure has to mean something.
