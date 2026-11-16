---
name: comment-audit
description: Use when auditing or cleaning up code comments, before committing, or when reviewing a diff. Removes comments that add no value (dividers, banners, empty, commented-out code, WHAT-comments) and keeps only WHY-comments. Includes a deterministic detector script.
---

## Comment Audit

Goal: **every comment that survives explains the WHY, not the WHAT.** Everything else goes.

### Golden rule

- ✅ **Keep** a comment only if it says something the code cannot say by itself: the **reason** for a decision, a non-obvious **why**, a business constraint, a workaround and its motive, a gotcha, a link to a ticket/issue, a subtle invariant.
- ❌ **Delete** anything that narrates the WHAT (paraphrases the code), is decorative or is dead.

### What goes (categories)

| Category | Example | Action |
|----------|---------|--------|
| **divider** | `# --------`, `// =====`, `####` | Delete (deterministic) |
| **banner** | ASCII-art / box-drawing boxes | Delete (deterministic) |
| **empty** | `#`, `//` with no text | Delete (deterministic) |
| **code** | commented-out code: `# old = foo(5)` | Delete (review each; dead code is not versioned, that is what git is for) |
| **WHAT** | `// increment i`, `# return the user`, `// constructor` | Delete (judgement) |
| **redundant** | repeats the function/variable name | Delete (judgement) |
| **TODO/FIXME** | `# TODO: fix this` | Review: turn into an issue or remove |

WHAT vs WHY:

```py
# ❌ WHAT: divide by 100 and format       (the code already says it)
price = cents / 100

# ✅ WHY: amounts arrive as signed cents; the backend never uses float
price = cents / 100
```

### Flow (deterministic first)

1. **Detect** with the bundled script (mechanical, unambiguous categories):
   ```bash
   python3 "$CLAUDE_PROJECT_DIR/.claude/skills/comment-audit/scripts/audit_comments.py" <paths>
   ```
   Without arguments it audits the files tracked by git. `--json` for structured output.
2. **Auto-clean** the unambiguous noise (divider/banner/empty):
   ```bash
   python3 "$CLAUDE_PROJECT_DIR/.claude/skills/comment-audit/scripts/audit_comments.py" <paths> --fix
   ```
   `--fix` **only** removes divider/banner/empty (it never touches `code` or prose: zero false positives).
3. **Review by hand** the `code` findings (delete the commented-out code) and the `TODO`s.
4. **Apply the WHY-vs-WHAT judgement** to the remaining comments (this is not deterministic): delete those that narrate the WHAT; keep those that explain the WHY. When in doubt, if the comment disappears and the code is still understandable, it was WHAT: delete it.

### Limits

- The script is deterministic only for divider/banner/empty/code. It does **not** decide WHAT-vs-WHY (that needs understanding the code), by design, so it never deletes a valuable comment by mistake.
- It does not touch docstrings or JSDoc/TSDoc (they are API documentation, not inline comments).
- Before a bulk `--fix`, have a clean working tree or a branch so the diff can be reviewed.

## Notes

- You may combine the script run with a quick manual scan, but still respect the WHAT-vs-WHY boundary.
- Do not delete `TODO` or commented-out code automatically; flag them for human review.
