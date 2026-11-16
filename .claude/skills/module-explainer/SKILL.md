---
name: module-explainer
description: |
  One-screen explainer of a module (entry points, main callers, dependencies, invariants, tests) before
  working on it, so an executor does not re-explore it. Uses code-review-graph when the repo has
  .code-review-graph/, rg otherwise. Use before a complex issue or when asked to explain a module.
---

## Module Explainer

Input: a module (directory, file or package) of the current repo. Output: the explainer below, **at most
40 lines**, printed in the chat (write it to a file only when asked). Read as little as possible: the
explainer replaces exploration, it must not cost more than it saves.

### Steps

1. **Graph or rg.** If the git toplevel has `.code-review-graph/`, use the graph:
   `get_minimal_context(task="explain <module>")`, then `query_graph` with `children_of` on its files,
   `callers_of` on its public symbols, `imports_of` and `tests_for` (`detail_level="minimal"`).
   Otherwise use `rg`:
   - entry points: `rg -n '^(async )?def [a-z]|^class |^export (async )?(function|class|const)|@(router|app)\.' <module>`
   - callers: `rg -n --glob '!<module>/**' '<import path of the module>|<public symbol>'`
   - tests: `rg -l '<import path of the module>' <tests dirs>`
2. **Callers first.** Group call sites by caller file; keep the 5 with most references, with `file:line`.
3. **Invariants**: read only the docstrings, asserts, validations and raised errors of the entry points,
   plus the lines of `AGENTS.md` / ADRs that name the module. State each as a rule, not as code.
4. Write the explainer. Leave a section out rather than pad it; never exceed 40 lines.

### Output format

```markdown
# <module> — explainer (<graph | rg>, <date>)
**Purpose**: one sentence.
**Entry points**: `symbol` (file:line) — what it does, one per line, at most 6.
**Main callers**: `caller file:line` → `symbol`, at most 5, most references first.
**Depends on**: internal modules it imports, at most 5.
**Invariants**: rules that must keep holding, at most 5.
**Tests**: test files that cover it, and what is not covered.
**Gotchas**: at most 3 surprises (side effects, ordering, globals).
```

## Notes

- You may batch the rg or graph queries, but keep the format and the 40-line cap.
- Name only callers you saw in a tool result; never infer one.
