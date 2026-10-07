# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release tags carry no `v` prefix.

## [1.0.1] - 2026-10-07

Everything the community directory's automated review of 1.0.0 raised. No user-visible
behaviour changes.

### Added

- Provenance attestations on the release assets, so `main.js` and `styles.css` can be
  verified cryptographically as having been built from this repository.

### Changed

- The `color-mix` tints move behind an `@supports` block. They were a fallback written as
  two declarations in a row, which reads as seven duplicated properties; the condition is
  now stated rather than implied. The fallback itself stays, because mobile runs the
  system webview and `color-mix` arrived there in iOS 16.2.
- `debounce` takes its timers as an argument instead of reaching for the main window's.
- Reading mode uses Obsidian's cross-window `instanceOf` instead of `instanceof`.
- One fewer development dependency: `builtin-modules` is `node:module`.

## [1.0.0] - 2026-10-07

First public release.

### Added

- Comments on a selection or on a whole line, without ever modifying the note: comments live in `.margin-comments/` at the vault root.
- Threaded replies, one level deep. Edit, resolve, reopen and delete, with the replies a delete takes named before it happens.
- Highlights on commented text, a tint on commented lines, and gutter markers that carry a count when a line holds several threads.
- A popover beside the line, or the sidebar panel when it is open.
- A sidebar panel filtered by all, open or resolved and sorted by document order, date or last activity, plus an all-notes view listing every commented note in the vault.
- Reading mode: commented text is highlighted, and a tap or click on a mark opens its thread.
- Commands to add a comment, jump between comments, resolve every thread in a note and toggle the panel. None has a default hotkey.
- Mobile and touch support: markers without hover, thumb-sized controls, and a composer that stays above the on-screen keyboard.
- Keyboard and screen reader access to every control, with colours and type taken from the theme.
- Comments that follow their note through renames and moves, including a rename made outside Obsidian, and come back whenever a deleted note does — they are held on disk, so a restart does not lose them.
- Damaged storage is never overwritten: an unreadable sidecar or an invalid comment is set aside in a kept file, and a notice says where.

[1.0.1]: https://github.com/jonaas-dev/obsidian-margin-comments/releases/tag/1.0.1
[1.0.0]: https://github.com/jonaas-dev/obsidian-margin-comments/releases/tag/1.0.0
