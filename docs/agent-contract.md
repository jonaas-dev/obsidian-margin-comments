# Agent contract: reading and answering comments from outside Obsidian

How a script or an AI agent (Claude Code, OpenCode, …) can read the comments in a vault and
reply to them while Obsidian may be open. The source of truth is `src/storage.ts` and
`src/types.ts`; this page only covers what an external writer needs.

## Files

| Path (vault-relative) | Content |
|---|---|
| `.margin-comments/_index.json` | `{ "version": 1, "notes": { "<note path>": { "hash", "threads", "open" } } }` |
| `.margin-comments/<hash>.json` | One note's sidecar: `{ "version": 1, "filePath": "<note path>", "comments": [Comment] }` |
| `.margin-comments/held/` | Comments of deleted notes waiting for them to come back. Do not touch |

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
