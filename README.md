# Inline Comments for Obsidian

Add inline comments to your Obsidian notes with threaded replies, resolve/unresolve, and a sidebar panel. Non-destructive storage — your Markdown files are never modified.

> **Status: in development.** Not yet released. Track progress on the [project board](https://github.com/users/jonaas-dev/projects).

## Planned features

- **Inline comments** — hover the left edge of a text block to add a comment
- **Threaded replies** — reply to any comment (flat, one level)
- **Resolve / unresolve** — mark comments as resolved, reopen anytime
- **Sidebar panel** — all comments with filters (open / resolved) and sorting
- **Non-destructive** — comments live in `.inline-comments/`, your notes stay clean
- **Theme-aware** — follows your Obsidian theme colors
- **Mobile support** — tap replaces hover

## How it works

Comments are stored as JSON files in `.inline-comments/` at the vault root. Markdown files are never modified, so comments are safe with any sync service (Git, iCloud, Dropbox, Obsidian Sync), survive Obsidian updates, and are trivial to back up or migrate.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup.

## License

[MIT](LICENSE)
