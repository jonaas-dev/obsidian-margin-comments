# Inline Comments for Obsidian

Add inline comments to your Obsidian notes with threaded replies, resolve/unresolve, and a sidebar panel. Non-destructive storage — your Markdown files are never modified.

> **Status: in development.** Not yet released. Track progress on the [project board](https://github.com/users/jonaas-dev/projects).

## Features

Everything below is implemented and covered by tests against a real Obsidian.

- **Inline comments** — hover the left edge of a line to comment on it, or select text and comment on the selection
- **Threaded replies** — reply to any comment; threads are flat, one level deep
- **Edit, resolve, delete** — edit in place, resolve and reopen a thread, delete with the reply cascade named up front
- **Line highlights and gutter markers** — lines carrying open comments are marked in the editor
- **Popover or panel** — click a marker to read the thread beside the line, or in the sidebar when it is open
- **Sidebar panel** — filter by all / open / resolved, sort by document order, date or last activity, with counts that match what is shown
- **All-notes view** — every commented note in the vault, one collapsed row each, opened on demand
- **Commands and hotkeys** — add a comment (`Mod+Shift+M`), jump to the next or previous comment, resolve every thread in a note, toggle the panel. All rebindable in Obsidian's hotkey settings
- **Non-destructive** — comments live in `.inline-comments/`, your notes stay untouched
- **Theme-aware** — colours and type come from your Obsidian theme
- **Mobile support** — tap replaces hover

### Still to come

Fuzzy re-anchoring for heavily edited text, orphaned-comment handling, rename tracking,
a settings tab, and the accessibility and performance passes before 1.0.

## How it works

Comments are stored as JSON files in `.inline-comments/` at the vault root: one sidecar per commented note, plus an index of which notes have comments and how many. Markdown files are never modified, so comments are safe with any sync service (Git, iCloud, Dropbox, Obsidian Sync), survive Obsidian updates, and are trivial to back up or migrate.

Each comment remembers the text it was made on, not a line number, so it follows that text as the note is edited. A comment whose text is gone is shown as orphaned rather than dropped.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup.

## License

[MIT](LICENSE)
