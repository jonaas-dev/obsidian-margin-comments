# Architecture and data model

## Architecture

```
src/
├── main.ts          entry point, plugin registration
├── types.ts         Comment, TextAnchor, PluginSettings
├── storage.ts       sidecar CRUD over vault.adapter in the configured folder
├── anchor.ts        content-based anchoring (hash → context → fuzzy → orphaned)
├── editor/          CodeMirror 6 extensions (gutter, highlights, floating editor)
├── ui/              sidebar panel, comment cards, modals
├── settings.ts      settings tab
└── utils.ts         hashing, relative dates, ids
```

## Storage folder

The folder is the `storageFolder` setting: `.margin-comments` by default, or a single folder name
at the vault root that may be visible so Obsidian Sync can carry it (ADR-0001). `CommentStorage.moveTo`
changes it without losing a comment. It waits for queued writes, copies each file to the target and
reads every copy back to compare it, switches the store to the target, and only then deletes the
source. A target that already holds this plugin's files (synced from another device) is merged per
note by comment id: when both sides hold a comment, the newer `updatedAt` wins, and a comment on one
side only is kept. A sidecar in a newer format, or one that does not parse, is never rewritten.

Vault events for files in the storage folder are ignored by `src/vault-events.ts`. A rename of the
folder in the file explorer makes the setting follow it.

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
