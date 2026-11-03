# Architecture and data model

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
