---
id: ADR-0001
title: The storage folder is configurable and may be visible
status: accepted
scope: repo
date: 2026-11-03
---
# ADR-0001: The storage folder is configurable and may be visible

## Context
Comments live in the dotfolder `.margin-comments/`, which Obsidian Sync skips, so Sync users never
see their comments on other devices (#208, documented in #218). The maintainer decided to add an
optional "Storage folder" setting so a visible folder can travel with Sync. This relaxes the
hard constraint that the folder is a dotfolder invisible to the Vault API.

## Decision
- The default stays `.margin-comments`; a visible folder is opt-in, a single segment at the vault root (D1: nested paths are rejected).
- Storage I/O still goes only through `app.vault.adapter` with `normalizePath()`; the Vault API sees a visible folder, so its handlers must ignore it.
- `FORMAT_VERSION` is unchanged: the layout inside the folder does not change.
- Whether Sync carries `.json` files under default settings is UNVERIFIED. User-facing text tells
  Sync users to enable "Sync all other types".
- D2: after a move the old folder is deleted once the copy is verified (copy, verify, switch the
  setting, delete the source); re-running finishes an interrupted move.
- D3: a non-empty target is merged by comment id; the newer `updatedAt` wins and one-sided comments are kept.
- D4: renaming the folder in the file explorer makes the setting follow it; if the new name is
  invalid, show a Notice and keep the old setting.
- D5: deleting the folder shows a persistent Notice; the folder is not recreated until the next new comment.

## Consequences
`AGENTS.md` is rewritten to match; code lands in #400 onwards; external readers read the folder name from the settings.
