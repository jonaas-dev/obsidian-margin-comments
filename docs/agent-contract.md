# Agent contract: reading and answering comments from outside Obsidian

How a script or an AI agent (Claude Code, OpenCode, …) can read the comments in a vault and
reply to them while Obsidian may be open. The source of truth is `src/storage.ts` and
`src/types.ts`; this page only covers what an external writer needs.

## Finding the folder

`<storage>` below is the storage folder: `.margin-comments` by default, but the user can choose
another single folder name at the vault root. Do not hard-code `.margin-comments`.

1. Read `<configDir>/plugins/margin-comments/data.json`. `configDir` is `.obsidian` unless the
   vault changed it (Obsidian exposes it as `app.vault.configDir`).
2. Take its `storageFolder` value when it is a single folder name at the vault root: not empty,
   none of `/ \ : * ? " < > |`, not `.`, `..` or `.trash`, and not the config folder. Otherwise,
   or when the file or key is absent, use `.margin-comments`.
3. Fallback, when that folder holds no `_index.json` with a numeric `version`: use the root
   folder that does.

The rules in step 2 are `toStorageFolder` in `src/settings-values.ts`.

## Files

| Path (vault-relative) | Content |
|---|---|
| `<storage>/_index.json` | `{ "version": 1, "notes": { "<note path>": { "hash", "threads", "open" } } }` |
| `<storage>/<hash>.json` | One note's sidecar: `{ "version": 1, "filePath": "<note path>", "comments": [Comment] }` |
| `<storage>/held/` | Comments of deleted notes waiting for them to come back. Do not touch |

`<hash>` is `hashString(filePath)` from `src/utils.ts`: two FNV-1a 32-bit passes over the
UTF-16 code units (both bytes of each one) with offset bases `2166136261` and `2166136830`,
each printed as 8 hex digits. Prefer reading it from `_index.json` over recomputing it.

A sidecar whose `version` is higher than the one you understand must not be rewritten: the
plugin shows it read-only for the same reason.

## Comment

```jsonc
{
  "id": "uuid",
  "filePath": "projects/x/plan.md",
  "anchor": { "selectedText", "textHash", "isLineComment", "contextBefore", "contextAfter",
              "lineHint", "startOffset", "endOffset" },
  "content": "Markdown",
  "author": "",
  "createdAt": 1792917464910,   // ms since epoch
  "updatedAt": 1792917464910,   // any activity, resolving included
  "editedAt": 1792917464910,    // optional: body rewritten
  "resolved": false,            // only meaningful on a root
  "parentId": null              // null = thread root; a reply points at the root
}
```

The model is flat: a reply always points at its thread root, never at another reply.

## Operations

**List open threads of a note:** comments with `parentId: null` and `resolved: false`.

**Reply:** append a comment with a new UUID `id`, `parentId` set to the root's `id`, a copy of
the root's `anchor`, `resolved: false`, and `createdAt` = `updatedAt` = now.

**Resolve:** set `resolved: true` and `updatedAt` = now on the root. Leave replies as they are.

**Index:** after changing a sidecar, update its entry in `_index.json`: `threads` = number of
roots, `open` = unresolved roots.

## Writing safely

- Write the whole file to a temporary name and rename it into place, as the plugin does. A
  half-written sidecar is set aside by the plugin as invalid.
- Keep every field you do not understand: a newer plugin may have added it.
- Obsidian notices external changes (`changedOnDisk`, #260) and redraws, so the user sees
  the reply without restarting. Avoid writing while the user is editing the same note's
  comments; the last write wins.
- Never edit the `.md` note to "answer" a comment. If a change rewrites the note so much that
  the anchors no longer match, resolve the threads first and tell the user: rewritten text
  leaves its threads orphaned.
