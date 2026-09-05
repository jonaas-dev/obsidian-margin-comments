# AGENTS.md — obsidian-inline-comments

Project-specific instructions. The cross-repo rules in `~/Repos/AGENTS.md` also apply
(branch + PR, Conventional Commits in Spanish, PRs under 400 lines, pre-commit linting,
WHY-only comments).

## Language

**All repo content is in English**: source code, identifiers, code comments, docstrings,
CSS classes, file names, README, issues and PR titles/bodies. Commit messages follow
Conventional Commits — the type prefix is English, the subject may be Spanish per the
cross-repo convention.

## What this is

An Obsidian plugin that adds inline comments to notes without ever modifying the
Markdown files. Comment data lives in JSON sidecars under `.inline-comments/` at the
vault root.

## Hard constraints

- **Never write to the user's `.md` files.** Comments are sidecar-only.
- **`.inline-comments/` is a dotfolder**, therefore invisible to the Obsidian Vault API.
  Use `app.vault.adapter` (`read`/`write`/`exists`/`list`/`mkdir`) with `normalizePath()`
  for every path. `vault.create`, `vault.getAbstractFileByPath` and `vault.on('modify')`
  will not see it.
- **Mobile must work** (`isDesktopOnly: false`), so no Node built-ins: no `require('crypto')`,
  no `fs`, no `path`. Hashing is a synchronous non-cryptographic function implemented in
  plain TypeScript.
- Register every event with `registerEvent()` and every interval with `registerInterval()`;
  tear everything down in `onunload()`.
- No `console.log` left in shipped code.

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

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | esbuild watch |
| `npm run build` | production build |
| `npm test` | vitest |
| `npx tsc --noEmit` | type check |

## Task tracking

Work items live in the GitHub Project, not in this repo. The design document is kept
outside the repo and is not published.
