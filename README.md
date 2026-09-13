# Margin Comments for Obsidian

Add inline comments to your Obsidian notes with threaded replies, resolve/unresolve, and a sidebar panel. Non-destructive storage — your Markdown files are never modified.

> **Status: in development.** Not yet released. Track progress on the [project board](https://github.com/users/jonaas-dev/projects).

## Features

Everything below is implemented and covered by tests against a real Obsidian.

- **Inline comments** — hover the left edge of a line to comment on it, or select text and comment on the selection
- **Threaded replies** — reply to any comment; threads are flat, one level deep
- **Edit, resolve, delete** — edit in place, resolve and reopen a thread, delete with the reply cascade named up front
- **Highlights and gutter markers** — a comment on a selection marks those words; a comment on a whole line tints the line; a line with both shows both. The gutter marker carries a count when a line has several threads
- **Keyboard and screen readers** — every control is reachable without a mouse, with a focus ring from your theme and a name on every icon
- **Popover or panel** — click a marker to read the thread beside the line, or in the sidebar when it is open
- **Sidebar panel** — filter by all / open / resolved, sort by document order, date or last activity, with counts that match what is shown
- **All-notes view** — every commented note in the vault, one collapsed row each, opened on demand
- **Commands and hotkeys** — add a comment, jump to the next or previous comment, resolve every thread in a note, toggle the panel. None ships with a default hotkey; bind the ones you use in **Settings → Hotkeys**
- **Non-destructive** — comments live in `.margin-comments/`, your notes stay untouched
- **Theme-aware** — colours and type come from your Obsidian theme
- **Reading mode** — commented text is highlighted there too; see below for what reading mode does and does not do
- **Mobile and touch** — tap replaces hover: markers stay on the commented lines and on the line the caret is on, controls are thumb-sized, and the composer stays above the on-screen keyboard

## Reading mode

Comments are **created and managed in editing mode**. In reading mode the plugin
highlights the commented text and nothing else.

**What works**

- Commented text is highlighted in the rendered note
- The highlight follows the same anchoring as the editor, so text that moved is
  still marked where it ended up
- Resolving a thread clears its highlight without leaving reading mode
- Turning off "Highlight commented lines" turns these off too

**What does not**

- **No gutter markers**, so there is nowhere to hover or tap to add a comment.
  Switch to editing mode, or use the panel
- **No click-to-open.** A highlight marks the text; the thread is read in the
  sidebar panel, which works the same in either mode
- A comment made on text that Markdown consumes — the asterisks in `**bold**`,
  a link's target — cannot be marked around the words it belongs to, because
  those characters are not in the rendered output. The whole block carries a rule
  down its left edge instead
- A whole-line comment marks its block the same way, for the same reason: there
  is no selection to find. The block is the rendered paragraph, so comments on
  several consecutive lines of one paragraph mark that paragraph once rather
  than line by line — the rendered output keeps no record of which source line
  each part came from
- A comment inside a fenced code block marks the code block with that rule too,
  rather than the words inside it

The cause is that these are CodeMirror editor extensions, and CodeMirror does not
run in reading mode. The highlights arrive through a Markdown post-processor,
which can reach the rendered output but not the gutter beside it.

### Panel size

The panel draws every thread it is showing. Measured against a real Obsidian, on
a note with one thousand comments that costs about 250ms once, when the panel
opens or repaints — and scrolling stays at the frame budget however many there
are, because the browser only paints what is on screen. At three thousand the
render is about a second and scrolling is unchanged.

So there is no virtual scrolling, deliberately: it would trade `Cmd+F` and Tab
reaching the threads that are off screen for a cost that only shows up on notes
far past any real one.

## How it works

Comments are stored as JSON files in `.margin-comments/` at the vault root: one sidecar per commented note, plus an index of which notes have comments and how many. Markdown files are never modified, so comments are safe with any sync service (Git, iCloud, Dropbox, Obsidian Sync), survive Obsidian updates, and are trivial to back up or migrate.

Each comment remembers the text it was made on, not a line number, so it follows that text as the note is edited. A comment whose text is gone is shown as orphaned rather than dropped.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup.

## License

[MIT](LICENSE)
